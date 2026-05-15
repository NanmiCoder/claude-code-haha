import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { CCRClient } from '../cli/transports/ccrClient.js'
import type { HybridTransport } from '../cli/transports/HybridTransport.js'
import { SSETransport } from '../cli/transports/SSETransport.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { updateSessionIngressAuthToken } from '../utils/sessionIngressAuth.js'
import type { SessionState } from '../utils/sessionState.js'
import { registerWorker } from './workSecret.js'

/**
 * replBridge 的 transport 抽象。它精确覆盖 replBridge.ts 实际会用到的
 * HybridTransport 能力，从而把 v1/v2 的选择限制在构造点。
 *
 * - v1: HybridTransport (WS reads + POST writes to Session-Ingress)
 * - v2: SSETransport (reads) + CCRClient (writes to CCR v2 /worker/*)
 *
 * v2 的写路径走的是 CCRClient.writeEvent → SerialBatchEventUploader，
 * 而不是 SSETransport.write()。SSETransport.write() 面向的是 Session-Ingress
 * 的 POST URL 形式，这对 CCR v2 来说是错的。
 */
export type ReplBridgeTransport = {
  write(message: StdoutMessage): Promise<void>
  writeBatch(messages: StdoutMessage[]): Promise<void>
  close(): void
  isConnectedStatus(): boolean
  getStateLabel(): string
  setOnData(callback: (data: string) => void): void
  setOnClose(callback: (closeCode?: number) => void): void
  setOnConnect(callback: () => void): void
  connect(): void
  /**
   * 底层读流事件序列号的高水位值。replBridge 会在切换 transport 前读取它，
   * 这样新的 transport 才能从旧 transport 停下的位置继续恢复
   * （否则服务端会从 seq 0 开始重放整段 session 历史）。
   *
   * v1 返回 0，因为 Session-Ingress WS 不使用 SSE 序列号；
   * 重连后的重放由服务端消息游标负责处理。
   */
  getLastSequenceNum(): number
  /**
   * 通过 maxConsecutiveFailures 被丢弃的 batch 的单调递增计数。
   * 在 writeBatch() 前后取快照并比较，可用来检测静默丢弃
   * （即使 batch 被丢弃，writeBatch() 也会正常 resolve）。
   * v2 返回 0，因为 v2 写路径不会设置 maxConsecutiveFailures。
   */
  readonly droppedBatchCount: number
  /**
   * PUT /worker state（仅 v2；v1 为 no-op）。`requires_action` 用于告诉后端
   * 当前有权限提示待处理，claude.ai 会据此显示“waiting for input”指示器。
   * REPL/daemon 调用方通常不需要它（用户在本地看 REPL），但多 session worker
   * 调用方需要。
   */
  reportState(state: SessionState): void
  /** PUT /worker external_metadata（仅 v2；v1 为 no-op）。 */
  reportMetadata(metadata: Record<string, unknown>): void
  /**
   * POST /worker/events/{id}/delivery（仅 v2；v1 为 no-op）。会填充
   * CCR 的 processing_at/processed_at 列。`received` 会由 CCRClient 在每个
   * SSE frame 上自动触发，因此不在这里暴露。
   */
  reportDelivery(eventId: string, status: 'processing' | 'processed'): void
  /**
   * 在 close() 之前排空写队列（仅 v2；v1 会立即 resolve，因为
   * HybridTransport 的 POST 本来就是逐次 await 的）。
   */
  flush(): Promise<void>
}

/**
 * v1 适配器。HybridTransport 本身已经具备完整能力面
 * （它继承自带有 setOnConnect + getStateLabel 的 WebSocketTransport）。
 * 这里的 no-op 包装只是为了让 replBridge 的 `transport` 变量拥有统一类型。
 */
export function createV1ReplTransport(
  hybrid: HybridTransport,
): ReplBridgeTransport {
  return {
    write: msg => hybrid.write(msg),
    writeBatch: msgs => hybrid.writeBatch(msgs),
    close: () => hybrid.close(),
    isConnectedStatus: () => hybrid.isConnectedStatus(),
    getStateLabel: () => hybrid.getStateLabel(),
    setOnData: cb => hybrid.setOnData(cb),
    setOnClose: cb => hybrid.setOnClose(cb),
    setOnConnect: cb => hybrid.setOnConnect(cb),
    connect: () => void hybrid.connect(),
    // v1 Session-Ingress WS 不使用 SSE 序列号，重放语义也不同。
    // 始终返回 0，这样 replBridge 中的 seq-num 延续逻辑对 v1 来说就是 no-op。
    getLastSequenceNum: () => 0,
    get droppedBatchCount() {
      return hybrid.droppedBatchCount
    },
    reportState: () => {},
    reportMetadata: () => {},
    reportDelivery: () => {},
    flush: () => Promise.resolve(),
  }
}

/**
 * v2 适配器：包装 SSETransport（读）和 CCRClient（写、heartbeat、状态、投递跟踪）。
 *
 * 鉴权方面，v2 endpoint 会校验 JWT 的 session_id claim（register_worker.go:32）
 * 和 worker role（environment_auth.py:856），而 OAuth token 两者都没有。
 * 这与故意使用 OAuth 的 v1 replBridge 路径正好相反。
 * 当 poll loop 重新分发 work 时，JWT 会刷新，调用方会再用新的 token 调一次
 * 工厂函数 createV2ReplTransport。
 *
 * 注册发生在这里，而不是调用方中，因此整个 v2 握手是单个异步步骤。
 * registerWorker 的失败会向上传播，replBridge 会捕获它并继续留在 poll loop 中。
 */
export async function createV2ReplTransport(opts: {
  sessionUrl: string
  ingressToken: string
  sessionId: string
  /**
    * 上一个 transport 的 SSE 序列号高水位值。
    * 会传给新的 SSETransport，使其第一次 connect() 就携带
    * from_sequence_num / Last-Event-ID，从而让服务端从旧流停下的位置继续恢复。
    * 如果没有这个值，每次切换 transport 都会要求服务端从 seq 0 重放整个 session 历史。
   */
  initialSequenceNum?: number
  /**
    * 来自 POST /bridge 响应的 worker epoch。若提供该值，说明服务端已经 bump 过 epoch
    * （/bridge 调用本身就是 register，见服务端 PR #293280）。若未提供
    * （即 replBridge.ts poll loop 里的 v1 CCR-v2 路径），则像以前一样调用 registerWorker。
   */
  epoch?: number
    /** CCRClient heartbeat 间隔。缺省时默认为 20s。 */
  heartbeatIntervalMs?: number
    /** 每次 heartbeat 的 ±fraction 抖动。缺省时为 0（无抖动）。 */
  heartbeatJitterFraction?: number
  /**
    * 为 true 时，跳过打开 SSE 读流，只启用 CCRClient 写路径。
    * 适用于 mirror 模式附件：它们只转发事件，不接收 inbound prompt 或控制请求。
   */
  outboundOnly?: boolean
  /**
    * 每实例的 auth header 来源。提供后，CCRClient + SSETransport 会从该闭包中
    * 读取鉴权信息，而不是读取进程级的 CLAUDE_CODE_SESSION_ACCESS_TOKEN 环境变量。
    * 这对同时管理多个并发 session 的调用方是必需的，因为 env var 路径会相互覆盖。
    * 省略时则回退到 env var（适用于单 session 调用方）。
   */
  getAuthToken?: () => string | undefined
}): Promise<ReplBridgeTransport> {
  const {
    sessionUrl,
    ingressToken,
    sessionId,
    initialSequenceNum,
    getAuthToken,
  } = opts

  // 鉴权 header 构造器。如果提供了 getAuthToken，就从它读取
  // （按实例隔离，适合多 session）。否则就把 ingressToken 写入进程级 env var
  // （遗留的单 session 路径，CCRClient 默认的 getAuthHeaders 会通过
  // getSessionIngressAuthHeaders 读取它）。
  let getAuthHeaders: (() => Record<string, string>) | undefined
  if (getAuthToken) {
    getAuthHeaders = (): Record<string, string> => {
      const token = getAuthToken()
      if (!token) return {}
      return { Authorization: `Bearer ${token}` }
    }
  } else {
    // CCRClient.request() 和 SSETransport.connect() 都会通过
    // getSessionIngressAuthHeaders() 读取这个 env var，所以要在任何网络访问前先写入。
    updateSessionIngressAuthToken(ingressToken)
  }

  const epoch = opts.epoch ?? (await registerWorker(sessionUrl, ingressToken))
  logForDebugging(
    `[bridge:repl] CCR v2: worker sessionId=${sessionId} epoch=${epoch}${opts.epoch !== undefined ? ' (from /bridge)' : ' (via registerWorker)'}`,
  )

  // 推导 SSE stream URL。逻辑与 transportUtils.ts:26-33 相同，
  // 只是这里从 http(s) base 开始，而不是可能为 ws:// 的 --sdk-url。
  const sseUrl = new URL(sessionUrl)
  sseUrl.pathname = sseUrl.pathname.replace(/\/$/, '') + '/worker/events/stream'

  const sse = new SSETransport(
    sseUrl,
    {},
    sessionId,
    undefined,
    initialSequenceNum,
    getAuthHeaders,
  )
  let onCloseCb: ((closeCode?: number) => void) | undefined
  const ccr = new CCRClient(sse, new URL(sessionUrl), {
    getAuthHeaders,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    heartbeatJitterFraction: opts.heartbeatJitterFraction,
    // 默认实现是 process.exit(1)，这对 spawn 模式子进程是正确的。
    // 但在同进程场景下它会直接杀掉 REPL，因此这里改为 close：
    // replBridge 的 onClose 会唤醒 poll loop，再接住服务端重新分发的 work。
    onEpochMismatch: () => {
      logForDebugging(
        '[bridge:repl] CCR v2: epoch superseded (409) — closing for poll-loop recovery',
      )
      // 把资源关闭放进 try 块，确保后面的 throw 一定会执行。
      // 即便 ccr.close() 或 sse.close() 抛错，也必须继续向上 unwind
      // 调用方（request()）；否则 handleEpochMismatch 的 `never` 返回约束
      // 会在运行时被破坏，控制流会错误地继续向后落下。
      try {
        ccr.close()
        sse.close()
        onCloseCb?.(4090)
      } catch (closeErr: unknown) {
        logForDebugging(
          `[bridge:repl] CCR v2: error during epoch-mismatch cleanup: ${errorMessage(closeErr)}`,
          { level: 'error' },
        )
      }
      // 这里不能 return。request() 在 409 分支后还会继续执行，
      // 调用方会看到日志里的 warning 与 false 返回值。
      // 因此必须 throw 以强制 unwind，上传路径会把它当成 send failure 捕获。
      throw new Error('epoch superseded')
    },
  })

  // CCRClient 构造函数会把 sse.setOnEvent 绑定到 reportDelivery('received')。
  // remoteIO.ts 还会通过 setCommandLifecycleListener 额外发送 'processing'/'processed'，
  // 而这些会在进程内 query loop 中触发。这个 transport 的唯一调用方
  // （replBridge/daemonBridge）没有这样的接线。daemon 的 agent 子进程是独立进程
  // （ProcessTransport），它自己的 notifyCommandLifecycle 调用在本模块作用域内的
  // listener 为 null。因此事件会永远停在 'received'，而 reconnectSession 会在每次
  // daemon 重启时重新把它们入队（已观测到 21→24→25 这类幽灵 prompt，表现为
  // “user sent a new message while you were working” 系统提示）。
  //
  // 修复：在 ACK 'received' 的同时立刻 ACK 'processed'。
  // 从收到 SSE 到写入 transcript 的窗口很窄（queue → SDK → child stdin → model）；
  // 如果在这里崩溃，最多丢一条 prompt，但相比之下我们已经观测到每次重启都会产生 N 条
  // prompt 洪泛。这里直接覆盖构造函数中的 wiring，让它一次做两件事。
  // 注意 setOnEvent 是替换而非追加（SSETransport.ts:658）。
  sse.setOnEvent(event => {
    ccr.reportDelivery(event.event_id, 'received')
    ccr.reportDelivery(event.event_id, 'processed')
  })

  // sse.connect() 和 ccr.initialize() 都会推迟到下面的 connect() 里执行。
  // replBridge 的调用顺序是 newTransport → setOnConnect → setOnData →
  // setOnClose → connect()，因此这两个调用都必须先等回调接线完成。
  // sse.connect() 一旦打开流，事件会立刻流向 onData/onClose；
  // ccr.initialize().then() 则会触发 onConnectCb。
  //
  // onConnect 会在 ccr.initialize() resolve 后触发。写入走的是 CCRClient 的 HTTP POST
  // （SerialBatchEventUploader），不是 SSE，因此一旦 workerEpoch 设置好，写路径就已可用。
  // SSE.connect() 会等待读循环，因此永远不会真正 resolve，不应把它作为 gating 条件。
  // SSE 流会并行打开（约 30ms），随后通过 setOnData 送出 inbound 事件；出站路径无须等待它。
  let onConnectCb: (() => void) | undefined
  let ccrInitialized = false
  let closed = false

  return {
    write(msg) {
      return ccr.writeEvent(msg)
    },
    async writeBatch(msgs) {
      // SerialBatchEventUploader 本身已经会做内部批处理（maxBatchSize=100）；
      // 顺序入队既能保持顺序，也能让 uploader 自行合并。
      // 在两次写之间检查 closed，可避免 transport teardown 之后继续发出半截 batch
      // （例如 epoch mismatch、SSE 掉线）。
      for (const m of msgs) {
        if (closed) break
        await ccr.writeEvent(m)
      }
    },
    close() {
      closed = true
      ccr.close()
      sse.close()
    },
    isConnectedStatus() {
      // 这里表示“写路径是否就绪”，而不是“读路径是否就绪”。replBridge 会在调用
      // writeBatch 前检查它。SSE 是否已打开是另一回事。
      return ccrInitialized
    },
    getStateLabel() {
      // SSETransport 不暴露自己的状态字符串，因此只能根据可观测信息拼一个。
      // replBridge 仅把它用于调试日志。
      if (sse.isClosedStatus()) return 'closed'
      if (sse.isConnectedStatus()) return ccrInitialized ? 'connected' : 'init'
      return 'connecting'
    },
    setOnData(cb) {
      sse.setOnData(cb)
    },
    setOnClose(cb) {
      onCloseCb = cb
      // SSE 重连预算耗尽时会触发 onClose(undefined)。把它映射成 4092，
      // 这样 ws_closed 遥测就能把它与 HTTP 状态关闭区分开来
      // （SSETransport:280 会传 response.status）。在通知 replBridge 前，
      // 先停掉 CCRClient 的 heartbeat timer。
      // （sse.close() 不会走到这里，因此上方的 epoch mismatch 路径不会重复触发。）
      sse.setOnClose(code => {
        ccr.close()
        cb(code ?? 4092)
      })
    },
    setOnConnect(cb) {
      onConnectCb = cb
    },
    getLastSequenceNum() {
      return sse.getLastSequenceNum()
    },
    // v2 写路径（CCRClient）不会设置 maxConsecutiveFailures，因此不存在批次丢弃计数。
    droppedBatchCount: 0,
    reportState(state) {
      ccr.reportState(state)
    },
    reportMetadata(metadata) {
      ccr.reportMetadata(metadata)
    },
    reportDelivery(eventId, status) {
      ccr.reportDelivery(eventId, status)
    },
    flush() {
      return ccr.flush()
    },
    connect() {
      // Outbound-only：完全跳过 SSE 读流，因为没有 inbound 事件需要接收，
      // 也没有 delivery ACK 需要发送。此时只需要 CCRClient 的写路径
      // （POST /worker/events）和 heartbeat。
      if (!opts.outboundOnly) {
        // Fire-and-forget：SSETransport.connect() 会等待 readStream()
        //（也就是读循环）结束，因此只有在流关闭/出错时才会 resolve。
        // remoteIO.ts 中的 spawn-mode 路径也是同样地直接 void 掉。
        void sse.connect()
      }
      void ccr.initialize(epoch).then(
        () => {
          ccrInitialized = true
          logForDebugging(
            `[bridge:repl] v2 transport ready for writes (epoch=${epoch}, sse=${sse.isConnectedStatus() ? 'open' : 'opening'})`,
          )
          onConnectCb?.()
        },
        (err: unknown) => {
          logForDebugging(
            `[bridge:repl] CCR v2 initialize failed: ${errorMessage(err)}`,
            { level: 'error' },
          )
          // 关闭 transport 资源，并通过 onClose 通知 replBridge，
          // 这样 poll loop 才能在下一次 work dispatch 时重试。
          // 如果没有这个回调，replBridge 就永远不会知道 transport 初始化失败，
          // 从而会一直卡在 transport === null。
          ccr.close()
          sse.close()
          onCloseCb?.(4091) // 4091 = init failure, distinguishable from 4090 epoch mismatch
        },
      )
    },
  }
}
