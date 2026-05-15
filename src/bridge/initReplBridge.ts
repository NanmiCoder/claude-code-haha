/**
 * 围绕 initBridgeCore 的 REPL 专用包装层。它负责读取 bootstrap 状态中的部分，
 * 包括 gate、cwd、session ID、git 上下文、OAuth、title 派生等，
 * 然后再委托给不依赖 bootstrap 的 core。
 *
 * 之所以从 replBridge.ts 中拆出来，是因为 sessionStorage 的导入
 * （getCurrentSessionTitle）会传递引入 src/commands.ts，进而带上整棵
 * slash command + React 组件树（约 1300 个模块）。把 initBridgeCore 留在一个
 * 不接触 sessionStorage 的文件里，能让 daemonBridge.ts 导入 core 时不至于把
 * Agent SDK bundle 撑大。
 *
 * 它通过动态导入被 useReplBridge（自动启动）和 print.ts
 * （SDK -p 模式，经由 query.enableRemoteControl）调用。
 */

import { feature } from 'bun:bundle'
import { hostname } from 'os'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../services/analytics/growthbook.js'
import { getOrganizationUUID } from '../services/oauth/client.js'
import {
  isPolicyAllowed,
  waitForPolicyLimitsToLoad,
} from '../services/policyLimits/index.js'
import type { Message } from '../types/message.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { stripDisplayTagsAllowEmpty } from '../utils/displayTags.js'
import { errorMessage } from '../utils/errors.js'
import { getBranch, getRemoteUrl } from '../utils/git.js'
import { toSDKMessages } from '../utils/messages/mappers.js'
import {
  getContentText,
  getMessagesAfterCompactBoundary,
  isSyntheticMessage,
} from '../utils/messages.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { getCurrentSessionTitle } from '../utils/sessionStorage.js'
import {
  extractConversationText,
  generateSessionTitle,
} from '../utils/sessionTitle.js'
import { generateShortWordSlug } from '../utils/words.js'
import {
  getBridgeAccessToken,
  getBridgeBaseUrl,
  getBridgeTokenOverride,
} from './bridgeConfig.js'
import {
  checkBridgeMinVersion,
  isBridgeEnabledBlocking,
  isCseShimEnabled,
  isEnvLessBridgeEnabled,
} from './bridgeEnabled.js'
import {
  archiveBridgeSession,
  createBridgeSession,
  updateBridgeSessionTitle,
} from './createSession.js'
import { logBridgeSkip } from './debugUtils.js'
import { checkEnvLessBridgeMinVersion } from './envLessBridgeConfig.js'
import { getPollIntervalConfig } from './pollConfig.js'
import type { BridgeState, ReplBridgeHandle } from './replBridge.js'
import { initBridgeCore } from './replBridge.js'
import { setCseShimGate } from './sessionIdCompat.js'
import type { BridgeWorkerType } from './types.js'

export type InitBridgeOptions = {
  onInboundMessage?: (msg: SDKMessage) => void | Promise<void>
  onPermissionResponse?: (response: SDKControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: BridgeState, detail?: string) => void
  initialMessages?: Message[]
  // 来自 `/remote-control <name>` 的显式 session 名称。设置后会覆盖
  // 从会话内容或 /rename 派生出的 title。
  initialName?: string
  // 调用时刻对完整对话的最新视图。供 onUserMessage 在 count-3 派生阶段使用，
  // 以便对整段对话调用 generateSessionTitle。
  // 该项是可选的。print.ts 的 SDK enableRemoteControl 路径没有 REPL 消息数组，
  // 缺失时 count-3 会退化为只使用单条消息文本。
  getMessages?: () => Message[]
  // 在先前 bridge session 中已 flush 过的 UUID。初始 flush 时会排除这些 UUID 对应的消息，
  // 以免污染服务端（跨 session 重复 UUID 会导致 WS 被杀掉）。
  // 该集合会被原地修改，每次新的 flush 后都会把新 UUID 加进去。
  previouslyFlushedUUIDs?: Set<string>
  /** 见 BridgeCoreParams.perpetual。 */
  perpetual?: boolean
  /**
   * 为 true 时，bridge 只会向外转发事件（没有 SSE inbound 流）。
   * 供 CCR mirror 模式使用，这样本地 session 能在 claude.ai 中可见，
   * 但不会启用入站控制。
   */
  outboundOnly?: boolean
  tags?: string[]
}

export async function initReplBridge(
  options?: InitBridgeOptions,
): Promise<ReplBridgeHandle | null> {
  const {
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    initialMessages,
    getMessages,
    previouslyFlushedUUIDs,
    initialName,
    perpetual,
    outboundOnly,
    tags,
  } = options ?? {}

  // 接上线 cse_ shim 的 kill switch，让 toCompatSessionId 遵守 GrowthBook gate。
  // Daemon/SDK 路径会跳过这一步，此时 shim 默认保持开启。
  setCseShimGate(isCseShimEnabled)

  // 1. 运行时 gate
  if (!(await isBridgeEnabledBlocking())) {
    logBridgeSkip('not_enabled', '[bridge:repl] Skipping: bridge not enabled')
    return null
  }

  // 1b. 最低版本检查要延后到下面的 v1/v2 分支之后，因为两套实现各自有独立下限：
  // v1 读 tengu_bridge_min_version，v2 读 tengu_bridge_repl_v2_config.min_version。

  // 2. 检查 OAuth，必须使用 claude.ai 账号登录。
  // 这一步要放在策略检查之前，避免 console-auth 用户因为陈旧/错误组织缓存，
  // 看到误导性的策略错误，而不是可操作的“/login”提示。
  if (!getBridgeAccessToken()) {
    logBridgeSkip('no_oauth', '[bridge:repl] Skipping: no OAuth tokens')
    onStateChange?.('failed', '/login')
    return null
  }

  // 3. 检查组织策略，remote control 可能被禁用
  await waitForPolicyLimitsToLoad()
  if (!isPolicyAllowed('allow_remote_control')) {
    logBridgeSkip(
      'policy_denied',
      '[bridge:repl] Skipping: allow_remote_control policy not allowed',
    )
    onStateChange?.('failed', "disabled by your organization's policy")
    return null
  }

  // 当设置了 CLAUDE_BRIDGE_OAUTH_TOKEN（ant-only 本地开发）时，bridge 会通过
  // getBridgeAccessToken() 直接使用该 token，此时 keychain 状态无关紧要。
  // 因而要跳过 2b/2c，以保留这层解耦：一个已过期的 keychain token 不应阻塞
  // 一条根本不使用它的 bridge 连接。
  if (!getBridgeTokenOverride()) {
    // 2a. 跨进程退避。如果此前已有 N 个进程看到过这个“完全相同”的死 token
    // （通过 expiresAt 匹配），就静默跳过：不打事件、不尝试刷新。
    // 这个计数阈值可以容忍瞬时刷新失败（auth 服务 5xx、lockfile 错误，见
    // auth.ts:1437/1444/1485）：每个进程都会独立重试，直到连续 3 次失败足以证明
    // token 确实已死。这与 useReplBridge 中进程内的 MAX_CONSECUTIVE_INIT_FAILURES 对齐。
    // expiresAt 作为内容寻址键：/login → 新 token → 新 expiresAt，于是无需显式 clear
    // 就会自然失配。
    const cfg = getGlobalConfig()
    if (
      cfg.bridgeOauthDeadExpiresAt != null &&
      (cfg.bridgeOauthDeadFailCount ?? 0) >= 3 &&
      getClaudeAIOAuthTokens()?.expiresAt === cfg.bridgeOauthDeadExpiresAt
    ) {
      logForDebugging(
        `[bridge:repl] Skipping: cross-process backoff (dead token seen ${cfg.bridgeOauthDeadFailCount} times)`,
      )
      return null
    }

    // 2b. 若已过期则主动刷新。它与 bridgeMain.ts:2096 保持一致。
    // REPL bridge 会在 useEffect mount 时、任何 v1/messages 调用之前触发，
    // 因此这通常是本次 session 的第一笔 OAuth 请求。没有这一步时，约 9% 的注册会带着
    // 已过期超过 8 小时的 token 去打服务端，然后收到 401，再由 withOAuthRetry 恢复。
    // 虽然能恢复，但那条 401 服务端日志其实是可以避免的。我们曾观测到当大量无关用户都卡在
    // 8 小时 TTL 边界时，某些 VPN 出口 IP 的 401:200 比例高达 30:1。
    //
    // 对于新鲜 token 的成本很低：一次带缓存的读取 + 一次 Date.now() 比较（约微秒级）。
    // checkAndRefreshOAuthTokenIfNeeded 会在所有涉及 keychain 的路径中自行清缓存
    // （刷新成功、lockfile 竞争、抛错），因此这里无需显式调用 clearOAuthTokenCache()。
    // 否则会让 91% 以上原本 token 新鲜的路径额外触发一次阻塞式 keychain 访问。
    await checkAndRefreshOAuthTokenIfNeeded()

    // 2c. 如果在尝试刷新后 token 依然过期，则直接跳过。env-var / FD token
    // （auth.ts:894-917）其 expiresAt=null，因此永远不会命中这里。但若一个 keychain token
    // 的 refresh token 已经失效（如改密码、离开组织、token 被 GC），它就会表现为
    // expiresAt<now 且刚刚刷新失败。此时客户端若继续往下走，就会陷入永久 401 循环：
    // withOAuthRetry → handleOAuth401Error → 刷新再次失败 → 用同一陈旧 token 重试 → 再 401。
    // Datadog 2026-03-08 曾观测到单个 IP 每天产生 2,879 次此类 401。
    // 这里直接跳过这次必然失败的 API 调用，并由 useReplBridge 去呈现失败状态。
    //
    // 这里刻意不使用 isOAuthTokenExpired，因为它带有 5 分钟的主动刷新缓冲。
    // 这很适合作为“应该很快刷新”的启发式，但不适合用来判断“是否已明确不可用”。
    // 一个还剩 3 分钟有效期的 token，只要碰上一次临时的刷新端点故障
    // （5xx/超时/wifi 重连），就会被带缓冲的检查误判；而事实上它本来仍可正常连接。
    // 因此这里检查的是实际过期时间：已经过期 且 刷新失败，才算真的死掉。
    const tokens = getClaudeAIOAuthTokens()
    if (tokens && tokens.expiresAt !== null && tokens.expiresAt <= Date.now()) {
      logBridgeSkip(
        'oauth_expired_unrefreshable',
        '[bridge:repl] Skipping: OAuth token expired and refresh failed (re-login required)',
      )
      onStateChange?.('failed', '/login')
      // 为下一个进程持久化这个结果。若再次发现的是同一个死 token
      // （由 expiresAt 匹配），就递增 failCount；若是不同 token，则重置为 1。
      // 一旦计数达到 3，步骤 2a 的提前返回就会生效，这条路径之后不会再被走到。
      // 也就是说，每个死 token 最多只会写 3 次。
      // 这里使用局部 const 保存已收窄类型，因为闭包无法保留 !==null 的收窄结果。
      const deadExpiresAt = tokens.expiresAt
      saveGlobalConfig(c => ({
        ...c,
        bridgeOauthDeadExpiresAt: deadExpiresAt,
        bridgeOauthDeadFailCount:
          c.bridgeOauthDeadExpiresAt === deadExpiresAt
            ? (c.bridgeOauthDeadFailCount ?? 0) + 1
            : 1,
      }))
      return null
    }
  }

  // 4. 计算 baseUrl。v1（基于 env）与 v2（env-less）路径都需要它，
  // 因而提到 v2 gate 之前，供两边共用。
  const baseUrl = getBridgeBaseUrl()

  // 5. 派生 session title。优先级为：显式 initialName → /rename
  // （session storage）→ 最后一条有意义的用户消息 → 自动生成的 slug。
  // 这只是外观层信息（claude.ai 的 session 列表），模型永远看不到它。
  // 这里有两个标志：`hasExplicitTitle`（initialName 或 /rename，永不自动覆盖）和
  // `hasTitle`（任意 title，包括自动派生的；它会阻止 count-1 的再派生，但不会阻止 count-3）。
  // 下方会接到 v1 和 v2 的 onUserMessage 回调，会在第 1 条 prompt 和第 3 条 prompt 时各派生一次，
  // 使移动端/Web 展示的标题能反映更多上下文。
  // slug 回退值（如 "remote-control-graceful-unicorn"）则让自动启动的 session 在
  // 第一条 prompt 到来前，也能在 claude.ai 列表中被区分开。
  let title = `remote-control-${generateShortWordSlug()}`
  let hasTitle = false
  let hasExplicitTitle = false
  if (initialName) {
    title = initialName
    hasTitle = true
    hasExplicitTitle = true
  } else {
    const sessionId = getSessionId()
    const customTitle = sessionId
      ? getCurrentSessionTitle(sessionId)
      : undefined
    if (customTitle) {
      title = customTitle
      hasTitle = true
      hasExplicitTitle = true
    } else if (initialMessages && initialMessages.length > 0) {
      // 找到最后一条具有实际内容的用户消息。要跳过 meta（提示类）、tool result、
      // compact summary（如 "This session is being continued…"）、非人类来源
      // （task notification、channel push），以及 synthetic interrupt
      // （[Request interrupted by user]），因为这些都不是人类直接写下的内容。
      // 这里的过滤规则与 extractTitleText + isSyntheticMessage 保持一致。
      for (let i = initialMessages.length - 1; i >= 0; i--) {
        const msg = initialMessages[i]!
        if (
          msg.type !== 'user' ||
          msg.isMeta ||
          msg.toolUseResult ||
          msg.isCompactSummary ||
          (msg.origin && msg.origin.kind !== 'human') ||
          isSyntheticMessage(msg)
        )
          continue
        const rawContent = getContentText(msg.message.content)
        if (!rawContent) continue
        const derived = deriveTitle(rawContent)
        if (!derived) continue
        title = derived
        hasTitle = true
        break
      }
    }
  }

  // 该逻辑供 v1 和 v2 共用。对于每条适合作为标题的用户消息都会触发，直到回调返回 true。
  // 在 count 1 时，会立即用 deriveTitle 生成一个占位标题，再 fire-and-forget 地用
  // generateSessionTitle（Haiku，句式大小写）升级它。到 count 3 时，会基于完整对话再生成一次。
  // 如果标题是显式指定的（/remote-control <name> 或 /rename），则整段逻辑完全跳过。
  // 每次调用时都会重新检查 sessionStorage，避免两条消息之间发生 /rename 时被覆盖。
  // 如果 initialMessages 已经完成过派生，则 count 1 会跳过（因为当前 title 仍然新鲜），
  // 但 count 3 仍会刷新。v2 传入的是 cse_*；updateBridgeSessionTitle 会在内部自行重标记。
  let userMessageCount = 0
  let lastBridgeSessionId: string | undefined
  let genSeq = 0
  const patch = (
    derived: string,
    bridgeSessionId: string,
    atCount: number,
  ): void => {
    hasTitle = true
    title = derived
    logForDebugging(
      `[bridge:repl] derived title from message ${atCount}: ${derived}`,
    )
    void updateBridgeSessionTitle(bridgeSessionId, derived, {
      baseUrl,
      getAccessToken: getBridgeAccessToken,
    }).catch(() => {})
  }
  // Fire-and-forget 的 Haiku 生成逻辑，并在 await 之后做保护性检查。
  // 会重新检查 /rename（sessionStorage）、v1 env-lost（lastBridgeSessionId），
  // 以及同一 session 内乱序 resolve 的情况（genSeq：如果 count-1 的 Haiku 在 count-3
  // 之后才 resolve，就会覆盖掉信息更丰富的标题）。generateSessionTitle 本身永不 reject。
  const generateAndPatch = (input: string, bridgeSessionId: string): void => {
    const gen = ++genSeq
    const atCount = userMessageCount
    void generateSessionTitle(input, AbortSignal.timeout(15_000)).then(
      generated => {
        if (
          generated &&
          gen === genSeq &&
          lastBridgeSessionId === bridgeSessionId &&
          !getCurrentSessionTitle(getSessionId())
        ) {
          patch(generated, bridgeSessionId, atCount)
        }
      },
    )
  }
  const onUserMessage = (text: string, bridgeSessionId: string): boolean => {
    if (hasExplicitTitle || getCurrentSessionTitle(getSessionId())) {
      return true
    }
    // v1 env-lost 会用新的 ID 重新创建 session。这里要重置计数，
    // 这样新 session 才能拥有自己的 count-3 派生；而 hasTitle 保持 true，
    // 因为新 session 是通过 getCurrentTitle() 创建的，它会从本闭包中读取 count-1 的标题。
    // 因此，新周期中的 count-1 会被正确跳过。
    if (
      lastBridgeSessionId !== undefined &&
      lastBridgeSessionId !== bridgeSessionId
    ) {
      userMessageCount = 0
    }
    lastBridgeSessionId = bridgeSessionId
    userMessageCount++
    if (userMessageCount === 1 && !hasTitle) {
      const placeholder = deriveTitle(text)
      if (placeholder) patch(placeholder, bridgeSessionId, userMessageCount)
      generateAndPatch(text, bridgeSessionId)
    } else if (userMessageCount === 3) {
      const msgs = getMessages?.()
      const input = msgs
        ? extractConversationText(getMessagesAfterCompactBoundary(msgs))
        : text
      generateAndPatch(input, bridgeSessionId)
    }
    // Also re-latches if v1 env-lost resets the transport's done flag past 3.
    return userMessageCount >= 3
  }

  const initialHistoryCap = getFeatureValue_CACHED_WITH_REFRESH(
    'tengu_bridge_initial_history_cap',
    200,
    5 * 60 * 1000,
  )

  // 在 v1/v2 分支前先取 orgUUID，因为两条路径都需要它。
  // v1 用它做 environment 注册；v2 则用在 archive 上
  // （archive 走的是 compat 的 /v1/sessions/{id}/archive，而不是 /v1/code/sessions）。
  // 没有它时，v2 archive 会 404，session 会在 /exit 之后继续残留在 CCR 中。
  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logBridgeSkip('no_org_uuid', '[bridge:repl] Skipping: no org UUID')
    onStateChange?.('failed', '/login')
    return null
  }

  // ── GrowthBook gate：env-less bridge ──────────────────────────────────
  // 打开后，会完全绕过 Environments API 层（不再 register/poll/ack/heartbeat），
  // 而是直接通过 POST /bridge → worker_jwt 建立连接。
  // 见服务端 PR #292605（后在 #293280 中更名）。仅用于 REPL，daemon/print 仍使用基于 env 的路径。
  //
  // 命名说明：“env-less” 与 “CCR v2”（/worker/* transport）不同。
  // 下方基于 env 的路径也同样可以通过 CLAUDE_CODE_USE_CCR_V2 使用 CCR v2。
  // tengu_bridge_repl_v2 控制的是 env-less（即没有 poll loop），而不是 transport 版本。
  //
  // perpetual（通过 bridge-pointer.json 实现 assistant 模式下的 session 连续性）
  // 仍依赖 env，且这里尚未实现。因此只要设置了它，就回退到基于 env 的路径，
  // 以免 KAIROS 用户在不知情的情况下失去跨重启连续性。
  if (isEnvLessBridgeEnabled() && !perpetual) {
    const versionError = await checkEnvLessBridgeMinVersion()
    if (versionError) {
      logBridgeSkip(
        'version_too_old',
        `[bridge:repl] Skipping: ${versionError}`,
        true,
      )
      onStateChange?.('failed', 'run `claude update` to upgrade')
      return null
    }
    logForDebugging(
      '[bridge:repl] Using env-less bridge path (tengu_bridge_repl_v2)',
    )
    const { initEnvLessBridgeCore } = await import('./remoteBridgeCore.js')
    return initEnvLessBridgeCore({
      baseUrl,
      orgUUID,
      title,
      getAccessToken: getBridgeAccessToken,
      onAuth401: handleOAuth401Error,
      toSDKMessages,
      initialHistoryCap,
      initialMessages,
      // v2 总会创建新的服务端 session（新的 cse_* ID），因此这里不传
      // previouslyFlushedUUIDs，不存在跨 session UUID 冲突风险。
      // 同时，该 ref 会跨 enable→disable→re-enable 周期持久存在，若继续复用，
      // 会导致新 session 收到 0 条历史（因为先前启用时所有 UUID 都已进集合）。
      // v1 的处理方式是在创建新 session 时调用 previouslyFlushedUUIDs.clear()
      //（replBridge.ts:768）；v2 则干脆完全跳过这个参数。
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
    })
  }

  // ── v1 路径：基于 env（register/poll/ack/heartbeat） ──────────────────

  const versionError = checkBridgeMinVersion()
  if (versionError) {
    logBridgeSkip('version_too_old', `[bridge:repl] Skipping: ${versionError}`)
    onStateChange?.('failed', 'run `claude update` to upgrade')
    return null
  }

  // 收集 git 上下文，这里就是 bootstrap 读取边界。
  // 从这里往下的所有内容都会显式传给 bridgeCore。
  const branch = await getBranch()
  const gitRepoUrl = await getRemoteUrl()
  const sessionIngressUrl =
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      ? process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      : baseUrl

  // assistant 模式 session 会声明独立的 worker_type，这样 Web UI 就能把它们筛到
  // 专门的 picker 里。KAIROS guard 则确保 assistant 模块完全不会进入外部构建。
  let workerType: BridgeWorkerType = 'claude_code'
  if (feature('KAIROS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isAssistantMode } =
      require('../assistant/index.js') as typeof import('../assistant/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isAssistantMode()) {
      workerType = 'claude_code_assistant'
    }
  }

  // 6. 委托下去。BridgeCoreHandle 在结构上是 ReplBridgeHandle 的超集
  // （额外带有 REPL 调用方不会用到的 writeSdkMessages），因此无需再加适配层，
  // 只需在返回时收窄类型即可。
  return initBridgeCore({
    dir: getOriginalCwd(),
    machineName: hostname(),
    branch,
    gitRepoUrl,
    title,
    baseUrl,
    sessionIngressUrl,
    workerType,
    getAccessToken: getBridgeAccessToken,
    createSession: opts =>
      createBridgeSession({
        ...opts,
        events: [],
        baseUrl,
        getAccessToken: getBridgeAccessToken,
      }),
    archiveSession: sessionId =>
      archiveBridgeSession(sessionId, {
        baseUrl,
        getAccessToken: getBridgeAccessToken,
        // gracefulShutdown.ts:407 会让 runCleanupFunctions 与 2 秒上限竞速。
        // teardown 里还会并行执行 stopWork，并顺序执行 deregister，
        // 因此 archive 不能独占全部预算。1.5s 与 v2 的
        // teardown_archive_timeout_ms 默认值保持一致。
        timeoutMs: 1500,
      }).catch((err: unknown) => {
        // archiveBridgeSession 没有 try/catch，5xx/超时/网络错误都会直接向上抛。
        // 过去这里会被静默吞掉，导致 archive 失败既无法进入 BQ，也无法从 debug log 中诊断。
        logForDebugging(
          `[bridge:repl] archiveBridgeSession threw: ${errorMessage(err)}`,
          { level: 'error' },
        )
      }),
    // getCurrentTitle 会在 env-lost 后重连时读取，用于给新 session 重新命名。
    // /rename 会写入 session storage；onUserMessage 则会直接修改 `title`。
    // 这两条路径在这里都会被统一采集到。
    getCurrentTitle: () => getCurrentSessionTitle(getSessionId()) ?? title,
    onUserMessage,
    toSDKMessages,
    onAuth401: handleOAuth401Error,
    getPollIntervalConfig,
    initialHistoryCap,
    initialMessages,
    previouslyFlushedUUIDs,
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    perpetual,
  })
}

const TITLE_MAX_LEN = 50

/**
 * 快速生成一个占位标题：去掉 display tag，取第一句，折叠空白，并截断到 50 个字符。
 * 如果结果为空（例如消息内容只有 <local-command-stdout>），则返回 undefined。
 * 后续当 Haiku 的 generateSessionTitle 完成后（约 1-15 秒），会用正式标题替换它。
 */
function deriveTitle(raw: string): string | undefined {
  // 去掉 <ide_opened_file>、<session-start-hook> 等标签。这些内容会在 IDE/hook
  // 注入上下文时出现在用户消息中。stripDisplayTagsAllowEmpty 对纯标签消息会返回 ''
  // （而不是原文），因此这类消息会被跳过。
  const clean = stripDisplayTagsAllowEmpty(raw)
  // 第一通常最能表达意图，后面往往只是上下文或细节。
  // 这里用捕获组而不是 lookbehind，以保持 YARR JIT 友好。
  const firstSentence = /^(.*?[.!?])\s/.exec(clean)?.[1] ?? clean
  // 折叠换行与制表符，因为 claude.ai 列表中的标题只能是单行。
  const flat = firstSentence.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > TITLE_MAX_LEN
    ? flat.slice(0, TITLE_MAX_LEN - 1) + '\u2026'
    : flat
}
