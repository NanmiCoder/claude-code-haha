// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * Env-less Remote Control bridge 核心实现。
 *
 * “Env-less” 表示没有 Environments API 层。这与 “CCR v2”
 * （/worker/* transport 协议）不同，基于 env 的路径（replBridge.ts）也可以
 * 通过 CLAUDE_CODE_USE_CCR_V2 使用 CCR v2 transport。这个文件关注的是移除
 * poll/dispatch 层，而不是底层 transport 协议选哪一种。
 *
 * 与 initBridgeCore（基于 env，约 2400 行）不同，它会绕过 Environments API
 * 的 work-dispatch 层，直接连接到 session-ingress 层：
 *
 *   1. POST /v1/code/sessions              (OAuth, no env_id)  → session.id
 *   2. POST /v1/code/sessions/{id}/bridge  (OAuth)             → {worker_jwt, expires_in, api_base_url, worker_epoch}
 *      每次 /bridge 调用都会递增 epoch，它本身就是注册动作，不再需要单独的 /worker/register。
 *   3. createV2ReplTransport(worker_jwt, worker_epoch)         → SSE + CCRClient
 *   4. createTokenRefreshScheduler                             → 主动再次调用 /bridge（新的 JWT + 新的 epoch）
 *   5. 401 on SSE → rebuild transport with fresh /bridge credentials (same seq-num)
 *
 * 不再有 register/poll/ack/stop/heartbeat/deregister 这套 environment 生命周期。
 * 历史上之所以需要 Environments API，是因为 CCR 的 /worker/* endpoint 需要一个
 * 带 session_id+role=worker 的 JWT，而这只能由 work-dispatch 层签发。
 * 服务端 PR #292605（后在 #293280 中更名）新增了 /bridge endpoint，允许直接把
 * OAuth 换成 worker_jwt，从而使 env 层对 REPL session 来说变成可选。
 *
 * 由 initReplBridge.ts 中的 `tengu_bridge_repl_v2` GrowthBook flag 控制。
 * 仅用于 REPL，daemon/print 仍保持基于 env 的实现。
 */

import { feature } from 'bun:bundle'
import axios from 'axios'
import {
  createV2ReplTransport,
  type ReplBridgeTransport,
} from './replBridgeTransport.js'
import { buildCCRv2SdkUrl } from './workSecret.js'
import { toCompatSessionId } from './sessionIdCompat.js'
import { FlushGate } from './flushGate.js'
import { createTokenRefreshScheduler } from './jwtUtils.js'
import { getTrustedDeviceToken } from './trustedDevice.js'
import {
  getEnvLessBridgeConfig,
  type EnvLessBridgeConfig,
} from './envLessBridgeConfig.js'
import {
  handleIngressMessage,
  handleServerControlRequest,
  makeResultMessage,
  isEligibleBridgeMessage,
  extractTitleText,
  BoundedUUIDSet,
} from './bridgeMessaging.js'
import { logBridgeSkip } from './debugUtils.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { isInProtectedNamespace } from '../utils/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { sleep } from '../utils/sleep.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ReplBridgeHandle, BridgeState } from './replBridge.js'
import type { Message } from '../types/message.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'

const ANTHROPIC_VERSION = '2023-06-01'

// 用于 ws_connected 的遥测区分字段。'initial' 是默认值，且不会传给
// rebuildTransport（它只能在初始化后调用）；用 Exclude<> 可以在两个签名上
// 显式表达这一约束。
type ConnectCause = 'initial' | 'proactive_refresh' | 'auth_401_recovery'

function oauthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

export type EnvLessBridgeParams = {
  baseUrl: string
  orgUUID: string
  title: string
  getAccessToken: () => string | undefined
  onAuth401?: (staleAccessToken: string) => Promise<boolean>
  /**
    * 将内部的 Message[] 转成 SDKMessage[]，供 writeMessages() 以及
    * initial-flush/drain 路径使用。以注入方式提供而非直接导入，
    * 因为 mappers.ts 会传递引入 src/commands.ts（整套 command registry + React tree），
    * 从而让本来不需要这些内容的 bundle 变胖。
   */
  toSDKMessages: (messages: Message[]) => SDKMessage[]
  initialHistoryCap: number
  initialMessages?: Message[]
  onInboundMessage?: (msg: SDKMessage) => void | Promise<void>
  /**
   * Fired on each title-worthy user message seen in writeMessages() until
   * the callback returns true (done). Mirrors replBridge.ts's onUserMessage —
   * caller derives a title and PATCHes /v1/sessions/{id} so auto-started
   * sessions don't stay at the generic fallback. The caller owns the
   * derive-at-count-1-and-3 policy; the transport just keeps calling until
   * told to stop. sessionId is the raw cse_* — updateBridgeSessionTitle
   * retags internally.
   */
  onUserMessage?: (text: string, sessionId: string) => boolean
  onPermissionResponse?: (response: SDKControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: BridgeState, detail?: string) => void
  /**
   * 为 true 时，跳过打开 SSE 读流，只启用 CCRClient 的写路径。
   * 该参数会一路传到 createV2ReplTransport 和 handleServerControlRequest。
   */
  outboundOnly?: boolean
  /** 用于 session 分类的自由标签（例如 ['ccr-mirror']）。 */
  tags?: string[]
}

/**
 * 创建 session，获取 worker JWT，并连接 v2 transport。
 *
 * 任何前置步骤失败（session 创建失败、/bridge 失败、transport 初始化失败）
 * 都会返回 null。调用方（initReplBridge）会把它呈现为通用的
 * “initialization failed” 状态。
 */
export async function initEnvLessBridgeCore(
  params: EnvLessBridgeParams,
): Promise<ReplBridgeHandle | null> {
  const {
    baseUrl,
    orgUUID,
    title,
    getAccessToken,
    onAuth401,
    toSDKMessages,
    initialHistoryCap,
    initialMessages,
    onInboundMessage,
    onUserMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    outboundOnly,
    tags,
  } = params

  const cfg = await getEnvLessBridgeConfig()

  // ── 1. 创建 session（POST /v1/code/sessions，无 env_id） ───────────────
  const accessToken = getAccessToken()
  if (!accessToken) {
    logForDebugging('[remote-bridge] No OAuth token')
    return null
  }

  const createdSessionId = await withRetry(
    () =>
      createCodeSession(baseUrl, accessToken, title, cfg.http_timeout_ms, tags),
    'createCodeSession',
    cfg,
  )
  if (!createdSessionId) {
    onStateChange?.('failed', 'Session creation failed — see debug log')
    logBridgeSkip('v2_session_create_failed', undefined, true)
    return null
  }
  const sessionId: string = createdSessionId
  logForDebugging(`[remote-bridge] Created session ${sessionId}`)
  logForDiagnosticsNoPII('info', 'bridge_repl_v2_session_created')

  // ── 2. 获取 bridge 凭据（POST /bridge → worker_jwt、expires_in、api_base_url） ──
  const credentials = await withRetry(
    () =>
      fetchRemoteCredentials(
        sessionId,
        baseUrl,
        accessToken,
        cfg.http_timeout_ms,
      ),
    'fetchRemoteCredentials',
    cfg,
  )
  if (!credentials) {
    onStateChange?.('failed', 'Remote credentials fetch failed — see debug log')
    logBridgeSkip('v2_remote_creds_failed', undefined, true)
    void archiveSession(
      sessionId,
      baseUrl,
      accessToken,
      orgUUID,
      cfg.http_timeout_ms,
    )
    return null
  }
  logForDebugging(
    `[remote-bridge] Fetched bridge credentials (expires_in=${credentials.expires_in}s)`,
  )

  // ── 3. 构建 v2 transport（SSETransport + CCRClient） ────────────────────
  const sessionUrl = buildCCRv2SdkUrl(credentials.api_base_url, sessionId)
  logForDebugging(`[remote-bridge] v2 session URL: ${sessionUrl}`)

  let transport: ReplBridgeTransport
  try {
    transport = await createV2ReplTransport({
      sessionUrl,
      ingressToken: credentials.worker_jwt,
      sessionId,
      epoch: credentials.worker_epoch,
      heartbeatIntervalMs: cfg.heartbeat_interval_ms,
      heartbeatJitterFraction: cfg.heartbeat_jitter_fraction,
      // 每实例闭包，避免把 worker JWT 放进
      // process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN。mcp/client.ts 会不加门控地
      // 读取它，否则会把该 token 发给用户配置的 ws/http MCP server。
      // 在构造时固定是正确的，因为刷新时 transport 会被完整重建
      // （见下方 rebuildTransport）。
      getAuthToken: () => credentials.worker_jwt,
      outboundOnly,
    })
  } catch (err) {
    logForDebugging(
      `[remote-bridge] v2 transport setup failed: ${errorMessage(err)}`,
      { level: 'error' },
    )
    onStateChange?.('failed', `Transport setup failed: ${errorMessage(err)}`)
    logBridgeSkip('v2_transport_setup_failed', undefined, true)
    void archiveSession(
      sessionId,
      baseUrl,
      accessToken,
      orgUUID,
      cfg.http_timeout_ms,
    )
    return null
  }
  logForDebugging(
    `[remote-bridge] v2 transport created (epoch=${credentials.worker_epoch})`,
  )
  onStateChange?.('ready')

  // ── 4. 状态 ────────────────────────────────────────────────────────────

  // Echo 去重：我们通过 POST 发出的消息会从读流里再回来。
  // 用初始消息 UUID 为集合打底，这样服务端对已 flush 历史的回显也能识别。
  // 两个集合都会覆盖初始 UUID。recentPostedUUIDs 是 2000 容量的环形缓冲区，
  // 活跃写入足够多时可能驱逐它们；initialMessageUUIDs 则是无界兜底集合。
  // 这是防御性设计，与 replBridge.ts 保持一致。
  const recentPostedUUIDs = new BoundedUUIDSet(cfg.uuid_dedup_buffer_size)
  const initialMessageUUIDs = new Set<string>()
  if (initialMessages) {
    for (const msg of initialMessages) {
      initialMessageUUIDs.add(msg.uuid)
      recentPostedUUIDs.add(msg.uuid)
    }
  }

  // 对重复投递的 inbound prompt 做防御性去重
  // （seq-num 协商边缘情况、transport 切换后的服务端历史重放）。
  const recentInboundUUIDs = new BoundedUUIDSet(cfg.uuid_dedup_buffer_size)

  // FlushGate：当历史 flush 的 POST 正在进行中时，把实时写入先排队，
  // 这样服务端就能按 [history..., live...] 的顺序接收。
  const flushGate = new FlushGate<Message>()

  let initialFlushDone = false
  let tornDown = false
  let authRecoveryInFlight = false
  // onUserMessage 的锁存器。当回调返回 true 时翻转为 true
  //（策略层表示“派生已完成”）。sessionId 是常量
  //（不存在重建 session 的路径，rebuildTransport 只会替换 JWT/epoch，session 不变），
  // 因此无需重置。
  let userMessageCallbackDone = !onUserMessage

  // 遥测：onConnect 是因何触发？由 rebuildTransport 在
  // wireTransportCallbacks 之前设置，onConnect 异步读取。
  // 之所以没有竞态，是因为 authRecoveryInFlight 会串行化 rebuild 调用方，
  // 而新一次 initEnvLessBridgeCore() 会拿到默认值为 'initial' 的新闭包。
  let connectCause: ConnectCause = 'initial'

  // transport.connect() 之后等待 onConnect 的截止时间。会在 onConnect
  // （连接成功）和 onClose（收到了 close，不是静默）时清除。
  // 如果在 cfg.connect_timeout_ms 之前两者都没触发，就由 onConnectTimeout 发信号，
  // 这是 `started → （沉默）` 缺口的唯一观测点。
  let connectDeadline: ReturnType<typeof setTimeout> | undefined
  function onConnectTimeout(cause: ConnectCause): void {
    if (tornDown) return
    logEvent('tengu_bridge_repl_connect_timeout', {
      v2: true,
      elapsed_ms: cfg.connect_timeout_ms,
      cause:
        cause as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // ── 5. JWT 刷新调度器 ────────────────────────────────────────────
  // 根据 response.expires_in，在过期前 5 分钟安排一次回调。
  // 触发后用 OAuth 重新获取 /bridge，再用新凭据重建 transport。
  // 每次 /bridge 调用都会在服务端递增 epoch，因此如果只替换 JWT，旧 CCRClient
  // 就会继续带着陈旧 epoch 发 heartbeat，并在 20 秒内收到 409。
  // JWT 是不透明值，不要解码。
  const refresh = createTokenRefreshScheduler({
    refreshBufferMs: cfg.token_refresh_buffer_ms,
    getAccessToken: async () => {
      // 调用 /bridge 前无条件刷新 OAuth。getAccessToken() 会把已过期 token
      // 也当作非 null 字符串返回（不检查 expiresAt），因此“有值”并不等于“有效”。
      // 把陈旧 token 传给 onAuth401，这样 handleOAuth401Error 的 keychain 比较逻辑
      // 就能检测到并行刷新。
      const stale = getAccessToken()
      if (onAuth401) await onAuth401(stale ?? '')
      return getAccessToken() ?? stale
    },
    onRefresh: (sid, oauthToken) => {
      void (async () => {
        // 笔记本唤醒时，逾期的主动刷新 timer 和 SSE 401 可能几乎同时触发。
        // 必须在拉取 /bridge 之前先占住这个标志，才能让另一条路径彻底跳过，
        // 防止 epoch 被重复递增（每次 /bridge 都会 bump；如果两边都去 fetch，
        // 第一次 rebuild 拿到的 epoch 反而会变陈旧，并收到 409）。
        if (authRecoveryInFlight || tornDown) {
          logForDebugging(
            '[remote-bridge] Recovery already in flight, skipping proactive refresh',
          )
          return
        }
        authRecoveryInFlight = true
        try {
          const fresh = await withRetry(
            () =>
              fetchRemoteCredentials(
                sid,
                baseUrl,
                oauthToken,
                cfg.http_timeout_ms,
              ),
            'fetchRemoteCredentials (proactive)',
            cfg,
          )
          if (!fresh || tornDown) return
          await rebuildTransport(fresh, 'proactive_refresh')
          logForDebugging(
            '[remote-bridge] Transport rebuilt (proactive refresh)',
          )
        } catch (err) {
          logForDebugging(
            `[remote-bridge] Proactive refresh rebuild failed: ${errorMessage(err)}`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII(
            'error',
            'bridge_repl_v2_proactive_refresh_failed',
          )
          if (!tornDown) {
            onStateChange?.('failed', `Refresh failed: ${errorMessage(err)}`)
          }
        } finally {
          authRecoveryInFlight = false
        }
      })()
    },
    label: 'remote',
  })
  refresh.scheduleFromExpiresIn(sessionId, credentials.expires_in)

  // ── 6. 接线回调（抽出来以便 transport 重建时重新绑定） ──────
  function wireTransportCallbacks(): void {
    transport.setOnConnect(() => {
      clearTimeout(connectDeadline)
      logForDebugging('[remote-bridge] v2 transport connected')
      logForDiagnosticsNoPII('info', 'bridge_repl_v2_transport_connected')
      logEvent('tengu_bridge_repl_ws_connected', {
        v2: true,
        cause:
          connectCause as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      if (!initialFlushDone && initialMessages && initialMessages.length > 0) {
        initialFlushDone = true
        // 捕获当前 transport。如果在 flush 中途发生 401/teardown，
        // 过期的 .finally() 绝不能去排空 gate 或宣告 connected。
        // （与 replBridge.ts:1119 使用同一防护模式。）
        const flushTransport = transport
        void flushHistory(initialMessages)
          .catch(e =>
            logForDebugging(`[remote-bridge] flushHistory failed: ${e}`),
          )
          .finally(() => {
            // authRecoveryInFlight 用来捕获 v1/v2 的不对称行为：v1 会在 setOnClose
            // 中同步把 transport 置空（replBridge.ts:1175），因此
            // transport !== flushTransport 会立刻成立。v2 不会置空，只有在
            // rebuildTransport:346 处、经历 3 个 await 之后才会重新赋值。
            // authRecoveryInFlight 会在 rebuildTransport 入口同步置位。
            if (
              transport !== flushTransport ||
              tornDown ||
              authRecoveryInFlight
            ) {
              return
            }
            drainFlushGate()
            onStateChange?.('connected')
          })
      } else if (!flushGate.active) {
        onStateChange?.('connected')
      }
    })

    transport.setOnData((data: string) => {
      handleIngressMessage(
        data,
        recentPostedUUIDs,
        recentInboundUUIDs,
        onInboundMessage,
        // 远端客户端已经回答了权限提示，当前轮次应恢复运行。
        // 没有这个状态推进，服务端会一直停留在 requires_action，直到下一条用户消息
        // 或本轮结束结果到来。
        onPermissionResponse
          ? res => {
              transport.reportState('running')
              onPermissionResponse(res)
            }
          : undefined,
        req =>
          handleServerControlRequest(req, {
            transport,
            sessionId,
            onInterrupt,
            onSetModel,
            onSetMaxThinkingTokens,
            onSetPermissionMode,
            outboundOnly,
          }),
      )
    })

    transport.setOnClose((code?: number) => {
      clearTimeout(connectDeadline)
      if (tornDown) return
      logForDebugging(`[remote-bridge] v2 transport closed (code=${code})`)
      logEvent('tengu_bridge_repl_ws_closed', { code, v2: true })
      // onClose 只会在终局性故障时触发：401（JWT 无效）、4090（CCR epoch 不匹配）、
      // 4091（CCR 初始化失败），或 SSE 10 分钟重连预算耗尽。
      // 短暂断连会在 SSETransport 内部透明处理。401 还可恢复
      // （重新取 JWT 并重建 transport）；其余 code 都是死路。
      if (code === 401 && !authRecoveryInFlight) {
        void recoverFromAuthFailure()
        return
      }
      onStateChange?.('failed', `Transport closed (code ${code})`)
    })
  }

  // ── 7. Transport 重建（供主动刷新与 401 恢复共用） ──
  // 每次 /bridge 调用都会在服务端 bump epoch，因此两条刷新路径都必须用新 epoch
  // 重建 transport。只换 JWT 会让旧 CCRClient 继续用陈旧 epoch 发 heartbeat，
  // 从而收到 409。SSE 会从旧 transport 的最高 seq-num 恢复，因此不会触发服务端重放。
  // 调用方必须在调用前就把 authRecoveryInFlight = true 同步置位
  // （在任何 await 之前），并在 finally 中清除。
  // 这个函数本身不负责管理该标志，因为如果放到这里才设置，就已经来不及阻止
  // /bridge 被重复拉取了，而每次拉取都会 bump epoch。
  async function rebuildTransport(
    fresh: RemoteCredentials,
    cause: Exclude<ConnectCause, 'initial'>,
  ): Promise<void> {
    connectCause = cause
    // 在重建期间把写入先排队。一旦 /bridge 返回，旧 transport 的 epoch 就过期了，
    // 它的下一次 write/heartbeat 会得到 409。没有这个 gate 时，writeMessages 会先把
    // UUID 放进 recentPostedUUIDs，随后 writeBatch 在 409 后因 uploader 已关闭而
    // 静默 no-op，最终造成永久性的静默消息丢失。
    flushGate.start()
    try {
      const seq = transport.getLastSequenceNum()
      transport.close()
      transport = await createV2ReplTransport({
        sessionUrl: buildCCRv2SdkUrl(fresh.api_base_url, sessionId),
        ingressToken: fresh.worker_jwt,
        sessionId,
        epoch: fresh.worker_epoch,
        heartbeatIntervalMs: cfg.heartbeat_interval_ms,
        heartbeatJitterFraction: cfg.heartbeat_jitter_fraction,
        initialSequenceNum: seq,
        getAuthToken: () => fresh.worker_jwt,
        outboundOnly,
      })
      if (tornDown) {
        // teardown 在异步 createV2ReplTransport 窗口期间发生了。
        // 不要再绑定/连接/调度，否则会在 cancelAll() 之后重新挂上 timer，
        // 并把 onInboundMessage 发到一个已经 teardown 的 bridge 上。
        transport.close()
        return
      }
      wireTransportCallbacks()
      transport.connect()
      connectDeadline = setTimeout(
        onConnectTimeout,
        cfg.connect_timeout_ms,
        connectCause,
      )
      refresh.scheduleFromExpiresIn(sessionId, fresh.expires_in)
      // 把排队中的写入排空到新的 uploader。它会在 ccr.initialize() resolve 前运行
      // （transport.connect() 是 fire-and-forget），但 uploader 会串行排在初始
      // PUT /worker 之后。如果初始化失败（4091），这些事件会丢失，但只有
      // 每实例的 recentPostedUUIDs 被填充，因此重新启用 bridge 时仍会再次 flush。
      drainFlushGate()
    } finally {
      // 失败路径下也要结束 gate。成功路径已经由 drainFlushGate 结束了它。
      // 这里排队中的消息会被丢弃（因为 transport 仍然是死的）。
      flushGate.drop()
    }
  }

  // ── 8. 401 恢复（OAuth 刷新 + 重建） ───────────────────────────
  async function recoverFromAuthFailure(): Promise<void> {
    // setOnClose 虽然已检查 `!authRecoveryInFlight`，但这次检查与置位动作
    // 必须相对于 onRefresh 原子化，因此要在任何 await 之前同步抢占。
    // 笔记本唤醒时两条路径大约会同时触发。
    if (authRecoveryInFlight) return
    authRecoveryInFlight = true
    onStateChange?.('reconnecting', 'JWT expired — refreshing')
    logForDebugging('[remote-bridge] 401 on SSE — attempting JWT refresh')
    try {
      // 无条件尝试刷新 OAuth。getAccessToken() 会把过期 token 也作为非 null 字符串返回，
      // 因此 !oauthToken 并不能判断是否过期。把陈旧 token 传过去，
      // 以便 handleOAuth401Error 的 keychain 比较逻辑检测是否已有其他标签页完成刷新。
      const stale = getAccessToken()
      if (onAuth401) await onAuth401(stale ?? '')
      const oauthToken = getAccessToken() ?? stale
      if (!oauthToken || tornDown) {
        if (!tornDown) {
          onStateChange?.('failed', 'JWT refresh failed: no OAuth token')
        }
        return
      }

      const fresh = await withRetry(
        () =>
          fetchRemoteCredentials(
            sessionId,
            baseUrl,
            oauthToken,
            cfg.http_timeout_ms,
          ),
        'fetchRemoteCredentials (recovery)',
        cfg,
      )
      if (!fresh || tornDown) {
        if (!tornDown) {
          onStateChange?.('failed', 'JWT refresh failed after 401')
        }
        return
      }
      // 如果 401 打断了初始 flush，writeBatch 可能已经在关闭的 uploader 上静默 no-op
      // （ccr.close() 在我们的 setOnClose 回调之前就已由 SSE wrapper 执行）。
      // 这里重置标记，让新的 onConnect 再次执行 flush。
      // （v1 把 initialFlushDone 放在每个 transport 的闭包内，见 replBridge.ts:1027，
      // 因此会自然重置；v2 则把它放在外层作用域。）
      initialFlushDone = false
      await rebuildTransport(fresh, 'auth_401_recovery')
      logForDebugging('[remote-bridge] Transport rebuilt after 401')
    } catch (err) {
      logForDebugging(
        `[remote-bridge] 401 recovery failed: ${errorMessage(err)}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'bridge_repl_v2_jwt_refresh_failed')
      if (!tornDown) {
        onStateChange?.('failed', `JWT refresh failed: ${errorMessage(err)}`)
      }
    } finally {
      authRecoveryInFlight = false
    }
  }

  wireTransportCallbacks()

  // 在 connect 之前先启动 flushGate，这样握手期间的 writeMessages() 会先入队，
  // 而不是去和历史 POST 抢跑。
  if (initialMessages && initialMessages.length > 0) {
    flushGate.start()
  }
  transport.connect()
  connectDeadline = setTimeout(
    onConnectTimeout,
    cfg.connect_timeout_ms,
    connectCause,
  )

  // ── 8. 历史 flush 与 drain 辅助逻辑 ────────────────────────────────────
  function drainFlushGate(): void {
    const msgs = flushGate.end()
    if (msgs.length === 0) return
    for (const msg of msgs) recentPostedUUIDs.add(msg.uuid)
    const events = toSDKMessages(msgs).map(m => ({
      ...m,
      session_id: sessionId,
    }))
    if (msgs.some(m => m.type === 'user')) {
      transport.reportState('running')
    }
    logForDebugging(
      `[remote-bridge] Drained ${msgs.length} queued message(s) after flush`,
    )
    void transport.writeBatch(events)
  }

  async function flushHistory(msgs: Message[]): Promise<void> {
    // v2 总是创建全新的服务端 session（见上方无条件 createCodeSession），
    // 不存在 session 复用，也就没有重复投递风险。与 v1 不同，这里不按
    // previouslyFlushedUUIDs 过滤，因为那个集合会跨 REPL 启用/禁用周期持久存在
    // （通过 useRef），从而在重新启用时错误地把历史全部抑制掉。
    const eligible = msgs.filter(isEligibleBridgeMessage)
    const capped =
      initialHistoryCap > 0 && eligible.length > initialHistoryCap
        ? eligible.slice(-initialHistoryCap)
        : eligible
    if (capped.length < eligible.length) {
      logForDebugging(
        `[remote-bridge] Capped initial flush: ${eligible.length} -> ${capped.length} (cap=${initialHistoryCap})`,
      )
    }
    const events = toSDKMessages(capped).map(m => ({
      ...m,
      session_id: sessionId,
    }))
    if (events.length === 0) return
    // 在轮次中途初始化：如果某次 query 进行中启用了 Remote Control，最后一条
    // eligible 消息会是 user prompt 或 tool_result（两者的类型都是 'user'）。
    // 若不在这里推进状态，init PUT 的 'idle' 就会一直保持到下一条 user 类型消息通过
    // writeMessages 转发为止；而对于纯文本轮次，这种下一条消息根本不会出现
    // （初始化后只会流出 assistant chunk）。这里检查的是 eligible（cap 之前），
    // 不是 capped，因为 cap 可能把结果截断成 user 消息，即便实际尾部消息是 assistant。
    if (eligible.at(-1)?.type === 'user') {
      transport.reportState('running')
    }
    logForDebugging(`[remote-bridge] Flushing ${events.length} history events`)
    await transport.writeBatch(events)
  }

  // ── 9. Teardown ───────────────────────────────────────────────────────────
  // 在 SIGINT/SIGTERM/exit 时，gracefulShutdown 会让 runCleanupFunctions()
  // 与 2 秒上限竞速，超时后 forceExit 直接杀进程。因此预算必须这样分配：
  //   - archive: teardown_archive_timeout_ms (default 1500, cap 2000)
  //   - result write: fire-and-forget，利用 archive 延迟覆盖排空时间
  //   - 401 retry: 只有首次 archive 返回 401 时才做，且共用同一预算
  async function teardown(): Promise<void> {
    if (tornDown) return
    tornDown = true
    refresh.cancelAll()
    clearTimeout(connectDeadline)
    flushGate.drop()

    // 在 archive 之前先发出 result 消息。transport.write() 只会等待 enqueue 完成
    // （SerialBatchEventUploader 在入缓冲后就 resolve，真正排空是异步的）。
    // 先 archive 再 close() 能给 uploader 的 drain loop 留出一个窗口
    // （典型 archive 大约 100-500ms），从而无需显式 sleep 就能把 result POST 出去。
    // close() 会把 closed=true，导致 drain 在下一次 while 检查时被打断，
    // 因此如果先 close 再 archive，result 就会丢失。
    transport.reportState('idle')
    void transport.write(makeResultMessage(sessionId))

    let token = getAccessToken()
    let status = await archiveSession(
      sessionId,
      baseUrl,
      token,
      orgUUID,
      cfg.teardown_archive_timeout_ms,
    )

    // token 通常是新的（刷新调度器会在过期前 5 分钟运行），但如果电脑在刷新窗口后唤醒，
    // getAccessToken() 仍可能返回一个陈旧字符串。遇到 401 时只重试一次。
    // onAuth401（即 handleOAuth401Error）会清 keychain 缓存并强制刷新。
    // 在正常路径上不主动刷新，因为 handleOAuth401Error 即使面对有效 token 也会强制刷新，
    // 99% 的时候那只是浪费预算。这里的 try/catch 与 recoverFromAuthFailure 对齐：
    // keychain 读取可能抛错（例如 macOS 唤醒后仍锁定）；如果不捕获，后续
    // transport.close 和遥测都会被跳过。
    if (status === 401 && onAuth401) {
      try {
        await onAuth401(token ?? '')
        token = getAccessToken()
        status = await archiveSession(
          sessionId,
          baseUrl,
          token,
          orgUUID,
          cfg.teardown_archive_timeout_ms,
        )
      } catch (err) {
        logForDebugging(
          `[remote-bridge] Teardown 401 retry threw: ${errorMessage(err)}`,
          { level: 'error' },
        )
      }
    }

    transport.close()

    const archiveStatus: ArchiveTelemetryStatus =
      status === 'no_token'
        ? 'skipped_no_token'
        : status === 'timeout' || status === 'error'
          ? 'network_error'
          : status >= 500
            ? 'server_5xx'
            : status >= 400
              ? 'server_4xx'
              : 'ok'

    logForDebugging(`[remote-bridge] Torn down (archive=${status})`)
    logForDiagnosticsNoPII('info', 'bridge_repl_v2_teardown')
    logEvent(
      feature('CCR_MIRROR') && outboundOnly
        ? 'tengu_ccr_mirror_teardown'
        : 'tengu_bridge_repl_teardown',
      {
        v2: true,
        archive_status:
          archiveStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        archive_ok: typeof status === 'number' && status < 400,
        archive_http_status: typeof status === 'number' ? status : undefined,
        archive_timeout: status === 'timeout',
        archive_no_token: status === 'no_token',
      },
    )
  }
  const unregister = registerCleanup(teardown)

  if (feature('CCR_MIRROR') && outboundOnly) {
    logEvent('tengu_ccr_mirror_started', {
      v2: true,
      expires_in_s: credentials.expires_in,
    })
  } else {
    logEvent('tengu_bridge_repl_started', {
      has_initial_messages: !!(initialMessages && initialMessages.length > 0),
      v2: true,
      expires_in_s: credentials.expires_in,
      inProtectedNamespace: isInProtectedNamespace(),
    })
  }

  // ── 10. Handle ──────────────────────────────────────────────────────────
  return {
    bridgeSessionId: sessionId,
    environmentId: '',
    sessionIngressUrl: credentials.api_base_url,
    writeMessages(messages) {
      const filtered = messages.filter(
        m =>
          isEligibleBridgeMessage(m) &&
          !initialMessageUUIDs.has(m.uuid) &&
          !recentPostedUUIDs.has(m.uuid),
      )
      if (filtered.length === 0) return

      // 为标题派生触发 onUserMessage。它要在 flushGate 检查之前扫描，因为 prompt
      // 即使入队也仍然值得作为标题依据。会在每条适合做标题的消息上持续调用，
      // 直到回调返回 true；策略层面（例如在第 1 和第 3 条时派生、显式标题时跳过）
      // 由调用方自行决定。
      if (!userMessageCallbackDone) {
        for (const m of filtered) {
          const text = extractTitleText(m)
          if (text !== undefined && onUserMessage?.(text, sessionId)) {
            userMessageCallbackDone = true
            break
          }
        }
      }

      if (flushGate.enqueue(...filtered)) {
        logForDebugging(
          `[remote-bridge] Queued ${filtered.length} message(s) during flush`,
        )
        return
      }

      for (const msg of filtered) recentPostedUUIDs.add(msg.uuid)
      const events = toSDKMessages(filtered).map(m => ({
        ...m,
        session_id: sessionId,
      }))
      // v2 不会像 v1 的 session-ingress session_status_updater.go 那样在服务端
      // 从事件推导 worker_status。因此需要在这里主动上报状态，避免 CCR Web 的
      // session 列表一直卡在 Idle，而不是显示 Running。批次中出现 user 消息就表示
      // 一轮开始。CCRClient.reportState 会自动去重连续相同状态的推送。
      if (filtered.some(m => m.type === 'user')) {
        transport.reportState('running')
      }
      logForDebugging(`[remote-bridge] Sending ${filtered.length} message(s)`)
      void transport.writeBatch(events)
    },
    writeSdkMessages(messages: SDKMessage[]) {
      const filtered = messages.filter(
        m => !m.uuid || !recentPostedUUIDs.has(m.uuid),
      )
      if (filtered.length === 0) return
      for (const msg of filtered) {
        if (msg.uuid) recentPostedUUIDs.add(msg.uuid)
      }
      const events = filtered.map(m => ({ ...m, session_id: sessionId }))
      void transport.writeBatch(events)
    },
    sendControlRequest(request: SDKControlRequest) {
      if (authRecoveryInFlight) {
        logForDebugging(
          `[remote-bridge] Dropping control_request during 401 recovery: ${request.request_id}`,
        )
        return
      }
      const event = { ...request, session_id: sessionId }
      if (request.request.subtype === 'can_use_tool') {
        transport.reportState('requires_action')
      }
      void transport.write(event)
      logForDebugging(
        `[remote-bridge] Sent control_request request_id=${request.request_id}`,
      )
    },
    sendControlResponse(response: SDKControlResponse) {
      if (authRecoveryInFlight) {
        logForDebugging(
          '[remote-bridge] Dropping control_response during 401 recovery',
        )
        return
      }
      const event = { ...response, session_id: sessionId }
      transport.reportState('running')
      void transport.write(event)
      logForDebugging('[remote-bridge] Sent control_response')
    },
    sendControlCancelRequest(requestId: string) {
      if (authRecoveryInFlight) {
        logForDebugging(
          `[remote-bridge] Dropping control_cancel_request during 401 recovery: ${requestId}`,
        )
        return
      }
      const event = {
        type: 'control_cancel_request' as const,
        request_id: requestId,
        session_id: sessionId,
      }
      // Hook/classifier/channel/recheck 已在本地解决了该权限请求。
      // interactiveHandler 在这些路径上只会调用 cancelRequest（不会 sendResponse），
      // 因此若不在这里切回状态，服务端会一直停在 requires_action。
      transport.reportState('running')
      void transport.write(event)
      logForDebugging(
        `[remote-bridge] Sent control_cancel_request request_id=${requestId}`,
      )
    },
    sendResult() {
      if (authRecoveryInFlight) {
        logForDebugging('[remote-bridge] Dropping result during 401 recovery')
        return
      }
      transport.reportState('idle')
      void transport.write(makeResultMessage(sessionId))
      logForDebugging(`[remote-bridge] Sent result`)
    },
    async teardown() {
      unregister()
      await teardown()
    },
  }
}

// ─── Session API（v2 /code/sessions，无 env） ─────────────────────────────────

/** 对异步初始化调用执行指数退避 + 抖动重试。 */
async function withRetry<T>(
  fn: () => Promise<T | null>,
  label: string,
  cfg: EnvLessBridgeConfig,
): Promise<T | null> {
  const max = cfg.init_retry_max_attempts
  for (let attempt = 1; attempt <= max; attempt++) {
    const result = await fn()
    if (result !== null) return result
    if (attempt < max) {
      const base = cfg.init_retry_base_delay_ms * 2 ** (attempt - 1)
      const jitter =
        base * cfg.init_retry_jitter_fraction * (2 * Math.random() - 1)
      const delay = Math.min(base + jitter, cfg.init_retry_max_delay_ms)
      logForDebugging(
        `[remote-bridge] ${label} failed (attempt ${attempt}/${max}), retrying in ${Math.round(delay)}ms`,
      )
      await sleep(delay)
    }
  }
  return null
}

// 已移到 codeSessionApi.ts，这样 SDK /bridge 子路径可以单独打包这些逻辑，
// 而不必引入本文件沉重的 CLI 树（analytics、transport）。
export {
  createCodeSession,
  type RemoteCredentials,
} from './codeSessionApi.js'
import {
  createCodeSession,
  fetchRemoteCredentials as fetchRemoteCredentialsRaw,
  type RemoteCredentials,
} from './codeSessionApi.js'
import { getBridgeBaseUrlOverride } from './bridgeConfig.js'

// CLI 侧包装器：应用 CLAUDE_BRIDGE_BASE_URL 开发覆盖项，并注入 trusted-device token。
// 这两者都依赖 env/GrowthBook 读取，因此面向 SDK 的 codeSessionApi.ts 导出必须保持无依赖。
export async function fetchRemoteCredentials(
  sessionId: string,
  baseUrl: string,
  accessToken: string,
  timeoutMs: number,
): Promise<RemoteCredentials | null> {
  const creds = await fetchRemoteCredentialsRaw(
    sessionId,
    baseUrl,
    accessToken,
    timeoutMs,
    getTrustedDeviceToken(),
  )
  if (!creds) return null
  return getBridgeBaseUrlOverride()
    ? { ...creds, api_base_url: baseUrl }
    : creds
}

type ArchiveStatus = number | 'timeout' | 'error' | 'no_token'

// 供 BQ `GROUP BY archive_status` 使用的单一分类字段。_teardown 上那些布尔值
// 比这里更早存在，因此和它大体重复（archive_timeout 除外，它能把 ECONNABORTED
// 与其他网络错误区分开来，但在这里两者都归为 'network_error'，因为在 1.5s 窗口内
// 主导原因通常就是超时）。
type ArchiveTelemetryStatus =
  | 'ok'
  | 'skipped_no_token'
  | 'network_error'
  | 'server_4xx'
  | 'server_5xx'

async function archiveSession(
  sessionId: string,
  baseUrl: string,
  accessToken: string | undefined,
  orgUUID: string,
  timeoutMs: number,
): Promise<ArchiveStatus> {
  if (!accessToken) return 'no_token'
  // Archive 位于 compat 层（/v1/sessions/*，而不是 /v1/code/sessions）。
  // compat.parseSessionID 只接受 TagSession（session_*），因此需要把 cse_* 重标记。
  // anthropic-beta 和 x-organization-uuid 都是必需的，否则 compat gateway 会在
  // 到达真正 handler 之前就返回 404。
  //
  // 与 bridgeMain.ts 不同（它会把 compatId 缓存在 sessionCompatIds 中，以便在
  // session 中途 gate 翻转时保持内存里的 titledSessions/logger key 一致），这里的
  // compatId 只用作服务端 URL 路径片段，不涉及内存状态。每次现算都能匹配服务端
  // 当前接受的格式：如果 gate 关闭，则说明服务端已经支持 cse_*，那我们直接发它就是正确的。
  const compatId = toCompatSessionId(sessionId)
  try {
    const response = await axios.post(
      `${baseUrl}/v1/sessions/${compatId}/archive`,
      {},
      {
        headers: {
          ...oauthHeaders(accessToken),
          'anthropic-beta': 'ccr-byoc-2025-07-29',
          'x-organization-uuid': orgUUID,
        },
        timeout: timeoutMs,
        validateStatus: () => true,
      },
    )
    logForDebugging(
      `[remote-bridge] Archive ${compatId} status=${response.status}`,
    )
    return response.status
  } catch (err) {
    const msg = errorMessage(err)
    logForDebugging(`[remote-bridge] Archive failed: ${msg}`)
    return axios.isAxiosError(err) && err.code === 'ECONNABORTED'
      ? 'timeout'
      : 'error'
  }
}
