// biome-ignore-all assist/source/organizeImports：ANT-ONLY import 标记不能被重排。
import { randomUUID } from 'crypto'
import {
  createBridgeApiClient,
  BridgeFatalError,
  isExpiredErrorType,
  isSuppressible403,
} from './bridgeApi.js'
import type { BridgeConfig, BridgeApiClient } from './types.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import {
  handleIngressMessage,
  handleServerControlRequest,
  makeResultMessage,
  isEligibleBridgeMessage,
  extractTitleText,
  BoundedUUIDSet,
} from './bridgeMessaging.js'
import {
  decodeWorkSecret,
  buildSdkUrl,
  buildCCRv2SdkUrl,
  sameSessionId,
} from './workSecret.js'
import { toCompatSessionId, toInfraSessionId } from './sessionIdCompat.js'
import { updateSessionBridgeId } from '../utils/concurrentSessions.js'
import { getTrustedDeviceToken } from './trustedDevice.js'
import { HybridTransport } from '../cli/transports/HybridTransport.js'
import {
  type ReplBridgeTransport,
  createV1ReplTransport,
  createV2ReplTransport,
} from './replBridgeTransport.js'
import { updateSessionIngressAuthToken } from '../utils/sessionIngressAuth.js'
import { isEnvTruthy, isInProtectedNamespace } from '../utils/envUtils.js'
import { validateBridgeId } from './bridgeApi.js'
import {
  describeAxiosError,
  extractHttpStatus,
  logBridgeSkip,
} from './debugUtils.js'
import type { Message } from '../types/message.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import { createCapacityWake, type CapacitySignal } from './capacityWake.js'
import { FlushGate } from './flushGate.js'
import {
  DEFAULT_POLL_CONFIG,
  type PollIntervalConfig,
} from './pollConfigDefaults.js'
import { errorMessage } from '../utils/errors.js'
import { sleep } from '../utils/sleep.js'
import {
  wrapApiForFaultInjection,
  registerBridgeDebugHandle,
  clearBridgeDebugHandle,
  injectBridgeFault,
} from './bridgeDebug.js'

export type ReplBridgeHandle = {
  bridgeSessionId: string
  environmentId: string
  sessionIngressUrl: string
  writeMessages(messages: Message[]): void
  writeSdkMessages(messages: SDKMessage[]): void
  sendControlRequest(request: SDKControlRequest): void
  sendControlResponse(response: SDKControlResponse): void
  sendControlCancelRequest(requestId: string): void
  sendResult(): void
  teardown(): Promise<void>
}

export type BridgeState = 'ready' | 'connected' | 'reconnecting' | 'failed'

/**
 * initBridgeCore 的显式参数输入。initReplBridge 从 bootstrap 状态里读取的所有内容
 * （cwd、session ID、git、OAuth）都会在这里变成字段。
 * 对于从不运行 main.tsx 的 daemon 调用方（Agent SDK，PR 4），
 * 这些字段都由其自行填充。
 */
export type BridgeCoreParams = {
  dir: string
  machineName: string
  branch: string
  gitRepoUrl: string | null
  title: string
  baseUrl: string
  sessionIngressUrl: string
  /**
    * 作为 metadata.worker_type 发送的不透明字符串。
    * 对于 CLI 产生的两个值，使用 BridgeWorkerType；daemon 调用方则可以发送后端
    * 能识别的任意字符串（它在 Web 侧只是一个过滤键）。
   */
  workerType: string
  getAccessToken: () => string | undefined
  /**
    * POST /v1/sessions。以注入方式提供，是因为 `createSession.ts` 会懒加载
    * `auth.ts`/`model.ts`/`oauth/client.ts`，但 `bun --outfile` 会把动态导入内联化，
    * 使懒加载失效，最后整个 REPL 树都会被打进 Agent SDK bundle。
   *
    * REPL wrapper 传入的是来自 `createSession.ts` 的 `createBridgeSession`。
    * Daemon wrapper 传入的是来自 `sessionApi.ts` 的 `createBridgeSessionLean`
    * （仅 HTTP，orgUUID+model 由 daemon 调用方提供）。
   *
    * 之所以接收 `gitRepoUrl` 和 `branch`，是为了让 REPL wrapper 能给 claude.ai 的
    * session 卡片构造 git source/outcome；daemon 则会忽略它们。
   */
  createSession: (opts: {
    environmentId: string
    title: string
    gitRepoUrl: string | null
    branch: string
    signal: AbortSignal
  }) => Promise<string | null>
  /**
    * POST /v1/sessions/{id}/archive。注入理由相同。Best-effort 语义；
    * 该回调绝不能抛错。
   */
  archiveSession: (sessionId: string) => Promise<void>
  /**
    * 在 env-lost 之后重连时调用，用于刷新标题。REPL wrapper 会去读 session storage
    *（以便拿到 /rename 的结果）；daemon 则返回静态 title。默认值为 () => title。
   */
  getCurrentTitle?: () => string
  /**
    * 将内部的 Message[] 转为 SDKMessage[]，供 writeMessages() 以及
    * initial-flush/drain 路径使用。REPL wrapper 会传入来自 utils/messages/mappers.ts
    * 的真实 toSDKMessages。仅使用 writeSdkMessages() 且不传 initialMessages 的 daemon
    * 调用方可以省略它，因为那些代码路径根本不可达。
   *
    * 之所以用注入而不是直接导入，是因为 mappers.ts 会通过
    * messages.ts → api.ts → prompts.ts 传递引入 src/commands.ts，进而把整套
    * command registry + React 树拖进 Agent SDK bundle。
   */
  toSDKMessages?: (messages: Message[]) => SDKMessage[]
  /**
    * 传给 createBridgeApiClient 的 OAuth 401 刷新处理器。
    * REPL wrapper 传入 handleOAuth401Error；daemon 则传入其 AuthManager 的 handler。
    * 之所以要注入，是因为 utils/auth.ts 会经由 config.ts → file.ts →
    * 依赖链：permissions/filesystem.ts → sessionStorage.ts → commands.ts
    * 传递引入整套 command registry 体系。
   */
  onAuth401?: (staleAccessToken: string) => Promise<boolean>
  /**
    * work-poll heartbeat 循环使用的轮询间隔配置 getter。REPL wrapper 会传入由
    * GrowthBook 驱动的 getPollIntervalConfig（使 ops 可在整个集群内实时调节轮询速率）。
    * Daemon 则传入一个静态配置，使用 60s heartbeat
    *（在 300s 的 work-lease TTL 下仍有 5 倍余量）。
    * 之所以要注入，是因为 growthbook.ts 会沿着同一条 config.ts 依赖链传递引入
    * command registry 体系。
   */
  getPollIntervalConfig?: () => PollIntervalConfig
  /**
    * 连接时最多回放多少条初始消息。REPL wrapper 会从
    * tengu_bridge_initial_history_cap GrowthBook flag 中读取该值。
    * Daemon 不传 initialMessages，因此不会读取这里。默认值 200 与 flag 默认值一致。
   */
  initialHistoryCap?: number
    // 与 InitBridgeOptions 相同的 REPL flush 机制字段，daemon 会省略它们。
  initialMessages?: Message[]
  previouslyFlushedUUIDs?: Set<string>
  onInboundMessage?: (msg: SDKMessage) => void
  onPermissionResponse?: (response: SDKControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  /**
    * 返回策略裁决，使本模块能在不自行导入策略检查逻辑的前提下发送 error control_response
    *（bootstrap 隔离约束）。回调必须在调用 transitionPermissionMode 之前先拦住
    * `auto`（isAutoModeGateEnabled）和 `bypassPermissions`
    *（isBypassPermissionsModeDisabled AND isBypassPermissionsModeAvailable）。
    * 因为 transitionPermissionMode 内部对 auto gate 的检查是防御性抛错，
    * 不是平滑保护，而且它的副作用顺序是先 setAutoModeActive(true) 再 throw。
    * 如果回调允许这个 throw 冒泡到这里，就会破坏 src/CLAUDE.md 中记录的三方不变量。
   */
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: BridgeState, detail?: string) => void
  /**
   * 每当真实用户消息经过 writeMessages() 时触发，直到回调返回 true（表示完成）。
   * 它与 remoteBridgeCore.ts 中的 onUserMessage 对应，用于让 REPL bridge 在初始化时
   * 没有 title 的情况下，也能从早期 prompt 中派生 session 标题
   *（例如用户在空对话上执行 /remote-control 后再开始输入）。
   * tool-result 包装消息、meta 消息以及仅由 display tag 构成的消息都会被跳过。
   * 这里会把 currentSessionId 一并传入，这样 wrapper 就能直接 PATCH title，
   * 而不需要通过复杂闭包去碰那个尚未返回的 handle。派生策略
   *（如在第 1 和第 3 条时生成）由调用方决定；transport 只负责持续调用，直到被告知停止。
   * 这条逻辑不会在 daemon 的 writeSdkMessages 路径触发（daemon 会在初始化时自行设定标题）。
   * 它也不同于 SessionSpawnOpts 的 onFirstUserMessage（spawn-bridge，PR #21250），
   * 后者始终只会触发一次。
   */
  onUserMessage?: (text: string, sessionId: string) => boolean
  /** 见 InitBridgeOptions.perpetual。 */
  perpetual?: boolean
  /**
   * 为 lastTransportSequenceNum 提供初始值，也就是单个进程内跨 transport 切换时
   * 要带过去的 SSE 事件流高水位值。Daemon 调用方会把关闭时持久化下来的值传回，
   * 这样新进程的第一次 SSE 连接就能带上 from_sequence_num，避免服务端重放全部历史。
   * REPL 调用方则省略它（每次运行都是新 session，因此 0 才是正确值）。
   */
  initialSSESequenceNum?: number
}

/**
 * ReplBridgeHandle 的超集。它额外提供 getSSESequenceNum，供那些会在进程重启间
 * 持久化 SSE seq-num，并在下次启动时通过 initialSSESequenceNum 传回的 daemon 调用方使用。
 */
export type BridgeCoreHandle = ReplBridgeHandle & {
  /**
   * 当前 SSE 序列号高水位值。随着 transport 切换而更新。
   * Daemon 调用方会在关闭时持久化它，并在下次启动时通过 initialSSESequenceNum 传回。
   */
  getSSESequenceNum(): number
}

/**
 * 轮询错误恢复相关常量。当 work poll 开始失败（例如服务端 500）时，
 * 我们会使用指数退避，并在达到这个超时后放弃。
 * 这个时间刻意设置得较长，因为关于 session 是否真的死亡，服务端才是权威。
 * 只要服务端仍然接受我们的 poll，我们就继续等待它重新分发 work item。
 */
const POLL_ERROR_INITIAL_DELAY_MS = 2_000
const POLL_ERROR_MAX_DELAY_MS = 60_000
const POLL_ERROR_GIVE_UP_MS = 15 * 60 * 1000

// 单调递增计数器，用于在日志中区分不同的 init 调用
let initSequence = 0

/**
 * 不依赖 bootstrap 的核心流程：env 注册 → session 创建 → poll loop →
 * ingress WS → teardown。它不会从 bootstrap/state 或 sessionStorage 读取任何东西，
 * 所有上下文都来自 params。调用方（下方的 initReplBridge，或 PR 4 中的 daemon）
 * 已经完成了权限 gate 检查，并收集好了 git/auth/title。
 *
 * 当注册或 session 创建失败时返回 null。
 */
export async function initBridgeCore(
  params: BridgeCoreParams,
): Promise<BridgeCoreHandle | null> {
  const {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    title,
    baseUrl,
    sessionIngressUrl,
    workerType,
    getAccessToken,
    createSession,
    archiveSession,
    getCurrentTitle = () => title,
    toSDKMessages = () => {
      throw new Error(
        'BridgeCoreParams.toSDKMessages not provided. Pass it if you use writeMessages() or initialMessages — daemon callers that only use writeSdkMessages() never hit this path.',
      )
    },
    onAuth401,
    getPollIntervalConfig = () => DEFAULT_POLL_CONFIG,
    initialHistoryCap = 200,
    initialMessages,
    previouslyFlushedUUIDs,
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    onUserMessage,
    perpetual,
    initialSSESequenceNum = 0,
  } = params

  const seq = ++initSequence

  // 提前加载 bridgePointer：perpetual 模式会在 register 前读取它；
  // 非 perpetual 模式会在 session 创建后写入；两者在 teardown 时都要用到 clear。
  const { writeBridgePointer, clearBridgePointer, readBridgePointer } =
    await import('./bridgePointer.js')

  // perpetual 模式：读取 crash-recovery pointer，并把它视为先前状态。
  // 该 pointer 会在 session 创建后无条件写入（为所有 session 提供 crash-recovery）；
  // perpetual 模式只是跳过 teardown 中的 clear，让它在正常退出后也保留下来。
  // 这里只复用 source 为 'repl' 的 pointer；崩溃的 standalone bridge
  //（`claude remote-control`）会写 source:'standalone'，且 workerType 不同。
  const rawPrior = perpetual ? await readBridgePointer(dir) : null
  const prior = rawPrior?.source === 'repl' ? rawPrior : null

  logForDebugging(
    `[bridge:repl] initBridgeCore #${seq} starting (initialMessages=${initialMessages?.length ?? 0}${prior ? ` perpetual prior=env:${prior.environmentId}` : ''})`,
  )

  // 5. 注册 bridge environment
  const rawApi = createBridgeApiClient({
    baseUrl,
    getAccessToken,
    runnerVersion: MACRO.VERSION,
    onDebug: logForDebugging,
    onAuth401,
    getTrustedDeviceToken,
  })
  // ant-only：在这里插入一层，使 /bridge-kick 可以注入 poll/register/heartbeat 失败。
  // 对外部构建没有额外成本（rawApi 会原样透传）。
  const api =
    process.env.USER_TYPE === 'ant' ? wrapApiForFaultInjection(rawApi) : rawApi

  const bridgeConfig: BridgeConfig = {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    maxSessions: 1,
    spawnMode: 'single-session',
    verbose: false,
    sandbox: false,
    bridgeId: randomUUID(),
    workerType,
    environmentId: randomUUID(),
    reuseEnvironmentId: prior?.environmentId,
    apiBaseUrl: baseUrl,
    sessionIngressUrl,
  }

  let environmentId: string
  let environmentSecret: string
  try {
    const reg = await api.registerBridgeEnvironment(bridgeConfig)
    environmentId = reg.environment_id
    environmentSecret = reg.environment_secret
  } catch (err) {
    logBridgeSkip(
      'registration_failed',
      `[bridge:repl] Environment registration failed: ${errorMessage(err)}`,
    )
    // 失败原因可能只是 pointer 已过期，指向了失效/被删除的 env。
    // 这里把它清掉，避免下次启动时再次重试同一个死 ID。
    if (prior) {
      await clearBridgePointer(dir)
    }
    onStateChange?.('failed', errorMessage(err))
    return null
  }

  logForDebugging(`[bridge:repl] Environment registered: ${environmentId}`)
  logForDiagnosticsNoPII('info', 'bridge_repl_env_registered')
  logEvent('tengu_bridge_repl_env_registered', {})

  /**
    * 原地重连：如果刚注册得到的 environmentId 与请求的一致，就调用 reconnectSession
    * 强制停止陈旧 worker，并把该 session 重新排队。它既用于初始化阶段
    *（perpetual 模式下，env 在正常 teardown 后仍然活着但处于 idle），
    * 也用于 doReconnect() 的策略 1（env 丢失后又被恢复）。成功时返回 true；
    * 返回 false 时调用方会回退为创建全新 session。
   */
  async function tryReconnectInPlace(
    requestedEnvId: string,
    sessionId: string,
  ): Promise<boolean> {
    if (environmentId !== requestedEnvId) {
      logForDebugging(
        `[bridge:repl] Env mismatch (requested ${requestedEnvId}, got ${environmentId}) — cannot reconnect in place`,
      )
      return false
    }
    // pointer 中存的是 createBridgeSession 返回的值（session_*，见 compat/convert.go:41）。
    // /bridge/reconnect 属于 environments 层 endpoint，一旦服务端开启 ccr_v2_compat_enabled gate，
    // 它就会按基础设施标签（cse_*）查 session，而对 session_* 这层“外衣”返回
    // "Session not found"。由于在 poll 前我们并不知道 gate 状态，因此两个格式都试一遍；
    // 如果传入本来就是 cse_*，那么重标记本身就是 no-op。
    //（doReconnect 的策略 1 路径里 currentSessionId 当前不会变成 cse_*，但这里仍做前向兼容。）
    const infraId = toInfraSessionId(sessionId)
    const candidates =
      infraId === sessionId ? [sessionId] : [sessionId, infraId]
    for (const id of candidates) {
      try {
        await api.reconnectSession(environmentId, id)
        logForDebugging(
          `[bridge:repl] Reconnected session ${id} in place on env ${environmentId}`,
        )
        return true
      } catch (err) {
        logForDebugging(
          `[bridge:repl] reconnectSession(${id}) failed: ${errorMessage(err)}`,
        )
      }
    }
    logForDebugging(
      '[bridge:repl] reconnectSession exhausted — falling through to fresh session',
    )
    return false
  }

  // perpetual 初始化：env 在正常 teardown 之后仍然存活，但没有排队中的 work。
  // reconnectSession 会把它重新排队。doReconnect() 中也会执行相同调用，
  // 但它只会在 poll 404（env 死掉）时触发；这里则是 env 活着但 idle 的情况。
  const reusedPriorSession = prior
    ? await tryReconnectInPlace(prior.environmentId, prior.sessionId)
    : false
  if (prior && !reusedPriorSession) {
    await clearBridgePointer(dir)
  }

  // 6. 在 bridge 上创建 session。初始消息不会作为 session 创建事件一并带上，
  // 因为那条路径使用的是 STREAM_ONLY 持久化，并且会早于 CCR UI 的订阅建立发布出去，
  // 所以最终会丢失。取而代之的是，在 ingress WebSocket 连接成功后再通过它 flush 初始消息。

  // 可变的 session ID。当连接丢失后重新创建 environment+session 组合时，它会被更新。
  let currentSessionId: string


  if (reusedPriorSession && prior) {
    currentSessionId = prior.sessionId
    logForDebugging(
      `[bridge:repl] Perpetual session reused: ${currentSessionId}`,
    )
    // 服务端已经持有上一次 CLI 运行中的全部 initialMessages。
    // 把它们标记为 previously-flushed，这样初始 flush 过滤器就会把它们排除掉
    //（每次 CLI 启动时 previouslyFlushedUUIDs 都是新的 Set）。重复 UUID 会导致
    // 服务端直接关闭 WebSocket。
    if (initialMessages && previouslyFlushedUUIDs) {
      for (const msg of initialMessages) {
        previouslyFlushedUUIDs.add(msg.uuid)
      }
    }
  } else {
    const createdSessionId = await createSession({
      environmentId,
      title,
      gitRepoUrl,
      branch,
      signal: AbortSignal.timeout(15_000),
    })

    if (!createdSessionId) {
      logForDebugging(
        '[bridge:repl] Session creation failed, deregistering environment',
      )
      logEvent('tengu_bridge_repl_session_failed', {})
      await api.deregisterEnvironment(environmentId).catch(() => {})
      onStateChange?.('failed', 'Session creation failed')
      return null
    }

    currentSessionId = createdSessionId
    logForDebugging(`[bridge:repl] Session created: ${currentSessionId}`)
  }

  // crash-recovery pointer：现在就写入，这样从此之后任意时刻发生 kill -9
  // 都会留下可恢复痕迹。它会在 teardown 中被清掉（非 perpetual），
  // 或被保留下来（perpetual 模式下，正常退出后也会保留）。
  // 同目录下执行 `claude remote-control --continue` 时会检测到它，并提供恢复选项。
  await writeBridgePointer(dir, {
    sessionId: currentSessionId,
    environmentId,
    source: 'repl',
  })
  logForDiagnosticsNoPII('info', 'bridge_repl_session_created')
  logEvent('tengu_bridge_repl_started', {
    has_initial_messages: !!(initialMessages && initialMessages.length > 0),
    inProtectedNamespace: isInProtectedNamespace(),
  })

  // 初始消息的 UUID 集合。writeMessages 会用它来去重，避免再次发送那些已在
  // WebSocket 打开时 flush 过的消息。
  const initialMessageUUIDs = new Set<string>()
  if (initialMessages) {
    for (const msg of initialMessages) {
      initialMessageUUIDs.add(msg.uuid)
    }
  }

  // 有界环形缓冲区，记录那些已经通过 ingress WebSocket 发给服务端的消息 UUID。
  // 它有两个用途：
  //  1. 过滤 echo：忽略服务端经 WS 回弹给我们的自发消息。
  //  2. 作为 writeMessages 的二级去重，兜住 index 跟踪不足时的竞态。
  //
  // 初始值会用 initialMessageUUIDs 预先播种，这样当服务端把初始对话上下文
  // 回显到 ingress WebSocket 时，这些消息会被识别成 echo，而不会再次注入 REPL。
  //
  // 容量 2000 足以覆盖任何现实中的 echo 窗口（echo 通常在毫秒内到达），
  // 也能覆盖 compaction 后可能再次遇到的消息。
  // hook 的 lastWrittenIndexRef 才是主去重机制；这里是安全网。
  const recentPostedUUIDs = new BoundedUUIDSet(2000)
  for (const uuid of initialMessageUUIDs) {
    recentPostedUUIDs.add(uuid)
  }

  // 有界集合，记录已经转发给 REPL 的入站 prompt UUID。
  // 这是防御式去重，用来处理服务端重复投递 prompt 的情况
  // （如序号协商失败、服务端边界条件、transport 切换竞态）。
  // 下方的 seq-num 延续才是主修复，这里只是安全网。
  const recentInboundUUIDs = new BoundedUUIDSet(2000)

  // 7. 启动 work item 的 poll loop，这一步会让 session 真正在 claude.ai 上“活起来”。
  // 用户在那边输入后，后端会把 work item 分发到我们的 environment；
  // 我们通过轮询拿到 ingress token，再建立 ingress WebSocket。
  //
  // poll loop 会一直运行：一旦有 work 到来就连上 ingress WebSocket；
  // 如果 WebSocket 意外断开（code != 1000），则恢复轮询，获取新的 ingress token 并重连。
  const pollController = new AbortController()
  // transport 适配层：要么是 HybridTransport
  //（v1：WS 读 + POST 写到 Session-Ingress），要么是 SSETransport + CCRClient
  //（v2：SSE 读 + POST 写到 CCR /worker/*）。
  // v1/v2 的选择在 onWorkReceived 中决定：服务端通过 secret.use_code_sessions 驱动，
  // CLAUDE_BRIDGE_USE_CCR_V2 只是 ant-dev 的手动覆盖开关。
  let transport: ReplBridgeTransport | null = null
  // 每次 onWorkReceived 都会递增。
  // createV2ReplTransport 的 .then() 闭包会捕获它，用来识别过期解析结果：
  // 若在 transport 仍为 null 时两个调用发生竞态，二者都会 registerWorker()
  //（从而 bump server epoch），真正正确的反而是“第二个 resolve 的那个”。
  // 但单纯依赖 transport !== null 判断会把顺序搞反，因此这里用 generation 计数器
  // 在 transport 状态之外单独兜住这种情况。
  let v2Generation = 0
  // 跨 transport 切换保留的 SSE 序列号高水位值。
  // 没有它的话，每个新的 SSETransport 都会从 0 起步，首次 connect() 时既不带
  // from_sequence_num，也不带 Last-Event-ID，服务端就会把整个 session 事件历史重放一遍，
  // 导致过去所有 prompt 在每次 onWorkReceived 时都被重新当成新入站消息送回来。
  //
  // 只有在我们确实重连了旧 session 时才会用旧值播种。
  // 若 `reusedPriorSession` 为 false，说明我们已经退化到 `createSession()` 创建新 session；
  // 调用方持久化的 seq-num 属于一个死 session，把它套到从 1 开始的新流上会静默丢事件。
  // 这与 doReconnect 的策略 2 面临的是同类风险，因此修复方式也相同：重置它。
  let lastTransportSequenceNum = reusedPriorSession ? initialSSESequenceNum : 0
  // 记录当前 work ID，方便 teardown 时调用 stopWork。
  let currentWorkId: string | null = null
  // 当前 work item 对应的 session ingress JWT，用于 heartbeat 鉴权。
  let currentIngressToken: string | null = null
  // transport 丢失时，用它提前唤醒“满容量休眠”，
  // 让 poll loop 立刻切回快速轮询去拿新 work。
  const capacityWake = createCapacityWake(pollController.signal)
  const wakePollLoop = capacityWake.wake
  const capacitySignal = capacityWake.signal
  // 在初始 flush 期间对消息写入做门控，避免新消息与历史消息在服务端交错到达，
  // 从而引发顺序竞态。
  const flushGate = new FlushGate<Message>()

  // onUserMessage 的锁存位：当回调返回 true 时置为 true，
  // 表示策略已经“推导完成”。如果压根没有回调，则直接跳过整段扫描
  //（daemon 路径不需要标题推导）。
  let userMessageCallbackDone = !onUserMessage

  // environment 重建的共享计数器，onEnvironmentLost 与异常关闭处理器都会用到。
  const MAX_ENVIRONMENT_RECREATIONS = 3
  let environmentRecreations = 0
  let reconnectPromise: Promise<boolean> | null = null

  /**
   * 处理 onEnvironmentLost（即 poll 返回 404，说明 env 已在服务端被回收）的恢复逻辑。
   * 按顺序尝试两种策略：
   *
   *   1. 原地重连：带 reuseEnvironmentId 进行幂等 re-register。
   *      如果后端返回的是同一个 env ID，就调用 reconnectSession() 重新把旧 session 排队。
   *      这样 currentSessionId 不变，用户手机上的 URL 继续有效，
   *      previouslyFlushedUUIDs 也能保留，从而避免历史消息重发。
   *
   *   2. 新 session 兜底：如果后端返回了不同的 env ID
   *      （例如原 env TTL 过期，笔记本休眠超过 4 小时），
   *      或 reconnectSession() 抛错，就归档旧 session，并在新注册好的 env 上创建新 session。
   *      这也是 #20460 相关原语落地前的旧行为。
   *
   * 这里使用基于 promise 的重入保护，让并发调用共享同一次重连尝试。
   */
  async function reconnectEnvironmentWithSession(): Promise<boolean> {
    if (reconnectPromise) {
      return reconnectPromise
    }
    reconnectPromise = doReconnect()
    try {
      return await reconnectPromise
    } finally {
      reconnectPromise = null
    }
  }

  async function doReconnect(): Promise<boolean> {
    environmentRecreations++
    // 让所有进行中的 v2 握手失效。
    // environment 正在被重建，若旧 transport 在重连后才慢一步到达，
    // 它只会指向一个已经死掉的 session。
    v2Generation++
    logForDebugging(
      `[bridge:repl] Reconnecting after env lost (attempt ${environmentRecreations}/${MAX_ENVIRONMENT_RECREATIONS})`,
    )

    if (environmentRecreations > MAX_ENVIRONMENT_RECREATIONS) {
      logForDebugging(
        `[bridge:repl] Environment reconnect limit reached (${MAX_ENVIRONMENT_RECREATIONS}), giving up`,
      )
      return false
    }

    // 先关闭陈旧 transport。
    // 必须在 close 之前抓取 seq：如果策略 1（tryReconnectInPlace）成功，
    // 我们会继续沿用“同一个” session，下一个 transport 就必须从当前 seq 继续，
    // 而不是从上一次 transport-swap 的检查点开始重放。
    if (transport) {
      const seq = transport.getLastSequenceNum()
      if (seq > lastTransportSequenceNum) {
        lastTransportSequenceNum = seq
      }
      transport.close()
      transport = null
    }
    // transport 已失效，提前唤醒 poll loop 当前的“满容量 heartbeat 睡眠”，
    // 让它立即切回快速轮询，重新接住被重新分发的 work。
    wakePollLoop()
    // 重置 flush gate，让 writeMessages() 走到 !transport 的 guard，
    // 而不是悄悄把消息继续排进一个已经失效的缓冲区。
    flushGate.drop()

    // 释放当前 work item（force=false，因为我们可能还想把同一个 session 要回来）。
    // 这里是 best-effort：env 很可能已经没了，所以大概率会 404。
    if (currentWorkId) {
      const workIdBeingCleared = currentWorkId
      await api
        .stopWork(environmentId, workIdBeingCleared, false)
        .catch(() => {})
      // doReconnect 与 poll loop 并发运行时（例如 ws_closed 分支里是 void 调用，
      // 不像 onEnvironmentLost 那样被 await），onWorkReceived 可能会在 stopWork 等待期间
      // 先一步触发，并设置一个全新的 currentWorkId。若发生这种情况，说明 poll loop
      // 已经自行恢复，此时应直接让它接管，而不是继续走 archiveSession，
      // 否则会把它新 transport 正在连接的那个 session 一并销毁。
      if (currentWorkId !== workIdBeingCleared) {
        logForDebugging(
          '[bridge:repl] Poll loop recovered during stopWork await — deferring to it',
        )
        environmentRecreations = 0
        return true
      }
      currentWorkId = null
      currentIngressToken = null
    }

    // 如果等待期间 teardown 已经启动，就直接退出。
    if (pollController.signal.aborted) {
      logForDebugging('[bridge:repl] Reconnect aborted by teardown')
      return false
    }

    // 策略 1：使用服务端签发的 env ID 做幂等 re-register。
    // 如果后端复活了同一个 env（但 secret 是新的），我们就能重连旧 session；
    // 若返回了不同 ID，说明原 env 真的没了，需要继续退化为新 session。
    const requestedEnvId = environmentId
    bridgeConfig.reuseEnvironmentId = requestedEnvId
    try {
      const reg = await api.registerBridgeEnvironment(bridgeConfig)
      environmentId = reg.environment_id
      environmentSecret = reg.environment_secret
    } catch (err) {
      bridgeConfig.reuseEnvironmentId = undefined
      logForDebugging(
        `[bridge:repl] Environment re-registration failed: ${errorMessage(err)}`,
      )
      return false
    }
    // 必须在任何 await 前清掉 reuseEnvironmentId，
    // 否则下次 doReconnect 再进来时，旧值会污染新的注册流程。
    bridgeConfig.reuseEnvironmentId = undefined

    logForDebugging(
      `[bridge:repl] Re-registered: requested=${requestedEnvId} got=${environmentId}`,
    )

    // 如果注册期间 teardown 启动了，就直接退出并做清理。
    if (pollController.signal.aborted) {
      logForDebugging(
        '[bridge:repl] Reconnect aborted after env registration, cleaning up',
      )
      await api.deregisterEnvironment(environmentId).catch(() => {})
      return false
    }

    // 与上面类似的竞态，但窗口更窄：poll loop 可能在 registerBridgeEnvironment await
    // 期间已经先把 transport 建好了。这里必须提前退出，避免后面的
    // tryReconnectInPlace/archiveSession 把它在服务端一并干掉。
    if (transport !== null) {
      logForDebugging(
        '[bridge:repl] Poll loop recovered during registerBridgeEnvironment await — deferring to it',
      )
      environmentRecreations = 0
      return true
    }

    // 策略 1 的具体执行与 perpetual 初始化复用同一 helper。
    // 成功时 currentSessionId 保持不变，移动端/网页端 URL 继续有效，
    // previouslyFlushedUUIDs 也能保留，不需要重新 flush 历史。
    if (await tryReconnectInPlace(requestedEnvId, currentSessionId)) {
      logEvent('tengu_bridge_repl_reconnected_in_place', {})
      environmentRecreations = 0
      return true
    }
    // env 不同，说明原 env 已 TTL 过期/被回收；或者 reconnect 直接失败。
    // 这里不要 deregister，因为无论哪种情况，我们手上都已经拿到了这个 env 的新 secret。
    if (environmentId !== requestedEnvId) {
      logEvent('tengu_bridge_repl_env_expired_fresh_session', {})
    }

    // 策略 2：在刚注册好的 env 上创建一个全新的 session。
    // 先归档旧 session，因为它已经成了孤儿：要么绑在死 env 上，
    // 要么就是被 reconnectSession 拒绝了。
    // 同样不要 deregister env，因为我们刚拿到它的新 secret，马上还要继续用。
    await archiveSession(currentSessionId)

    // 如果归档期间 teardown 启动了，就退出并清理。
    if (pollController.signal.aborted) {
      logForDebugging(
        '[bridge:repl] Reconnect aborted after archive, cleaning up',
      )
      await api.deregisterEnvironment(environmentId).catch(() => {})
      return false
    }

    // 重新读取当前 title，避免用户已经在别处把 session 改名。
    // REPL wrapper 会读 session storage；daemon wrapper 则返回原始 title
    //（即没有可刷新的内容）。
    const currentTitle = getCurrentTitle()

    // 在刚注册完成的 environment 上创建新 session。
    const newSessionId = await createSession({
      environmentId,
      title: currentTitle,
      gitRepoUrl,
      branch,
      signal: AbortSignal.timeout(15_000),
    })

    if (!newSessionId) {
      logForDebugging(
        '[bridge:repl] Session creation failed during reconnection',
      )
      return false
    }

    // 如果创建 session 的这段时间里 teardown 已启动，就直接退出并清理。
    if (pollController.signal.aborted) {
      logForDebugging(
        '[bridge:repl] Reconnect aborted after session creation, cleaning up',
      )
      await archiveSession(newSessionId)
      return false
    }

    currentSessionId = newSessionId
    // 把新 ID 重新发布到 PID 文件里，确保 peer dedup（peerRegistry.ts）能感知到它。
    // setReplBridgeHandle 只会在 init/teardown 时触发，不会在 reconnect 时自动跑。
    void updateSessionBridgeId(toCompatSessionId(newSessionId)).catch(() => {})
    // 一旦 session 完成切换，就要立刻重置 per-session transport 状态，
    // 而且必须发生在任何 await 之前。
    // 如果拖到下面的 `await writeBridgePointer` 之后，
    // 就会出现 handle.bridgeSessionId 已经返回 session B，
    // 但 getSSESequenceNum() 还停留在 session A 的短暂窗口。
    // 此时 daemon 若执行 persistState()，会写出
    // {bridgeSessionId: B, seq: OLD_A}，这个组合甚至还能通过 session ID 校验，
    // 从而彻底绕过原本的保护。
    //
    // 此外，SSE seq-num 本来就是绑定在“某个 session 的事件流”上的；
    // 如果把它硬带到新 session，transport 的 lastSequenceNum 会卡在一个过高值，
    // 后续内部重连再发 from_sequence_num=OLD_SEQ 给一个从 1 开始的新流时，
    // 中间所有事件都会被静默丢掉。入站 UUID 去重同样也是 session 级别的。
    lastTransportSequenceNum = 0
    recentInboundUUIDs.clear()
    // title 推导同样是 session 级的：如果用户恰好在上面的 createSession await 期间输入了内容，
    // 回调会打到“旧的、已归档的” session ID 上，PATCH 也就丢失了；
    // 而新 session 拿到的却是用户输入“之前”抓取的 `currentTitle`。
    // 因此这里要重置，让下一条 prompt 再重新推导一次。
    // 这又是自修复的：如果调用方策略本来已经完成
    //（如显式标题或消息数 >= 3），那它会在重置后的第一次调用里立刻重新锁住。
    userMessageCallbackDone = !onUserMessage
    logForDebugging(`[bridge:repl] Re-created session: ${currentSessionId}`)

    // 用新 ID 重写 crash-recovery pointer，确保若此后进程崩溃，恢复的也是正确 session。
    //（上面的原地重连路径不需要改 pointer，因为 session 和 env 都没变。）
    await writeBridgePointer(dir, {
      sessionId: currentSessionId,
      environmentId,
      source: 'repl',
    })

    // 清空已 flush UUID 集合，让初始消息在新 session 上重新发送。
    // UUID 在服务端本来就是 session 级作用域，因此重新 flush 是安全的。
    previouslyFlushedUUIDs?.clear()


    // 重置计数器，避免几个小时后发生的独立重连也被累计进上限里。
    // 它要防的是“短时间连续失败”，不是生命周期总次数。
    environmentRecreations = 0

    return true
  }

  // 帮助函数：获取当前用于 session ingress 鉴权的 OAuth access token。
  // 与 JWT 路径不同，OAuth token 会由标准 OAuth 流程自动刷新，
  // 因此这里不需要主动调度器。
  function getOAuthToken(): string | undefined {
    return getAccessToken()
  }

  // 把初始 flush 期间暂存的消息放出来。
  // 它会在 writeBatch 完成或失败后调用，确保这些排队消息总是在历史消息之后按序发送。
  function drainFlushGate(): void {
    const msgs = flushGate.end()
    if (msgs.length === 0) return
    if (!transport) {
      logForDebugging(
        `[bridge:repl] Cannot drain ${msgs.length} pending message(s): no transport`,
      )
      return
    }
    for (const msg of msgs) {
      recentPostedUUIDs.add(msg.uuid)
    }
    const sdkMessages = toSDKMessages(msgs)
    const events = sdkMessages.map(sdkMsg => ({
      ...sdkMsg,
      session_id: currentSessionId,
    }))
    logForDebugging(
      `[bridge:repl] Drained ${msgs.length} pending message(s) after flush`,
    )
    void transport.writeBatch(events)
  }

  // teardown 实现的引用会在下方定义完成后再赋值。
  // 所有调用方都是赋值后才会触发的异步回调，因此这个引用始终有效。
  let doTeardownImpl: (() => Promise<void>) | null = null
  function triggerTeardown(): void {
    void doTeardownImpl?.()
  }

  /**
   * transport 的 setOnClose 回调主体，被提升到 initBridgeCore 作用域，
   * 这样 /bridge-kick 就能直接触发它。
   * setOnClose 会在外层再包一层 stale-transport guard；debugFireClose 则会裸调它。
   *
   * 当 autoReconnect:true 时，这个回调只会在以下场景触发：
   * 正常关闭（1000）、服务端永久拒绝（4001/1002/4003），
   * 或 10 分钟重连预算耗尽。瞬时断连会由 transport 内部自行重试。
   */
  function handleTransportPermanentClose(closeCode: number | undefined): void {
    logForDebugging(
      `[bridge:repl] Transport permanently closed: code=${closeCode}`,
    )
    logEvent('tengu_bridge_repl_ws_closed', {
      code: closeCode,
    })
    // 在 transport 置空前先抓一遍 SSE seq 的高水位。
    // 若是由 setOnClose 触发，guard 会保证 transport !== null；
    // 若来自 /bridge-kick，则它可能已经是 null 了（例如重复触发），那就直接跳过。
    if (transport) {
      const closedSeq = transport.getLastSequenceNum()
      if (closedSeq > lastTransportSequenceNum) {
        lastTransportSequenceNum = closedSeq
      }
      transport = null
    }
    // transport 已失效，提前唤醒 poll loop 当前的满容量 heartbeat 睡眠，
    // 这样等下面的重连完成、服务端重新排队 work 时，轮询已经切回快速模式。
    wakePollLoop()
    // 重置 flush 状态，让 writeMessages() 命中 !transport 的 guard 并打出 warning，
    // 而不是悄悄把消息排进一个永远不会被 drain 的缓冲区。
    // 与 onWorkReceived 不同，那边会把待发消息留给新 transport；
    // onClose 表示永久关闭，后面不会再有新 transport 来接这些消息。
    const dropped = flushGate.drop()
    if (dropped > 0) {
      logForDebugging(
        `[bridge:repl] Dropping ${dropped} pending message(s) on transport close (code=${closeCode})`,
        { level: 'warn' },
      )
    }

    if (closeCode === 1000) {
      // 正常关闭，说明 session 已正常结束，直接 teardown bridge。
      onStateChange?.('failed', 'session ended')
      pollController.abort()
      triggerTeardown()
      return
    }

    // 这里说明 transport 的重连预算已经耗尽，或被服务端永久拒绝了。
    // 到这个阶段，env 往往已经在服务端被回收，单靠 poll 很难恢复；
    // stopWork(force=false) 也无法把已经归档 env 上的 work 再次分发出来。
    // reconnectEnvironmentWithSession 会尝试通过 POST /bridge/reconnect 把它重新激活，
    // 若 env 真没了，则继续退化为新 session。
    // 上面已经唤醒过 poll loop，等 doReconnect 完成后它就会捞起重新排队的 work。
    onStateChange?.(
      'reconnecting',
      `Remote Control connection lost (code ${closeCode})`,
    )
    logForDebugging(
      `[bridge:repl] Transport reconnect budget exhausted (code=${closeCode}), attempting env reconnect`,
    )
    void reconnectEnvironmentWithSession().then(success => {
      if (success) return
      // doReconnect 内部有多处“teardown 进行中则返回 false”的分支。
      // 用户只是正常退出时，不应污染 BQ 失败信号，也不应重复 teardown。
      if (pollController.signal.aborted) return
      // doReconnect 在真实失败时会返回 false，而不是抛错。
      // 最危险的情形是：registerBridgeEnvironment 成功了
      //（environmentId 已指向一个新的有效 env），但 createSession 失败，
      // 这样 poll loop 会一直对“无 session 的 env”轮询，只拿到 null work 且没有错误，
      // 永远不会命中任何 give-up 路径，因此这里必须显式 teardown。
      logForDebugging(
        '[bridge:repl] reconnectEnvironmentWithSession resolved false — tearing down',
      )
      logEvent('tengu_bridge_repl_reconnect_failed', {
        close_code: closeCode,
      })
      onStateChange?.('failed', 'reconnection failed')
      triggerTeardown()
    })
  }

  // Ant-only：通过 SIGUSR2 强制触发 doReconnect()，便于手工测试。
  // 这样可以跳过大约 30 秒的 poll 等待，直接在 debug log 里观察结果。
  // Windows 没有 USR 信号，因此那边如果调用 `process.on` 会直接抛错。
  let sigusr2Handler: (() => void) | undefined
  if (process.env.USER_TYPE === 'ant' && process.platform !== 'win32') {
    sigusr2Handler = () => {
      logForDebugging(
        '[bridge:repl] SIGUSR2 received — forcing doReconnect() for testing',
      )
      void reconnectEnvironmentWithSession()
    }
    process.on('SIGUSR2', sigusr2Handler)
  }

  // Ant-only：/bridge-kick 故障注入入口。
  // handleTransportPermanentClose 会在下方定义并塞进这个槽位，
  // 这样 slash command 就能直接调用它；真正的 setOnClose 回调埋在
  // onWorkReceived 内部的 wireTransport 里，不方便直接拿到。
  let debugFireClose: ((code: number) => void) | null = null
  if (process.env.USER_TYPE === 'ant') {
    registerBridgeDebugHandle({
      fireClose: code => {
        if (!debugFireClose) {
          logForDebugging('[bridge:debug] fireClose: no transport wired yet')
          return
        }
        logForDebugging(`[bridge:debug] fireClose(${code}) — injecting`)
        debugFireClose(code)
      },
      forceReconnect: () => {
        logForDebugging('[bridge:debug] forceReconnect — injecting')
        void reconnectEnvironmentWithSession()
      },
      injectFault: injectBridgeFault,
      wakePollLoop,
      describe: () =>
        `env=${environmentId} session=${currentSessionId} transport=${transport?.getStateLabel() ?? 'null'} workId=${currentWorkId ?? 'null'}`,
    })
  }

  const pollOpts = {
    api,
    getCredentials: () => ({ environmentId, environmentSecret }),
    signal: pollController.signal,
    getPollIntervalConfig,
    onStateChange,
    getWsState: () => transport?.getStateLabel() ?? 'null',
    // REPL bridge 只服务单个 session，因此只要存在任意 transport 就等价于“已满容量”。
    // 不需要额外检查 isConnectedStatus()：即便 transport 还在内部自动重连
    //（最长 10 分钟），poll 也只是做 heartbeat 维持。
    isAtCapacity: () => transport !== null,
    capacitySignal,
    onFatalError: triggerTeardown,
    getHeartbeatInfo: () => {
      if (!currentWorkId || !currentIngressToken) {
        return null
      }
      return {
        environmentId,
        workId: currentWorkId,
        sessionToken: currentIngressToken,
      }
    },
    // work-item JWT 过期了，或者对应 work 已经失效。
    // 此时 transport 也跟着失去意义，因为 SSE 重连与 CCR 写入都会继续使用同一张旧 token。
    // 如果没有这个回调，poll loop 会以“满容量”模式回退 10 分钟，
    // 期间 work lease（300s TTL）会先过期，服务端也不再转发 prompt，
    // 实际上会形成一个很长的死窗口。
    // 因此这里要直接杀掉 transport 与 work 状态，让 isAtCapacity()=false，
    // 使轮询立刻恢复快速模式，几秒内重新接住服务端重分发的 work。
    onHeartbeatFatal: (err: BridgeFatalError) => {
      logForDebugging(
        `[bridge:repl] heartbeatWork fatal (status=${err.status}) — tearing down work item for fast re-dispatch`,
      )
      if (transport) {
        const seq = transport.getLastSequenceNum()
        if (seq > lastTransportSequenceNum) {
          lastTransportSequenceNum = seq
        }
        transport.close()
        transport = null
      }
      flushGate.drop()
      // force=false 表示让服务端重新排队。
      // work 大概率已经过期，但这里是幂等调用；若还没过期，也能立即促成重新分发。
      if (currentWorkId) {
        void api
          .stopWork(environmentId, currentWorkId, false)
          .catch((e: unknown) => {
            logForDebugging(
              `[bridge:repl] stopWork after heartbeat fatal: ${errorMessage(e)}`,
            )
          })
      }
      currentWorkId = null
      currentIngressToken = null
      wakePollLoop()
      onStateChange?.(
        'reconnecting',
        'Work item lease expired, fetching fresh token',
      )
    },
    async onEnvironmentLost() {
      const success = await reconnectEnvironmentWithSession()
      if (!success) {
        return null
      }
      return { environmentId, environmentSecret }
    },
    onWorkReceived: (
      workSessionId: string,
      ingressToken: string,
      workId: string,
      serverUseCcrV2: boolean,
    ) => {
      // 如果 transport 已经打开时又收到新的 work，说明服务端主动决定重新分发
      //（例如 token 轮转、服务端重启）。
      // 这里应关闭旧 transport 并重连；如果直接把这次 work 丢掉，而旧 WS 又很快死掉，
      // 状态就会卡在“reconnecting”，因为服务端不会再次重发一个它认为已投递过的 work item。
      // ingressToken（JWT）会先保存下来供 heartbeat 使用；
      // transport 层的鉴权策略则分 v1/v2，见下方分支。
      if (transport?.isConnectedStatus()) {
        logForDebugging(
          `[bridge:repl] Work received while transport connected, replacing with fresh token (workId=${workId})`,
        )
      }

      logForDebugging(
        `[bridge:repl] Work received: workId=${workId} workSessionId=${workSessionId} currentSessionId=${currentSessionId} match=${sameSessionId(workSessionId, currentSessionId)}`,
      )

      // 刷新 crash-recovery pointer 的 mtime。
      // 过期判断依赖文件 mtime，而不是文件内嵌时间戳，因此这里重写一次就能刷新时钟；
      // 即使是持续 5 小时以上的 session，只要中途崩掉，也还能保留一个新鲜 pointer。
      // 这个刷新频率不高，只会在每次 work 分发时触发一次。
      void writeBridgePointer(dir, {
        sessionId: currentSessionId,
        environmentId,
        source: 'repl',
      })

      // 拒绝外来的 session ID。服务端不应把其他 environment 下的 session 分给我们；
      // 既然 env 与 session 是成对创建的，只要不匹配，就说明服务端发生了意料外的重绑定。
      //
      // 这里按底层 UUID 比较，而不是按带前缀的 tagged ID 比较。
      // 在 CCR v2 compat 层提供 session 时，createBridgeSession 从 v1 API 拿到的是 session_*，
      // 但基础设施层在 work queue 中投递的是 cse_*；UUID 相同，只是 tag 不同。
      if (!sameSessionId(workSessionId, currentSessionId)) {
        logForDebugging(
          `[bridge:repl] Rejecting foreign session: expected=${currentSessionId} got=${workSessionId}`,
        )
        return
      }

      currentWorkId = workId
      currentIngressToken = ingressToken

      // 服务端按 session 决定是否使用 v2，信号来自 work secret 里的 secret.use_code_sessions，
      // 并通过 runWorkPollLoop 一路传下来。
      // 这里的 env var 只是 ant-dev 用来在服务端 flag 尚未对当前用户打开前，强制体验 v2 的覆盖项；
      // 前提仍然是服务端已经启用 ccr_v2_compat_enabled，否则 registerWorker 会直接 404。
      //
      // 它刻意与 CLAUDE_CODE_USE_CCR_V2 分离，避免 spawn 模式下父进程 orchestrator 的变量
      // 意外泄露到一个本应走 v1 的子进程中。
      const useCcrV2 =
        serverUseCcrV2 || isEnvTruthy(process.env.CLAUDE_BRIDGE_USE_CCR_V2)

      // 鉴权是 v1 与 v2 差异最大的地方：
      //
      // - v1（Session-Ingress）同时接受 OAuth 与 JWT。这里优先选 OAuth，
      //   因为标准 OAuth 刷新链路会自动处理过期问题，不需要再单独维护 JWT 刷新调度器。
      //
      // - v2（CCR /worker/*）则“必须”使用 JWT。register_worker.go:32 会校验 session_id claim，
      //   而 OAuth token 不带这个字段。work secret 中的 JWT 同时具备该 claim 与 worker role。
      //   JWT 过期后，服务端会带着新 token 重新分发 work，于是 onWorkReceived 会再触发一次；
      //   createV2ReplTransport 会在任何网络请求前，先通过 updateSessionIngressAuthToken()
      //   把它存好。
      let v1OauthToken: string | undefined
      if (!useCcrV2) {
        v1OauthToken = getOAuthToken()
        if (!v1OauthToken) {
          logForDebugging(
            '[bridge:repl] No OAuth token available for session ingress, skipping work',
          )
          return
        }
        updateSessionIngressAuthToken(v1OauthToken)
      }
      logEvent('tengu_bridge_repl_work_received', {})

      // 先关闭旧 transport。
      // 必须在调用 close() 前先把引用置空，避免 close 回调把这次程序化关闭误判成
      // “session 正常结束”，进而触发整套 teardown。
      if (transport) {
        const oldTransport = transport
        transport = null
        // 抓取 SSE 序列号高水位，保证下一个 transport 能继续接流，
        // 而不是从 seq 0 重新回放。这里取 max()，防止一个过早死亡、
        // 还没收到任何 frame 的 transport 反过来把非零高水位冲回 0。
        const oldSeq = oldTransport.getLastSequenceNum()
        if (oldSeq > lastTransportSequenceNum) {
          lastTransportSequenceNum = oldSeq
        }
        oldTransport.close()
      }
      // 重置 flush 状态，旧 transport 上那次 flush 若还没跑完也已经失去意义。
      // 同时保留待发消息，让它们在新 transport 完成 flush 后继续 drain；
      // hook 的 lastWrittenIndex 已经前进，不会自行重发这些消息。
      flushGate.deactivate()

      // 对共享的 handleServerControlRequest 做一层闭包适配。
      // 它会捕获 transport/currentSessionId，省掉下方 transport.setOnData
      // 再额外把这些值手动往里传的麻烦。
      const onServerControlRequest = (request: SDKControlRequest): void =>
        handleServerControlRequest(request, {
          transport,
          sessionId: currentSessionId,
          onInterrupt,
          onSetModel,
          onSetMaxThinkingTokens,
          onSetPermissionMode,
        })

      let initialFlushDone = false

      // 给一个全新构造出来的 transport 挂上回调并执行 connect。
      // 单独抽成函数，是为了让同步的 v1 路径与异步的 v2 路径共用完全一致的
      // callback 与 flush 机制。
      const wireTransport = (newTransport: ReplBridgeTransport): void => {
        transport = newTransport

        newTransport.setOnConnect(() => {
          // 防御：如果 WS 还在连接过程中，transport 就已被更新的 onWorkReceived 替换，
          // 那就忽略这个过期回调。
          if (transport !== newTransport) return

          logForDebugging('[bridge:repl] Ingress transport connected')
          logEvent('tengu_bridge_repl_ws_connected', {})

          // 把最新 OAuth token 写回 env var，确保后续 POST 写路径
          //（通过 getSessionIngressAuthToken() 读取）拿到的是新 token。
          // v2 不走这段，因为 createV2ReplTransport 已经写入了 JWT；
          // 若再用 OAuth 覆盖，会把后续 /worker/* 请求直接搞坏。
          if (!useCcrV2) {
            const freshToken = getOAuthToken()
            if (freshToken) {
              updateSessionIngressAuthToken(freshToken)
            }
          }

          // 重置 teardownStarted，避免后续 teardown 被错误阻断。
          teardownStarted = false

          // 初始消息只在“第一次 connect”时 flush，一旦进入 WS 自动重连路径就不能再重复发，
          // 否则会制造重复消息。
          // 关键点在于：onStateChange('connected') 必须延后到 flush 完成之后。
          // 这样既能防止 writeMessages() 把新消息插进历史消息中间，
          // 也能让 web UI 直到历史持久化完成后才把该 session 视为 active。
          if (
            !initialFlushDone &&
            initialMessages &&
            initialMessages.length > 0
          ) {
            initialFlushDone = true

            // 只保留最近 N 条用于初始 flush。
            // 全量历史只对 UI 有意义，模型本身并不会读取；
            // 过大的重放会拖慢 session-ingress 持久化
            //（每条事件都是一次 threadstore 写），也会抬高 Firestore 压力。
            // cap <= 0 表示禁用这个限制。
            const historyCap = initialHistoryCap
            const eligibleMessages = initialMessages.filter(
              m =>
                isEligibleBridgeMessage(m) &&
                !previouslyFlushedUUIDs?.has(m.uuid),
            )
            const cappedMessages =
              historyCap > 0 && eligibleMessages.length > historyCap
                ? eligibleMessages.slice(-historyCap)
                : eligibleMessages
            if (cappedMessages.length < eligibleMessages.length) {
              logForDebugging(
                `[bridge:repl] Capped initial flush: ${eligibleMessages.length} -> ${cappedMessages.length} (cap=${historyCap})`,
              )
              logEvent('tengu_bridge_repl_history_capped', {
                eligible_count: eligibleMessages.length,
                capped_count: cappedMessages.length,
              })
            }
            const sdkMessages = toSDKMessages(cappedMessages)
            if (sdkMessages.length > 0) {
              logForDebugging(
                `[bridge:repl] Flushing ${sdkMessages.length} initial message(s) via transport`,
              )
              const events = sdkMessages.map(sdkMsg => ({
                ...sdkMsg,
                session_id: currentSessionId,
              }))
              const dropsBefore = newTransport.droppedBatchCount
              void newTransport
                .writeBatch(events)
                .then(() => {
                  // 如果这次 flush 期间有 batch 因连续失败被丢弃，
                  // flush() 依然会正常 resolve，但事件实际上并没有送达。
                  // 此时绝不能把这些 UUID 标记成 flushed，
                  // 必须让它们在下一次 onWorkReceived 时仍可重发。
                  if (newTransport.droppedBatchCount > dropsBefore) {
                    logForDebugging(
                      `[bridge:repl] Initial flush dropped ${newTransport.droppedBatchCount - dropsBefore} batch(es) — not marking ${sdkMessages.length} UUID(s) as flushed`,
                    )
                    return
                  }
                  if (previouslyFlushedUUIDs) {
                    for (const sdkMsg of sdkMessages) {
                      if (sdkMsg.uuid) {
                        previouslyFlushedUUIDs.add(sdkMsg.uuid)
                      }
                    }
                  }
                })
                .catch(e =>
                  logForDebugging(`[bridge:repl] Initial flush failed: ${e}`),
                )
                .finally(() => {
                  // 防御：如果 flush 期间 transport 已被替换，
                  // 就不要再 signal connected 或 drain 了，生命周期已经归新 transport 接管。
                  if (transport !== newTransport) return
                  drainFlushGate()
                  onStateChange?.('connected')
                })
            } else {
              // 所有初始消息都已经 flush 过了（被 previouslyFlushedUUIDs 过滤掉），
              // 因此不需要再发 flush POST，直接清掉标记并立刻 signal connected。
              // 当前仍是该 transport 的首次 connect（处在 !initialFlushDone 分支内），
              // 不存在任何在途 flush POST，因此这里必须主动把标记清掉。
              drainFlushGate()
              onStateChange?.('connected')
            }
          } else if (!flushGate.active) {
            // 没有初始消息，或首次 connect 时已经 flush 过。
            // 这里属于 WS 自动重连路径：只有在没有 flush POST 在途时才 signal connected；
            // 如果有，就让 .finally() 接管生命周期。
            onStateChange?.('connected')
          }
        })

        newTransport.setOnData(data => {
          handleIngressMessage(
            data,
            recentPostedUUIDs,
            recentInboundUUIDs,
            onInboundMessage,
            onPermissionResponse,
            onServerControlRequest,
          )
        })

        // 这段逻辑被放在 initBridgeCore 作用域里，
        // 这样 /bridge-kick 就能通过 debugFireClose 直接调用它。
        // 它依赖的闭包（transport、wakePollLoop、flushGate、reconnectEnvironmentWithSession 等）
        // 本来也都在这一层。原先唯一依赖 wireTransport 局部作用域的是
        // `newTransport.getLastSequenceNum()`，但一旦下面的 guard 通过，
        // 我们就已经知道 transport === newTransport。
        debugFireClose = handleTransportPermanentClose
        newTransport.setOnClose(closeCode => {
          // 防御：如果 transport 已被替换，则忽略这个过期 close 事件。
          if (transport !== newTransport) return
          handleTransportPermanentClose(closeCode)
        })

        // 在 connect() 之前就开启 flush gate，用于覆盖 WS handshake 窗口。
        // 从 transport 赋值到 setOnConnect 真正触发之间，writeMessages() 可能已经
        // 先通过 HTTP POST 发送消息，抢在初始 flush 之前到达服务端。
        // 提前打开 gate 可以把这些调用先排队；如果本来就没有初始消息，gate 会保持不激活。
        if (
          !initialFlushDone &&
          initialMessages &&
          initialMessages.length > 0
        ) {
          flushGate.start()
        }

        newTransport.connect()
      } // end wireTransport

      // 无条件递增：只要出现任何新 transport（无论 v1 还是 v2），
      // 当前进行中的 v2 握手都应被视为失效。doReconnect() 里也会做同样处理。
      v2Generation++

      if (useCcrV2) {
        // workSessionId 使用的是 cse_* 形式，即 work queue 里给出的基础设施层 ID；
        // 这正是 /v1/code/sessions/{id}/worker/* 所要求的格式。
        // currentSessionId 那种 session_* 形式在这里不可用，
        // 因为 handler/convert.go:30 会校验 TagCodeSession。
        const sessionUrl = buildCCRv2SdkUrl(baseUrl, workSessionId)
        const thisGen = v2Generation
        logForDebugging(
          `[bridge:repl] CCR v2: sessionUrl=${sessionUrl} session=${workSessionId} gen=${thisGen}`,
        )
        void createV2ReplTransport({
          sessionUrl,
          ingressToken,
          sessionId: workSessionId,
          initialSequenceNum: lastTransportSequenceNum,
        }).then(
          t => {
            // registerWorker 还在飞行中时，teardown 已经启动了。
            // teardown 当时看到 transport === null，因此不会 close；
            // 若现在继续安装这个 transport，就会泄露 CCRClient 的 heartbeat timer，
            // 还会通过 wireTransport 的副作用把 teardownStarted 错误重置掉。
            if (pollController.signal.aborted) {
              t.close()
              return
            }
            // registerWorker() 执行期间，onWorkReceived 可能已经再次触发
            //（服务端用新 JWT 重分发 work）。当两次尝试都看到 transport === null 时，
            // 单靠 transport !== null 判断会保留“先 resolve 的那个”，也就是过期 epoch；
            // generation 检查则能不依赖 transport 状态，正确识别并丢弃旧结果。
            if (thisGen !== v2Generation) {
              logForDebugging(
                `[bridge:repl] CCR v2: discarding stale handshake gen=${thisGen} current=${v2Generation}`,
              )
              t.close()
              return
            }
            wireTransport(t)
          },
          (err: unknown) => {
            logForDebugging(
              `[bridge:repl] CCR v2: createV2ReplTransport failed: ${errorMessage(err)}`,
              { level: 'error' },
            )
            logEvent('tengu_bridge_repl_ccr_v2_init_failed', {})
            // 如果更新的一次尝试已经在路上，或者已经成功，
            // 就不要再碰它的 work item 了；我们这次失败已经无关紧要。
            if (thisGen !== v2Generation) return
            // 释放当前 work item，让服务端立刻重新分发，
            // 而不是等它自己的超时器慢慢触发。currentWorkId 已在上面写入；
            // 如果这里不放，用户看到的 session 就会像是卡死了。
            if (currentWorkId) {
              void api
                .stopWork(environmentId, currentWorkId, false)
                .catch((e: unknown) => {
                  logForDebugging(
                    `[bridge:repl] stopWork after v2 init failure: ${errorMessage(e)}`,
                  )
                })
              currentWorkId = null
              currentIngressToken = null
            }
            wakePollLoop()
          },
        )
      } else {
        // v1 路径：HybridTransport（WS 读 + POST 写到 Session-Ingress）。
        // autoReconnect 默认开启，WS 挂掉后 transport 会带指数退避自动重连。
        // POST 写路径不受影响，它独立读取 getSessionIngressAuthToken()，
        // 因此即便 WS 断开也能继续发。若 10 分钟重连预算耗尽，poll loop 才会作为二级兜底。
        //
        // 鉴权方面，v1 直接使用 OAuth token，而不是 work secret 中的 JWT；
        // refreshHeaders 会在每次 WS 重连时重新取最新 OAuth token。
        const wsUrl = buildSdkUrl(sessionIngressUrl, workSessionId)
        logForDebugging(`[bridge:repl] Ingress URL: ${wsUrl}`)
        logForDebugging(
          `[bridge:repl] Creating HybridTransport: session=${workSessionId}`,
        )
        // v1OauthToken 在上面已经验证过非空，否则早就提前 return 了。
        const oauthToken = v1OauthToken ?? ''
        wireTransport(
          createV1ReplTransport(
            new HybridTransport(
              new URL(wsUrl),
              {
                Authorization: `Bearer ${oauthToken}`,
                'anthropic-version': '2023-06-01',
              },
              workSessionId,
              () => ({
                Authorization: `Bearer ${getOAuthToken() ?? oauthToken}`,
                'anthropic-version': '2023-06-01',
              }),
              // 给重试次数设上限，避免一个长期失败的 session-ingress 把 uploader 的 drain loop
              // 整个 bridge 生命周期都钉死。50 次大约对应 20 分钟量级。
              // 这是 bridge 专用策略；1P 路径仍保持无限重试。
              {
                maxConsecutiveFailures: 50,
                isBridge: true,
                onBatchDropped: () => {
                  onStateChange?.(
                    'reconnecting',
                    'Lost sync with Remote Control — events could not be delivered',
                  )
                  // SI 已经宕了大约 20 分钟，唤醒 poll loop。
                  // 这样一旦 SI 恢复，下一次 poll -> onWorkReceived -> 新 transport
                  // -> 初始 flush 成功 -> onStateChange('connected') 整条链路就能尽快恢复。
                  // 否则即便 SI 已经恢复，状态也可能一直停留在 'reconnecting'。
                  // 如果 outage 期间 env 已被归档，则 poll 404 会自动走 onEnvironmentLost 的恢复路径。
                  wakePollLoop()
                },
              },
            ),
          ),
        )
      }
    },
  }
  void startWorkPollLoop(pollOpts)

  // perpetual 模式下，每小时刷新一次 crash-recovery pointer 的 mtime。
  // onWorkReceived 的刷新频率取决于用户 prompt；如果 daemon 空闲超过 4 小时，
  // pointer 会变旧，下一次重启时就会在 readBridgePointer 的 TTL 检查中被清掉，
  // 最终退化成新 session。独立 bridge（bridgeMain.ts）也有同样的小时级定时器。
  const pointerRefreshTimer = perpetual
    ? setInterval(() => {
        // doReconnect() 对 currentSessionId/environmentId 的更新不是原子的，
        // 中间还夹着若干 await。
        // 若这个定时器恰好在那段窗口里触发，它的 fire-and-forget 写入就可能与
        // doReconnect 自己的 pointer 写入竞态，最终把 pointer 又写回已归档的旧 session。
        // 既然 doReconnect 本身会负责改 pointer，这里直接跳过就是最安全的。
        if (reconnectPromise) return
        void writeBridgePointer(dir, {
          sessionId: currentSessionId,
          environmentId,
          source: 'repl',
        })
      }, 60 * 60_000)
    : null
  pointerRefreshTimer?.unref?.()

  // 按固定间隔发送一个静默 keep_alive frame，避免上游代理或 session-ingress 层
  // 把一个本来只是空闲的 remote control session 提前 GC 掉。
  // keep_alive 类型在到达任何客户端 UI 前都会被过滤掉
  //（Query.ts 会丢弃它，web/iOS/Android 也不会在消息循环里看到它）。
  // 间隔值来自 GrowthBook 配置
  //（tengu_bridge_poll_interval_config.session_keepalive_interval_v2_ms，默认 120 秒）；
  // 设为 0 表示禁用。
  const keepAliveIntervalMs =
    getPollIntervalConfig().session_keepalive_interval_v2_ms
  const keepAliveTimer =
    keepAliveIntervalMs > 0
      ? setInterval(() => {
          if (!transport) return
          logForDebugging('[bridge:repl] keep_alive sent')
          void transport.write({ type: 'keep_alive' }).catch((err: unknown) => {
            logForDebugging(
              `[bridge:repl] keep_alive write failed: ${errorMessage(err)}`,
            )
          })
        }, keepAliveIntervalMs)
      : null
  keepAliveTimer?.unref?.()

  // cleanup 注册与返回 handle 上显式 teardown() 方法共用的 teardown 流程。
  let teardownStarted = false
  doTeardownImpl = async (): Promise<void> => {
    if (teardownStarted) {
      logForDebugging(
        `[bridge:repl] Teardown already in progress, skipping duplicate call env=${environmentId} session=${currentSessionId}`,
      )
      return
    }
    teardownStarted = true
    const teardownStart = Date.now()
    logForDebugging(
      `[bridge:repl] Teardown starting: env=${environmentId} session=${currentSessionId} workId=${currentWorkId ?? 'none'} transportState=${transport?.getStateLabel() ?? 'null'}`,
    )

    if (pointerRefreshTimer !== null) {
      clearInterval(pointerRefreshTimer)
    }
    if (keepAliveTimer !== null) {
      clearInterval(keepAliveTimer)
    }
    if (sigusr2Handler) {
      process.off('SIGUSR2', sigusr2Handler)
    }
    if (process.env.USER_TYPE === 'ant') {
      clearBridgeDebugHandle()
      debugFireClose = null
    }
    pollController.abort()
    logForDebugging('[bridge:repl] Teardown: poll loop aborted')

    // 必须在 close() 之前抓取“当前活跃 transport”的 seq。
    // close() 是同步的（只会中止 SSE fetch），而且不会触发 onClose，
    // 因此显式 teardown 不会经过 setOnClose 那条抓 seq 的路径。
    // 否则 teardown 之后 getSSESequenceNum() 只能拿到上一次 transport 交换时留下的旧值，
    // daemon 调用方把这个值持久化后，会丢掉从那以后到现在的所有事件。
    if (transport) {
      const finalSeq = transport.getLastSequenceNum()
      if (finalSeq > lastTransportSequenceNum) {
        lastTransportSequenceNum = finalSeq
      }
    }

    if (perpetual) {
      // perpetual 模式下的 teardown 仅在本地生效。
      // 不发送 result，不调用 stopWork，也不关闭 transport，
      // 因为这些动作都会向服务端以及所有 attach/mobile 订阅方明确宣告“session 正在结束”。
      // 正确做法是停止轮询，让 socket 随进程死亡；后端会自行把 work-item lease
      // 在 TTL 300 秒后退回 pending。下一次 daemon 启动时，读取 pointer 再走
      // reconnectSession 就能把 work 重新排队。
      transport = null
      flushGate.drop()
      // 刷新 pointer 的 mtime，避免运行超过 BRIDGE_POINTER_TTL_MS（4 小时）的 session
      // 在下次启动时被误判为 stale。
      await writeBridgePointer(dir, {
        sessionId: currentSessionId,
        environmentId,
        source: 'repl',
      })
      logForDebugging(
        `[bridge:repl] Teardown (perpetual): leaving env=${environmentId} session=${currentSessionId} alive on server, duration=${Date.now() - teardownStart}ms`,
      )
      return
    }

    // 先发 result message，再 archive，最后才 close。
    // transport.write() 只负责入队；真正 result POST 的发送窗口来自 stopWork/archive
    // 那段约 200-500ms 的延迟。若在 archive 之前先 close，只能寄希望于
    // HybridTransport 那个没人 await 的 3 秒 grace period；forceExit 一来，
    // socket 可能直接在 POST 中途被杀掉。这里与 remoteBridgeCore.ts teardown 采用相同重排。
    const teardownTransport = transport
    transport = null
    flushGate.drop()
    if (teardownTransport) {
      void teardownTransport.write(makeResultMessage(currentSessionId))
    }

    const stopWorkP = currentWorkId
      ? api
          .stopWork(environmentId, currentWorkId, true)
          .then(() => {
            logForDebugging('[bridge:repl] Teardown: stopWork completed')
          })
          .catch((err: unknown) => {
            logForDebugging(
              `[bridge:repl] Teardown stopWork failed: ${errorMessage(err)}`,
            )
          })
      : Promise.resolve()

    // stopWork 与 archiveSession 并行执行。
    // gracefulShutdown.ts:407 实际上是拿 runCleanupFunctions() 与 2 秒做竞速，
    // 不是外层那个 5 秒 failsafe；因此 archive 在注入点被限制到 1.5 秒以内。
    // archiveSession 按契约不会抛错，各个注入实现会在内部自行记录成功或失败。
    await Promise.all([stopWorkP, archiveSession(currentSessionId)])

    teardownTransport?.close()
    logForDebugging('[bridge:repl] Teardown: transport closed')

    await api.deregisterEnvironment(environmentId).catch((err: unknown) => {
      logForDebugging(
        `[bridge:repl] Teardown deregister failed: ${errorMessage(err)}`,
      )
    })

    // 清掉 crash-recovery pointer。
    // 显式断开或干净退出 REPL，说明用户确实结束了这个 session；
    // 只有 crash/kill -9 才不会走到这里，从而把 pointer 留给下次启动恢复。
    await clearBridgePointer(dir)

    logForDebugging(
      `[bridge:repl] Teardown complete: env=${environmentId} duration=${Date.now() - teardownStart}ms`,
    )
  }

  // 8. Register cleanup for graceful shutdown
  const unregister = registerCleanup(() => doTeardownImpl?.())

  logForDebugging(
    `[bridge:repl] Ready: env=${environmentId} session=${currentSessionId}`,
  )
  onStateChange?.('ready')

  return {
    get bridgeSessionId() {
      return currentSessionId
    },
    get environmentId() {
      return environmentId
    },
    getSSESequenceNum() {
      // lastTransportSequenceNum 只会在 transport 关闭时更新
      //（即 swap/onClose 的捕获点）。正常运行期间，当前 transport 的实时 seq
      // 并不会自动反映到那里，因此这里要把两者合并，给调用方真正的高水位值。
      const live = transport?.getLastSequenceNum() ?? 0
      return Math.max(lastTransportSequenceNum, live)
    },
    sessionIngressUrl,
    writeMessages(messages) {
      // 只保留那些尚未发送过的 user/assistant 消息。
      // 这里有两层去重：
      //  - initialMessageUUIDs：作为 session 创建事件发送过的消息
      //  - recentPostedUUIDs：近期通过 POST 发过的消息
      const filtered = messages.filter(
        m =>
          isEligibleBridgeMessage(m) &&
          !initialMessageUUIDs.has(m.uuid) &&
          !recentPostedUUIDs.has(m.uuid),
      )
      if (filtered.length === 0) return

      // 为标题推导触发 onUserMessage。
      // 这一步必须发生在 flushGate 检查之前，因为即便 prompt 只是先排队等待初始历史 flush，
      // 它依然有资格参与标题推导。只要回调还没返回 true，就会持续对每条合格消息调用它；
      // 具体停止策略由调用方自己决定。
      if (!userMessageCallbackDone) {
        for (const m of filtered) {
          const text = extractTitleText(m)
          if (text !== undefined && onUserMessage?.(text, currentSessionId)) {
            userMessageCallbackDone = true
            break
          }
        }
      }

      // 初始 flush 尚未完成时，把消息先排队，避免它们与历史消息交错到达服务端。
      if (flushGate.enqueue(...filtered)) {
        logForDebugging(
          `[bridge:repl] Queued ${filtered.length} message(s) during initial flush`,
        )
        return
      }

      if (!transport) {
        const types = filtered.map(m => m.type).join(',')
        logForDebugging(
          `[bridge:repl] Transport not configured, dropping ${filtered.length} message(s) [${types}] for session=${currentSessionId}`,
          { level: 'warn' },
        )
        return
      }

      // 先记入有界环形缓冲区，用于后续 echo 过滤与去重。
      for (const msg of filtered) {
        recentPostedUUIDs.add(msg.uuid)
      }

      logForDebugging(
        `[bridge:repl] Sending ${filtered.length} message(s) via transport`,
      )

      // 转成 SDK 格式后通过 HTTP POST（HybridTransport）发送。
      // web UI 会通过 subscribe WebSocket 收到这些消息。
      const sdkMessages = toSDKMessages(filtered)
      const events = sdkMessages.map(sdkMsg => ({
        ...sdkMsg,
        session_id: currentSessionId,
      }))
      void transport.writeBatch(events)
    },
    writeSdkMessages(messages) {
      // daemon 路径里，query() 本来就直接产出 SDKMessage，因此不需要再转换。
      // 但 echo 去重仍要继续做，因为服务端会把写入经 WS 回弹回来。
      // daemon 没有 initial messages，也不会启动 flushGate。
      const filtered = messages.filter(
        m => !m.uuid || !recentPostedUUIDs.has(m.uuid),
      )
      if (filtered.length === 0) return
      if (!transport) {
        logForDebugging(
          `[bridge:repl] Transport not configured, dropping ${filtered.length} SDK message(s) for session=${currentSessionId}`,
          { level: 'warn' },
        )
        return
      }
      for (const msg of filtered) {
        if (msg.uuid) recentPostedUUIDs.add(msg.uuid)
      }
      const events = filtered.map(m => ({ ...m, session_id: currentSessionId }))
      void transport.writeBatch(events)
    },
    sendControlRequest(request: SDKControlRequest) {
      if (!transport) {
        logForDebugging(
          '[bridge:repl] Transport not configured, skipping control_request',
        )
        return
      }
      const event = { ...request, session_id: currentSessionId }
      void transport.write(event)
      logForDebugging(
        `[bridge:repl] Sent control_request request_id=${request.request_id}`,
      )
    },
    sendControlResponse(response: SDKControlResponse) {
      if (!transport) {
        logForDebugging(
          '[bridge:repl] Transport not configured, skipping control_response',
        )
        return
      }
      const event = { ...response, session_id: currentSessionId }
      void transport.write(event)
      logForDebugging('[bridge:repl] Sent control_response')
    },
    sendControlCancelRequest(requestId: string) {
      if (!transport) {
        logForDebugging(
          '[bridge:repl] Transport not configured, skipping control_cancel_request',
        )
        return
      }
      const event = {
        type: 'control_cancel_request' as const,
        request_id: requestId,
        session_id: currentSessionId,
      }
      void transport.write(event)
      logForDebugging(
        `[bridge:repl] Sent control_cancel_request request_id=${requestId}`,
      )
    },
    sendResult() {
      if (!transport) {
        logForDebugging(
          `[bridge:repl] sendResult: skipping, transport not configured session=${currentSessionId}`,
        )
        return
      }
      void transport.write(makeResultMessage(currentSessionId))
      logForDebugging(
        `[bridge:repl] Sent result for session=${currentSessionId}`,
      )
    },
    async teardown() {
      unregister()
      await doTeardownImpl?.()
      logForDebugging('[bridge:repl] Torn down')
      logEvent('tengu_bridge_repl_teardown', {})
    },
  }
}

/**
 * 持续运行的 work item poll loop。
 * 它会在整个 bridge 连接生命周期内于后台运行。
 *
 * 当有 work item 到来时，它会先确认接收，再带着 session ID 与 ingress token
 * 调用 onWorkReceived（由后者负责建立 ingress WebSocket）。
 * 之后轮询不会停止；如果 ingress WebSocket 断开，服务端会再下发新的 work item，
 * 从而在不 teardown bridge 的前提下实现自动重连。
 */
async function startWorkPollLoop({
  api,
  getCredentials,
  signal,
  onStateChange,
  onWorkReceived,
  onEnvironmentLost,
  getWsState,
  isAtCapacity,
  capacitySignal,
  onFatalError,
  getPollIntervalConfig = () => DEFAULT_POLL_CONFIG,
  getHeartbeatInfo,
  onHeartbeatFatal,
}: {
  api: BridgeApiClient
  getCredentials: () => { environmentId: string; environmentSecret: string }
  signal: AbortSignal
  onStateChange?: (state: BridgeState, detail?: string) => void
  onWorkReceived: (
    sessionId: string,
    ingressToken: string,
    workId: string,
    useCodeSessions: boolean,
  ) => void
  /** environment 被删除时调用。返回新的凭据，或返回 null。 */
  onEnvironmentLost?: () => Promise<{
    environmentId: string
    environmentSecret: string
  } | null>
  /** 返回当前 WebSocket 的 readyState 标签，供诊断日志使用。 */
  getWsState?: () => string
  /**
   * 当调用方无法再接收新 work（例如 transport 已连接）时返回 true。
   * 一旦如此，loop 就会按 at-capacity 配置间隔仅做 heartbeat 轮询。
   * 服务端的 BRIDGE_LAST_POLL_TTL 为 4 小时，因此任何短于它的间隔都足以维持活性。
   */
  isAtCapacity?: () => boolean
  /**
   * 生成一个在容量恢复可用（例如 transport 丢失）时会 abort 的 signal，
   * 并与 loop 自身 signal 合并。它用于打断 at-capacity sleep，
   * 让恢复用轮询可以立即开始。
   */
  capacitySignal?: () => CapacitySignal
  /** 在不可恢复错误（例如服务端过期）上调用，触发完整 teardown。 */
  onFatalError?: () => void
  /** 轮询间隔配置 getter，默认返回 DEFAULT_POLL_CONFIG。 */
  getPollIntervalConfig?: () => PollIntervalConfig
  /**
   * 返回当前用于 heartbeat 的 work ID 与 session ingress token。
   * 返回 null 表示当前无法执行 heartbeat（没有活跃 work item）。
   */
  getHeartbeatInfo?: () => {
    environmentId: string
    workId: string
    sessionToken: string
  } | null
  /**
   * 当 heartbeatWork 抛出 BridgeFatalError（401/403/404/410）时调用，
   * 这通常意味着 JWT 已过期或 work item 已消失。
   * 调用方应清掉 transport 与 work 状态，让 isAtCapacity() 变成 false，
   * 这样 loop 就能快速轮询并接住服务端重新分发的 work item。
   * 若提供该回调，loop 会跳过 at-capacity backoff sleep；
   * 若未提供，则仍回退到 backoff sleep，避免形成紧密的 poll+heartbeat 死循环。
   */
  onHeartbeatFatal?: (err: BridgeFatalError) => void
}): Promise<void> {
  const MAX_ENVIRONMENT_RECREATIONS = 3

  logForDebugging(
    `[bridge:repl] Starting work poll loop for env=${getCredentials().environmentId}`,
  )

  let consecutiveErrors = 0
  let firstErrorTime: number | null = null
  let lastPollErrorTime: number | null = null
  let environmentRecreations = 0
  // 当 at-capacity sleep 严重超时（通常意味着进程被挂起）时置为 true。
  // 下一轮循环顶部会读取并清掉它，用来强制执行一次快速轮询。
  // 否则由于 isAtCapacity() 只是 `transport !== null`，在 transport 自动重连期间它仍为 true，
  // loop 就会再次直接睡回 10 分钟，而这时 transport 可能已经指向死 socket。
  let suspensionDetected = false

  while (!signal.aborted) {
    // 在 try 外先抓一份凭据，方便 catch 块判断是否有并发重连已经替换了 environment。
    const { environmentId: envId, environmentSecret: envSecret } =
      getCredentials()
    const pollConfig = getPollIntervalConfig()
    try {
      const work = await api.pollForWork(
        envId,
        envSecret,
        signal,
        pollConfig.reclaim_older_than_ms,
      )

      // poll 成功就说明 env 当前确实健康，应重置 env-loss 计数器，
      // 让几个小时后再发生的事件重新从新预算开始。
      // 它放在下面 state-change guard 之外，是因为 onEnvLost 的成功路径本来就会发 'ready'，
      // 这里再发一次会重复。
      // 注意：onEnvLost 仅返回 creds 并不代表 env 已健康，不能在那一步重置计数器，
      // 否则新 env 立刻再死掉时会破坏振荡保护。
      environmentRecreations = 0

      // poll 成功后，重置错误追踪状态。
      if (consecutiveErrors > 0) {
        logForDebugging(
          `[bridge:repl] Poll recovered after ${consecutiveErrors} consecutive error(s)`,
        )
        consecutiveErrors = 0
        firstErrorTime = null
        lastPollErrorTime = null
        onStateChange?.('ready')
      }

      if (!work) {
        // 读出并清空 suspension 标记。
        // 一旦检测到进程挂起，下一次要“仅一次”跳过 at-capacity 分支。
        // 上面的 pollForWork 已经刷新过服务端 BRIDGE_LAST_POLL_TTL，
        // 这一轮快速循环是为了给任何重新分发的 work item 一个落地机会，
        // 然后再重新回到 at-capacity 节奏。
        const skipAtCapacityOnce = suspensionDetected
        suspensionDetected = false
        if (isAtCapacity?.() && capacitySignal && !skipAtCapacityOnce) {
          const atCapMs = pollConfig.poll_interval_ms_at_capacity
          // 这里 heartbeat 会在“不额外 poll”的情况下单独循环。
          // 若同时也启用了 at-capacity polling（atCapMs > 0），
          // 则会在内部维护一个 deadline，到时跳出去执行 poll，
          // 让 heartbeat 与 poll 叠加，而不是互相压制。
          // 跳出条件包括：
          //   - poll 截止时间到达（仅在 atCapMs > 0 时）
          //   - 鉴权失败（JWT 过期，需要 poll 获取新 token）
          //   - capacity wake 触发（transport 丢失，需要 poll 新 work）
          //   - heartbeat 配置被关闭（GrowthBook 更新）
          //   - loop 被中止（shutdown）
          if (
            pollConfig.non_exclusive_heartbeat_interval_ms > 0 &&
            getHeartbeatInfo
          ) {
            logEvent('tengu_bridge_heartbeat_mode_entered', {
              heartbeat_interval_ms:
                pollConfig.non_exclusive_heartbeat_interval_ms,
            })
            // deadline 只在进入时计算一次。
            // 若 GrowthBook 中途更新 atCapMs，不会影响当前这轮 deadline，
            // 下一次进入循环才会读到新值。
            const pollDeadline = atCapMs > 0 ? Date.now() + atCapMs : null
            let needsBackoff = false
            let hbCycles = 0
            while (
              !signal.aborted &&
              isAtCapacity() &&
              (pollDeadline === null || Date.now() < pollDeadline)
            ) {
              const hbConfig = getPollIntervalConfig()
              if (hbConfig.non_exclusive_heartbeat_interval_ms <= 0) break

              const info = getHeartbeatInfo()
              if (!info) break

              // 在异步 heartbeat 调用前先抓取 capacity signal，
              // 这样若 HTTP 请求期间 transport 丢失，后续 sleep 就能及时感知到。
              const cap = capacitySignal()

              try {
                await api.heartbeatWork(
                  info.environmentId,
                  info.workId,
                  info.sessionToken,
                )
              } catch (err) {
                logForDebugging(
                  `[bridge:repl:heartbeat] Failed: ${errorMessage(err)}`,
                )
                if (err instanceof BridgeFatalError) {
                  cap.cleanup()
                  logEvent('tengu_bridge_heartbeat_error', {
                    status:
                      err.status as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    error_type: (err.status === 401 || err.status === 403
                      ? 'auth_failed'
                      : 'fatal') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  })
                  // JWT 已过期（401/403）或 work item 已消失（404/410）。
                  // 无论哪种情况，当前 transport 都已经失效，因为 SSE 重连与 CCR 写入
                  // 仍会继续使用同一张旧 token。
                  // 若调用方提供了恢复 hook，就立刻清掉 work 状态并跳过 backoff，
                  // 让下一次外层循环快速轮询服务端重新分发的 work item；
                  // 否则只能回退到 backoff，避免形成过紧的 poll+heartbeat 循环。
                  if (onHeartbeatFatal) {
                    onHeartbeatFatal(err)
                    logForDebugging(
                      `[bridge:repl:heartbeat] Fatal (status=${err.status}), work state cleared — fast-polling for re-dispatch`,
                    )
                  } else {
                    needsBackoff = true
                  }
                  break
                }
              }

              hbCycles++
              await sleep(
                hbConfig.non_exclusive_heartbeat_interval_ms,
                cap.signal,
              )
              cap.cleanup()
            }

            const exitReason = needsBackoff
              ? 'error'
              : signal.aborted
                ? 'shutdown'
                : !isAtCapacity()
                  ? 'capacity_changed'
                  : pollDeadline !== null && Date.now() >= pollDeadline
                    ? 'poll_due'
                    : 'config_disabled'
            logEvent('tengu_bridge_heartbeat_mode_exited', {
              reason:
                exitReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              heartbeat_cycles: hbCycles,
            })

            // 遇到 auth_failed 或其他 fatal 情况时，
            // 在重新 poll 前先执行一次 backoff，避免形成紧密的 poll+heartbeat 循环。
            // 这里复用下方同一套 capacitySignal 包裹的 sleep，
            // 这样挂起超时检测逻辑也能被两条路径共享。
            if (!needsBackoff) {
              if (exitReason === 'poll_due') {
                // bridgeApi 会节流 empty-poll 日志，
                // 导致这种每 10 分钟一次的 poll_due 轮询在计数器上并不明显。
                // 这里额外打一条日志，方便验证时确认两个端点都真的在工作。
                logForDebugging(
                  `[bridge:repl] Heartbeat poll_due after ${hbCycles} cycles — falling through to pollForWork`,
                )
              }
              continue
            }
          }
          // at-capacity sleep 会被两条路径共用：
          // 旧逻辑（heartbeat 关闭）与 heartbeat-backoff 路径（needsBackoff=true）。
          // 合并后，挂起检测器就能同时覆盖两者；此前 backoff 路径没有 overrun 检查，
          // 笔记本唤醒后可能直接又睡回 10 分钟。
          // 若启用了 atCapMs 就用它，否则退回 heartbeat interval 作为下限，
          // 避免“只有 heartbeat 配置”时进入紧密循环。
          const sleepMs =
            atCapMs > 0
              ? atCapMs
              : pollConfig.non_exclusive_heartbeat_interval_ms
          if (sleepMs > 0) {
            const cap = capacitySignal()
            const sleepStart = Date.now()
            await sleep(sleepMs, cap.signal)
            cap.cleanup()
            // 进程挂起检测器。
            // 如果一个 setTimeout 比预期时间多睡了 60 秒以上，
            // 那几乎可以确定进程经历了挂起（合盖、SIGSTOP、VM 暂停等）；
            // 就算是极端 GC pause，也通常是秒级而非分钟级。
            // 若是被提前 abort（例如 wakePollLoop -> cap.signal），
            // overrun 会小于 0，并自然落入后续分支。
            // 这个检测器只能抓到“超过原定截止时间”的睡眠；更短的挂起仍主要依赖
            // WebSocketTransport 的 ping interval 检测。这里更像是后备保险。
            const overrun = Date.now() - sleepStart - sleepMs
            if (overrun > 60_000) {
              logForDebugging(
                `[bridge:repl] At-capacity sleep overran by ${Math.round(overrun / 1000)}s — process suspension detected, forcing one fast-poll cycle`,
              )
              logEvent('tengu_bridge_repl_suspension_detected', {
                overrun_ms: overrun,
              })
              suspensionDetected = true
            }
          }
        } else {
          await sleep(pollConfig.poll_interval_ms_not_at_capacity, signal)
        }
        continue
      }

      // 在按类型分发前先解码，因为显式 ack 需要用到 JWT。
      let secret
      try {
        secret = decodeWorkSecret(work.secret)
      } catch (err) {
        logForDebugging(
          `[bridge:repl] Failed to decode work secret: ${errorMessage(err)}`,
        )
        logEvent('tengu_bridge_repl_work_secret_failed', {})
        // 无法 ack，因为 ack 依赖那张没解码出来的 JWT；而 stopWork 走的是 OAuth。
        // 这里能避免 XAUTOCLAIM 在每轮都把这个坏 work 重新投递回来。
        await api.stopWork(envId, work.id, false).catch(() => {})
        continue
      }

      // 显式 ack，防止 work 被重复投递。
      // ack 失败并不是致命错误：服务端会再次重投，onWorkReceived 里本身就有去重逻辑。
      logForDebugging(`[bridge:repl] Acknowledging workId=${work.id}`)
      try {
        await api.acknowledgeWork(envId, work.id, secret.session_ingress_token)
      } catch (err) {
        logForDebugging(
          `[bridge:repl] Acknowledge failed workId=${work.id}: ${errorMessage(err)}`,
        )
      }

      if (work.data.type === 'healthcheck') {
        logForDebugging('[bridge:repl] Healthcheck received')
        continue
      }

      if (work.data.type === 'session') {
        const workSessionId = work.data.id
        try {
          validateBridgeId(workSessionId, 'session_id')
        } catch {
          logForDebugging(
            `[bridge:repl] Invalid session_id in work: ${workSessionId}`,
          )
          continue
        }

        onWorkReceived(
          workSessionId,
          secret.session_ingress_token,
          work.id,
          secret.use_code_sessions === true,
        )
        logForDebugging('[bridge:repl] Work accepted, continuing poll loop')
      }
    } catch (err) {
      if (signal.aborted) break

      // 检测“environment 已被删除”这种永久错误，单纯重试无法恢复，
      // 必须重新注册新 environment。
      // 这里要放在通用 BridgeFatalError 分支之前处理。
      // pollForWork 使用 validateStatus: s => s < 500，因此 404 一定会先被 handleErrorStatus()
      // 包装成 BridgeFatalError，而不是 axios 风格错误对象。
      // poll 端点唯一的路径参数就是 env ID，因此 404 可以明确解释为 env 已不存在；
      // “没有 work”则是 200 + null body。服务端发回的 error.type 虽然是标准的
      // not_found_error，但真正可靠且能跨 body 结构变化长期稳定的信号仍是 status===404。
      if (
        err instanceof BridgeFatalError &&
        err.status === 404 &&
        onEnvironmentLost
      ) {
        // 如果并发重连（例如 WS close handler）已经提前刷新了凭据，
        // 那么这次旧 poll 抛错本来就是预期中的；
        // 直接跳过 onEnvironmentLost，用新凭据重试即可。
        const currentEnvId = getCredentials().environmentId
        if (envId !== currentEnvId) {
          logForDebugging(
            `[bridge:repl] Stale poll error for old env=${envId}, current env=${currentEnvId} — skipping onEnvironmentLost`,
          )
          consecutiveErrors = 0
          firstErrorTime = null
          continue
        }

        environmentRecreations++
        logForDebugging(
          `[bridge:repl] Environment deleted, attempting re-registration (attempt ${environmentRecreations}/${MAX_ENVIRONMENT_RECREATIONS})`,
        )
        logEvent('tengu_bridge_repl_env_lost', {
          attempt: environmentRecreations,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)

        if (environmentRecreations > MAX_ENVIRONMENT_RECREATIONS) {
          logForDebugging(
            `[bridge:repl] Environment re-registration limit reached (${MAX_ENVIRONMENT_RECREATIONS}), giving up`,
          )
          onStateChange?.(
            'failed',
            'Environment deleted and re-registration limit reached',
          )
          onFatalError?.()
          break
        }

        onStateChange?.('reconnecting', 'environment lost, recreating session')
        const newCreds = await onEnvironmentLost()
        // doReconnect() 内部会串行发起数次网络调用，整体可能持续 1 到 5 秒。
        // 如果用户在这段时间里触发了 teardown，内部 abort check 虽会返回 false，
        // 但这里仍要再检查一次，避免在 graceful shutdown 过程中额外抛出伪造的
        // 'failed' 状态与 onFatalError()。
        if (signal.aborted) break
        if (newCreds) {
          // 凭据会在外层通过 reconnectEnvironmentWithSession 更新，
          // 下一次 poll 时 getCredentials() 就会读到新值。
          // 这里不要重置 environmentRecreations，
          // 因为 onEnvLost 返回 creds 只说明我们“尝试修复过”，不代表 env 已经恢复健康。
          // 真正的重置点必须是上面的成功 poll；否则新 env 如果立刻再死一次，
          // 限制器就失去意义了。
          consecutiveErrors = 0
          firstErrorTime = null
          onStateChange?.('ready')
          logForDebugging(
            `[bridge:repl] Re-registered environment: ${newCreds.environmentId}`,
          )
          continue
        }

        onStateChange?.(
          'failed',
          'Environment deleted and re-registration failed',
        )
        onFatalError?.()
        break
      }

      // 致命错误（401/403/404/410），继续重试没有意义。
      if (err instanceof BridgeFatalError) {
        const isExpiry = isExpiredErrorType(err.errorType)
        const isSuppressible = isSuppressible403(err)
        logForDebugging(
          `[bridge:repl] Fatal poll error: ${err.message} (status=${err.status}, type=${err.errorType ?? 'unknown'})${isSuppressible ? ' (suppressed)' : ''}`,
        )
        logEvent('tengu_bridge_repl_fatal_error', {
          status: err.status,
          error_type:
            err.errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        logForDiagnosticsNoPII(
          isExpiry ? 'info' : 'error',
          'bridge_repl_fatal_error',
          { status: err.status, error_type: err.errorType },
        )
        // 一些 403 只是“表象级”错误，例如缺少 external_poll_sessions scope
        // 或 environments:manage 权限。此时可以压下用户可见错误文案，
        // 但仍必须触发 teardown，确保清理逻辑照常运行。
        if (!isSuppressible) {
          onStateChange?.(
            'failed',
            isExpiry
              ? 'session expired · /remote-control to reconnect'
              : err.message,
          )
        }
        // 无论如何都要触发 teardown。
        // 这与 bridgeMain.ts 保持一致：fatalExit 是无条件的，循环结束后的 cleanup 也必须总会执行。
        onFatalError?.()
        break
      }

      const now = Date.now()

      // 检测系统休眠/唤醒：如果距离上次 poll error 的间隔远大于最大 backoff，
      // 那机器大概率是睡过一轮了。
      // 这种情况下应重置错误跟踪，用新的预算重新尝试，而不是立刻判定 give up。
      if (
        lastPollErrorTime !== null &&
        now - lastPollErrorTime > POLL_ERROR_MAX_DELAY_MS * 2
      ) {
        logForDebugging(
          `[bridge:repl] Detected system sleep (${Math.round((now - lastPollErrorTime) / 1000)}s gap), resetting poll error budget`,
        )
        logForDiagnosticsNoPII('info', 'bridge_repl_poll_sleep_detected', {
          gapMs: now - lastPollErrorTime,
        })
        consecutiveErrors = 0
        firstErrorTime = null
      }
      lastPollErrorTime = now

      consecutiveErrors++
      if (firstErrorTime === null) {
        firstErrorTime = now
      }
      const elapsed = now - firstErrorTime
      const httpStatus = extractHttpStatus(err)
      const errMsg = describeAxiosError(err)
      const wsLabel = getWsState?.() ?? 'unknown'

      logForDebugging(
        `[bridge:repl] Poll error (attempt ${consecutiveErrors}, elapsed ${Math.round(elapsed / 1000)}s, ws=${wsLabel}): ${errMsg}`,
      )
      logEvent('tengu_bridge_repl_poll_error', {
        status: httpStatus,
        consecutiveErrors,
        elapsedMs: elapsed,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)

      // 只在第一次错误时切到 'reconnecting'，后续保持该状态直到 poll 成功，
      // 以免 UI 状态来回闪烁。
      if (consecutiveErrors === 1) {
        onStateChange?.('reconnecting', errMsg)
      }

      // 连续失败达到阈值后直接放弃。
      if (elapsed >= POLL_ERROR_GIVE_UP_MS) {
        logForDebugging(
          `[bridge:repl] Poll failures exceeded ${POLL_ERROR_GIVE_UP_MS / 1000}s (${consecutiveErrors} errors), giving up`,
        )
        logForDiagnosticsNoPII('info', 'bridge_repl_poll_give_up')
        logEvent('tengu_bridge_repl_poll_give_up', {
          consecutiveErrors,
          elapsedMs: elapsed,
          lastStatus: httpStatus,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
        onStateChange?.('failed', 'connection to server lost')
        break
      }

      // 指数退避：2s -> 4s -> 8s -> 16s -> 32s -> 60s（封顶）。
      const backoff = Math.min(
        POLL_ERROR_INITIAL_DELAY_MS * 2 ** (consecutiveErrors - 1),
        POLL_ERROR_MAX_DELAY_MS,
      )
      // 从 heartbeat-loop 的 poll_due 分支退出时，当前 lease 其实仍是健康的，
      // 但接下来会落入这条 backoff 路径。
      // 因此在每次 sleep 前都先打一个 heartbeat，避免 /poll 故障把 300 秒 lease TTL 拖死。
      if (getPollIntervalConfig().non_exclusive_heartbeat_interval_ms > 0) {
        const info = getHeartbeatInfo?.()
        if (info) {
          try {
            await api.heartbeatWork(
              info.environmentId,
              info.workId,
              info.sessionToken,
            )
          } catch {
            // best-effort 即可：如果 heartbeat 也失败了，那 lease 还是会死掉，
            // 这与 poll_due 逻辑引入前的行为一致。
          }
        }
      }
      await sleep(backoff, signal)
    }
  }

  logForDebugging(
    `[bridge:repl] Work poll loop ended (aborted=${signal.aborted}) env=${getCredentials().environmentId}`,
  )
}

// 仅供测试导出。
export {
  startWorkPollLoop as _startWorkPollLoopForTesting,
  POLL_ERROR_INITIAL_DELAY_MS as _POLL_ERROR_INITIAL_DELAY_MS_ForTesting,
  POLL_ERROR_MAX_DELAY_MS as _POLL_ERROR_MAX_DELAY_MS_ForTesting,
  POLL_ERROR_GIVE_UP_MS as _POLL_ERROR_GIVE_UP_MS_ForTesting,
}
