import { feature } from 'bun:bundle'
import { randomUUID } from 'crypto'
import { hostname, tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { getRemoteSessionUrl } from '../constants/product.js'
import { shutdownDatadog } from '../services/analytics/datadog.js'
import { shutdown1PEventLogging } from '../services/analytics/firstPartyEventLogger.js'
import { checkGate_CACHED_OR_BLOCKING } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
  logEventAsync,
} from '../services/analytics/index.js'
import { isInBundledMode } from '../utils/bundledMode.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { isEnvTruthy, isInProtectedNamespace } from '../utils/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { truncateToWidth } from '../utils/format.js'
import { logError } from '../utils/log.js'
import { sleep } from '../utils/sleep.js'
import { createAgentWorktree, removeAgentWorktree } from '../utils/worktree.js'
import {
  BridgeFatalError,
  createBridgeApiClient,
  isExpiredErrorType,
  isSuppressible403,
  validateBridgeId,
} from './bridgeApi.js'
import { formatDuration } from './bridgeStatusUtil.js'
import { createBridgeLogger } from './bridgeUI.js'
import { createCapacityWake } from './capacityWake.js'
import { describeAxiosError } from './debugUtils.js'
import { createTokenRefreshScheduler } from './jwtUtils.js'
import { getPollIntervalConfig } from './pollConfig.js'
import { toCompatSessionId, toInfraSessionId } from './sessionIdCompat.js'
import { createSessionSpawner, safeFilenameId } from './sessionRunner.js'
import { getTrustedDeviceToken } from './trustedDevice.js'
import {
  BRIDGE_LOGIN_ERROR,
  type BridgeApiClient,
  type BridgeConfig,
  type BridgeLogger,
  DEFAULT_SESSION_TIMEOUT_MS,
  type SessionDoneStatus,
  type SessionHandle,
  type SessionSpawner,
  type SessionSpawnOpts,
  type SpawnMode,
} from './types.js'
import {
  buildCCRv2SdkUrl,
  buildSdkUrl,
  decodeWorkSecret,
  registerWorker,
  sameSessionId,
} from './workSecret.js'

export type BackoffConfig = {
  connInitialMs: number
  connCapMs: number
  connGiveUpMs: number
  generalInitialMs: number
  generalCapMs: number
  generalGiveUpMs: number
  /** 关闭时从 SIGTERM 到 SIGKILL 的宽限期。默认 30s。 */
  shutdownGraceMs?: number
  /** stopWorkWithRetry 的基础延迟（1s/2s/4s 退避）。默认 1000ms。 */
  stopWorkBaseDelayMs?: number
}

const DEFAULT_BACKOFF: BackoffConfig = {
  connInitialMs: 2_000,
  connCapMs: 120_000, // 2 minutes
  connGiveUpMs: 600_000, // 10 minutes
  generalInitialMs: 500,
  generalCapMs: 30_000,
  generalGiveUpMs: 600_000, // 10 minutes
}

/** 实时状态显示的更新间隔（毫秒）。 */
const STATUS_UPDATE_INTERVAL_MS = 1_000
const SPAWN_SESSIONS_DEFAULT = 32

/**
 * 多 session spawn 模式（--spawn / --capacity / --create-session-in-dir）使用的
 * 对应的 GrowthBook gate。
 * 它与 tengu_ccr_bridge_multi_environment（每个 host:dir 支持多个 env）配套，
 * 这个 gate 控制的是每个 environment 支持多个 session。
 * rollout 通过 targeting rules 分阶段进行：先给 ants，再逐步开放给外部用户。
 *
 * 这里使用阻塞式 gate 检查，避免因为陈旧磁盘缓存 miss 而不公平地拒绝访问。
 * 快路径（缓存里已有 true）仍然是即时的；只有冷启动路径会等待服务端拉取，
 * 而这次拉取也会顺便为下次写入磁盘缓存。
 */
async function isMultiSessionSpawnEnabled(): Promise<boolean> {
  return checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge_multi_session')
}

/**
 * 返回轮询循环中用于检测系统休眠/唤醒的阈值。
 * 该值必须大于最大退避上限，否则普通退避延迟也会误触发休眠检测
 * （导致错误预算被无限重置）。这里使用连接退避上限的 2 倍，
 * 与 WebSocketTransport 和 replBridge 中的模式保持一致。
 */
function pollSleepDetectionThresholdMs(backoff: BackoffConfig): number {
  return backoff.connCapMs * 2
}

/**
 * 返回在启动子 claude 进程时必须位于 CLI flags 之前的参数。
 * 在编译后的二进制里，process.execPath 就是 claude 二进制本身，
 * 参数可以直接传给它。在 npm 安装场景（由 node 运行 cli.js）中，
 * process.execPath 是 node 运行时，因此子进程必须把脚本路径作为第一个参数传入；
 * 否则 node 会把 --sdk-url 解释成 node 选项，并以
 * "bad option: --sdk-url" 退出。见 anthropics/claude-code#28334。
 */
function spawnScriptArgs(): string[] {
  if (isInBundledMode() || !process.argv[1]) {
    return []
  }
  return [process.argv[1]]
}

/** 尝试启动一个 session；如果 spawn 抛错则返回错误字符串。 */
function safeSpawn(
  spawner: SessionSpawner,
  opts: SessionSpawnOpts,
  dir: string,
): SessionHandle | string {
  try {
    return spawner.spawn(opts, dir)
  } catch (err) {
    const errMsg = errorMessage(err)
    logError(new Error(`Session spawn failed: ${errMsg}`))
    return errMsg
  }
}

export async function runBridgeLoop(
  config: BridgeConfig,
  environmentId: string,
  environmentSecret: string,
  api: BridgeApiClient,
  spawner: SessionSpawner,
  logger: BridgeLogger,
  signal: AbortSignal,
  backoffConfig: BackoffConfig = DEFAULT_BACKOFF,
  initialSessionId?: string,
  getAccessToken?: () => string | undefined | Promise<string | undefined>,
): Promise<void> {
  // 本地 abort controller，供 onSessionDone 停止轮询循环。
  // 它会与传入 signal 关联，这样外部 abort 也能生效。
  const controller = new AbortController()
  if (signal.aborted) {
    controller.abort()
  } else {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const loopSignal = controller.signal

  const activeSessions = new Map<string, SessionHandle>()
  const sessionStartTimes = new Map<string, number>()
  const sessionWorkIds = new Map<string, string>()
  // Compat surface 的 ID（session_*）在 spawn 时计算一次并缓存，
  // 这样 cleanup 和状态更新定时器就会始终使用同一个 key，
  // 不受 tengu_bridge_repl_v2_cse_shim_enabled gate 在 session 中途切换影响。
  const sessionCompatIds = new Map<string, string>()
  // 用于 heartbeat 鉴权的 session ingress JWT，按 sessionId 索引。
  // 它们单独存放，而不是放在 handle.accessToken 上，
  // 因为 token refresh scheduler 会把那个字段覆盖成 OAuth token（约 3h55m 后）。
  const sessionIngressTokens = new Map<string, string>()
  const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const completedWorkIds = new Set<string>()
  const sessionWorktrees = new Map<
    string,
    {
      worktreePath: string
      worktreeBranch?: string
      gitRoot?: string
      hookBased?: boolean
    }
  >()
  // 记录被超时 watchdog 杀掉的 session，
  // 这样 onSessionDone 能把它们与服务端中断或 shutdown 中断区分开。
  const timedOutSessions = new Set<string>()
  // 已经有标题的 session（服务端设置或 bridge 推导），
  // 用来避免 onFirstUserMessage 覆盖用户指定的 --name / Web rename。
  // 以 compatSessionId 为 key，与 logger.setSessionTitle 保持一致。
  const titledSessions = new Set<string>()
  // 某个 session 完成时用来提前唤醒 at-capacity 休眠的信号，
  // 让 bridge 能立即接收新的 work。
  const capacityWake = createCapacityWake(loopSignal)

  /**
   * 对所有活跃 work item 发送 heartbeat。
   * 如果至少有一个 heartbeat 成功，返回 'ok'；如果任一请求收到 401/403
   * （JWT 过期，会通过 reconnectSession 重新入队，因此下一次 poll 会拿到
   * 新 work），返回 'auth_failed'；如果全都因其他原因失败，则返回 'failed'。
   */
  async function heartbeatActiveWorkItems(): Promise<
    'ok' | 'auth_failed' | 'fatal' | 'failed'
  > {
    let anySuccess = false
    let anyFatal = false
    const authFailedSessions: string[] = []
    for (const [sessionId] of activeSessions) {
      const workId = sessionWorkIds.get(sessionId)
      const ingressToken = sessionIngressTokens.get(sessionId)
      if (!workId || !ingressToken) {
        continue
      }
      try {
        await api.heartbeatWork(environmentId, workId, ingressToken)
        anySuccess = true
      } catch (err) {
        logForDebugging(
          `[bridge:heartbeat] Failed for sessionId=${sessionId} workId=${workId}: ${errorMessage(err)}`,
        )
        if (err instanceof BridgeFatalError) {
          logEvent('tengu_bridge_heartbeat_error', {
            status:
              err.status as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            error_type: (err.status === 401 || err.status === 403
              ? 'auth_failed'
              : 'fatal') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          if (err.status === 401 || err.status === 403) {
            authFailedSessions.push(sessionId)
          } else {
            // 404/410 = environment 已过期或已删除，没有重试价值。
            anyFatal = true
          }
        }
      }
    }
    // JWT 过期后要触发服务端重新分发。否则 work 会一直处于已 ACK、
    // 但仍留在 Redis PEL 之外的状态，poll 将永久返回空结果（CC-1263）。
    // 下方 existingHandle 路径会把新 token 传给子进程。
    // 这里的 sessionId 已经符合 /bridge/reconnect 所需格式：它来自
    // work.data.id，与服务端 EnvironmentInstance 存储一致
    // （compat gate 下为 cse_*，否则为 session_*）。
    for (const sessionId of authFailedSessions) {
      logger.logVerbose(
        `Session ${sessionId} token expired — re-queuing via bridge/reconnect`,
      )
      try {
        await api.reconnectSession(environmentId, sessionId)
        logForDebugging(
          `[bridge:heartbeat] Re-queued sessionId=${sessionId} via bridge/reconnect`,
        )
      } catch (err) {
        logger.logError(
          `Failed to refresh session ${sessionId} token: ${errorMessage(err)}`,
        )
        logForDebugging(
          `[bridge:heartbeat] reconnectSession(${sessionId}) failed: ${errorMessage(err)}`,
          { level: 'error' },
        )
      }
    }
    if (anyFatal) {
      return 'fatal'
    }
    if (authFailedSessions.length > 0) {
      return 'auth_failed'
    }
    return anySuccess ? 'ok' : 'failed'
  }

  // 通过 CCR v2 环境变量启动的 session。v2 子进程不能使用 OAuth token
  // （CCR worker endpoint 会校验 JWT 的 session_id claim，见 register_worker.go:32），
  // 因此 onRefresh 会改为触发服务端重新分发，随后下一次 poll 会通过
  // 下方 existingHandle 路径带来新的 JWT work。
  const v2Sessions = new Set<string>()

  // 主动 token 刷新：在 session ingress JWT 过期前 5 分钟安排定时器。
  // v1 会直接下发 OAuth；v2 则调用 reconnectSession 触发服务端重新分发
  // （CC-1263：没有这一步时，v2 daemon session 会在约 5 小时后静默死亡，
  // 因为服务端不会在 lease 过期时自动重新分发已 ACK 的 work）。
  const tokenRefresh = getAccessToken
    ? createTokenRefreshScheduler({
        getAccessToken,
        onRefresh: (sessionId, oauthToken) => {
          const handle = activeSessions.get(sessionId)
          if (!handle) {
            return
          }
          if (v2Sessions.has(sessionId)) {
            logger.logVerbose(
              `Refreshing session ${sessionId} token via bridge/reconnect`,
            )
            void api
              .reconnectSession(environmentId, sessionId)
              .catch((err: unknown) => {
                logger.logError(
                  `Failed to refresh session ${sessionId} token: ${errorMessage(err)}`,
                )
                logForDebugging(
                  `[bridge:token] reconnectSession(${sessionId}) failed: ${errorMessage(err)}`,
                  { level: 'error' },
                )
              })
          } else {
            handle.updateAccessToken(oauthToken)
          }
        },
        label: 'bridge',
      })
    : null
  const loopStartTime = Date.now()
  // 跟踪所有进行中的 cleanup promise（stopWork、worktree 删除），
  // 这样 shutdown 流程就能在 process.exit() 前等待它们完成。
  const pendingCleanups = new Set<Promise<unknown>>()
  function trackCleanup(p: Promise<unknown>): void {
    pendingCleanups.add(p)
    void p.finally(() => pendingCleanups.delete(p))
  }
  let connBackoff = 0
  let generalBackoff = 0
  let connErrorStart: number | null = null
  let generalErrorStart: number | null = null
  let lastPollErrorTime: number | null = null
  let statusUpdateTimer: ReturnType<typeof setInterval> | null = null
  // 由 BridgeFatalError 和 give-up 路径设置，
  // 用于让 shutdown 阶段跳过 resume 提示
  // （env 过期、鉴权失败、持续连接错误后都无法 resume）。
  let fatalExit = false

  logForDebugging(
    `[bridge:work] Starting poll loop spawnMode=${config.spawnMode} maxSessions=${config.maxSessions} environmentId=${environmentId}`,
  )
  logForDiagnosticsNoPII('info', 'bridge_loop_started', {
    max_sessions: config.maxSessions,
    spawn_mode: config.spawnMode,
  })

  // 对 ant 用户显示 session debug 日志将写到哪里，方便他们 tail。
  // sessionRunner.ts 使用相同的基础路径；session 启动后文件才会出现。
  if (process.env.USER_TYPE === 'ant') {
    let debugGlob: string
    if (config.debugFile) {
      const ext = config.debugFile.lastIndexOf('.')
      debugGlob =
        ext > 0
          ? `${config.debugFile.slice(0, ext)}-*${config.debugFile.slice(ext)}`
          : `${config.debugFile}-*`
    } else {
      debugGlob = join(tmpdir(), 'claude', 'bridge-session-*.log')
    }
    logger.setDebugLogPath(debugGlob)
  }

  logger.printBanner(config, environmentId)

  // 在首次渲染前先把 logger 的 session 数量和 spawn mode 设好。
  // 否则下面的 setAttached() 会带着 logger 默认的 sessionMax=1 渲染，
  // 在状态 ticker 启动前都会显示 "Capacity: 0/1"
  // （而 ticker 受 !initialSessionId 限制，只有 poll loop 拿到 work 后才启动）。
  logger.updateSessionCount(0, config.maxSessions, config.spawnMode)

  // 如果已经预创建了一个初始 session，就从一开始显示它的 URL，
  // 让用户可以立即点击进入（与 /remote-control 的行为保持一致）。
  if (initialSessionId) {
    logger.setAttached(initialSessionId)
  }

  /** 刷新内联状态显示。会根据当前状态显示 idle 或 active。 */
  function updateStatusDisplay(): void {
    // 推送 session 数量（当 maxSessions === 1 时为 no-op），
    // 让下一次 renderStatusLine tick 能显示当前计数。
    logger.updateSessionCount(
      activeSessions.size,
      config.maxSessions,
      config.spawnMode,
    )

    // 把每个 session 的活动状态推送到多 session 展示中。
    for (const [sid, handle] of activeSessions) {
      const act = handle.currentActivity
      if (act) {
        logger.updateSessionActivity(sessionCompatIds.get(sid) ?? sid, act)
      }
    }

    if (activeSessions.size === 0) {
      logger.updateIdleStatus()
      return
    }

    // 显示最近启动、且仍在活跃工作的那个 session。
    // 当前活动为 'result' 或 'error' 的 session 处于两轮交互之间：
    // CLI 已经输出结果，但进程仍存活并等待下一条用户消息。
    // 此时跳过更新，让状态行保留原有状态（Attached / session title）。
    const [sessionId, handle] = [...activeSessions.entries()].pop()!
    const startTime = sessionStartTimes.get(sessionId)
    if (!startTime) return

    const activity = handle.currentActivity
    if (!activity || activity.type === 'result' || activity.type === 'error') {
      // Session 处于两轮交互之间，保留当前状态（Attached/titled）。
      // 在多 session 模式下仍要刷新，确保项目符号列表中的活动保持最新。
      if (config.maxSessions > 1) logger.refreshDisplay()
      return
    }

    const elapsed = formatDuration(Date.now() - startTime)

    // 由最近的 tool 活动构建轨迹（最近 5 条）。
    const trail = handle.activities
      .filter(a => a.type === 'tool_start')
      .slice(-5)
      .map(a => a.summary)

    logger.updateSessionStatus(sessionId, elapsed, activity, trail)
  }

  /** 启动状态显示更新定时器。 */
  function startStatusUpdates(): void {
    stopStatusUpdates()
    // 先立即调用一次，让第一次状态切换（例如 Connecting → Ready）
    // 无需等待，同时避免并发定时器竞争。
    updateStatusDisplay()
    statusUpdateTimer = setInterval(
      updateStatusDisplay,
      STATUS_UPDATE_INTERVAL_MS,
    )
  }

  /** 停止状态显示更新定时器。 */
  function stopStatusUpdates(): void {
    if (statusUpdateTimer) {
      clearInterval(statusUpdateTimer)
      statusUpdateTimer = null
    }
  }

  function onSessionDone(
    sessionId: string,
    startTime: number,
    handle: SessionHandle,
  ): (status: SessionDoneStatus) => void {
    return (rawStatus: SessionDoneStatus): void => {
      const workId = sessionWorkIds.get(sessionId)
      activeSessions.delete(sessionId)
      sessionStartTimes.delete(sessionId)
      sessionWorkIds.delete(sessionId)
      sessionIngressTokens.delete(sessionId)
      const compatId = sessionCompatIds.get(sessionId) ?? sessionId
      sessionCompatIds.delete(sessionId)
      logger.removeSession(compatId)
      titledSessions.delete(compatId)
      v2Sessions.delete(sessionId)
      // 清理每个 session 的超时定时器。
      const timer = sessionTimers.get(sessionId)
      if (timer) {
        clearTimeout(timer)
        sessionTimers.delete(sessionId)
      }
      // 清理 token 刷新定时器。
      tokenRefresh?.cancel(sessionId)
      // 唤醒 at-capacity 休眠，让 bridge 能立即接收新 work。
      capacityWake.wake()

      // 如果 session 是被超时 watchdog 杀掉的，把它视为 failed session，
      // 而不是服务端中断或 shutdown 中断，这样下面仍会调用
      // stopWork 和 archiveSession。
      const wasTimedOut = timedOutSessions.delete(sessionId)
      const status: SessionDoneStatus =
        wasTimedOut && rawStatus === 'interrupted' ? 'failed' : rawStatus
      const durationMs = Date.now() - startTime

      logForDebugging(
        `[bridge:session] sessionId=${sessionId} workId=${workId ?? 'unknown'} exited status=${status} duration=${formatDuration(durationMs)}`,
      )
      logEvent('tengu_bridge_session_done', {
        status:
          status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        duration_ms: durationMs,
      })
      logForDiagnosticsNoPII('info', 'bridge_session_done', {
        status,
        duration_ms: durationMs,
      })

      // 在打印最终日志前先清空状态显示。
      logger.clearStatus()
      stopStatusUpdates()

      // 如果有 stderr，就基于它构造错误消息。
      const stderrSummary =
        handle.lastStderr.length > 0 ? handle.lastStderr.join('\n') : undefined
      let failureMessage: string | undefined

      switch (status) {
        case 'completed':
          logger.logSessionComplete(sessionId, durationMs)
          break
        case 'failed':
          // shutdown 期间跳过 failure 日志，因为子进程被 kill 后
          // 非零退出是预期行为，不是真正的失败。
          // 对超时杀掉的 session 也跳过，因为 timeout watchdog
          // 已经记录过明确的超时消息。
          if (!wasTimedOut && !loopSignal.aborted) {
            failureMessage = stderrSummary ?? 'Process exited with error'
            logger.logSessionFailed(sessionId, failureMessage)
            logError(new Error(`Bridge session failed: ${failureMessage}`))
          }
          break
        case 'interrupted':
          logger.logVerbose(`Session ${sessionId} interrupted`)
          break
      }

      // 通知服务端该 work item 已完成。对 interrupted session 跳过：
      // 中断要么由服务端发起（服务端已知晓），要么由 bridge shutdown 引起
      // （后者会单独调用 stopWork()）。
      if (status !== 'interrupted' && workId) {
        trackCleanup(
          stopWorkWithRetry(
            api,
            environmentId,
            workId,
            logger,
            backoffConfig.stopWorkBaseDelayMs,
          ),
        )
        completedWorkIds.add(workId)
      }

      // 如果该 session 创建过 worktree，就在这里清理。
      const wt = sessionWorktrees.get(sessionId)
      if (wt) {
        sessionWorktrees.delete(sessionId)
        trackCleanup(
          removeAgentWorktree(
            wt.worktreePath,
            wt.worktreeBranch,
            wt.gitRoot,
            wt.hookBased,
          ).catch((err: unknown) =>
            logger.logVerbose(
              `Failed to remove worktree ${wt.worktreePath}: ${errorMessage(err)}`,
            ),
          ),
        )
      }

      // 生命周期决策：在 multi-session 模式下，session 完成后保持 bridge 继续运行；
      // 在 single-session 模式下，中止 poll loop，让 bridge 干净退出。
      if (status !== 'interrupted' && !loopSignal.aborted) {
        if (config.spawnMode !== 'single-session') {
          // Multi-session：归档已完成的 session，避免它在 Web UI 中作为陈旧项滞留。
          // archiveSession 是幂等的（已归档时返回 409），所以 shutdown 时重复归档也安全。
          // 这里的 sessionId 来自 work poll，格式可能是 cse_*（基础设施层 tag）。
          // archiveSession 调用的是 /v1/sessions/{id}/archive，这是 compat surface，
          // 会校验 TagSession（session_*），因此需要重新打 tag，但底层 UUID 不变。
          trackCleanup(
            api
              .archiveSession(compatId)
              .catch((err: unknown) =>
                logger.logVerbose(
                  `Failed to archive session ${sessionId}: ${errorMessage(err)}`,
                ),
              ),
          )
          logForDebugging(
            `[bridge:session] Session ${status}, returning to idle (multi-session mode)`,
          )
        } else {
          // Single-session：生命周期绑定在一起，需要一并拆除 environment。
          logForDebugging(
            `[bridge:session] Session ${status}, aborting poll loop to tear down environment`,
          )
          controller.abort()
          return
        }
      }

      if (!loopSignal.aborted) {
        startStatusUpdates()
      }
    }
  }

  // 立即启动 idle 状态显示，除非已经有预创建 session；
  // 那种情况下 setAttached() 已经完成显示初始化，poll loop
  // 会在接到该 session 时启动状态更新。
  if (!initialSessionId) {
    startStatusUpdates()
  }

  while (!loopSignal.aborted) {
    // 每轮循环只获取一次。GrowthBook 缓存每 5 分钟刷新，
    // 因此按 at-capacity 速率运行的循环，会在一个 sleep 周期内感知到配置变化。
    const pollConfig = getPollIntervalConfig()

    try {
      const work = await api.pollForWork(
        environmentId,
        environmentSecret,
        loopSignal,
        pollConfig.reclaim_older_than_ms,
      )

      // 如果之前断开过，这里记录重连事件。
      const wasDisconnected =
        connErrorStart !== null || generalErrorStart !== null
      if (wasDisconnected) {
        const disconnectedMs =
          Date.now() - (connErrorStart ?? generalErrorStart ?? Date.now())
        logger.logReconnected(disconnectedMs)
        logForDebugging(
          `[bridge:poll] Reconnected after ${formatDuration(disconnectedMs)}`,
        )
        logEvent('tengu_bridge_reconnected', {
          disconnected_ms: disconnectedMs,
        })
      }

      connBackoff = 0
      generalBackoff = 0
      connErrorStart = null
      generalErrorStart = null
      lastPollErrorTime = null

      // 返回 null 表示队列里当前没有可用 work。
      // 加一个最小延迟，避免对服务端形成打点式轰炸。
      if (!work) {
        // 使用实时检查而不是快照，因为 session 可能在 poll 期间结束。
        const atCap = activeSessions.size >= config.maxSessions
        if (atCap) {
          const atCapMs = pollConfig.multisession_poll_interval_ms_at_capacity
          // heartbeat 循环本身不做 polling。当同时开启 at-capacity polling
          // （atCapMs > 0）时，循环会跟踪一个截止时间，并在到点时跳出重新 poll。
          // 也就是说 heartbeat 与 poll 是组合关系，而不是互相压制。
          // 在以下情况会跳出并执行 poll：
          //   - 达到 poll 截止时间（仅当 atCapMs > 0）
          //   - 鉴权失败（JWT 过期，需要 poll 刷新 token）
          //   - capacity wake 触发（session 结束，需要 poll 新 work）
          //   - 循环被中止（shutdown）
          if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
            logEvent('tengu_bridge_heartbeat_mode_entered', {
              active_sessions: activeSessions.size,
              heartbeat_interval_ms:
                pollConfig.non_exclusive_heartbeat_interval_ms,
            })
            // 截止时间只在进入时计算一次，GB 对 atCapMs 的更新不会影响
            // 当前正在进行的截止时间；下一次进入循环时才会使用新值。
            const pollDeadline = atCapMs > 0 ? Date.now() + atCapMs : null
            let hbResult: 'ok' | 'auth_failed' | 'fatal' | 'failed' = 'ok'
            let hbCycles = 0
            while (
              !loopSignal.aborted &&
              activeSessions.size >= config.maxSessions &&
              (pollDeadline === null || Date.now() < pollDeadline)
            ) {
              // 每轮都重新读取配置，让 GrowthBook 更新能立即生效。
              const hbConfig = getPollIntervalConfig()
              if (hbConfig.non_exclusive_heartbeat_interval_ms <= 0) break

              // 在异步 heartbeat 调用之前先捕获 capacity signal，
              // 这样即使 HTTP 请求期间有 session 结束，也能被后续 sleep 捕获，
              // 而不会因为 controller 被替换而丢失这次唤醒。
              const cap = capacityWake.signal()

              hbResult = await heartbeatActiveWorkItems()
              if (hbResult === 'auth_failed' || hbResult === 'fatal') {
                cap.cleanup()
                break
              }

              hbCycles++
              await sleep(
                hbConfig.non_exclusive_heartbeat_interval_ms,
                cap.signal,
              )
              cap.cleanup()
            }

            // 为 telemetry 判断退出原因。
            const exitReason =
              hbResult === 'auth_failed' || hbResult === 'fatal'
                ? hbResult
                : loopSignal.aborted
                  ? 'shutdown'
                  : activeSessions.size < config.maxSessions
                    ? 'capacity_changed'
                    : pollDeadline !== null && Date.now() >= pollDeadline
                      ? 'poll_due'
                      : 'config_disabled'
            logEvent('tengu_bridge_heartbeat_mode_exited', {
              reason:
                exitReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              heartbeat_cycles: hbCycles,
              active_sessions: activeSessions.size,
            })
            if (exitReason === 'poll_due') {
              // bridgeApi 会对 empty-poll 日志做节流（EMPTY_POLL_LOG_INTERVAL=100），
              // 因而这个每 10 分钟一次的 poll_due poll 在 counter=2 时不可见。
              // 这里补打一条日志，便于验证时在 debug log 中看到两个 endpoint。
              logForDebugging(
                `[bridge:poll] Heartbeat poll_due after ${hbCycles} cycles — falling through to pollForWork`,
              )
            }

            // 遇到 auth_failed 或 fatal 时，在下一次 poll 前先 sleep，
            // 避免形成紧密的 poll+heartbeat 死循环。对于 auth_failed，
            // heartbeatActiveWorkItems 已经调用过 reconnectSession，
            // 这里的 sleep 是给服务端留出传播重新入队结果的时间。
            // 对 fatal（404/410）来说，也可能只是某个 work item 被 GC，
            // environment 本身仍然有效。
            // 优先使用 atCapMs；如果没启用，就以 heartbeat 间隔作为下限
            // （这里保证大于 0），避免仅 heartbeat 配置出现紧密循环。
            if (hbResult === 'auth_failed' || hbResult === 'fatal') {
              const cap = capacityWake.signal()
              await sleep(
                atCapMs > 0
                  ? atCapMs
                  : pollConfig.non_exclusive_heartbeat_interval_ms,
                cap.signal,
              )
              cap.cleanup()
            }
          } else if (atCapMs > 0) {
            // heartbeat 已禁用：退回到慢速 poll，作为存活信号。
            const cap = capacityWake.signal()
            await sleep(atCapMs, cap.signal)
            cap.cleanup()
          }
        } else {
          const interval =
            activeSessions.size > 0
              ? pollConfig.multisession_poll_interval_ms_partial_capacity
              : pollConfig.multisession_poll_interval_ms_not_at_capacity
          await sleep(interval, loopSignal)
        }
        continue
      }

      // 当前已满载。我们这次 poll 只是为了维持 heartbeat，
      // 但此刻不能接收新的 work。即便如此，仍然要进入下面的 switch，
      // 以便处理现有 session 的 token 刷新
      // （'session' 分支会在内部 capacity guard 之前先检查 existing session）。
      const atCapacityBeforeSwitch = activeSessions.size >= config.maxSessions

      // 跳过那些已经完成并且 stop 过的 work item。
      // 服务端可能会在处理完我们的 stop 请求前重新投递陈旧 work，
      // 否则这里会导致重复启动同一个 session。
      if (completedWorkIds.has(work.id)) {
        logForDebugging(
          `[bridge:work] Skipping already-completed workId=${work.id}`,
        )
        // 遵守 capacity throttle。否则持续的陈旧重投会以 poll 请求速度形成紧密循环
        // （上面的 !work 分支是唯一会 sleep 的地方，而 work != null 会跳过它）。
        if (atCapacityBeforeSwitch) {
          const cap = capacityWake.signal()
          if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
            await heartbeatActiveWorkItems()
            await sleep(
              pollConfig.non_exclusive_heartbeat_interval_ms,
              cap.signal,
            )
          } else if (pollConfig.multisession_poll_interval_ms_at_capacity > 0) {
            await sleep(
              pollConfig.multisession_poll_interval_ms_at_capacity,
              cap.signal,
            )
          }
          cap.cleanup()
        } else {
          await sleep(1000, loopSignal)
        }
        continue
      }

      // 解码 work secret，用于后续启动 session，
      // 以及提取下面 ack 调用所需的 JWT。
      let secret
      try {
        secret = decodeWorkSecret(work.secret)
      } catch (err) {
        const errMsg = errorMessage(err)
        logger.logError(
          `Failed to decode work secret for workId=${work.id}: ${errMsg}`,
        )
        logEvent('tengu_bridge_work_secret_failed', {})
        // 无法 ack，因为 ack 需要我们刚才解码失败的 JWT。这里仍可以调用使用 OAuth 的
        // stopWork，从而避免这个毒化 item 在每个 reclaim_older_than_ms 周期里
        // 被 XAUTOCLAIM 反复重新投递。
        completedWorkIds.add(work.id)
        trackCleanup(
          stopWorkWithRetry(
            api,
            environmentId,
            work.id,
            logger,
            backoffConfig.stopWorkBaseDelayMs,
          ),
        )
        // 在重试前同样遵守 capacity throttle。否则满载场景下反复解码失败会以
        // poll 请求速度紧密循环（因为 work != null，会跳过上方 !work 的 sleep）。
        if (atCapacityBeforeSwitch) {
          const cap = capacityWake.signal()
          if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
            await heartbeatActiveWorkItems()
            await sleep(
              pollConfig.non_exclusive_heartbeat_interval_ms,
              cap.signal,
            )
          } else if (pollConfig.multisession_poll_interval_ms_at_capacity > 0) {
            await sleep(
              pollConfig.multisession_poll_interval_ms_at_capacity,
              cap.signal,
            )
          }
          cap.cleanup()
        }
        continue
      }

      // 只有在确认要处理该 work 之后才显式 ack，而不是更早。
      // case 'session' 内部的 at-capacity guard 可能会在未真正 spawn 的情况下直接 break；
      // 如果在那里提前 ack，就会把这个 work 永久丢失。
      // ack 失败不是致命错误：服务端会重新投递，后面的 existingHandle
      // / completedWorkIds 路径会负责去重。
      const ackWork = async (): Promise<void> => {
        logForDebugging(`[bridge:work] Acknowledging workId=${work.id}`)
        try {
          await api.acknowledgeWork(
            environmentId,
            work.id,
            secret.session_ingress_token,
          )
        } catch (err) {
          logForDebugging(
            `[bridge:work] Acknowledge failed workId=${work.id}: ${errorMessage(err)}`,
          )
        }
      }

      const workType: string = work.data.type
      switch (work.data.type) {
        case 'healthcheck':
          await ackWork()
          logForDebugging('[bridge:work] Healthcheck received')
          logger.logVerbose('Healthcheck received')
          break
        case 'session': {
          const sessionId = work.data.id
          try {
            validateBridgeId(sessionId, 'session_id')
          } catch {
            await ackWork()
            logger.logError(`Invalid session_id received: ${sessionId}`)
            break
          }

          // 如果该 session 已经在运行，就把新 token 送过去，
          // 让子进程能用新的 session ingress token 重新连上 WebSocket。
          // 这处理的是服务端在 WS 断开后，给已有 session 重新分发 work 的场景。
          const existingHandle = activeSessions.get(sessionId)
          if (existingHandle) {
            existingHandle.updateAccessToken(secret.session_ingress_token)
            sessionIngressTokens.set(sessionId, secret.session_ingress_token)
            sessionWorkIds.set(sessionId, work.id)
            // 基于新 JWT 的过期时间重新安排下一次刷新。
            // onRefresh 会根据 v2Sessions 分支处理，因此这里对 v1 和 v2 都安全。
            tokenRefresh?.schedule(sessionId, secret.session_ingress_token)
            logForDebugging(
              `[bridge:work] Updated access token for existing sessionId=${sessionId} workId=${work.id}`,
            )
            await ackWork()
            break
          }

          // 已达到容量上限。已有 session 的 token 刷新在上面已经处理，
          // 但此时不能再启动新的 session。switch 之后的 capacity sleep
          // 会给循环做节流，这里直接 break 即可。
          if (activeSessions.size >= config.maxSessions) {
            logForDebugging(
              `[bridge:work] At capacity (${activeSessions.size}/${config.maxSessions}), cannot spawn new session for workId=${work.id}`,
            )
            break
          }

          await ackWork()
          const spawnStartTime = Date.now()

          // CCR v2 路径：把当前 bridge 注册成这个 session 的 worker，拿到
          // epoch，并把子进程指向 /v1/code/sessions/{id}。子进程本身已经带有完整的
          // v2 client（SSETransport + CCRClient），与 environment-manager
          // 在容器里启动时使用的是同一条代码路径。
          //
          // v1 路径：Session-Ingress WebSocket。这里使用 config.sessionIngressUrl，
          // 而不是 secret.api_base_url，因为后者可能指向一个并不了解
          // 本地创建 session 的 remote proxy tunnel。
          let sdkUrl: string
          let useCcrV2 = false
          let workerEpoch: number | undefined
          // 具体走哪条路径由服务端通过 work secret 按 session 决定；
          // 环境变量只是 ant-dev 的覆盖开关（例如在服务端 flag 打开前强制启用 v2）。
          if (
            secret.use_code_sessions === true ||
            isEnvTruthy(process.env.CLAUDE_BRIDGE_USE_CCR_V2)
          ) {
            sdkUrl = buildCCRv2SdkUrl(config.apiBaseUrl, sessionId)
            // 对瞬时失败（网络抖动、500）额外重试一次，
            // 再决定永久放弃并杀掉该 session。
            for (let attempt = 1; attempt <= 2; attempt++) {
              try {
                workerEpoch = await registerWorker(
                  sdkUrl,
                  secret.session_ingress_token,
                )
                useCcrV2 = true
                logForDebugging(
                  `[bridge:session] CCR v2: registered worker sessionId=${sessionId} epoch=${workerEpoch} attempt=${attempt}`,
                )
                break
              } catch (err) {
                const errMsg = errorMessage(err)
                if (attempt < 2) {
                  logForDebugging(
                    `[bridge:session] CCR v2: registerWorker attempt ${attempt} failed, retrying: ${errMsg}`,
                  )
                  await sleep(2_000, loopSignal)
                  if (loopSignal.aborted) break
                  continue
                }
                logger.logError(
                  `CCR v2 worker registration failed for session ${sessionId}: ${errMsg}`,
                )
                logError(new Error(`registerWorker failed: ${errMsg}`))
                completedWorkIds.add(work.id)
                trackCleanup(
                  stopWorkWithRetry(
                    api,
                    environmentId,
                    work.id,
                    logger,
                    backoffConfig.stopWorkBaseDelayMs,
                  ),
                )
              }
            }
            if (!useCcrV2) break
          } else {
            sdkUrl = buildSdkUrl(config.sessionIngressUrl, sessionId)
          }

          // 在 worktree 模式下，按需创建的 session 会获得独立的 git worktree，
          // 避免并发 session 互相干扰文件修改。预创建的初始 session（如果有）
          // 仍运行在 config.dir 中，这样用户的第一个 session 会落在他们执行 `rc`
          // 时所在的目录里，与旧的 single-session 体验一致。
          // 在 same-dir 和 single-session 模式下，所有 session 都共用 config.dir。
          // 注意在下面 await 之前先捕获 spawnMode：`w` 键处理器会直接修改
          // config.spawnMode，而 createAgentWorktree 可能耗时 1-2 秒，
          // 如果 await 之后再读，就可能产出自相矛盾的埋点
          // （spawn_mode:'same-dir'，但 in_worktree:true）。
          const spawnModeAtDecision = config.spawnMode
          let sessionDir = config.dir
          let worktreeCreateMs = 0
          if (
            spawnModeAtDecision === 'worktree' &&
            (initialSessionId === undefined ||
              !sameSessionId(sessionId, initialSessionId))
          ) {
            const wtStart = Date.now()
            try {
              const wt = await createAgentWorktree(
                `bridge-${safeFilenameId(sessionId)}`,
              )
              worktreeCreateMs = Date.now() - wtStart
              sessionWorktrees.set(sessionId, {
                worktreePath: wt.worktreePath,
                worktreeBranch: wt.worktreeBranch,
                gitRoot: wt.gitRoot,
                hookBased: wt.hookBased,
              })
              sessionDir = wt.worktreePath
              logForDebugging(
                `[bridge:session] Created worktree for sessionId=${sessionId} at ${wt.worktreePath}`,
              )
            } catch (err) {
              const errMsg = errorMessage(err)
              logger.logError(
                `Failed to create worktree for session ${sessionId}: ${errMsg}`,
              )
              logError(new Error(`Worktree creation failed: ${errMsg}`))
              completedWorkIds.add(work.id)
              trackCleanup(
                stopWorkWithRetry(
                  api,
                  environmentId,
                  work.id,
                  logger,
                  backoffConfig.stopWorkBaseDelayMs,
                ),
              )
              break
            }
          }

          logForDebugging(
            `[bridge:session] Spawning sessionId=${sessionId} sdkUrl=${sdkUrl}`,
          )

          // 为 logger / Sessions API 调用准备 compat surface 的 session_* 形式。
          // 在 v2 compat 下，work poll 可能返回 cse_*，因此要在 spawn 前完成转换，
          // 让 onFirstUserMessage 回调闭包捕获的是 compat 形式。
          const compatSessionId = toCompatSessionId(sessionId)

          const spawnResult = safeSpawn(
            spawner,
            {
              sessionId,
              sdkUrl,
              accessToken: secret.session_ingress_token,
              useCcrV2,
              workerEpoch,
              onFirstUserMessage: text => {
                // 服务端设置的标题（--name、Web rename）优先级更高。
                // fetchSessionTitle 会并发执行；如果它已经填充了 titledSessions，
                // 这里就跳过。若它尚未返回，那么派生标题就会保留下来，
                // 这也是可接受的，因为 spawn 时服务端本来就还没有标题。
                if (titledSessions.has(compatSessionId)) return
                titledSessions.add(compatSessionId)
                const title = deriveSessionTitle(text)
                logger.setSessionTitle(compatSessionId, title)
                logForDebugging(
                  `[bridge:title] derived title for ${compatSessionId}: ${title}`,
                )
                void import('./createSession.js')
                  .then(({ updateBridgeSessionTitle }) =>
                    updateBridgeSessionTitle(compatSessionId, title, {
                      baseUrl: config.apiBaseUrl,
                    }),
                  )
                  .catch(err =>
                    logForDebugging(
                      `[bridge:title] failed to update title for ${compatSessionId}: ${err}`,
                      { level: 'error' },
                    ),
                  )
              },
            },
            sessionDir,
          )
          if (typeof spawnResult === 'string') {
            logger.logError(
              `Failed to spawn session ${sessionId}: ${spawnResult}`,
            )
            // 如果已经为该 session 创建了 worktree，这里要顺手清理掉。
            const wt = sessionWorktrees.get(sessionId)
            if (wt) {
              sessionWorktrees.delete(sessionId)
              trackCleanup(
                removeAgentWorktree(
                  wt.worktreePath,
                  wt.worktreeBranch,
                  wt.gitRoot,
                  wt.hookBased,
                ).catch((err: unknown) =>
                  logger.logVerbose(
                    `Failed to remove worktree ${wt.worktreePath}: ${errorMessage(err)}`,
                  ),
                ),
              )
            }
            completedWorkIds.add(work.id)
            trackCleanup(
              stopWorkWithRetry(
                api,
                environmentId,
                work.id,
                logger,
                backoffConfig.stopWorkBaseDelayMs,
              ),
            )
            break
          }
          const handle = spawnResult

          const spawnDurationMs = Date.now() - spawnStartTime
          logEvent('tengu_bridge_session_started', {
            active_sessions: activeSessions.size,
            spawn_mode:
              spawnModeAtDecision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            in_worktree: sessionWorktrees.has(sessionId),
            spawn_duration_ms: spawnDurationMs,
            worktree_create_ms: worktreeCreateMs,
            inProtectedNamespace: isInProtectedNamespace(),
          })
          logForDiagnosticsNoPII('info', 'bridge_session_started', {
            spawn_mode: spawnModeAtDecision,
            in_worktree: sessionWorktrees.has(sessionId),
            spawn_duration_ms: spawnDurationMs,
            worktree_create_ms: worktreeCreateMs,
          })

          activeSessions.set(sessionId, handle)
          sessionWorkIds.set(sessionId, work.id)
          sessionIngressTokens.set(sessionId, secret.session_ingress_token)
          sessionCompatIds.set(sessionId, compatSessionId)

          const startTime = Date.now()
          sessionStartTimes.set(sessionId, startTime)

          // 由于不再拿到 startup_context，这里使用一个通用的 prompt 描述。
          logger.logSessionStart(sessionId, `Session ${sessionId}`)

          // 计算实际的 debug 文件路径（与 sessionRunner.ts 的逻辑保持一致）。
          const safeId = safeFilenameId(sessionId)
          let sessionDebugFile: string | undefined
          if (config.debugFile) {
            const ext = config.debugFile.lastIndexOf('.')
            if (ext > 0) {
              sessionDebugFile = `${config.debugFile.slice(0, ext)}-${safeId}${config.debugFile.slice(ext)}`
            } else {
              sessionDebugFile = `${config.debugFile}-${safeId}`
            }
          } else if (config.verbose || process.env.USER_TYPE === 'ant') {
            sessionDebugFile = join(
              tmpdir(),
              'claude',
              `bridge-session-${safeId}.log`,
            )
          }

          if (sessionDebugFile) {
            logger.logVerbose(`Debug log: ${sessionDebugFile}`)
          }

          // 在启动状态更新前先注册到 sessions Map，
          // 这样第一次渲染 tick 就能显示正确的计数，并让项目符号列表保持同步。
          logger.addSession(
            compatSessionId,
            getRemoteSessionUrl(compatSessionId, config.sessionIngressUrl),
          )

          // 启动实时状态更新，并切换到 "Attached" 状态。
          startStatusUpdates()
          logger.setAttached(compatSessionId)

          // 一次性的标题拉取。如果 session 已经有标题（来自 --name、Web rename
          // 或 /remote-control），就显示并标记为 titled，避免 first-user-message
          // 回退逻辑把它覆盖。否则就由 onFirstUserMessage 从第一条 prompt 派生标题。
          void fetchSessionTitle(compatSessionId, config.apiBaseUrl)
            .then(title => {
              if (title && activeSessions.has(sessionId)) {
                titledSessions.add(compatSessionId)
                logger.setSessionTitle(compatSessionId, title)
                logForDebugging(
                  `[bridge:title] server title for ${compatSessionId}: ${title}`,
                )
              }
            })
            .catch(err =>
              logForDebugging(
                `[bridge:title] failed to fetch title for ${compatSessionId}: ${err}`,
                { level: 'error' },
              ),
            )

          // 启动每个 session 的超时 watchdog。
          const timeoutMs =
            config.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS
          if (timeoutMs > 0) {
            const timer = setTimeout(
              onSessionTimeout,
              timeoutMs,
              sessionId,
              timeoutMs,
              logger,
              timedOutSessions,
              handle,
            )
            sessionTimers.set(sessionId, timer)
          }

          // 在 JWT 过期前安排主动 token 刷新。
          // onRefresh 会根据 v2Sessions 分支：v1 直接把 OAuth 送给子进程，
          // v2 则通过 reconnectSession 触发服务端重新分发。
          if (useCcrV2) {
            v2Sessions.add(sessionId)
          }
          tokenRefresh?.schedule(sessionId, secret.session_ingress_token)

          void handle.done.then(onSessionDone(sessionId, startTime, handle))
          break
        }
        default:
          await ackWork()
          // 平滑忽略未知 work 类型。后端可能会在 bridge client 更新前
          // 就先开始发送新的类型。
          logForDebugging(
            `[bridge:work] Unknown work type: ${workType}, skipping`,
          )
          break
      }

      // 在达到容量上限时，对循环做节流。上面的 switch 仍会执行，
      // 这样已有 session 的 token 刷新还能被处理；但这里仍要 sleep，
      // 避免形成 busy loop。同时把 capacity wake signal 也纳入等待，
      // 这样某个 session 一结束就能立刻中断休眠。
      if (atCapacityBeforeSwitch) {
        const cap = capacityWake.signal()
        if (pollConfig.non_exclusive_heartbeat_interval_ms > 0) {
          await heartbeatActiveWorkItems()
          await sleep(
            pollConfig.non_exclusive_heartbeat_interval_ms,
            cap.signal,
          )
        } else if (pollConfig.multisession_poll_interval_ms_at_capacity > 0) {
          await sleep(
            pollConfig.multisession_poll_interval_ms_at_capacity,
            cap.signal,
          )
        }
        cap.cleanup()
      }
    } catch (err) {
      if (loopSignal.aborted) {
        break
      }

      // 致命错误（401/403）没有重试价值，鉴权问题不会自己恢复。
      if (err instanceof BridgeFatalError) {
        fatalExit = true
        // 服务端强制过期只展示干净的状态消息，不记为错误。
        if (isExpiredErrorType(err.errorType)) {
          logger.logStatus(err.message)
        } else if (isSuppressible403(err)) {
          // 外观层面的 403 错误（例如 external_poll_sessions scope、
          // environments:manage 权限）不展示给用户。
          logForDebugging(`[bridge:work] Suppressed 403 error: ${err.message}`)
        } else {
          logger.logError(err.message)
          logError(err)
        }
        logEvent('tengu_bridge_fatal_error', {
          status: err.status,
          error_type:
            err.errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        logForDiagnosticsNoPII(
          isExpiredErrorType(err.errorType) ? 'info' : 'error',
          'bridge_fatal_error',
          { status: err.status, error_type: err.errorType },
        )
        break
      }

      const errMsg = describeAxiosError(err)

      if (isConnectionError(err) || isServerError(err)) {
        const now = Date.now()

        // 检测系统休眠/唤醒：如果距离上次 poll 错误的间隔远大于预期退避，
        // 说明机器很可能睡眠过。此时要重置错误跟踪，
        // 让 bridge 用全新的预算继续重试。
        if (
          lastPollErrorTime !== null &&
          now - lastPollErrorTime > pollSleepDetectionThresholdMs(backoffConfig)
        ) {
          logForDebugging(
            `[bridge:work] Detected system sleep (${Math.round((now - lastPollErrorTime) / 1000)}s gap), resetting error budget`,
          )
          logForDiagnosticsNoPII('info', 'bridge_poll_sleep_detected', {
            gapMs: now - lastPollErrorTime,
          })
          connErrorStart = null
          connBackoff = 0
          generalErrorStart = null
          generalBackoff = 0
        }
        lastPollErrorTime = now

        if (!connErrorStart) {
          connErrorStart = now
        }
        const elapsed = now - connErrorStart
        if (elapsed >= backoffConfig.connGiveUpMs) {
          logger.logError(
            `Server unreachable for ${Math.round(elapsed / 60_000)} minutes, giving up.`,
          )
          logEvent('tengu_bridge_poll_give_up', {
            error_type:
              'connection' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            elapsed_ms: elapsed,
          })
          logForDiagnosticsNoPII('error', 'bridge_poll_give_up', {
            error_type: 'connection',
            elapsed_ms: elapsed,
          })
          fatalExit = true
          break
        }

        // 当错误类型切换时，重置另一条跟踪轨道。
        generalErrorStart = null
        generalBackoff = 0

        connBackoff = connBackoff
          ? Math.min(connBackoff * 2, backoffConfig.connCapMs)
          : backoffConfig.connInitialMs
        const delay = addJitter(connBackoff)
        logger.logVerbose(
          `Connection error, retrying in ${formatDelay(delay)} (${Math.round(elapsed / 1000)}s elapsed): ${errMsg}`,
        )
        logger.updateReconnectingStatus(
          formatDelay(delay),
          formatDuration(elapsed),
        )
        // 由于 heartbeat loop 以 poll_due 退出时，lease 仍然是健康的，
        // 所以这里在每次 sleep 前都补一次 heartbeat，避免 /poll 故障
        // （也就是引入 VerifyEnvironmentSecretAuth DB path heartbeat 要规避的问题）
        // 导致 300s 的 lease TTL 被耗尽。activeSessions 为空或 heartbeat 被禁用时为 no-op。
        if (getPollIntervalConfig().non_exclusive_heartbeat_interval_ms > 0) {
          await heartbeatActiveWorkItems()
        }
        await sleep(delay, loopSignal)
      } else {
        const now = Date.now()

        // 对一般错误也做休眠检测（逻辑与连接错误相同）。
        if (
          lastPollErrorTime !== null &&
          now - lastPollErrorTime > pollSleepDetectionThresholdMs(backoffConfig)
        ) {
          logForDebugging(
            `[bridge:work] Detected system sleep (${Math.round((now - lastPollErrorTime) / 1000)}s gap), resetting error budget`,
          )
          logForDiagnosticsNoPII('info', 'bridge_poll_sleep_detected', {
            gapMs: now - lastPollErrorTime,
          })
          connErrorStart = null
          connBackoff = 0
          generalErrorStart = null
          generalBackoff = 0
        }
        lastPollErrorTime = now

        if (!generalErrorStart) {
          generalErrorStart = now
        }
        const elapsed = now - generalErrorStart
        if (elapsed >= backoffConfig.generalGiveUpMs) {
          logger.logError(
            `Persistent errors for ${Math.round(elapsed / 60_000)} minutes, giving up.`,
          )
          logEvent('tengu_bridge_poll_give_up', {
            error_type:
              'general' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            elapsed_ms: elapsed,
          })
          logForDiagnosticsNoPII('error', 'bridge_poll_give_up', {
            error_type: 'general',
            elapsed_ms: elapsed,
          })
          fatalExit = true
          break
        }

        // 当错误类型切换时，重置另一条跟踪轨道。
        connErrorStart = null
        connBackoff = 0

        generalBackoff = generalBackoff
          ? Math.min(generalBackoff * 2, backoffConfig.generalCapMs)
          : backoffConfig.generalInitialMs
        const delay = addJitter(generalBackoff)
        logger.logVerbose(
          `Poll failed, retrying in ${formatDelay(delay)} (${Math.round(elapsed / 1000)}s elapsed): ${errMsg}`,
        )
        logger.updateReconnectingStatus(
          formatDelay(delay),
          formatDuration(elapsed),
        )
        if (getPollIntervalConfig().non_exclusive_heartbeat_interval_ms > 0) {
          await heartbeatActiveWorkItems()
        }
        await sleep(delay, loopSignal)
      }
    }
  }

  // 清理收尾。
  stopStatusUpdates()
  logger.clearStatus()

  const loopDurationMs = Date.now() - loopStartTime
  logEvent('tengu_bridge_shutdown', {
    active_sessions: activeSessions.size,
    loop_duration_ms: loopDurationMs,
  })
  logForDiagnosticsNoPII('info', 'bridge_shutdown', {
    active_sessions: activeSessions.size,
    loop_duration_ms: loopDurationMs,
  })

  // 优雅关闭流程：杀掉活跃 session，将它们标记为 interrupted，
  // 归档 session，然后注销 environment，让 Web UI 显示 bridge 已离线。

  // 收集退出时需要归档的全部 session ID，包括：
  // 1. 活跃 session（在 kill 前抓快照，因为 onSessionDone 会清掉这些 map）
  // 2. 初始自动创建的 session（它可能从未真正拿到过 work）
  // api.archiveSession 是幂等的（已归档时返回 409），因此重复归档是安全的。
  const sessionsToArchive = new Set(activeSessions.keys())
  if (initialSessionId) {
    sessionsToArchive.add(initialSessionId)
  }
  // 在 kill 前抓一个快照，因为 onSessionDone 会清掉 sessionCompatIds。
  const compatIdSnapshot = new Map(sessionCompatIds)

  if (activeSessions.size > 0) {
    logForDebugging(
      `[bridge:shutdown] Shutting down ${activeSessions.size} active session(s)`,
    )
    logger.logStatus(
      `Shutting down ${activeSessions.size} active session(s)\u2026`,
    )

    // 在 kill 前抓 work ID 快照，因为每个子进程退出时 onSessionDone 会清这些 map；
    // 下面的 stopWork 调用要用到这份拷贝。
    const shutdownWorkIds = new Map(sessionWorkIds)

    for (const [sessionId, handle] of activeSessions.entries()) {
      logForDebugging(
        `[bridge:shutdown] Sending SIGTERM to sessionId=${sessionId}`,
      )
      handle.kill()
    }

    const timeout = new AbortController()
    await Promise.race([
      Promise.allSettled([...activeSessions.values()].map(h => h.done)),
      sleep(backoffConfig.shutdownGraceMs ?? 30_000, timeout.signal),
    ])
    timeout.abort()

    // 对那些在宽限期内没有响应 SIGTERM 的进程发送 SIGKILL。
    for (const [sid, handle] of activeSessions.entries()) {
      logForDebugging(`[bridge:shutdown] Force-killing stuck sessionId=${sid}`)
      handle.forceKill()
    }

    // 清理残留的 session 超时定时器和刷新定时器。
    for (const timer of sessionTimers.values()) {
      clearTimeout(timer)
    }
    sessionTimers.clear()
    tokenRefresh?.cancelAll()

    // 清理所有仍然残留的活跃 session worktree。
    // 先抓快照并清空 map，这样下面 await 期间即使 handle.done 触发了 onSessionDone，
    // 也不会再次尝试删除同一批 worktree。
    if (sessionWorktrees.size > 0) {
      const remainingWorktrees = [...sessionWorktrees.values()]
      sessionWorktrees.clear()
      logForDebugging(
        `[bridge:shutdown] Cleaning up ${remainingWorktrees.length} worktree(s)`,
      )
      await Promise.allSettled(
        remainingWorktrees.map(wt =>
          removeAgentWorktree(
            wt.worktreePath,
            wt.worktreeBranch,
            wt.gitRoot,
            wt.hookBased,
          ),
        ),
      )
    }

    // 停掉所有活跃 work item，让服务端知道它们已经结束。
    await Promise.allSettled(
      [...shutdownWorkIds.entries()].map(([sessionId, workId]) => {
        return api
          .stopWork(environmentId, workId, true)
          .catch(err =>
            logger.logVerbose(
              `Failed to stop work ${workId} for session ${sessionId}: ${errorMessage(err)}`,
            ),
          )
      }),
    )
  }

  // 确保 onSessionDone 发起的所有进行中 cleanup（stopWork、worktree 删除）
  // 都在 deregister 之前完成，否则 process.exit() 可能会把它们在半路杀掉。
  if (pendingCleanups.size > 0) {
    await Promise.allSettled([...pendingCleanups])
  }

  // 在 single-session 模式且已知 session ID 的情况下，保留 session 与 environment，
  // 这样 `claude remote-control --session-id=<id>` 还能恢复。
  // 后端会通过 4 小时 TTL（BRIDGE_LAST_POLL_TTL）清理陈旧 environment。
  // 如果归档 session 或注销 environment，就会让打印出来的 resume 命令变成假话，
  // 因为 deregister 会删除 Firestore + Redis stream。
  // 如果循环是因致命错误退出（env 过期、鉴权失败、give-up），这里就跳过，
  // 因为那种情况下无法恢复，而且提示信息会与上面已经打印的错误相冲突。
  // feature('KAIROS') gate：--session-id 仅对 ant 用户开放；没有这个 gate 时，
  // 仍退回到 PR 之前的行为（每次 shutdown 都 archive + deregister）。
  if (
    feature('KAIROS') &&
    config.spawnMode === 'single-session' &&
    initialSessionId &&
    !fatalExit
  ) {
    logger.logStatus(
      `Resume this session by running \`claude remote-control --continue\``,
    )
    logForDebugging(
      `[bridge:shutdown] Skipping archive+deregister to allow resume of session ${initialSessionId}`,
    )
    return
  }

  // 归档所有已知 session，避免在 bridge 离线后它们仍以 idle/running 的形式
  // 留在服务端。
  if (sessionsToArchive.size > 0) {
    logForDebugging(
      `[bridge:shutdown] Archiving ${sessionsToArchive.size} session(s)`,
    )
    await Promise.allSettled(
      [...sessionsToArchive].map(sessionId =>
        api
          .archiveSession(
            compatIdSnapshot.get(sessionId) ?? toCompatSessionId(sessionId),
          )
          .catch(err =>
            logger.logVerbose(
              `Failed to archive session ${sessionId}: ${errorMessage(err)}`,
            ),
          ),
      ),
    )
  }

  // 注销 environment，让 Web UI 显示 bridge 已离线，
  // 同时清理对应的 Redis stream。
  try {
    await api.deregisterEnvironment(environmentId)
    logForDebugging(
      `[bridge:shutdown] Environment deregistered, bridge offline`,
    )
    logger.logVerbose('Environment deregistered.')
  } catch (err) {
    logger.logVerbose(`Failed to deregister environment: ${errorMessage(err)}`)
  }

  // 清理 crash-recovery pointer，因为 env 已不存在，pointer 也会变陈旧。
  // 上面那条可恢复的 SIGINT shutdown 早返回路径会跳过这里，
  // 从而让该 pointer 继续作为打印出来的 --session-id 提示的后备信息。
  const { clearBridgePointer } = await import('./bridgePointer.js')
  await clearBridgePointer(config.dir)

  logger.logVerbose('Environment offline.')
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

export function isConnectionError(err: unknown): boolean {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof err.code === 'string' &&
    CONNECTION_ERROR_CODES.has(err.code)
  ) {
    return true
  }
  return false
}

/** 检测 axios 抛出的 HTTP 5xx 错误（code: 'ERR_BAD_RESPONSE'）。 */
export function isServerError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof err.code === 'string' &&
    err.code === 'ERR_BAD_RESPONSE'
  )
}

/** 为一个延迟值增加 ±25% 的抖动。 */
function addJitter(ms: number): number {
  return Math.max(0, ms + ms * 0.25 * (2 * Math.random() - 1))
}

function formatDelay(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

/**
 * 以指数退避方式重试 stopWork（3 次，1s/2s/4s）。
 * 这样可以确保服务端知道该 work item 已经结束，避免产生服务端 zombie。
 */
async function stopWorkWithRetry(
  api: BridgeApiClient,
  environmentId: string,
  workId: string,
  logger: BridgeLogger,
  baseDelayMs = 1000,
): Promise<void> {
  const MAX_ATTEMPTS = 3

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await api.stopWork(environmentId, workId, false)
      logForDebugging(
        `[bridge:work] stopWork succeeded for workId=${workId} on attempt ${attempt}/${MAX_ATTEMPTS}`,
      )
      return
    } catch (err) {
      // 鉴权/权限错误靠重试无法修复。
      if (err instanceof BridgeFatalError) {
        if (isSuppressible403(err)) {
          logForDebugging(
            `[bridge:work] Suppressed stopWork 403 for ${workId}: ${err.message}`,
          )
        } else {
          logger.logError(`Failed to stop work ${workId}: ${err.message}`)
        }
        logForDiagnosticsNoPII('error', 'bridge_stop_work_failed', {
          attempts: attempt,
          fatal: true,
        })
        return
      }
      const errMsg = errorMessage(err)
      if (attempt < MAX_ATTEMPTS) {
        const delay = addJitter(baseDelayMs * Math.pow(2, attempt - 1))
        logger.logVerbose(
          `Failed to stop work ${workId} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${formatDelay(delay)}: ${errMsg}`,
        )
        await sleep(delay)
      } else {
        logger.logError(
          `Failed to stop work ${workId} after ${MAX_ATTEMPTS} attempts: ${errMsg}`,
        )
        logForDiagnosticsNoPII('error', 'bridge_stop_work_failed', {
          attempts: MAX_ATTEMPTS,
        })
      }
    }
  }
}

function onSessionTimeout(
  sessionId: string,
  timeoutMs: number,
  logger: BridgeLogger,
  timedOutSessions: Set<string>,
  handle: SessionHandle,
): void {
  logForDebugging(
    `[bridge:session] sessionId=${sessionId} timed out after ${formatDuration(timeoutMs)}`,
  )
  logEvent('tengu_bridge_session_timeout', {
    timeout_ms: timeoutMs,
  })
  logger.logSessionFailed(
    sessionId,
    `Session timed out after ${formatDuration(timeoutMs)}`,
  )
  timedOutSessions.add(sessionId)
  handle.kill()
}

export type ParsedArgs = {
  verbose: boolean
  sandbox: boolean
  debugFile?: string
  sessionTimeoutMs?: number
  permissionMode?: string
  name?: string
  /** 传给 --spawn 的值（如果有）；若未提供 --spawn，则为 undefined。 */
  spawnMode: SpawnMode | undefined
  /** 传给 --capacity 的值（如果有）；若未提供 --capacity，则为 undefined。 */
  capacity: number | undefined
  /** --[no-]create-session-in-dir 的覆盖值；undefined 表示使用默认值（开启）。 */
  createSessionInDir: boolean | undefined
  /** 恢复一个已有 session，而不是创建新的 session。 */
  sessionId?: string
  /** 恢复该目录中的最近一个 session（会读取 bridge-pointer.json）。 */
  continueSession: boolean
  help: boolean
  error?: string
}

const SPAWN_FLAG_VALUES = ['session', 'same-dir', 'worktree'] as const

function parseSpawnValue(raw: string | undefined): SpawnMode | string {
  if (raw === 'session') return 'single-session'
  if (raw === 'same-dir') return 'same-dir'
  if (raw === 'worktree') return 'worktree'
  return `--spawn requires one of: ${SPAWN_FLAG_VALUES.join(', ')} (got: ${raw ?? '<missing>'})`
}

function parseCapacityValue(raw: string | undefined): number | string {
  const n = raw === undefined ? NaN : parseInt(raw, 10)
  if (isNaN(n) || n < 1) {
    return `--capacity requires a positive integer (got: ${raw ?? '<missing>'})`
  }
  return n
}

export function parseArgs(args: string[]): ParsedArgs {
  let verbose = false
  let sandbox = false
  let debugFile: string | undefined
  let sessionTimeoutMs: number | undefined
  let permissionMode: string | undefined
  let name: string | undefined
  let help = false
  let spawnMode: SpawnMode | undefined
  let capacity: number | undefined
  let createSessionInDir: boolean | undefined
  let sessionId: string | undefined
  let continueSession = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--sandbox') {
      sandbox = true
    } else if (arg === '--no-sandbox') {
      sandbox = false
    } else if (arg === '--debug-file' && i + 1 < args.length) {
      debugFile = resolve(args[++i]!)
    } else if (arg.startsWith('--debug-file=')) {
      debugFile = resolve(arg.slice('--debug-file='.length))
    } else if (arg === '--session-timeout' && i + 1 < args.length) {
      sessionTimeoutMs = parseInt(args[++i]!, 10) * 1000
    } else if (arg.startsWith('--session-timeout=')) {
      sessionTimeoutMs =
        parseInt(arg.slice('--session-timeout='.length), 10) * 1000
    } else if (arg === '--permission-mode' && i + 1 < args.length) {
      permissionMode = args[++i]!
    } else if (arg.startsWith('--permission-mode=')) {
      permissionMode = arg.slice('--permission-mode='.length)
    } else if (arg === '--name' && i + 1 < args.length) {
      name = args[++i]!
    } else if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length)
    } else if (
      feature('KAIROS') &&
      arg === '--session-id' &&
      i + 1 < args.length
    ) {
      sessionId = args[++i]!
      if (!sessionId) {
        return makeError('--session-id requires a value')
      }
    } else if (feature('KAIROS') && arg.startsWith('--session-id=')) {
      sessionId = arg.slice('--session-id='.length)
      if (!sessionId) {
        return makeError('--session-id requires a value')
      }
    } else if (feature('KAIROS') && (arg === '--continue' || arg === '-c')) {
      continueSession = true
    } else if (arg === '--spawn' || arg.startsWith('--spawn=')) {
      if (spawnMode !== undefined) {
        return makeError('--spawn may only be specified once')
      }
      const raw = arg.startsWith('--spawn=')
        ? arg.slice('--spawn='.length)
        : args[++i]
      const v = parseSpawnValue(raw)
      if (v === 'single-session' || v === 'same-dir' || v === 'worktree') {
        spawnMode = v
      } else {
        return makeError(v)
      }
    } else if (arg === '--capacity' || arg.startsWith('--capacity=')) {
      if (capacity !== undefined) {
        return makeError('--capacity may only be specified once')
      }
      const raw = arg.startsWith('--capacity=')
        ? arg.slice('--capacity='.length)
        : args[++i]
      const v = parseCapacityValue(raw)
      if (typeof v === 'number') capacity = v
      else return makeError(v)
    } else if (arg === '--create-session-in-dir') {
      createSessionInDir = true
    } else if (arg === '--no-create-session-in-dir') {
      createSessionInDir = false
    } else {
      return makeError(
        `Unknown argument: ${arg}\nRun 'claude remote-control --help' for usage.`,
      )
    }
  }

  // 注意：--spawn/--capacity/--create-session-in-dir 的 gate 检查在 bridgeMain 中完成
  // （那里能返回带 gate 感知的错误）。这里负责 flag 之间的交叉校验。

  // --capacity 只对 multi-session 模式有意义。
  if (spawnMode === 'single-session' && capacity !== undefined) {
    return makeError(
      `--capacity cannot be used with --spawn=session (single-session mode has fixed capacity 1).`,
    )
  }

  // --session-id / --continue 会在原始 environment 上恢复某个特定 session；
  // 因此与 spawn 相关 flag（它们用于配置新 session 的创建）不兼容，
  // 并且二者彼此也互斥。
  if (
    (sessionId || continueSession) &&
    (spawnMode !== undefined ||
      capacity !== undefined ||
      createSessionInDir !== undefined)
  ) {
    return makeError(
      `--session-id and --continue cannot be used with --spawn, --capacity, or --create-session-in-dir.`,
    )
  }
  if (sessionId && continueSession) {
    return makeError(`--session-id and --continue cannot be used together.`)
  }

  return {
    verbose,
    sandbox,
    debugFile,
    sessionTimeoutMs,
    permissionMode,
    name,
    spawnMode,
    capacity,
    createSessionInDir,
    sessionId,
    continueSession,
    help,
  }

  function makeError(error: string): ParsedArgs {
    return {
      verbose,
      sandbox,
      debugFile,
      sessionTimeoutMs,
      permissionMode,
      name,
      spawnMode,
      capacity,
      createSessionInDir,
      sessionId,
      continueSession,
      help,
      error,
    }
  }
}

async function printHelp(): Promise<void> {
  // 帮助文本里使用 EXTERNAL_PERMISSION_MODES。内部模式（bubble）仅对 ant 开放，
  // 而 auto 又受 feature gate 控制；不过校验逻辑仍然会接受这些值。
  const { EXTERNAL_PERMISSION_MODES } = await import('../types/permissions.js')
  const modes = EXTERNAL_PERMISSION_MODES.join(', ')
  const showServer = await isMultiSessionSpawnEnabled()
  const serverOptions = showServer
    ? `  --spawn <mode>                   Spawn mode: same-dir, worktree, session
                                   (default: same-dir)
  --capacity <N>                   Max concurrent sessions in worktree or
                                   same-dir mode (default: ${SPAWN_SESSIONS_DEFAULT})
  --[no-]create-session-in-dir     Pre-create a session in the current
                                   directory; in worktree mode this session
                                   stays in cwd while on-demand sessions get
                                   isolated worktrees (default: on)
`
    : ''
  const serverDescription = showServer
    ? `
  Remote Control runs as a persistent server that accepts multiple concurrent
  sessions in the current directory. One session is pre-created on start so
  you have somewhere to type immediately. Use --spawn=worktree to isolate
  each on-demand session in its own git worktree, or --spawn=session for
  the classic single-session mode (exits when that session ends). Press 'w'
  during runtime to toggle between same-dir and worktree.
`
    : ''
  const serverNote = showServer
    ? `  - Worktree mode requires a git repository or WorktreeCreate/WorktreeRemove hooks
`
    : ''
  const help = `
Remote Control - Connect your local environment to claude.ai/code

USAGE
  claude remote-control [options]
OPTIONS
  --name <name>                    Name for the session (shown in claude.ai/code)
${
  feature('KAIROS')
    ? `  -c, --continue                   Resume the last session in this directory
  --session-id <id>                Resume a specific session by ID (cannot be
                                   used with spawn flags or --continue)
`
    : ''
}  --permission-mode <mode>         Permission mode for spawned sessions
                                   (${modes})
  --debug-file <path>              Write debug logs to file
  -v, --verbose                    Enable verbose output
  -h, --help                       Show this help
${serverOptions}
DESCRIPTION
  Remote Control allows you to control sessions on your local device from
  claude.ai/code (https://claude.ai/code). Run this command in the
  directory you want to work in, then connect from the Claude app or web.
${serverDescription}
NOTES
  - You must be logged in with a Claude account that has a subscription
  - Run \`claude\` first in the directory to accept the workspace trust dialog
${serverNote}`
  // biome-ignore lint/suspicious/noConsole: intentional help output
  console.log(help)
}

const TITLE_MAX_LEN = 80

/** 根据用户消息派生 session 标题：取第一行并截断。 */
function deriveSessionTitle(text: string): string {
  // 折叠空白字符，否则换行和制表符会破坏单行状态显示。
  const flat = text.replace(/\s+/g, ' ').trim()
  return truncateToWidth(flat, TITLE_MAX_LEN)
}

/**
 * 通过 GET /v1/sessions/{id} 一次性拉取 session 标题。
 *
 * 这里使用 createSession.ts 中的 `getBridgeSession`（ccr-byoc headers + org UUID），
 * 而不是面向 environments 的 bridgeApi client，因为后者的 headers 会让
 * Sessions API 返回 404。如果 session 还没有标题，或拉取失败，则返回 undefined，
 * 调用方会回退到从第一条用户消息派生标题。
 */
async function fetchSessionTitle(
  compatSessionId: string,
  baseUrl: string,
): Promise<string | undefined> {
  const { getBridgeSession } = await import('./createSession.js')
  const session = await getBridgeSession(compatSessionId, { baseUrl })
  return session?.title || undefined
}

export async function bridgeMain(args: string[]): Promise<void> {
  const parsed = parseArgs(args)

  if (parsed.help) {
    await printHelp()
    return
  }
  if (parsed.error) {
    // biome-ignore lint/suspicious/noConsole: intentional error output
    console.error(`Error: ${parsed.error}`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  const {
    verbose,
    sandbox,
    debugFile,
    sessionTimeoutMs,
    permissionMode,
    name,
    spawnMode: parsedSpawnMode,
    capacity: parsedCapacity,
    createSessionInDir: parsedCreateSessionInDir,
    sessionId: parsedSessionId,
    continueSession,
  } = parsed
  // 这里需要可变，便于 --continue 从 pointer 文件中写入它。
  // 下面的 #20460 恢复流程会把它与显式传入的 --session-id 等同处理。
  let resumeSessionId = parsedSessionId
  // 当 --continue 找到 pointer 时，这里记录它来自哪个目录
  // （可能是某个 worktree 同级目录，而不是当前 `dir`）。
  // 如果恢复流程发生确定性失败，就清理这个文件，避免 --continue 一直命中
  // 同一个已失效 session。显式 --session-id 则保持 undefined，不去碰 pointer。
  let resumePointerDir: string | undefined

  const usedMultiSessionFeature =
    parsedSpawnMode !== undefined ||
    parsedCapacity !== undefined ||
    parsedCreateSessionInDir !== undefined

  // 尽早校验 permission mode，让用户在 bridge 开始轮询 work 之前就看到错误。
  if (permissionMode !== undefined) {
    const { PERMISSION_MODES } = await import('../types/permissions.js')
    const valid: readonly string[] = PERMISSION_MODES
    if (!valid.includes(permissionMode)) {
      // biome-ignore lint/suspicious/noConsole: intentional error output
      console.error(
        `Error: Invalid permission mode '${permissionMode}'. Valid modes: ${valid.join(', ')}`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  }

  const dir = resolve('.')

  // bridge 的快速路径会绕过 init.ts，因此必须在任何会间接调用
  // getGlobalConfig() 的代码之前先启用 config 读取。
  const { enableConfigs, checkHasTrustDialogAccepted } = await import(
    '../utils/config.js'
  )
  enableConfigs()

  // 初始化 analytics 与错误上报 sinks。bridge 会绕过 setup() 的初始化流程，
  // 所以这里直接调用 initSinks() 来挂载 sinks。
  const { initSinks } = await import('../utils/sinks.js')
  initSinks()

  // 带 gate 感知的校验：--spawn / --capacity / --create-session-in-dir
  // 都要求 multi-session gate 开启。parseArgs 已经校验过 flag 组合；
  // 这里仅检查 gate，因为这一步需要异步的 GrowthBook 调用。
  // 它必须在 enableConfigs() 之后运行（GrowthBook 缓存会读取全局配置），
  // 也要在 initSinks() 之后运行，这样拒绝事件才能被正确入队。
  const multiSessionEnabled = await isMultiSessionSpawnEnabled()
  if (usedMultiSessionFeature && !multiSessionEnabled) {
    await logEventAsync('tengu_bridge_multi_session_denied', {
      used_spawn: parsedSpawnMode !== undefined,
      used_capacity: parsedCapacity !== undefined,
      used_create_session_in_dir: parsedCreateSessionInDir !== undefined,
    })
    // logEventAsync 只负责入队，而 process.exit() 会直接丢弃缓冲中的事件。
    // 因此这里显式 flush，一并把上限控制在 500ms，与 gracefulShutdown.ts 保持一致。
    // （sleep() 的定时器不会 unref，但后面立刻就会 process.exit()，
    // 所以这个带引用的定时器也不会拖慢关闭。）
    await Promise.race([
      Promise.all([shutdown1PEventLogging(), shutdownDatadog()]),
      sleep(500, undefined, { unref: true }),
    ]).catch(() => {})
    // biome-ignore lint/suspicious/noConsole: intentional error output
    console.error(
      'Error: Multi-session Remote Control is not enabled for your account yet.',
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // 设置 bootstrap CWD，让 trust 检查、项目配置查找以及 git 工具
  // （getBranch、getRemoteUrl）都能基于正确路径解析。
  const { setOriginalCwd, setCwdState } = await import('../bootstrap/state.js')
  setOriginalCwd(dir)
  setCwdState(dir)

  // bridge 会绕过 main.tsx（后者会通过 showSetupScreens 渲染交互式 TrustDialog），
  // 所以这里必须确认信任关系已经在正常 `claude` 会话中建立过。
  if (!checkHasTrustDialogAccepted()) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      `Error: Workspace not trusted. Please run \`claude\` in ${dir} first to review and accept the workspace trust dialog.`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // 解析鉴权信息。
  const { clearOAuthTokenCache, checkAndRefreshOAuthTokenIfNeeded } =
    await import('../utils/auth.js')
  const { getBridgeAccessToken, getBridgeBaseUrl } = await import(
    './bridgeConfig.js'
  )

  const bridgeToken = getBridgeAccessToken()
  if (!bridgeToken) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(BRIDGE_LOGIN_ERROR)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // 首次使用 remote 的对话框：解释 bridge 的作用并征求用户同意。
  const {
    getGlobalConfig,
    saveGlobalConfig,
    getCurrentProjectConfig,
    saveCurrentProjectConfig,
  } = await import('../utils/config.js')
  if (!getGlobalConfig().remoteDialogSeen) {
    const readline = await import('readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      '\nRemote Control lets you access this CLI session from the web (claude.ai/code)\nor the Claude app, so you can pick up where you left off on any device.\n\nYou can disconnect remote access anytime by running /remote-control again.\n',
    )
    const answer = await new Promise<string>(resolve => {
      rl.question('Enable Remote Control? (y/n) ', resolve)
    })
    rl.close()
    saveGlobalConfig(current => {
      if (current.remoteDialogSeen) return current
      return { ...current, remoteDialogSeen: true }
    })
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(0)
    }
  }

  // --continue：从 crash-recovery pointer 中解析最近的 session，
  // 再串接到 #20460 的 --session-id 恢复流程。这里具备 worktree 感知能力：
  // 会先检查当前目录（快路径，不执行外部命令），如果没命中，再扩散到 git
  // worktree 同级目录，因为 REPL bridge 会写入 getOriginalCwd()，而
  // EnterWorktreeTool/activeWorktreeSession 可能把它指向某个 worktree，
  // 即使用户的 shell 当前还停在 repo 根目录。
  // parseArgs 已经通过 KAIROS gate 做了约束，因此在 external build 中
  // continueSession 永远为 false，这个分支会被 tree-shake 掉。
  if (feature('KAIROS') && continueSession) {
    const { readBridgePointerAcrossWorktrees } = await import(
      './bridgePointer.js'
    )
    const found = await readBridgePointerAcrossWorktrees(dir)
    if (!found) {
      // biome-ignore lint/suspicious/noConsole: intentional error output
      console.error(
        `Error: No recent session found in this directory or its worktrees. Run \`claude remote-control\` to start a new one.`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    const { pointer, dir: pointerDir } = found
    const ageMin = Math.round(pointer.ageMs / 60_000)
    const ageStr = ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`
    const fromWt = pointerDir !== dir ? ` from worktree ${pointerDir}` : ''
    // biome-ignore lint/suspicious/noConsole: intentional info output
    console.error(
      `Resuming session ${pointer.sessionId} (${ageStr} ago)${fromWt}\u2026`,
    )
    resumeSessionId = pointer.sessionId
    // 记录 pointer 来自哪里，这样下面 #20460 的 exit(1) 路径在确定性失败时
    // 才能清掉正确的文件；否则 --continue 会反复命中同一个失效 session。
    // 它也可能来自某个 worktree 同级目录。
    resumePointerDir = pointerDir
  }

  // 在生产环境中，baseUrl 来自 OAuth config，对应 Anthropic API。
  // CLAUDE_BRIDGE_BASE_URL 只用于 ant 本地开发场景做覆盖。
  const baseUrl = getBridgeBaseUrl()

  // 对非 localhost 目标强制要求 HTTPS，以保护凭据安全。
  if (
    baseUrl.startsWith('http://') &&
    !baseUrl.includes('localhost') &&
    !baseUrl.includes('127.0.0.1')
  ) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      'Error: Remote Control base URL uses HTTP. Only HTTPS or localhost HTTP is allowed.',
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // WebSocket 连接使用的 session ingress URL。在线上它与 baseUrl 相同，
  // 因为 Envoy 会把 /v1/session_ingress/* 路由到 session-ingress。
  // 在本地环境里，session-ingress 运行在与 contain-provide-api（8211）不同的端口
  // （9413），因此必须显式设置 CLAUDE_BRIDGE_SESSION_INGRESS_URL。
  // 这与 CLAUDE_BRIDGE_BASE_URL 一样，只对 ant 生效。
  const sessionIngressUrl =
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      ? process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      : baseUrl

  const { getBranch, getRemoteUrl, findGitRoot } = await import(
    '../utils/git.js'
  )

  // 为首次运行对话框和 `w` 切换键预先检查 worktree 是否可用。
  // 这里无条件执行，便于我们一开始就知道 worktree 是否是一个有效选项。
  const { hasWorktreeCreateHook } = await import('../utils/hooks.js')
  const worktreeAvailable = hasWorktreeCreateHook() || findGitRoot(dir) !== null

  // 读取项目级已保存的 spawn-mode 偏好。这里受 multiSessionEnabled 控制，
  // 这样一旦 GrowthBook 回滚，就能干净地让用户回到 single-session，
  // 否则一个旧的偏好会在 gate 关闭的情况下悄悄重新启用 multi-session 行为
  // （例如 worktree 隔离、32 上限、w 切换）。
  // 同时也要防御一种情况：当前目录曾经是 git repo（或用户复制过配置）留下了
  // 一个过期的 worktree 偏好。这里会把它从磁盘清掉，避免每次启动都重复警告。
  let savedSpawnMode = multiSessionEnabled
    ? getCurrentProjectConfig().remoteControlSpawnMode
    : undefined
  if (savedSpawnMode === 'worktree' && !worktreeAvailable) {
    // biome-ignore lint/suspicious/noConsole: intentional warning output
    console.error(
      'Warning: Saved spawn mode is worktree but this directory is not a git repository. Falling back to same-dir.',
    )
    savedSpawnMode = undefined
    saveCurrentProjectConfig(current => {
      if (current.remoteControlSpawnMode === undefined) return current
      return { ...current, remoteControlSpawnMode: undefined }
    })
  }

  // 首次运行时的 spawn-mode 选择：仅当这个选择确实有意义时
  // （gate 已开、两种模式都可用、没有显式覆盖、不是在恢复流程中）
  // 才会按项目询问一次。结果会保存到 ProjectConfig，后续启动即可跳过。
  if (
    multiSessionEnabled &&
    !savedSpawnMode &&
    worktreeAvailable &&
    parsedSpawnMode === undefined &&
    !resumeSessionId &&
    process.stdin.isTTY
  ) {
    const readline = await import('readline')
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    // biome-ignore lint/suspicious/noConsole: intentional dialog output
    console.log(
      `\nClaude Remote Control is launching in spawn mode which lets you create new sessions in this project from Claude Code on Web or your Mobile app. Learn more here: https://code.claude.com/docs/en/remote-control\n\n` +
        `Spawn mode for this project:\n` +
        `  [1] same-dir \u2014 sessions share the current directory (default)\n` +
        `  [2] worktree \u2014 each session gets an isolated git worktree\n\n` +
        `This can be changed later or explicitly set with --spawn=same-dir or --spawn=worktree.\n`,
    )
    const answer = await new Promise<string>(resolve => {
      rl.question('Choose [1/2] (default: 1): ', resolve)
    })
    rl.close()
    const chosen: 'same-dir' | 'worktree' =
      answer.trim() === '2' ? 'worktree' : 'same-dir'
    savedSpawnMode = chosen
    logEvent('tengu_bridge_spawn_mode_chosen', {
      spawn_mode:
        chosen as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    saveCurrentProjectConfig(current => {
      if (current.remoteControlSpawnMode === chosen) return current
      return { ...current, remoteControlSpawnMode: chosen }
    })
  }

  // 计算实际生效的 spawn mode。
  // 优先级：resume > 显式 --spawn > 保存的项目偏好 > gate 默认值
  // - 通过 --continue / --session-id 恢复时：始终使用 single-session
  //   （恢复针对的是原始目录中的某一个特定 session）
  // - 显式传入 --spawn：直接使用该值（不会持久化）
  // - 已保存的 ProjectConfig.remoteControlSpawnMode：由首次运行对话框或 `w` 设置
  // - gate 开启时的默认值：same-dir（持久化的 multi-session，共享 cwd）
  // - gate 关闭时的默认值：single-session（保持旧行为不变）
  // 同时记录 spawn mode 的来源，便于 rollout analytics。
  type SpawnModeSource = 'resume' | 'flag' | 'saved' | 'gate_default'
  let spawnModeSource: SpawnModeSource
  let spawnMode: SpawnMode
  if (resumeSessionId) {
    spawnMode = 'single-session'
    spawnModeSource = 'resume'
  } else if (parsedSpawnMode !== undefined) {
    spawnMode = parsedSpawnMode
    spawnModeSource = 'flag'
  } else if (savedSpawnMode !== undefined) {
    spawnMode = savedSpawnMode
    spawnModeSource = 'saved'
  } else {
    spawnMode = multiSessionEnabled ? 'same-dir' : 'single-session'
    spawnModeSource = 'gate_default'
  }
  const maxSessions =
    spawnMode === 'single-session'
      ? 1
      : (parsedCapacity ?? SPAWN_SESSIONS_DEFAULT)
  // 启动时预创建一个空 session，让用户立刻就有地方输入内容。
  // 它运行在当前目录下（在 spawn 循环中不参与 worktree 创建）。
  // 默认开启；--no-create-session-in-dir 可将其关闭，用于纯按需创建的模式，
  // 使每个 session 都保持隔离。
  // 创建位置处的 effectiveResumeSessionId 守卫会处理恢复场景：
  // 恢复成功时跳过创建；若因 env mismatch 回退，则继续走新建流程。
  const preCreateSession = parsedCreateSessionInDir ?? true

  // 如果没有使用 --continue，残留的 pointer 就意味着上一次运行没有正常关闭
  // （比如 crash、kill -9、终端被直接关闭）。这里要把它清掉，避免陈旧 env
  // 在失去意义后继续残留。这个逻辑会在所有模式下执行
  // （没有文件时 clearBridgePointer 本身就是 no-op），也覆盖了这种情况：
  // 用户在 single-session 模式下崩溃后，又以 worktree 模式重新启动。
  // 只有 single-session 模式会写入新的 pointer。
  if (!resumeSessionId) {
    const { clearBridgePointer } = await import('./bridgePointer.js')
    await clearBridgePointer(dir)
  }

  // worktree 模式要求存在 git，或者配置了 WorktreeCreate/WorktreeRemove hook。
  // 这里只有显式 --spawn=worktree 才会走到（默认是 same-dir）；
  // 已保存的 worktree 偏好已在上方提前做过防护。
  if (spawnMode === 'worktree' && !worktreeAvailable) {
    // biome-ignore lint/suspicious/noConsole: intentional error output
    console.error(
      `Error: Worktree mode requires a git repository or WorktreeCreate hooks configured. Use --spawn=session for single-session mode.`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  const branch = await getBranch()
  const gitRepoUrl = await getRemoteUrl()
  const machineName = hostname()
  const bridgeId = randomUUID()

  const { handleOAuth401Error } = await import('../utils/auth.js')
  const api = createBridgeApiClient({
    baseUrl,
    getAccessToken: getBridgeAccessToken,
    runnerVersion: MACRO.VERSION,
    onDebug: logForDebugging,
    onAuth401: handleOAuth401Error,
    getTrustedDeviceToken,
  })

  // 通过 --session-id 恢复 session 时，需要先把它取回来拿到 environment_id，
  // 然后在注册时复用该值（对后端来说这是幂等的）。否则就保持 undefined，
  // 因为后端会拒绝客户端自生成的 UUID，并自行分配新的 environment。
  // feature('KAIROS') gate：--session-id 仅对 ant 可用；parseArgs 在 gate 关闭时
  // 已经拒绝了这个 flag，因此 external build 里这里的 resumeSessionId
  // 始终会是 undefined。这个 guard 主要是为了 tree-shaking。
  let reuseEnvironmentId: string | undefined
  if (feature('KAIROS') && resumeSessionId) {
    try {
      validateBridgeId(resumeSessionId, 'sessionId')
    } catch {
      // biome-ignore lint/suspicious/noConsole: intentional error output
      console.error(
        `Error: Invalid session ID "${resumeSessionId}". Session IDs must not contain unsafe characters.`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    // 预先主动刷新 OAuth token。getBridgeSession 使用的是原始 axios，
    // 不带 withOAuthRetry 的 401 刷新逻辑；如果 token 已过期但仍存在，
    // 否则这里会产生一个具有误导性的“not found”错误。
    await checkAndRefreshOAuthTokenIfNeeded()
    clearOAuthTokenCache()
    const { getBridgeSession } = await import('./createSession.js')
    const session = await getBridgeSession(resumeSessionId, {
      baseUrl,
      getAccessToken: getBridgeAccessToken,
    })
    if (!session) {
      // 如果服务端已不存在该 session，说明 pointer 已过期。
      // 这里要把它清掉，避免用户下次启动时再次被提示。
      // （显式 --session-id 不会动 pointer，因为那是独立文件，用户甚至可能并没有。）
      // resumePointerDir 也可能是某个 worktree 同级目录，因此要清掉那个位置的文件。
      if (resumePointerDir) {
        const { clearBridgePointer } = await import('./bridgePointer.js')
        await clearBridgePointer(resumePointerDir)
      }
      // biome-ignore lint/suspicious/noConsole: intentional error output
      console.error(
        `Error: Session ${resumeSessionId} not found. It may have been archived or expired, or your login may have lapsed (run \`claude /login\`).`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    if (!session.environment_id) {
      if (resumePointerDir) {
        const { clearBridgePointer } = await import('./bridgePointer.js')
        await clearBridgePointer(resumePointerDir)
      }
      // biome-ignore lint/suspicious/noConsole: intentional error output
      console.error(
        `Error: Session ${resumeSessionId} has no environment_id. It may never have been attached to a bridge.`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
    reuseEnvironmentId = session.environment_id
    logForDebugging(
      `[bridge:init] Resuming session ${resumeSessionId} on environment ${reuseEnvironmentId}`,
    )
  }

  const config: BridgeConfig = {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    maxSessions,
    spawnMode,
    verbose,
    sandbox,
    bridgeId,
    workerType: 'claude_code',
    environmentId: randomUUID(),
    reuseEnvironmentId,
    apiBaseUrl: baseUrl,
    sessionIngressUrl,
    debugFile,
    sessionTimeoutMs,
  }

  logForDebugging(
    `[bridge:init] bridgeId=${bridgeId}${reuseEnvironmentId ? ` reuseEnvironmentId=${reuseEnvironmentId}` : ''} dir=${dir} branch=${branch} gitRepoUrl=${gitRepoUrl} machine=${machineName}`,
  )
  logForDebugging(
    `[bridge:init] apiBaseUrl=${baseUrl} sessionIngressUrl=${sessionIngressUrl}`,
  )
  logForDebugging(
    `[bridge:init] sandbox=${sandbox}${debugFile ? ` debugFile=${debugFile}` : ''}`,
  )

  // 在进入 poll loop 之前先注册 bridge environment。
  let environmentId: string
  let environmentSecret: string
  try {
    const reg = await api.registerBridgeEnvironment(config)
    environmentId = reg.environment_id
    environmentSecret = reg.environment_secret
  } catch (err) {
    logEvent('tengu_bridge_registration_failed', {
      status: err instanceof BridgeFatalError ? err.status : undefined,
    })
    // 注册失败属于致命错误，这里输出干净的提示，不打印 stack trace。
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      err instanceof BridgeFatalError && err.status === 404
        ? 'Remote Control environments are not available for your account.'
        : `Error: ${errorMessage(err)}`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // 记录 --session-id 恢复流程是否真正成功完成。
  // 下面会用它来跳过全新 session 创建，并初始化 initialSessionId。
  // 如果发生 env mismatch，会将其清空，从而平滑回退到新 session。
  let effectiveResumeSessionId: string | undefined
  if (feature('KAIROS') && resumeSessionId) {
    if (reuseEnvironmentId && environmentId !== reuseEnvironmentId) {
      // 后端返回了不同的 environment_id，说明原始 env 已经过期或被回收。
      // reconnect 无法对这个新 env 生效（session 绑定在旧 env 上）。
      // 这里记录到 sentry 便于观测，然后回落到在新 env 上创建全新 session。
      logError(
        new Error(
          `Bridge resume env mismatch: requested ${reuseEnvironmentId}, backend returned ${environmentId}. Falling back to fresh session.`,
        ),
      )
      // biome-ignore lint/suspicious/noConsole: intentional warning output
      console.warn(
        `Warning: Could not resume session ${resumeSessionId} — its environment has expired. Creating a fresh session instead.`,
      )
      // 这里不要 deregister，因为我们接下来就要使用这个新的 environment。
      // effectiveResumeSessionId 保持 undefined，下面会自然走全新 session 路径。
    } else {
      // 强制停掉该 session 的所有陈旧 worker 实例，并把它重新入队，
      // 这样我们的 poll loop 才能重新接手。必须在 registration 之后做，
      // 这样后端才知道这个 environment 上已经存在一个活跃 worker。
      //
      // pointer 里存的是 session_* ID，但当 ccr_v2_compat_enabled 打开时，
      // /bridge/reconnect 会按 infra tag（cse_*）查找 session。
      // 因此这里两个都试；如果本来就是 cse_*，转换本身就是 no-op。
      const infraResumeId = toInfraSessionId(resumeSessionId)
      const reconnectCandidates =
        infraResumeId === resumeSessionId
          ? [resumeSessionId]
          : [resumeSessionId, infraResumeId]
      let reconnected = false
      let lastReconnectErr: unknown
      for (const candidateId of reconnectCandidates) {
        try {
          await api.reconnectSession(environmentId, candidateId)
          logForDebugging(
            `[bridge:init] Session ${candidateId} re-queued via bridge/reconnect`,
          )
          effectiveResumeSessionId = resumeSessionId
          reconnected = true
          break
        } catch (err) {
          lastReconnectErr = err
          logForDebugging(
            `[bridge:init] reconnectSession(${candidateId}) failed: ${errorMessage(err)}`,
          )
        }
      }
      if (!reconnected) {
        const err = lastReconnectErr

        // 遇到瞬时 reconnect 失败时绝对不能 deregister，因为此时
        // environmentId 就是该 session 自己绑定的 environment。
        // 一旦注销就彻底无法重试。后端的 4 小时 TTL 会负责清理。
        const isFatal = err instanceof BridgeFatalError
        // 只有 fatal reconnect 失败时才清 pointer。瞬时失败
        // （“try running the same command again”）必须保留 pointer，
        // 让下次启动时继续提示恢复，这本身就是重试机制的一部分。
        if (resumePointerDir && isFatal) {
          const { clearBridgePointer } = await import('./bridgePointer.js')
          await clearBridgePointer(resumePointerDir)
        }
        // biome-ignore lint/suspicious/noConsole: intentional error output
        console.error(
          isFatal
            ? `Error: ${errorMessage(err)}`
            : `Error: Failed to reconnect session ${resumeSessionId}: ${errorMessage(err)}\nThe session may still be resumable — try running the same command again.`,
        )
        // eslint-disable-next-line custom-rules/no-process-exit
        process.exit(1)
      }
    }
  }

  logForDebugging(
    `[bridge:init] Registered, server environmentId=${environmentId}`,
  )
  const startupPollConfig = getPollIntervalConfig()
  logEvent('tengu_bridge_started', {
    max_sessions: config.maxSessions,
    has_debug_file: !!config.debugFile,
    sandbox: config.sandbox,
    verbose: config.verbose,
    heartbeat_interval_ms:
      startupPollConfig.non_exclusive_heartbeat_interval_ms,
    spawn_mode:
      config.spawnMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    spawn_mode_source:
      spawnModeSource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    multi_session_gate: multiSessionEnabled,
    pre_create_session: preCreateSession,
    worktree_available: worktreeAvailable,
  })
  logForDiagnosticsNoPII('info', 'bridge_started', {
    max_sessions: config.maxSessions,
    sandbox: config.sandbox,
    spawn_mode: config.spawnMode,
  })

  const spawner = createSessionSpawner({
    execPath: process.execPath,
    scriptArgs: spawnScriptArgs(),
    env: process.env,
    verbose,
    sandbox,
    debugFile,
    permissionMode,
    onDebug: logForDebugging,
    onActivity: (sessionId, activity) => {
      logForDebugging(
        `[bridge:activity] sessionId=${sessionId} ${activity.type} ${activity.summary}`,
      )
    },
    onPermissionRequest: (sessionId, request, _accessToken) => {
      logForDebugging(
        `[bridge:perm] sessionId=${sessionId} tool=${request.request.tool_name} request_id=${request.request_id} (not auto-approving)`,
      )
    },
  })

  const logger = createBridgeLogger({ verbose })
  const { parseGitHubRepository } = await import('../utils/detectRepository.js')
  const ownerRepo = gitRepoUrl ? parseGitHubRepository(gitRepoUrl) : null
  // 优先使用解析出来的 owner/repo 中的 repo 名；拿不到时退回目录 basename。
  const repoName = ownerRepo ? ownerRepo.split('/').pop()! : basename(dir)
  logger.setRepoInfo(repoName, branch)

  // 只有当当前处于 multi-session 模式且 worktree 确实可用时，`w` 切换键才可用。
  // 不可用时，界面上的模式后缀和提示也会一起隐藏。
  const toggleAvailable = spawnMode !== 'single-session' && worktreeAvailable
  if (toggleAvailable) {
    // 这里的类型断言是安全的：上面已经确保 spawnMode 不是 single-session，
    // 而且前面关于“非 git 环境中的已保存 worktree 偏好”的防护和退出检查
    // 也保证了只有在 worktree 可用时才会走到这里。
    logger.setSpawnModeDisplay(spawnMode as 'same-dir' | 'worktree')
  }

  // 监听按键：空格切换 QR code 显示，`w` 切换 spawn mode。
  const onStdinData = (data: Buffer): void => {
    if (data[0] === 0x03 || data[0] === 0x04) {
      // Ctrl+C / Ctrl+D：触发优雅关闭。
      process.emit('SIGINT')
      return
    }
    if (data[0] === 0x20 /* space */) {
      logger.toggleQr()
      return
    }
    if (data[0] === 0x77 /* 'w' */) {
      if (!toggleAvailable) return
      const newMode: 'same-dir' | 'worktree' =
        config.spawnMode === 'same-dir' ? 'worktree' : 'same-dir'
      config.spawnMode = newMode
      logEvent('tengu_bridge_spawn_mode_toggled', {
        spawn_mode:
          newMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logger.logStatus(
        newMode === 'worktree'
          ? 'Spawn mode: worktree (new sessions get isolated git worktrees)'
          : 'Spawn mode: same-dir (new sessions share the current directory)',
      )
      logger.setSpawnModeDisplay(newMode)
      logger.refreshDisplay()
      saveCurrentProjectConfig(current => {
        if (current.remoteControlSpawnMode === newMode) return current
        return { ...current, remoteControlSpawnMode: newMode }
      })
      return
    }
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onStdinData)
  }

  const controller = new AbortController()
  const onSigint = (): void => {
    logForDebugging('[bridge:shutdown] SIGINT received, shutting down')
    controller.abort()
  }
  const onSigterm = (): void => {
    logForDebugging('[bridge:shutdown] SIGTERM received, shutting down')
    controller.abort()
  }
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  // 自动创建一个空 session，让用户一开始就有地方输入内容
  // （与 /remote-control 的行为保持一致）。是否开启由 preCreateSession 控制：
  // 默认开启；--no-create-session-in-dir 可显式关闭。
  // 如果 --session-id 恢复成功，则完全跳过创建，因为该 session 已存在，
  // 且 bridge/reconnect 已经把它重新入队。
  // 如果请求了恢复但因为 env mismatch 失败，effectiveResumeSessionId 会是 undefined，
  // 于是会自然落回全新 session 创建路径，并保留上面那条
  // “Creating a fresh session instead” 警告语义。
  let initialSessionId: string | null =
    feature('KAIROS') && effectiveResumeSessionId
      ? effectiveResumeSessionId
      : null
  if (preCreateSession && !(feature('KAIROS') && effectiveResumeSessionId)) {
    const { createBridgeSession } = await import('./createSession.js')
    try {
      initialSessionId = await createBridgeSession({
        environmentId,
        title: name,
        events: [],
        gitRepoUrl,
        branch,
        signal: controller.signal,
        baseUrl,
        getAccessToken: getBridgeAccessToken,
        permissionMode,
      })
      if (initialSessionId) {
        logForDebugging(
          `[bridge:init] Created initial session ${initialSessionId}`,
        )
      }
    } catch (err) {
      logForDebugging(
        `[bridge:init] Session creation failed (non-fatal): ${errorMessage(err)}`,
      )
    }
  }

  // Crash-recovery pointer：立刻写入，这样从这里开始任意时刻即使被 kill -9，
  // 也仍会留下可恢复的线索。它同时覆盖新建 session 和恢复后的 session
  // （因此恢复后再次崩溃也仍可恢复）。
  // 当 runBridgeLoop 走到 archive+deregister 的正常结束路径时会清掉它；
  // 如果是 SIGINT 的可恢复 shutdown 提前返回，则会保留它，作为用户
  // 还没来得及抄下打印出来的 --session-id 提示时的后备信息。
  // 此外会每小时刷新一次，这样即使一个运行了 5 小时以上的 session 崩溃，
  // pointer 仍然是新的（过期判断基于文件 mtime，而后端 TTL 是按 poll 滚动计算）。
  let pointerRefreshTimer: ReturnType<typeof setInterval> | null = null
  // 仅 single-session 模式会写 pointer：--continue 在恢复时会强制走
  // single-session，因此如果在 multi-session 模式里写 pointer，用户恢复时
  // 就会与自己的配置相矛盾。可恢复 shutdown 路径本身也只对 single-session 开放，
  // 所以 multi-session 下写出来的 pointer 最终只会变成孤儿。
  if (initialSessionId && spawnMode === 'single-session') {
    const { writeBridgePointer } = await import('./bridgePointer.js')
    const pointerPayload = {
      sessionId: initialSessionId,
      environmentId,
      source: 'standalone' as const,
    }
    await writeBridgePointer(config.dir, pointerPayload)
    pointerRefreshTimer = setInterval(
      writeBridgePointer,
      60 * 60 * 1000,
      config.dir,
      pointerPayload,
    )
    // 不要让这个 interval 单独阻止进程退出。
    pointerRefreshTimer.unref?.()
  }

  try {
    await runBridgeLoop(
      config,
      environmentId,
      environmentSecret,
      api,
      spawner,
      logger,
      controller.signal,
      undefined,
      initialSessionId ?? undefined,
      async () => {
        // 清空已记忆的 OAuth token 缓存，强制重新从安全存储读取，
        // 这样才能拿到子进程刚刚刷新过的 token。
        clearOAuthTokenCache()
        // 如果磁盘上的 token 也过期了，这里再主动刷新一次。
        await checkAndRefreshOAuthTokenIfNeeded()
        return getBridgeAccessToken()
      },
    )
  } finally {
    if (pointerRefreshTimer !== null) {
      clearInterval(pointerRefreshTimer)
    }
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.stdin.off('data', onStdinData)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.stdin.pause()
  }

  // bridge 会绕过 init.ts（以及其中的 graceful shutdown handler），
  // 因此这里必须显式退出。
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(0)
}

// ─── Headless bridge (daemon worker) ────────────────────────────────────────

/**
 * runBridgeHeadless 在遇到 supervisor 不应重试的配置问题时会抛出它
 * （如 trust 未接受、worktree 不可用、http-not-https）。daemon worker
 * 会捕获它并以 EXIT_CODE_PERMANENT 退出，从而让 supervisor 停放该 worker，
 * 而不是继续按退避策略反复拉起。
 */
export class BridgeHeadlessPermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeHeadlessPermanentError'
  }
}

export type HeadlessBridgeOpts = {
  dir: string
  name?: string
  spawnMode: 'same-dir' | 'worktree'
  capacity: number
  permissionMode?: string
  sandbox: boolean
  sessionTimeoutMs?: number
  createSessionOnStart: boolean
  getAccessToken: () => string | undefined
  onAuth401: (failedToken: string) => Promise<boolean>
  log: (s: string) => void
}

/**
 * `remoteControl` daemon worker 使用的非交互式 bridge 入口。
 *
 * 它是 bridgeMain() 的线性子集：没有 readline 对话框，没有 stdin 按键处理，
 * 没有 TUI，也不会调用 process.exit()。配置由调用方（daemon.json）提供，
 * auth 通过 IPC 注入（supervisor 的 AuthManager），日志写到 worker 的 stdout
 * 管道。遇到致命错误时会直接抛出，由 worker 捕获后把 permanent / transient
 * 映射到正确的退出码。
 *
 * 当 `signal` abort 且 poll loop 完成拆除后，它会正常 resolve。
 */
export async function runBridgeHeadless(
  opts: HeadlessBridgeOpts,
  signal: AbortSignal,
): Promise<void> {
  const { dir, log } = opts

  // worker 会继承 supervisor 的 CWD。这里先 chdir，确保 git 工具
  // （getBranch/getRemoteUrl）在读取下方设置的 bootstrap CWD state 时，
  // 能够对准正确的 repo。
  process.chdir(dir)
  const { setOriginalCwd, setCwdState } = await import('../bootstrap/state.js')
  setOriginalCwd(dir)
  setCwdState(dir)

  const { enableConfigs, checkHasTrustDialogAccepted } = await import(
    '../utils/config.js'
  )
  enableConfigs()
  const { initSinks } = await import('../utils/sinks.js')
  initSinks()

  if (!checkHasTrustDialogAccepted()) {
    throw new BridgeHeadlessPermanentError(
      `Workspace not trusted: ${dir}. Run \`claude\` in that directory first to accept the trust dialog.`,
    )
  }

  if (!opts.getAccessToken()) {
    // 瞬时问题：supervisor 的 AuthManager 可能会在下一轮拿到 token。
    throw new Error(BRIDGE_LOGIN_ERROR)
  }

  const { getBridgeBaseUrl } = await import('./bridgeConfig.js')
  const baseUrl = getBridgeBaseUrl()
  if (
    baseUrl.startsWith('http://') &&
    !baseUrl.includes('localhost') &&
    !baseUrl.includes('127.0.0.1')
  ) {
    throw new BridgeHeadlessPermanentError(
      'Remote Control base URL uses HTTP. Only HTTPS or localhost HTTP is allowed.',
    )
  }
  const sessionIngressUrl =
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      ? process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      : baseUrl

  const { getBranch, getRemoteUrl, findGitRoot } = await import(
    '../utils/git.js'
  )
  const { hasWorktreeCreateHook } = await import('../utils/hooks.js')

  if (opts.spawnMode === 'worktree') {
    const worktreeAvailable =
      hasWorktreeCreateHook() || findGitRoot(dir) !== null
    if (!worktreeAvailable) {
      throw new BridgeHeadlessPermanentError(
        `Worktree mode requires a git repository or WorktreeCreate hooks. Directory ${dir} has neither.`,
      )
    }
  }

  const branch = await getBranch()
  const gitRepoUrl = await getRemoteUrl()
  const machineName = hostname()
  const bridgeId = randomUUID()

  const config: BridgeConfig = {
    dir,
    machineName,
    branch,
    gitRepoUrl,
    maxSessions: opts.capacity,
    spawnMode: opts.spawnMode,
    verbose: false,
    sandbox: opts.sandbox,
    bridgeId,
    workerType: 'claude_code',
    environmentId: randomUUID(),
    apiBaseUrl: baseUrl,
    sessionIngressUrl,
    sessionTimeoutMs: opts.sessionTimeoutMs,
  }

  const api = createBridgeApiClient({
    baseUrl,
    getAccessToken: opts.getAccessToken,
    runnerVersion: MACRO.VERSION,
    onDebug: log,
    onAuth401: opts.onAuth401,
    getTrustedDeviceToken,
  })

  let environmentId: string
  let environmentSecret: string
  try {
    const reg = await api.registerBridgeEnvironment(config)
    environmentId = reg.environment_id
    environmentSecret = reg.environment_secret
  } catch (err) {
    // 瞬时问题：交给 supervisor 按退避策略重试。
    throw new Error(`Bridge registration failed: ${errorMessage(err)}`)
  }

  const spawner = createSessionSpawner({
    execPath: process.execPath,
    scriptArgs: spawnScriptArgs(),
    env: process.env,
    verbose: false,
    sandbox: opts.sandbox,
    permissionMode: opts.permissionMode,
    onDebug: log,
  })

  const logger = createHeadlessBridgeLogger(log)
  logger.printBanner(config, environmentId)

  let initialSessionId: string | undefined
  if (opts.createSessionOnStart) {
    const { createBridgeSession } = await import('./createSession.js')
    try {
      const sid = await createBridgeSession({
        environmentId,
        title: opts.name,
        events: [],
        gitRepoUrl,
        branch,
        signal,
        baseUrl,
        getAccessToken: opts.getAccessToken,
        permissionMode: opts.permissionMode,
      })
      if (sid) {
        initialSessionId = sid
        log(`created initial session ${sid}`)
      }
    } catch (err) {
      log(`session pre-creation failed (non-fatal): ${errorMessage(err)}`)
    }
  }

  await runBridgeLoop(
    config,
    environmentId,
    environmentSecret,
    api,
    spawner,
    logger,
    signal,
    undefined,
    initialSessionId,
    async () => opts.getAccessToken(),
  )
}

/** BridgeLogger 适配器：把所有输出都路由到单一的行日志函数。 */
function createHeadlessBridgeLogger(log: (s: string) => void): BridgeLogger {
  const noop = (): void => {}
  return {
    printBanner: (cfg, envId) =>
      log(
        `registered environmentId=${envId} dir=${cfg.dir} spawnMode=${cfg.spawnMode} capacity=${cfg.maxSessions}`,
      ),
    logSessionStart: (id, _prompt) => log(`session start ${id}`),
    logSessionComplete: (id, ms) => log(`session complete ${id} (${ms}ms)`),
    logSessionFailed: (id, err) => log(`session failed ${id}: ${err}`),
    logStatus: log,
    logVerbose: log,
    logError: s => log(`error: ${s}`),
    logReconnected: ms => log(`reconnected after ${ms}ms`),
    addSession: (id, _url) => log(`session attached ${id}`),
    removeSession: id => log(`session detached ${id}`),
    updateIdleStatus: noop,
    updateReconnectingStatus: noop,
    updateSessionStatus: noop,
    updateSessionActivity: noop,
    updateSessionCount: noop,
    updateFailedStatus: noop,
    setSpawnModeDisplay: noop,
    setRepoInfo: noop,
    setDebugLogPath: noop,
    setAttached: noop,
    setSessionTitle: noop,
    clearStatus: noop,
    toggleQr: noop,
    refreshDisplay: noop,
  }
}
