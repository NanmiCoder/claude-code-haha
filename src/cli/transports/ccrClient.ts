import { randomUUID } from 'crypto'
import type {
  SDKPartialAssistantMessage,
  StdoutMessage,
} from 'src/entrypoints/sdk/controlTypes.js'
import { decodeJwtExpiry } from '../../bridge/jwtUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { errorMessage, getErrnoCode } from '../../utils/errors.js'
import { createAxiosInstance } from '../../utils/proxy.js'
import {
  registerSessionActivityCallback,
  unregisterSessionActivityCallback,
} from '../../utils/sessionActivity.js'
import {
  getSessionIngressAuthHeaders,
  getSessionIngressAuthToken,
} from '../../utils/sessionIngressAuth.js'
import type {
  RequiresActionDetails,
  SessionState,
} from '../../utils/sessionState.js'
import { sleep } from '../../utils/sleep.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import {
  RetryableError,
  SerialBatchEventUploader,
} from './SerialBatchEventUploader.js'
import type { SSETransport, StreamClientEvent } from './SSETransport.js'
import { WorkerStateUploader } from './WorkerStateUploader.js'

/** heartbeat 事件的默认间隔（20 秒；服务端 TTL 为 60 秒）。 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000

/**
 * stream_event 消息会先在延迟缓冲区中累积最多这么多毫秒，再统一 enqueue。
 * 这与 HybridTransport 的 batching 窗口保持一致。
 * 同一内容块上的 text_delta 会在每次 flush 时合并成一个“截至当前的完整快照”，
 * 从而保证每个发出的事件都是自包含的，哪怕客户端在中途接入，也能看到完整文本而非碎片。
 */
const STREAM_EVENT_FLUSH_INTERVAL_MS = 100

/** 提升到模块级的 axios validateStatus 回调，避免每次请求都新建闭包。 */
function alwaysValidStatus(): boolean {
  return true
}

export type CCRInitFailReason =
  | 'no_auth_headers'
  | 'missing_epoch'
  | 'worker_register_failed'

/** 由 initialize() 抛出；携带类型化失败原因，供诊断分类器使用。 */
export class CCRInitError extends Error {
  constructor(readonly reason: CCRInitFailReason) {
    super(`CCRClient init failed: ${reason}`)
  }
}

/**
 * 当 token 看起来仍然有效时，连续收到多少次 401/403 才放弃。
 * 若 JWT 已过期，会直接短路退出，因为这是确定性失败，重试没有意义。
 * 这个阈值只用于不确定场景：token 的 exp 仍在未来，但服务端仍返回 401，
 * 例如 userauth 故障、KMS 抖动、时钟偏移等。
 * 10 次 × 20 秒 heartbeat，大约给系统 200 秒自愈时间。
 */
const MAX_CONSECUTIVE_AUTH_FAILURES = 10

type EventPayload = {
  uuid: string
  type: string
  [key: string]: unknown
}

type ClientEvent = {
  payload: EventPayload
  ephemeral?: boolean
}

/**
 * 携带 text_delta 的 stream_event 的结构子集。
 * 这不是对 SDKPartialAssistantMessage 的窄化，
 * 因为 RawMessageStreamEvent 的 delta 本身是联合类型，跨两层去做窄化会破坏判别式。
 */
type CoalescedStreamEvent = {
  type: 'stream_event'
  uuid: string
  session_id: string
  parent_tool_use_id: string | null
  event: {
    type: 'content_block_delta'
    index: number
    delta: { type: 'text_delta'; text: string }
  }
}

/**
 * 用于 text_delta 合并的累加器状态。
 * 以 API message ID 为键，因此其生命周期与 assistant message 绑定；
 * 当完整的 SDKAssistantMessage 到达时会被清理（发生在 writeEvent 中），
 * 这个信号即便在 abort/error 路径跳过 content_block_stop/message_stop 时依然可靠。
 */
export type StreamAccumulatorState = {
  /** API message ID（msg_...）→ blocks[blockIndex] → chunk 数组。 */
  byMessage: Map<string, string[][]>
  /**
   * {session_id}:{parent_tool_use_id} → 当前活跃的 message ID。
   * content_block_delta 事件本身不携带 message ID，只有 message_start 才有，
   * 所以这里按 scope 追踪当前正在流式输出的是哪条消息。
   * 任意时刻每个 scope 最多只有一条消息在流式输出。
   */
  scopeToMessage: Map<string, string>
}

export function createStreamAccumulator(): StreamAccumulatorState {
  return { byMessage: new Map(), scopeToMessage: new Map() }
}

function scopeKey(m: {
  session_id: string
  parent_tool_use_id: string | null
}): string {
  return `${m.session_id}:${m.parent_tool_use_id ?? ''}`
}

/**
 * 把 text_delta 类型的 stream_event 按 content block 累积成“截至当前的完整快照”。
 * 每次 flush 时，每个被触达的 block 只会发出一个事件，
 * 且其中包含从该 block 起点到当前为止的全部文本。
 * 这样客户端即便在流式过程中才接入，也能拿到自包含快照，而不是一段碎片。
 *
 * 非 text_delta 事件会原样透传。message_start 用于记录某个 scope 当前活跃的 message ID；
 * content_block_delta 则向 chunks 追加内容；
 * 生成的 snapshot 会复用本次 flush 中该 block 第一个 text_delta 的 UUID，
 * 从而让服务端幂等性在重试场景下保持稳定。
 *
 * 清理逻辑不放在这里，而是在完整 assistant message 到达时由 writeEvent 触发，
 * 因为那个信号更可靠；stop 类事件在 abort/error 路径下可能根本不会送达。
 */
export function accumulateStreamEvents(
  buffer: SDKPartialAssistantMessage[],
  state: StreamAccumulatorState,
): EventPayload[] {
  const out: EventPayload[] = []
  // chunks[] -> 本次 flush 中已经写进 `out` 的 snapshot。
  // 这里用 chunks 数组引用作为 key（对每个 {messageId, index} 都是稳定的），
  // 这样后续 delta 只会重写同一个条目，而不是每个 delta 都额外发一个事件。
  const touched = new Map<string[], CoalescedStreamEvent>()
  for (const msg of buffer) {
    switch (msg.event.type) {
      case 'message_start': {
        const id = msg.event.message.id
        const prevId = state.scopeToMessage.get(scopeKey(msg))
        if (prevId) state.byMessage.delete(prevId)
        state.scopeToMessage.set(scopeKey(msg), id)
        state.byMessage.set(id, [])
        out.push(msg)
        break
      }
      case 'content_block_delta': {
        if (msg.event.delta.type !== 'text_delta') {
          out.push(msg)
          break
        }
        const messageId = state.scopeToMessage.get(scopeKey(msg))
        const blocks = messageId ? state.byMessage.get(messageId) : undefined
        if (!blocks) {
          // 当前 delta 前面没有对应的 message_start，
          // 可能是中途重连，也可能是先前缓冲区里的 message_start 已被丢弃。
          // 这种情况下只能原样透传，因为缺少前序 chunks，无法构造完整快照。
          out.push(msg)
          break
        }
        const chunks = (blocks[msg.event.index] ??= [])
        chunks.push(msg.event.delta.text)
        const existing = touched.get(chunks)
        if (existing) {
          existing.event.delta.text = chunks.join('')
          break
        }
        const snapshot: CoalescedStreamEvent = {
          type: 'stream_event',
          uuid: msg.uuid,
          session_id: msg.session_id,
          parent_tool_use_id: msg.parent_tool_use_id,
          event: {
            type: 'content_block_delta',
            index: msg.event.index,
            delta: { type: 'text_delta', text: chunks.join('') },
          },
        }
        touched.set(chunks, snapshot)
        out.push(snapshot)
        break
      }
      default:
        out.push(msg)
    }
  }
  return out
}

/**
 * 清理已经完成的 assistant message 对应的累加器条目。
 * 当 SDKAssistantMessage 到达时由 writeEvent 调用；
 * 这是一个可靠的流结束信号，即便 abort/interrupt/error 路径跳过 SSE stop 事件也会触发。
 */
export function clearStreamAccumulatorForMessage(
  state: StreamAccumulatorState,
  assistant: {
    session_id: string
    parent_tool_use_id: string | null
    message: { id: string }
  },
): void {
  state.byMessage.delete(assistant.message.id)
  const scope = scopeKey(assistant)
  if (state.scopeToMessage.get(scope) === assistant.message.id) {
    state.scopeToMessage.delete(scope)
  }
}

type RequestResult = { ok: true } | { ok: false; retryAfterMs?: number }

type WorkerEvent = {
  payload: EventPayload
  is_compaction?: boolean
  agent_id?: string
}

export type InternalEvent = {
  event_id: string
  event_type: string
  payload: Record<string, unknown>
  event_metadata?: Record<string, unknown> | null
  is_compaction: boolean
  created_at: string
  agent_id?: string
}

type ListInternalEventsResponse = {
  data: InternalEvent[]
  next_cursor?: string
}

type WorkerStateResponse = {
  worker?: {
    external_metadata?: Record<string, unknown>
  }
}

/**
 * 管理 CCR v2 下的 worker 生命周期协议：
 * - epoch 管理：从 CLAUDE_CODE_WORKER_EPOCH 环境变量读取 worker_epoch
 * - 运行时状态上报：PUT /sessions/{id}/worker
 * - heartbeat：通过 POST /sessions/{id}/worker/heartbeat 做存活探测
 *
 * 所有写操作最终都会经过 this.request()。
 */
export class CCRClient {
  private workerEpoch = 0
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatJitterFraction: number
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatInFlight = false
  private closed = false
  private consecutiveAuthFailures = 0
  private currentState: SessionState | null = null
  private readonly sessionBaseUrl: string
  private readonly sessionId: string
  private readonly http = createAxiosInstance({ keepAlive: true })

  // stream_event 的延迟缓冲区。
  // 最多累积 STREAM_EVENT_FLUSH_INTERVAL_MS 后再统一 enqueue，
  // 既能减少 POST 次数，也能启用 text_delta 合并；整体模式与 HybridTransport 一致。
  private streamEventBuffer: SDKPartialAssistantMessage[] = []
  private streamEventTimer: ReturnType<typeof setTimeout> | null = null
  // “截至当前的完整文本”累加器。
  // 它会跨 flush 持续保留，使得每个发出的 text_delta 都带上从 block 起点到当前的完整文本，
  // 从而让中途重连也能拿到自包含快照。以 API message ID 为键，
  // 并在完整 assistant message 到达时由 writeEvent 清理。
  private streamTextAccumulator = createStreamAccumulator()

  private readonly workerState: WorkerStateUploader
  private readonly eventUploader: SerialBatchEventUploader<ClientEvent>
  private readonly internalEventUploader: SerialBatchEventUploader<WorkerEvent>
  private readonly deliveryUploader: SerialBatchEventUploader<{
    eventId: string
    status: 'received' | 'processing' | 'processed'
  }>

  /**
   * 当服务端返回 409 时调用，表示有更新的 worker epoch 已经取代当前实例。
   * 默认行为是 process.exit(1)，这对 spawn-mode 子进程是正确的，因为父 bridge 会重新拉起它。
   * 但 in-process 调用方（如 replBridge）必须覆写为优雅关闭，否则会直接把用户的 REPL 一起杀掉。
   */
  private readonly onEpochMismatch: () => never

  /**
   * auth header 的来源。
   * 默认使用进程级的 session-ingress token，也就是 CLAUDE_CODE_SESSION_ACCESS_TOKEN 环境变量。
   * 如果调用方需要同时管理多个带不同 JWT 的并发 session，就必须显式注入这一来源，
   * 因为环境变量路径是进程级全局状态，会在多个 session 之间互相覆盖。
   */
  private readonly getAuthHeaders: () => Record<string, string>

  constructor(
    transport: SSETransport,
    sessionUrl: URL,
    opts?: {
      onEpochMismatch?: () => never
      heartbeatIntervalMs?: number
      heartbeatJitterFraction?: number
      /**
       * 实例级的 auth header 来源。
       * 若省略，则读取进程级的 CLAUDE_CODE_SESSION_ACCESS_TOKEN，
       * 适用于单 session 调用方，如 REPL 或 daemon。
       * 并发多 session 调用方则必须提供。
       */
      getAuthHeaders?: () => Record<string, string>
    },
  ) {
    this.onEpochMismatch =
      opts?.onEpochMismatch ??
      (() => {
        // eslint-disable-next-line custom-rules/no-process-exit
        process.exit(1)
      })
    this.heartbeatIntervalMs =
      opts?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatJitterFraction = opts?.heartbeatJitterFraction ?? 0
    this.getAuthHeaders = opts?.getAuthHeaders ?? getSessionIngressAuthHeaders
    // session URL 形如：https://host/v1/code/sessions/{id}
    if (sessionUrl.protocol !== 'http:' && sessionUrl.protocol !== 'https:') {
      throw new Error(
        `CCRClient: Expected http(s) URL, got ${sessionUrl.protocol}`,
      )
    }
    const pathname = sessionUrl.pathname.replace(/\/$/, '')
    this.sessionBaseUrl = `${sessionUrl.protocol}//${sessionUrl.host}${pathname}`
    // 从 URL path 的最后一段提取 session ID。
    this.sessionId = pathname.split('/').pop() || ''

    this.workerState = new WorkerStateUploader({
      send: body =>
        this.request(
          'put',
          '/worker',
          { worker_epoch: this.workerEpoch, ...body },
          'PUT worker',
        ).then(r => r.ok),
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    this.eventUploader = new SerialBatchEventUploader<ClientEvent>({
      maxBatchSize: 100,
      maxBatchBytes: 10 * 1024 * 1024,
      // flushStreamEventBuffer() 会一次性把 100ms 窗口内累积的 stream_events 全部 enqueue。
      // 如果是一波无法折叠为单个 snapshot 的混合 delta，数量可能超过旧上限 50，
      // 并在 SerialBatchEventUploader 的 backpressure 检查上直接死锁。
      // 这里与 HybridTransport 保持一致，设成只作为内存上界使用的高值。
      maxQueueSize: 100_000,
      send: async batch => {
        const result = await this.request(
          'post',
          '/worker/events',
          { worker_epoch: this.workerEpoch, events: batch },
          'client events',
        )
        if (!result.ok) {
          throw new RetryableError(
            'client event POST failed',
            result.retryAfterMs,
          )
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    this.internalEventUploader = new SerialBatchEventUploader<WorkerEvent>({
      maxBatchSize: 100,
      maxBatchBytes: 10 * 1024 * 1024,
      maxQueueSize: 200,
      send: async batch => {
        const result = await this.request(
          'post',
          '/worker/internal-events',
          { worker_epoch: this.workerEpoch, events: batch },
          'internal events',
        )
        if (!result.ok) {
          throw new RetryableError(
            'internal event POST failed',
            result.retryAfterMs,
          )
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    this.deliveryUploader = new SerialBatchEventUploader<{
      eventId: string
      status: 'received' | 'processing' | 'processed'
    }>({
      maxBatchSize: 64,
      maxQueueSize: 64,
      send: async batch => {
        const result = await this.request(
          'post',
          '/worker/events/delivery',
          {
            worker_epoch: this.workerEpoch,
            updates: batch.map(d => ({
              event_id: d.eventId,
              status: d.status,
            })),
          },
          'delivery batch',
        )
        if (!result.ok) {
          throw new RetryableError('delivery POST failed', result.retryAfterMs)
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    // 对每个收到的 client_event 立即回 ack，这样 CCR 才能追踪投递状态。
    // 之所以在这里而不是 initialize() 中挂接，是为了保证 new CCRClient() 一返回回调就已经生效，
    // 使 remoteIO 可以立刻调用 transport.connect()，避免首个 SSE catch-up frame
    // 抢在 onEventCallback 接好之前到来。
    transport.setOnEvent((event: StreamClientEvent) => {
      this.reportDelivery(event.event_id, 'received')
    })
  }

  /**
   * 初始化 session worker：
   * 1. 优先使用传入的 worker_epoch，否则回退到 CLAUDE_CODE_WORKER_EPOCH
   *    （由 env-manager / bridge spawner 设置）
   * 2. 上报状态为 'idle'
   * 3. 启动 heartbeat 定时器
   *
   * in-process 调用方（如 replBridge）会直接传入 epoch，
   * 因为 worker 是它们自己注册的，并不存在父进程替它们设置环境变量。
   */
  async initialize(epoch?: number): Promise<Record<string, unknown> | null> {
    const startMs = Date.now()
    if (Object.keys(this.getAuthHeaders()).length === 0) {
      throw new CCRInitError('no_auth_headers')
    }
    if (epoch === undefined) {
      const rawEpoch = process.env.CLAUDE_CODE_WORKER_EPOCH
      epoch = rawEpoch ? parseInt(rawEpoch, 10) : NaN
    }
    if (isNaN(epoch)) {
      throw new CCRInitError('missing_epoch')
    }
    this.workerEpoch = epoch

    // 这一步与 init PUT 并发执行，双方互不依赖。
    const restoredPromise = this.getWorkerState()

    const result = await this.request(
      'put',
      '/worker',
      {
        worker_status: 'idle',
        worker_epoch: this.workerEpoch,
        // 清掉先前 worker 崩溃遗留的 pending_action/task_summary。
        // 仅在 session 内做的清理不会跨进程重启保留下来。
        external_metadata: {
          pending_action: null,
          task_summary: null,
        },
      },
      'PUT worker (init)',
    )
    if (!result.ok) {
      // 409 时 onEpochMismatch 可能抛错，但 request() 会吞掉并返回 false。
      // 如果这里不再额外检查，就会继续 startHeartbeat()，
      // 从而在一个已经失效的 epoch 上泄露出 20 秒定时器。
      // 因此必须显式抛错，让 connect() 走 rejection 分支而不是误入成功路径。
      throw new CCRInitError('worker_register_failed')
    }
    this.currentState = 'idle'
    this.startHeartbeat()

    // sessionActivity 的引用计数计时器会在 API 调用或工具执行期间触发；
    // 如果这段时间没有任何写入，容器租约可能在等待中途过期。
    // v1 是在 WebSocketTransport 的每个连接上单独接这条线。
    registerSessionActivityCallback(() => {
      void this.writeEvent({ type: 'keep_alive' })
    })

    logForDebugging(`CCRClient: initialized, epoch=${this.workerEpoch}`)
    logForDiagnosticsNoPII('info', 'cli_worker_lifecycle_initialized', {
      epoch: this.workerEpoch,
      duration_ms: Date.now() - startMs,
    })

    // 等并发 GET 完成后，在这里记录 state_restored，而且必须放在 PUT 成功之后。
    // 之前把日志打在 getWorkerState() 里会产生竞态：
    // 如果 GET 先成功而 PUT 后失败，同一个 session 会同时出现 init_failed 与 state_restored。
    const { metadata, durationMs } = await restoredPromise
    if (!this.closed) {
      logForDiagnosticsNoPII('info', 'cli_worker_state_restored', {
        duration_ms: durationMs,
        had_state: metadata !== null,
      })
    }
    return metadata
  }

  // control_requests 一旦被标记为 processed，重启后就不会再投递，
  // 所以这里需要回读上一任 worker 已经写下的内容。
  private async getWorkerState(): Promise<{
    metadata: Record<string, unknown> | null
    durationMs: number
  }> {
    const startMs = Date.now()
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) {
      return { metadata: null, durationMs: 0 }
    }
    const data = await this.getWithRetry<WorkerStateResponse>(
      `${this.sessionBaseUrl}/worker`,
      authHeaders,
      'worker_state',
    )
    return {
      metadata: data?.worker?.external_metadata ?? null,
      durationMs: Date.now() - startMs,
    }
  }

  /**
   * 向 CCR 发送带鉴权的 HTTP 请求。
   * 负责处理 auth headers、409 epoch mismatch 以及错误日志。
   * 2xx 时返回 { ok: true }。
   * 若收到 429，还会读取 Retry-After（整数秒），
   * 以便 uploader 采用服务端建议的退避时长，而不是盲目走指数退避。
   */
  private async request(
    method: 'post' | 'put',
    path: string,
    body: unknown,
    label: string,
    { timeout = 10_000 }: { timeout?: number } = {},
  ): Promise<RequestResult> {
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) return { ok: false }

    try {
      const response = await this.http[method](
        `${this.sessionBaseUrl}${path}`,
        body,
        {
          headers: {
            ...authHeaders,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'User-Agent': getClaudeCodeUserAgent(),
          },
          validateStatus: alwaysValidStatus,
          timeout,
        },
      )

      if (response.status >= 200 && response.status < 300) {
        this.consecutiveAuthFailures = 0
        return { ok: true }
      }
      if (response.status === 409) {
        this.handleEpochMismatch()
      }
      if (response.status === 401 || response.status === 403) {
        // 已过期 JWT 导致的 401 是确定性失败，任何重试都不会成功。
        // 因此先检查 token 自身的 exp，避免在阈值循环里白白消耗真实时间。
        const tok = getSessionIngressAuthToken()
        const exp = tok ? decodeJwtExpiry(tok) : null
        if (exp !== null && exp * 1000 < Date.now()) {
          logForDebugging(
            `CCRClient: session_token expired (exp=${new Date(exp * 1000).toISOString()}) — no refresh was delivered, exiting`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_worker_token_expired_no_refresh')
          this.onEpochMismatch()
        }
        // token 看起来仍然有效，但服务端返回 401，
        // 可能是 userauth 故障、KMS 抖动等服务端瞬时问题；这里把它计入阈值。
        this.consecutiveAuthFailures++
        if (this.consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
          logForDebugging(
            `CCRClient: ${this.consecutiveAuthFailures} consecutive auth failures with a valid-looking token — server-side auth unrecoverable, exiting`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_worker_auth_failures_exhausted')
          this.onEpochMismatch()
        }
      }
      logForDebugging(`CCRClient: ${label} returned ${response.status}`, {
        level: 'warn',
      })
      logForDiagnosticsNoPII('warn', 'cli_worker_request_failed', {
        method,
        path,
        status: response.status,
      })
      if (response.status === 429) {
        const raw = response.headers?.['retry-after']
        const seconds = typeof raw === 'string' ? parseInt(raw, 10) : NaN
        if (!isNaN(seconds) && seconds >= 0) {
          return { ok: false, retryAfterMs: seconds * 1000 }
        }
      }
      return { ok: false }
    } catch (error) {
      logForDebugging(`CCRClient: ${label} failed: ${errorMessage(error)}`, {
        level: 'warn',
      })
      logForDiagnosticsNoPII('warn', 'cli_worker_request_error', {
        method,
        path,
        error_code: getErrnoCode(error),
      })
      return { ok: false }
    }
  }

  /** 通过 PUT /sessions/{id}/worker 向 CCR 上报 worker state。 */
  reportState(state: SessionState, details?: RequiresActionDetails): void {
    if (state === this.currentState && !details) return
    this.currentState = state
    this.workerState.enqueue({
      worker_status: state,
      requires_action_details: details
        ? {
            tool_name: details.tool_name,
            action_description: details.action_description,
            request_id: details.request_id,
          }
        : null,
    })
  }

  /** 通过 PUT /worker 向 CCR 上报 external metadata。 */
  reportMetadata(metadata: Record<string, unknown>): void {
    this.workerState.enqueue({ external_metadata: metadata })
  }

  /**
   * 处理 epoch mismatch（409 Conflict）。
   * 说明有更新的 CC 实例已经替换掉当前实例，此时应立即退出。
   */
  private handleEpochMismatch(): never {
    logForDebugging('CCRClient: Epoch mismatch (409), shutting down', {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_worker_epoch_mismatch')
    this.onEpochMismatch()
  }

  /** 启动周期性 heartbeat。 */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    const schedule = (): void => {
      const jitter =
        this.heartbeatIntervalMs *
        this.heartbeatJitterFraction *
        (2 * Math.random() - 1)
      this.heartbeatTimer = setTimeout(tick, this.heartbeatIntervalMs + jitter)
    }
    const tick = (): void => {
      void this.sendHeartbeat()
      // stopHeartbeat 会把 timer 置空；
      // 因此要在 fire-and-forget 发送之后、重新调度之前检查一次，
      // 以确保 sendHeartbeat 期间发生的 close() 能被正确尊重。
      if (this.heartbeatTimer === null) return
      schedule()
    }
    schedule()
  }

  /** 停止 heartbeat 定时器。 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** 通过 POST /sessions/{id}/worker/heartbeat 发送 heartbeat。 */
  private async sendHeartbeat(): Promise<void> {
    if (this.heartbeatInFlight) return
    this.heartbeatInFlight = true
    try {
      const result = await this.request(
        'post',
        '/worker/heartbeat',
        { session_id: this.sessionId, worker_epoch: this.workerEpoch },
        'Heartbeat',
        { timeout: 5_000 },
      )
      if (result.ok) {
        logForDebugging('CCRClient: Heartbeat sent')
      }
    } finally {
      this.heartbeatInFlight = false
    }
  }

  /**
   * 通过 POST /sessions/{id}/worker/events 把 StdoutMessage 写成 client event。
   * 这些事件会通过 SSE stream 对前端客户端可见。
   * 若消息缺少 UUID，这里会自动注入，以确保重试时服务端幂等。
   *
   * stream_event 会先进入 100ms 延迟缓冲并做累积，
   * 同一个 content block 的 text_delta 会在每次 flush 时产出“截至当前的完整快照”。
   * 如果写入的是非 stream_event，则会先 flush 缓冲区，以保持下游顺序。
   */
  async writeEvent(message: StdoutMessage): Promise<void> {
    if (message.type === 'stream_event') {
      this.streamEventBuffer.push(message)
      if (!this.streamEventTimer) {
        this.streamEventTimer = setTimeout(
          () => void this.flushStreamEventBuffer(),
          STREAM_EVENT_FLUSH_INTERVAL_MS,
        )
      }
      return
    }
    await this.flushStreamEventBuffer()
    if (message.type === 'assistant') {
      clearStreamAccumulatorForMessage(this.streamTextAccumulator, message)
    }
    await this.eventUploader.enqueue(this.toClientEvent(message))
  }

  /** 把 StdoutMessage 包装成 ClientEvent；若缺 UUID，则在这里补上。 */
  private toClientEvent(message: StdoutMessage): ClientEvent {
    const msg = message as unknown as Record<string, unknown>
    return {
      payload: {
        ...msg,
        uuid: typeof msg.uuid === 'string' ? msg.uuid : randomUUID(),
      } as EventPayload,
    }
  }

  /**
   * 清空 stream_event 延迟缓冲区：
   * 把 text_delta 累积成“截至当前的完整快照”，清掉定时器，再把结果事件入队。
   * 它会从定时器回调、writeEvent 的非 stream 分支以及 flush() 中被调用。
   * close() 会直接丢弃该缓冲区，因此如果需要投递保证，应先调用 flush()。
   */
  private async flushStreamEventBuffer(): Promise<void> {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    if (this.streamEventBuffer.length === 0) return
    const buffered = this.streamEventBuffer
    this.streamEventBuffer = []
    const payloads = accumulateStreamEvents(
      buffered,
      this.streamTextAccumulator,
    )
    await this.eventUploader.enqueue(
      payloads.map(payload => ({ payload, ephemeral: true })),
    )
  }

  /**
   * 通过 POST /sessions/{id}/worker/internal-events 写入内部 worker 事件。
   * 这些事件不会暴露给前端客户端；它们承载 session 恢复所需的 worker 内部状态，
   * 例如 transcript 消息和 compaction 标记。
   */
  async writeInternalEvent(
    eventType: string,
    payload: Record<string, unknown>,
    {
      isCompaction = false,
      agentId,
    }: {
      isCompaction?: boolean
      agentId?: string
    } = {},
  ): Promise<void> {
    const event: WorkerEvent = {
      payload: {
        type: eventType,
        ...payload,
        uuid: typeof payload.uuid === 'string' ? payload.uuid : randomUUID(),
      } as EventPayload,
      ...(isCompaction && { is_compaction: true }),
      ...(agentId && { agent_id: agentId }),
    }
    await this.internalEventUploader.enqueue(event)
  }

  /**
   * flush 尚未发送的 internal events。
   * 应在 turn 间隙和 shutdown 时调用，以确保 transcript 条目已经持久化。
   */
  flushInternalEvents(): Promise<void> {
    return this.internalEventUploader.flush()
  }

  /**
   * flush 尚未发送的 client events（即 writeEvent 队列）。
   * 当调用方需要投递确认时，应在 close() 前显式调用，因为 close() 会放弃该队列。
   * 一旦 uploader drain 完成或 reject 就会 resolve；
   * 至于单个 POST 是否实际成功，需要另外查询服务端状态。
   */
  async flush(): Promise<void> {
    await this.flushStreamEventBuffer()
    return this.eventUploader.flush()
  }

  /**
   * 从 GET /sessions/{id}/worker/internal-events 读取前台 agent 的内部事件。
   * 成功时返回从最近 compaction 边界开始的 transcript 条目；失败时返回 null。
   * 用于 session 恢复。
   */
  async readInternalEvents(): Promise<InternalEvent[] | null> {
    return this.paginatedGet('/worker/internal-events', {}, 'internal_events')
  }

  /**
   * 从 GET /sessions/{id}/worker/internal-events?subagents=true
   * 读取所有 subagent 的内部事件。
   * 返回的是所有非前台 agent 的合并流，每个 agent 都从自己的 compaction 点开始。
   * 用于 session 恢复。
   */
  async readSubagentInternalEvents(): Promise<InternalEvent[] | null> {
    return this.paginatedGet(
      '/worker/internal-events',
      { subagents: 'true' },
      'subagent_events',
    )
  }

  /**
   * 带重试的分页 GET。
   * 会从列表端点拉取全部分页，并在单页失败时按指数退避 + jitter 进行重试。
   */
  private async paginatedGet(
    path: string,
    params: Record<string, string>,
    context: string,
  ): Promise<InternalEvent[] | null> {
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) return null

    const allEvents: InternalEvent[] = []
    let cursor: string | undefined

    do {
      const url = new URL(`${this.sessionBaseUrl}${path}`)
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v)
      }
      if (cursor) {
        url.searchParams.set('cursor', cursor)
      }

      const page = await this.getWithRetry<ListInternalEventsResponse>(
        url.toString(),
        authHeaders,
        context,
      )
      if (!page) return null

      allEvents.push(...(page.data ?? []))
      cursor = page.next_cursor
    } while (cursor)

    logForDebugging(
      `CCRClient: Read ${allEvents.length} internal events from ${path}${params.subagents ? ' (subagents)' : ''}`,
    )
    return allEvents
  }

  /**
   * 单次 GET 请求的重试封装。
   * 成功时返回解析后的响应体；如果所有重试都耗尽，则返回 null。
   */
  private async getWithRetry<T>(
    url: string,
    authHeaders: Record<string, string>,
    context: string,
  ): Promise<T | null> {
    for (let attempt = 1; attempt <= 10; attempt++) {
      let response
      try {
        response = await this.http.get<T>(url, {
          headers: {
            ...authHeaders,
            'anthropic-version': '2023-06-01',
            'User-Agent': getClaudeCodeUserAgent(),
          },
          validateStatus: alwaysValidStatus,
          timeout: 30_000,
        })
      } catch (error) {
        logForDebugging(
          `CCRClient: GET ${url} failed (attempt ${attempt}/10): ${errorMessage(error)}`,
          { level: 'warn' },
        )
        if (attempt < 10) {
          const delay =
            Math.min(500 * 2 ** (attempt - 1), 30_000) + Math.random() * 500
          await sleep(delay)
        }
        continue
      }

      if (response.status >= 200 && response.status < 300) {
        return response.data
      }
      if (response.status === 409) {
        this.handleEpochMismatch()
      }
      logForDebugging(
        `CCRClient: GET ${url} returned ${response.status} (attempt ${attempt}/10)`,
        { level: 'warn' },
      )

      if (attempt < 10) {
        const delay =
          Math.min(500 * 2 ** (attempt - 1), 30_000) + Math.random() * 500
        await sleep(delay)
      }
    }

    logForDebugging('CCRClient: GET retries exhausted', { level: 'error' })
    logForDiagnosticsNoPII('error', 'cli_worker_get_retries_exhausted', {
      context,
    })
    return null
  }

  /**
   * 上报 client-to-worker 事件的投递状态。
   * 通过 POST /v1/code/sessions/{id}/worker/events/delivery 这个 batch endpoint 完成。
   */
  reportDelivery(
    eventId: string,
    status: 'received' | 'processing' | 'processed',
  ): void {
    void this.deliveryUploader.enqueue({ eventId, status })
  }

  /** 获取当前 epoch，供外部使用。 */
  getWorkerEpoch(): number {
    return this.workerEpoch
  }

  /** internal-event 队列深度，可作为 shutdown snapshot 的 backpressure 信号。 */
  get internalEventsPending(): number {
    return this.internalEventUploader.pendingCount
  }

  /** 清理所有 uploader 与定时器。 */
  close(): void {
    this.closed = true
    this.stopHeartbeat()
    unregisterSessionActivityCallback()
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    this.streamEventBuffer = []
    this.streamTextAccumulator.byMessage.clear()
    this.streamTextAccumulator.scopeToMessage.clear()
    this.workerState.close()
    this.eventUploader.close()
    this.internalEventUploader.close()
    this.deliveryUploader.close()
  }
}
