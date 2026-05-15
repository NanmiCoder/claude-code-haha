import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Attributes, Meter, MetricOptions } from '@opentelemetry/api'
import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { realpathSync } from 'fs'
import sumBy from 'lodash-es/sumBy.js'
import { cwd } from 'process'
import type { HookEvent, ModelUsage } from 'src/entrypoints/agentSdkTypes.js'
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
// 为 browser-sdk 构建做的一层间接导入（package.json 的 "browser" 字段会把
// crypto.ts 替换成 crypto.browser.ts）。这里只是对 node:crypto 的纯叶子重导出，
// 没有循环依赖风险。路径别名导入会绕过 bootstrap-isolation
// （该规则只检查 ./ 和 / 前缀）；显式 disable 用于说明这是有意为之。
// eslint-disable-next-line custom-rules/bootstrap-isolation
import { randomUUID } from 'src/utils/crypto.js'
import type { ModelSetting } from 'src/utils/model/model.js'
import type { ModelStrings } from 'src/utils/model/modelStrings.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import type { PluginHookMatcher } from 'src/utils/settings/types.js'
import { createSignal } from 'src/utils/signal.js'

// 已注册 hooks 的联合类型，既可能是 SDK 回调，也可能是原生插件 hook。
type RegisteredHookMatcher = HookCallbackMatcher | PluginHookMatcher

import type { SessionId } from 'src/types/ids.js'

// 不要再往这里添加更多状态，全局状态必须极度克制。

// 通过 --dangerously-load-development-channels 进入的条目会带 dev: true。
// allowlist gate 会按“单个条目”检查这个标记（而不是看 session 级别的
// hasDevChannels），因此即便同时传了两个 flag，也不会让开发对话框的
// 通过结果泄漏成对 --channels 条目的 allowlist 绕过。
export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

export type AttributedCounter = {
  add(value: number, additionalAttributes?: Attributes): void
}

type State = {
  originalCwd: string
  // 稳定的项目根目录，只在启动时设置一次（包括 --worktree 场景），
  // 不会被会话中途的 EnterWorktreeTool 更新。
  // 用于标识项目身份（history、skills、sessions），而不是文件操作。
  projectRoot: string
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  turnToolCount: number
  turnHookCount: number
  turnClassifierCount: number
  startTime: number
  lastInteractionTime: number
  totalLinesAdded: number
  totalLinesRemoved: number
  hasUnknownModelCost: boolean
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting
  modelStrings: ModelStrings | null
  isInteractive: boolean
  kairosActive: boolean
  // 为 true 时，ensureToolResultPairing 在不匹配时会直接抛错，
  // 而不是用合成占位符去修补。HFI 会在启动时启用它，
  // 这样轨迹会尽早失败，而不是让模型被假的 tool_results 误导。
  strictToolResultPairing: boolean
  sdkAgentProgressSummariesEnabled: boolean
  userMsgOptIn: boolean
  clientType: string
  sessionSource: string | undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined
  flagSettingsPath: string | undefined
  flagSettingsInline: Record<string, unknown> | null
  allowedSettingSources: SettingSource[]
  sessionIngressToken: string | null | undefined
  oauthTokenFromFd: string | null | undefined
  apiKeyFromFd: string | null | undefined
  // 遥测状态。
  meter: Meter | null
  sessionCounter: AttributedCounter | null
  locCounter: AttributedCounter | null
  prCounter: AttributedCounter | null
  commitCounter: AttributedCounter | null
  costCounter: AttributedCounter | null
  tokenCounter: AttributedCounter | null
  codeEditToolDecisionCounter: AttributedCounter | null
  activeTimeCounter: AttributedCounter | null
  statsStore: { observe(name: string, value: number): void } | null
  sessionId: SessionId
  // 父 session ID，用于追踪 session 谱系（例如 plan mode -> implementation）。
  parentSessionId: SessionId | undefined
  // Logger 状态。
  loggerProvider: LoggerProvider | null
  eventLogger: ReturnType<typeof logs.getLogger> | null
  // Meter provider 状态。
  meterProvider: MeterProvider | null
  // Tracer provider 状态。
  tracerProvider: BasicTracerProvider | null
  // Agent 颜色状态。
  agentColorMap: Map<string, AgentColorName>
  agentColorIndex: number
  // 最近一次 API 请求，用于 bug report。
  lastAPIRequest: Omit<BetaMessageStreamParams, 'messages'> | null
  // 最近一次 API 请求里的消息（仅 ant；保存引用，不做克隆）。
  // 它记录了 compaction 之后、注入 CLAUDE.md 之后真正发往 API 的消息集合，
  // 这样 /share 导出的 serialized_conversation.json 才能反映真实情况。
  lastAPIRequestMessages: BetaMessageStreamParams['messages'] | null
  // 最近一次 auto-mode classifier 请求，用于 /share transcript。
  lastClassifierRequests: unknown[] | null
  // 由 context.ts 为 auto-mode classifier 缓存的 CLAUDE.md 内容。
  // 用于打断 yoloClassifier → claudemd → filesystem → permissions 这条循环依赖链。
  cachedClaudeMdContent: string | null
  // 内存中的近期错误日志。
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>
  // 通过 --plugin-dir 注入、仅在本会话有效的插件。
  inlinePlugins: Array<string>
  // 显式传入的 --chrome / --no-chrome 值（undefined 表示 CLI 未设置）。
  chromeFlagOverride: boolean | undefined
  // 使用 cowork_plugins 目录替代 plugins（由 --cowork 或环境变量控制）。
  useCoworkPlugins: boolean
  // 仅当前会话有效的绕过权限模式标记（不会持久化）。
  sessionBypassPermissionsMode: boolean
  // 仅当前会话有效的开关，用来控制 .claude/scheduled_tasks.json watcher
  // （useScheduledTasks）。当 JSON 中已有条目时由 cronScheduler.start() 设置，
  // 或由 CronCreateTool 设置。不会持久化。
  scheduledTasksEnabled: boolean
  // 仅当前会话有效、由 CronCreate 且 durable: false 创建的 cron 任务。
  // 它们会像文件落盘的任务一样按计划触发，但永远不会写入
  // .claude/scheduled_tasks.json，因此会随进程退出而消失。
  // 类型使用下方的 SessionCronTask；不从 cronTasks.ts 导入，
  // 是为了保持 bootstrap 仍然是 import DAG 的叶子节点。
  sessionCronTasks: SessionCronTask[]
  // 本会话通过 TeamCreate 创建的 teams。cleanupSessionTeams()
  // 会在 gracefulShutdown 时清理它们，避免由 subagent 创建的 team 永久留在磁盘上
  // （gh-32730）。TeamDelete 会同步移除条目，防止重复清理。
  // 它放在这里而不是 teamHelpers.ts，是为了让 resetStateForTests()
  // 能在测试之间把它清干净。
  sessionCreatedTeams: Set<string>
  // 仅当前会话有效的 home 目录信任标记（不会持久化到磁盘）。
  // 当从 home 目录运行时，会弹出 trust 对话框，但不会写盘保存。
  // 这个标记允许那些依赖 trust 的功能在当前会话中继续工作。
  sessionTrustAccepted: boolean
  // 仅当前会话有效的标记，用于禁用 session 落盘。
  sessionPersistenceDisabled: boolean
  // 记录用户是否在本会话中退出过 plan mode（用于再次进入时的引导）。
  hasExitedPlanMode: boolean
  // 记录是否需要展示 plan mode 退出附件（一次性提示）。
  needsPlanModeExitAttachment: boolean
  // 记录是否需要展示 auto mode 退出附件（一次性提示）。
  needsAutoModeExitAttachment: boolean
  // 记录本会话是否已经展示过 LSP 插件推荐（只展示一次）。
  lspRecommendationShownThisSession: boolean
  // SDK init event 状态，保存结构化输出所需的 jsonSchema。
  initJsonSchema: Record<string, unknown> | null
  // 已注册 hooks，包括 SDK 回调与插件原生 hooks。
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null
  // plan slug 缓存：sessionId -> wordSlug。
  planSlugCache: Map<string, string>
  // 记录 teleported session，供可靠性日志使用。
  teleportedSessionInfo: {
    isTeleported: boolean
    hasLoggedFirstMessage: boolean
    sessionId: string | null
  } | null
  // 记录已调用的 skills，以便在 compaction 后继续保留。
  // key 使用复合形式：`${agentId ?? ''}:${skillName}`，避免不同 agent 互相覆盖。
  invokedSkills: Map<
    string,
    {
      skillName: string
      skillPath: string
      content: string
      invokedAt: number
      agentId: string | null
    }
  >
  // 记录慢操作，供 dev bar 显示（仅 ant）。
  slowOperations: Array<{
    operation: string
    durationMs: number
    timestamp: number
  }>
  // 由 SDK 提供的 betas（例如 context-1m-2025-08-07）。
  sdkBetas: string[] | undefined
  // 主线程 agent 类型（来自 --agent 或 settings）。
  mainThreadAgentType: string | undefined
  // Remote 模式（--remote flag）。
  isRemoteMode: boolean
  // 仅当 Remote Control 已连接且启用了入站控制时为 true。
  // 仅出站的 CCR 镜像模式会保留 bridge handle，但无法接收
  // 对等消息或用户文件请求。
  replBridgeActive: boolean
  // 直连服务器 URL（用于在 header 中展示）。
  directConnectServerUrl: string | undefined
  // system prompt 分段缓存状态。
  systemPromptSectionCache: Map<string, string | null>
  // 最近一次发给模型的日期（用于检测跨午夜日期变化）。
  lastEmittedDate: string | null
  // 通过 --add-dir 传入的额外目录（用于加载 CLAUDE.md）。
  additionalDirectoriesForClaudeMd: string[]
  // 通过 --channels 传入的 channel server allowlist（其 channel
  // notification 应注册当前 session 的那些 server）。仅在 main.tsx 中解析一次。
  // tag 会决定信任模型：'plugin' 需要 marketplace 验证 + allowlist；
  // 'server' 则始终无法通过 allowlist（schema 只支持 plugin）。
  // 无论哪种类型，都必须依赖 entry.dev 才能绕过 allowlist。
  allowedChannels: ChannelEntry[]
  // 若 allowedChannels 中任一条目来自
  // --dangerously-load-development-channels，则为 true
  // （这样 ChannelsNotice 就能在策略拦截提示中指出正确的 flag）。
  hasDevChannels: boolean
  // 当前 session 的 `.jsonl` 所在目录；为 null 时表示从 originalCwd 推导。
  sessionProjectDir: string | null
  // 从 GrowthBook 拉取并缓存的 1 小时 TTL prompt cache allowlist（会话内稳定）。
  promptCache1hAllowlist: string[] | null
  // 缓存的 1 小时 TTL 用户资格（会话内稳定）。会在首次评估时锁存，
  // 以避免会话中途额度变化影响 cache_control TTL，进而打爆服务端 prompt cache。
  promptCache1hEligible: boolean | null
  // AFK_MODE_BETA_HEADER 的 sticky-on 锁存。一旦 auto mode 首次启用，
  // 就在余下整个会话中持续发送该 header，避免 Shift+Tab 开关打爆
  // 约 50-70K token 的 prompt cache。
  afkModeHeaderLatched: boolean | null
  // FAST_MODE_BETA_HEADER 的 sticky-on 锁存。一旦 fast mode 首次启用，
  // 就持续发送该 header，避免冷却进入/退出时对 prompt cache 造成双重击穿。
  // `speed` body 参数仍保持动态。
  fastModeHeaderLatched: boolean | null
  // cache-editing beta header 的 sticky-on 锁存。一旦 cached microcompact
  // 首次启用，就持续发送该 header，避免会话中途 GrowthBook/settings 的切换
  // 把 prompt cache 打掉。
  cacheEditingHeaderLatched: boolean | null
  // 用于清除先前 tool loop thinking 的 sticky-on 锁存。
  // 当距离上次 API 调用超过 1 小时后触发（已确认 cache miss，继续保留 thinking
  // 已经没有命中缓存的收益）。一旦锁存，就会保持开启，避免刚重新预热的
  // thinking-cleared cache 因切回 keep:'all' 而被打掉。
  thinkingClearLatched: boolean | null
  // 当前 prompt ID（UUID），用于把用户 prompt 与后续 OTel 事件关联起来。
  promptId: string | null
  // 主对话链（不含 subagent）的最近一次 API requestId。
  // 每次主会话查询成功返回 API 响应后更新。
  // 会在 shutdown 时读取，用于向 inference 发送 cache eviction 提示。
  lastMainRequestId: string | undefined
  // 最近一次成功 API 调用完成时的时间戳（Date.now()）。
  // 用于在 tengu_api_success 中计算 timeSinceLastApiCallMs，
  // 以便把 cache miss 与空闲时长关联起来（cache TTL 约为 5 分钟）。
  lastApiCompletionTimestamp: number | null
  // 在 compaction（自动或手动 /compact）后置为 true。
  // 由 logAPISuccess 消费，用来标记 compaction 后的第一条 API 调用，
  // 这样就能把 compaction 导致的 cache miss 与 TTL 过期区分开。
  pendingPostCompaction: boolean
}

// 这里同样如此，修改前三思。
function getInitialState(): State {
  // 解析 cwd 中的符号链接，以与 shell.ts 的 setCwd 行为保持一致。
  // 这能确保路径在做 session 存储清洗时保持一致。
  let resolvedCwd = ''
  if (
    typeof process !== 'undefined' &&
    typeof process.cwd === 'function' &&
    typeof realpathSync === 'function'
  ) {
    const rawCwd = cwd()
    try {
      resolvedCwd = realpathSync(rawCwd).normalize('NFC')
    } catch {
      // CloudStorage 挂载点上的 File Provider 可能抛 EPERM（每个路径片段都要 lstat）。
      resolvedCwd = rawCwd.normalize('NFC')
    }
  }
  const state: State = {
    originalCwd: resolvedCwd,
    projectRoot: resolvedCwd,
    totalCostUSD: 0,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    turnHookDurationMs: 0,
    turnToolDurationMs: 0,
    turnClassifierDurationMs: 0,
    turnToolCount: 0,
    turnHookCount: 0,
    turnClassifierCount: 0,
    startTime: Date.now(),
    lastInteractionTime: Date.now(),
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    hasUnknownModelCost: false,
    cwd: resolvedCwd,
    modelUsage: {},
    mainLoopModelOverride: undefined,
    initialMainLoopModel: null,
    modelStrings: null,
    isInteractive: false,
    kairosActive: false,
    strictToolResultPairing: false,
    sdkAgentProgressSummariesEnabled: false,
    userMsgOptIn: false,
    clientType: 'cli',
    sessionSource: undefined,
    questionPreviewFormat: undefined,
    sessionIngressToken: undefined,
    oauthTokenFromFd: undefined,
    apiKeyFromFd: undefined,
    flagSettingsPath: undefined,
    flagSettingsInline: null,
    allowedSettingSources: [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ],
    // 遥测状态。
    meter: null,
    sessionCounter: null,
    locCounter: null,
    prCounter: null,
    commitCounter: null,
    costCounter: null,
    tokenCounter: null,
    codeEditToolDecisionCounter: null,
    activeTimeCounter: null,
    statsStore: null,
    sessionId: randomUUID() as SessionId,
    parentSessionId: undefined,
    // Logger 状态。
    loggerProvider: null,
    eventLogger: null,
    // Meter provider 状态。
    meterProvider: null,
    tracerProvider: null,
    // Agent 颜色状态。
    agentColorMap: new Map(),
    agentColorIndex: 0,
    // 最近一次 API 请求，用于 bug report。
    lastAPIRequest: null,
    lastAPIRequestMessages: null,
    // 最近一次 auto-mode classifier 请求，用于 /share transcript。
    lastClassifierRequests: null,
    cachedClaudeMdContent: null,
    // 内存中的近期错误日志。
    inMemoryErrorLog: [],
    // 通过 --plugin-dir 注入、仅在当前会话生效的插件。
    inlinePlugins: [],
    // 显式传入的 --chrome / --no-chrome 值（undefined 表示 CLI 未设置）。
    chromeFlagOverride: undefined,
    // 使用 cowork_plugins 目录替代 plugins。
    useCoworkPlugins: false,
    // 仅当前会话有效的绕过权限模式标记（不会持久化）。
    sessionBypassPermissionsMode: false,
    // scheduled tasks 默认禁用，直到 flag 或对话框显式启用它们。
    scheduledTasksEnabled: false,
    sessionCronTasks: [],
    sessionCreatedTeams: new Set(),
    // 仅当前会话有效的 trust 标记（不会持久化到磁盘）。
    sessionTrustAccepted: false,
    // 仅当前会话有效的标记，用于禁用 session 落盘。
    sessionPersistenceDisabled: false,
    // 记录用户是否在本会话中退出过 plan mode。
    hasExitedPlanMode: false,
    // 记录是否需要展示 plan mode 退出附件。
    needsPlanModeExitAttachment: false,
    // 记录是否需要展示 auto mode 退出附件。
    needsAutoModeExitAttachment: false,
    // 记录本会话是否已经展示过 LSP 插件推荐。
    lspRecommendationShownThisSession: false,
    // SDK init event 状态。
    initJsonSchema: null,
    registeredHooks: null,
    // plan slug 缓存。
    planSlugCache: new Map(),
    // 记录 teleported session，供可靠性日志使用。
    teleportedSessionInfo: null,
    // 记录已调用 skills，以便在 compaction 后保留。
    invokedSkills: new Map(),
    // 记录慢操作，供 dev bar 显示。
    slowOperations: [],
    // 由 SDK 提供的 betas。
    sdkBetas: undefined,
    // 主线程 agent 类型。
    mainThreadAgentType: undefined,
    // Remote 模式。
    isRemoteMode: false,
    replBridgeActive: false,
    // 直连服务器 URL。
    directConnectServerUrl: undefined,
    // system prompt 分段缓存状态。
    systemPromptSectionCache: new Map(),
    // 最近一次发给模型的日期。
    lastEmittedDate: null,
    // 通过 --add-dir 传入的额外目录（用于加载 CLAUDE.md）。
    additionalDirectoriesForClaudeMd: [],
    // 通过 --channels 传入的 channel server allowlist。
    allowedChannels: [],
    hasDevChannels: false,
    // session 项目目录（null 表示从 originalCwd 推导）。
    sessionProjectDir: null,
    // 1 小时 prompt cache allowlist（null 表示尚未从 GrowthBook 拉取）。
    promptCache1hAllowlist: null,
    // 1 小时 prompt cache eligibility（null 表示尚未评估）。
    promptCache1hEligible: null,
    // beta header 锁存（null 表示尚未触发）。
    afkModeHeaderLatched: null,
    fastModeHeaderLatched: null,
    cacheEditingHeaderLatched: null,
    thinkingClearLatched: null,
    // 当前 prompt ID。
    promptId: null,
    lastMainRequestId: undefined,
    lastApiCompletionTimestamp: null,
    pendingPostCompaction: false,
  }

  return state
}

// 这里更是如此。
const STATE: State = getInitialState()

export function getSessionId(): SessionId {
  return STATE.sessionId
}

export function regenerateSessionId(
  options: { setCurrentAsParent?: boolean } = {},
): SessionId {
  if (options.setCurrentAsParent) {
    STATE.parentSessionId = STATE.sessionId
  }
  // 删除旧 session 的 plan-slug 条目，避免 Map 持续积累陈旧 key。
  // 需要把 slug 带到新 session 的调用方（如 REPL.tsx 的 clearContext）
  // 会在调用 clearConversation 前先把它读出来。
  STATE.planSlugCache.delete(STATE.sessionId)
  // 重新生成的 session 视为属于当前项目，因此把 projectDir 重置为 null，
  // 这样 getTranscriptPath() 就会从 originalCwd 重新推导。
  STATE.sessionId = randomUUID() as SessionId
  STATE.sessionProjectDir = null
  return STATE.sessionId
}

export function getParentSessionId(): SessionId | undefined {
  return STATE.parentSessionId
}

/**
 * 原子地切换当前活动 session。`sessionId` 与 `sessionProjectDir`
 * 总是一起变化，没有单独的 setter，因此它们不会发生不同步（CC-34）。
 *
 * @param projectDir 包含 `<sessionId>.jsonl` 的目录。对于当前项目中的 session，
 *   可以省略（或传 `null`），路径会在读取时由 originalCwd 推导。
 *   当 session 位于另一个项目目录中时（如 git worktree、跨项目 resume），
 *   应传入 `dirname(transcriptPath)`。每次调用都会重置 project dir，
 *   不会沿用上一个 session 的值。
 */
export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  // 删除旧 session 的 plan-slug 条目，避免在反复 /resume 时 Map 无限增长。
  // 实际上只有当前 session 的 slug 会被读取
  // （plans.ts 的 getPlanSlug 默认调用 getSessionId()）。
  STATE.planSlugCache.delete(STATE.sessionId)
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  sessionSwitched.emit(sessionId)
}

const sessionSwitched = createSignal<[id: SessionId]>()

/**
 * 注册一个回调，在 switchSession 改变当前活动 sessionId 时触发。
 * bootstrap 不能直接导入监听器（它是 DAG 叶子节点），因此由调用方自行注册。
 * concurrentSessions.ts 用它来确保 PID 文件中的 sessionId 与 --resume 保持同步。
 */
export const onSessionSwitch = sessionSwitched.subscribe

/**
 * 当前 session transcript 所在的项目目录；如果该 session 创建于当前项目，
 * 则返回 `null`（常见情况，会从 originalCwd 推导）。见 `switchSession()`。
 */
export function getSessionProjectDir(): string | null {
  return STATE.sessionProjectDir
}

export function getOriginalCwd(): string {
  return STATE.originalCwd
}

/**
 * 获取稳定的项目根目录。
 * 与 getOriginalCwd() 不同，它不会被会话中途的 EnterWorktreeTool 更新
 * （这样进入临时 worktree 时，skills/history 仍能保持稳定）。
 * 但它会在启动时由 --worktree 设置，因为该 worktree 本身就是当前 session 的项目。
 * 这个值用于标识项目身份（history、skills、sessions），而不是文件操作。
 */
export function getProjectRoot(): string {
  return STATE.projectRoot
}

export function setOriginalCwd(cwd: string): void {
  STATE.originalCwd = cwd.normalize('NFC')
}

/**
 * 仅供 --worktree 启动参数使用。会话中途的 EnterWorktreeTool 严禁调用它，
 * 因为 skills/history 应继续锚定在 session 最初启动的位置。
 */
export function setProjectRoot(cwd: string): void {
  STATE.projectRoot = cwd.normalize('NFC')
}

export function getCwdState(): string {
  return STATE.cwd
}

export function setCwdState(cwd: string): void {
  STATE.cwd = cwd.normalize('NFC')
}

export function getDirectConnectServerUrl(): string | undefined {
  return STATE.directConnectServerUrl
}

export function setDirectConnectServerUrl(url: string): void {
  STATE.directConnectServerUrl = url
}

export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number,
): void {
  STATE.totalAPIDuration += duration
  STATE.totalAPIDurationWithoutRetries += durationWithoutRetries
}

export function resetTotalDurationStateAndCost_FOR_TESTS_ONLY(): void {
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalCostUSD = 0
}

export function addToTotalCostState(
  cost: number,
  modelUsage: ModelUsage,
  model: string,
): void {
  STATE.modelUsage[model] = modelUsage
  STATE.totalCostUSD += cost
}

export function getTotalCostUSD(): number {
  return STATE.totalCostUSD
}

export function getTotalAPIDuration(): number {
  return STATE.totalAPIDuration
}

export function getTotalDuration(): number {
  return Date.now() - STATE.startTime
}

export function getTotalAPIDurationWithoutRetries(): number {
  return STATE.totalAPIDurationWithoutRetries
}

export function getTotalToolDuration(): number {
  return STATE.totalToolDuration
}

export function addToToolDuration(duration: number): void {
  STATE.totalToolDuration += duration
  STATE.turnToolDurationMs += duration
  STATE.turnToolCount++
}

export function getTurnHookDurationMs(): number {
  return STATE.turnHookDurationMs
}

export function addToTurnHookDuration(duration: number): void {
  STATE.turnHookDurationMs += duration
  STATE.turnHookCount++
}

export function resetTurnHookDuration(): void {
  STATE.turnHookDurationMs = 0
  STATE.turnHookCount = 0
}

export function getTurnHookCount(): number {
  return STATE.turnHookCount
}

export function getTurnToolDurationMs(): number {
  return STATE.turnToolDurationMs
}

export function resetTurnToolDuration(): void {
  STATE.turnToolDurationMs = 0
  STATE.turnToolCount = 0
}

export function getTurnToolCount(): number {
  return STATE.turnToolCount
}

export function getTurnClassifierDurationMs(): number {
  return STATE.turnClassifierDurationMs
}

export function addToTurnClassifierDuration(duration: number): void {
  STATE.turnClassifierDurationMs += duration
  STATE.turnClassifierCount++
}

export function resetTurnClassifierDuration(): void {
  STATE.turnClassifierDurationMs = 0
  STATE.turnClassifierCount = 0
}

export function getTurnClassifierCount(): number {
  return STATE.turnClassifierCount
}

export function getStatsStore(): {
  observe(name: string, value: number): void
} | null {
  return STATE.statsStore
}

export function setStatsStore(
  store: { observe(name: string, value: number): void } | null,
): void {
  STATE.statsStore = store
}

/**
 * 标记发生过一次交互。
 *
 * 默认情况下，真正的 Date.now() 调用会延迟到下一次 Ink render 帧
 * （通过 flushInteractionTime() 完成），这样可以避免每一次按键都调用 Date.now()。
 *
 * 当从 React useEffect 回调，或其他发生在 Ink render cycle 已经 flush 之后的代码中调用时，
 * 需要传 `immediate = true`。
 * 否则时间戳会一直停留在旧值，直到下一次 render；而当用户空闲时
 * （例如权限对话框在等待输入），下一次 render 可能根本不会到来。
 */
let interactionTimeDirty = false

export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) {
    flushInteractionTime_inner()
  } else {
    interactionTimeDirty = true
  }
}

/**
 * 如果自上次 flush 以来记录到过交互，就立即更新时间戳。
 * 该函数会在 Ink 每次 render cycle 前调用，
 * 以便把大量按键批量合并成一次 Date.now() 调用。
 */
export function flushInteractionTime(): void {
  if (interactionTimeDirty) {
    flushInteractionTime_inner()
  }
}

function flushInteractionTime_inner(): void {
  STATE.lastInteractionTime = Date.now()
  interactionTimeDirty = false
}

export function addToTotalLinesChanged(added: number, removed: number): void {
  STATE.totalLinesAdded += added
  STATE.totalLinesRemoved += removed
}

export function getTotalLinesAdded(): number {
  return STATE.totalLinesAdded
}

export function getTotalLinesRemoved(): number {
  return STATE.totalLinesRemoved
}

export function getTotalInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'inputTokens')
}

export function getTotalOutputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'outputTokens')
}

export function getTotalCacheReadInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheReadInputTokens')
}

export function getTotalCacheCreationInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheCreationInputTokens')
}

export function getTotalWebSearchRequests(): number {
  return sumBy(Object.values(STATE.modelUsage), 'webSearchRequests')
}

let outputTokensAtTurnStart = 0
let currentTurnTokenBudget: number | null = null
export function getTurnOutputTokens(): number {
  return getTotalOutputTokens() - outputTokensAtTurnStart
}
export function getCurrentTurnTokenBudget(): number | null {
  return currentTurnTokenBudget
}
let budgetContinuationCount = 0
export function snapshotOutputTokensForTurn(budget: number | null): void {
  outputTokensAtTurnStart = getTotalOutputTokens()
  currentTurnTokenBudget = budget
  budgetContinuationCount = 0
}
export function getBudgetContinuationCount(): number {
  return budgetContinuationCount
}
export function incrementBudgetContinuationCount(): void {
  budgetContinuationCount++
}

export function setHasUnknownModelCost(): void {
  STATE.hasUnknownModelCost = true
}

export function hasUnknownModelCost(): boolean {
  return STATE.hasUnknownModelCost
}

export function getLastMainRequestId(): string | undefined {
  return STATE.lastMainRequestId
}

export function setLastMainRequestId(requestId: string): void {
  STATE.lastMainRequestId = requestId
}

export function getLastApiCompletionTimestamp(): number | null {
  return STATE.lastApiCompletionTimestamp
}

export function setLastApiCompletionTimestamp(timestamp: number): void {
  STATE.lastApiCompletionTimestamp = timestamp
}

/** 标记刚刚发生过一次 compaction。下一次 API success 事件将带上
 *  isPostCompaction=true，随后该标记会自动复位。 */
export function markPostCompaction(): void {
  STATE.pendingPostCompaction = true
}

/** 消费 post-compaction 标记。compaction 之后会返回一次 true，
 *  之后在下一次 compaction 之前都返回 false。 */
export function consumePostCompaction(): boolean {
  const was = STATE.pendingPostCompaction
  STATE.pendingPostCompaction = false
  return was
}

export function getLastInteractionTime(): number {
  return STATE.lastInteractionTime
}

// 滚动排空期间的暂停标记。后台 interval 会在做事前先检查它，
// 避免与滚动帧争抢事件循环。由 ScrollBox 的 scrollBy/scrollTo 设置，
// 并在最后一次滚动事件后的 SCROLL_DRAIN_IDLE_MS 自动清除。
// 这是模块级状态（不放进 STATE），属于瞬时热路径标记，
// 由于 debounce 定时器会自行清理，因此不需要专门的测试复位逻辑。
let scrollDraining = false
let scrollDrainTimer: ReturnType<typeof setTimeout> | undefined
const SCROLL_DRAIN_IDLE_MS = 150

/** 标记刚刚发生过一次滚动事件。后台 interval 会依赖
 *  getIsScrollDraining()，在 debounce 清除前跳过自己的工作。 */
export function markScrollActivity(): void {
  scrollDraining = true
  if (scrollDrainTimer) clearTimeout(scrollDrainTimer)
  scrollDrainTimer = setTimeout(() => {
    scrollDraining = false
    scrollDrainTimer = undefined
  }, SCROLL_DRAIN_IDLE_MS)
  scrollDrainTimer.unref?.()
}

/** 在滚动仍处于排空期时返回 true（即距上次事件不足 150ms）。
 *  interval 在该标记为 true 时应提前返回，等滚动稳定后的下一次 tick 再继续。 */
export function getIsScrollDraining(): boolean {
  return scrollDraining
}

/** 对于可能与滚动重叠的昂贵一次性工作（网络、子进程等），应先 await 它。
 *  如果当前没有滚动，会立即返回；否则会按 idle interval 轮询，直到标记清除。 */
export async function waitForScrollIdle(): Promise<void> {
  while (scrollDraining) {
    // bootstrap-isolation 禁止从 src/utils/ 导入 sleep()。
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(r => setTimeout(r, SCROLL_DRAIN_IDLE_MS).unref?.())
  }
}

export function getModelUsage(): { [modelName: string]: ModelUsage } {
  return STATE.modelUsage
}

export function getUsageForModel(model: string): ModelUsage | undefined {
  return STATE.modelUsage[model]
}

/**
 * 获取当前的 model override。
 * 该值来自 --model CLI 参数，或用户后续更新后的配置模型。
 */
export function getMainLoopModelOverride(): ModelSetting | undefined {
  return STATE.mainLoopModelOverride
}

export function getInitialMainLoopModel(): ModelSetting {
  return STATE.initialMainLoopModel
}

export function setMainLoopModelOverride(
  model: ModelSetting | undefined,
): void {
  STATE.mainLoopModelOverride = model
}

export function setInitialMainLoopModel(model: ModelSetting): void {
  STATE.initialMainLoopModel = model
}

export function getSdkBetas(): string[] | undefined {
  return STATE.sdkBetas
}

export function setSdkBetas(betas: string[] | undefined): void {
  STATE.sdkBetas = betas
}

export function resetCostState(): void {
  STATE.totalCostUSD = 0
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalToolDuration = 0
  STATE.startTime = Date.now()
  STATE.totalLinesAdded = 0
  STATE.totalLinesRemoved = 0
  STATE.hasUnknownModelCost = false
  STATE.modelUsage = {}
  STATE.promptId = null
}

/**
 * 为 session 恢复流程设置 cost 相关状态。
 * 由 cost-tracker.ts 中的 restoreCostStateForSession 调用。
 */
export function setCostStateForRestore({
  totalCostUSD,
  totalAPIDuration,
  totalAPIDurationWithoutRetries,
  totalToolDuration,
  totalLinesAdded,
  totalLinesRemoved,
  lastDuration,
  modelUsage,
}: {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}): void {
  STATE.totalCostUSD = totalCostUSD
  STATE.totalAPIDuration = totalAPIDuration
  STATE.totalAPIDurationWithoutRetries = totalAPIDurationWithoutRetries
  STATE.totalToolDuration = totalToolDuration
  STATE.totalLinesAdded = totalLinesAdded
  STATE.totalLinesRemoved = totalLinesRemoved

  // 恢复按模型拆分的 usage 明细。
  if (modelUsage) {
    STATE.modelUsage = modelUsage
  }

  // 调整 startTime，让 wall duration 能继续累计。
  if (lastDuration) {
    STATE.startTime = Date.now() - lastDuration
  }
}

// 仅用于测试。
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  outputTokensAtTurnStart = 0
  currentTurnTokenBudget = null
  budgetContinuationCount = 0
  sessionSwitched.clear()
}

// 不应直接调用这里。请改用 src/utils/model/modelStrings.ts::getModelStrings()
export function getModelStrings(): ModelStrings | null {
  return STATE.modelStrings
}

// 不应直接调用这里。见 src/utils/model/modelStrings.ts
export function setModelStrings(modelStrings: ModelStrings): void {
  STATE.modelStrings = modelStrings
}

// 测试辅助函数：把 model strings 重置为可重新初始化状态。
// 它与 setModelStrings 分开，是因为只有测试环境才允许传入 null。
export function resetModelStringsForTestingOnly() {
  STATE.modelStrings = null
}

export function setMeter(
  meter: Meter,
  createCounter: (name: string, options: MetricOptions) => AttributedCounter,
): void {
  STATE.meter = meter

  // 使用传入的 factory 初始化所有 counter。
  STATE.sessionCounter = createCounter('claude_code.session.count', {
    description: 'Count of CLI sessions started',
  })
  STATE.locCounter = createCounter('claude_code.lines_of_code.count', {
    description:
      "Count of lines of code modified, with the 'type' attribute indicating whether lines were added or removed",
  })
  STATE.prCounter = createCounter('claude_code.pull_request.count', {
    description: 'Number of pull requests created',
  })
  STATE.commitCounter = createCounter('claude_code.commit.count', {
    description: 'Number of git commits created',
  })
  STATE.costCounter = createCounter('claude_code.cost.usage', {
    description: 'Cost of the Claude Code session',
    unit: 'USD',
  })
  STATE.tokenCounter = createCounter('claude_code.token.usage', {
    description: 'Number of tokens used',
    unit: 'tokens',
  })
  STATE.codeEditToolDecisionCounter = createCounter(
    'claude_code.code_edit_tool.decision',
    {
      description:
        'Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools',
    },
  )
  STATE.activeTimeCounter = createCounter('claude_code.active_time.total', {
    description: 'Total active time in seconds',
    unit: 's',
  })
}

export function getMeter(): Meter | null {
  return STATE.meter
}

export function getSessionCounter(): AttributedCounter | null {
  return STATE.sessionCounter
}

export function getLocCounter(): AttributedCounter | null {
  return STATE.locCounter
}

export function getPrCounter(): AttributedCounter | null {
  return STATE.prCounter
}

export function getCommitCounter(): AttributedCounter | null {
  return STATE.commitCounter
}

export function getCostCounter(): AttributedCounter | null {
  return STATE.costCounter
}

export function getTokenCounter(): AttributedCounter | null {
  return STATE.tokenCounter
}

export function getCodeEditToolDecisionCounter(): AttributedCounter | null {
  return STATE.codeEditToolDecisionCounter
}

export function getActiveTimeCounter(): AttributedCounter | null {
  return STATE.activeTimeCounter
}

export function getLoggerProvider(): LoggerProvider | null {
  return STATE.loggerProvider
}

export function setLoggerProvider(provider: LoggerProvider | null): void {
  STATE.loggerProvider = provider
}

export function getEventLogger(): ReturnType<typeof logs.getLogger> | null {
  return STATE.eventLogger
}

export function setEventLogger(
  logger: ReturnType<typeof logs.getLogger> | null,
): void {
  STATE.eventLogger = logger
}

export function getMeterProvider(): MeterProvider | null {
  return STATE.meterProvider
}

export function setMeterProvider(provider: MeterProvider | null): void {
  STATE.meterProvider = provider
}
export function getTracerProvider(): BasicTracerProvider | null {
  return STATE.tracerProvider
}
export function setTracerProvider(provider: BasicTracerProvider | null): void {
  STATE.tracerProvider = provider
}

export function getIsNonInteractiveSession(): boolean {
  return !STATE.isInteractive
}

export function getIsInteractive(): boolean {
  return STATE.isInteractive
}

export function setIsInteractive(value: boolean): void {
  STATE.isInteractive = value
}

export function getClientType(): string {
  return STATE.clientType
}

export function setClientType(type: string): void {
  STATE.clientType = type
}

export function getSdkAgentProgressSummariesEnabled(): boolean {
  return STATE.sdkAgentProgressSummariesEnabled
}

export function setSdkAgentProgressSummariesEnabled(value: boolean): void {
  STATE.sdkAgentProgressSummariesEnabled = value
}

export function getKairosActive(): boolean {
  return STATE.kairosActive
}

export function setKairosActive(value: boolean): void {
  STATE.kairosActive = value
}

export function isReplBridgeActive(): boolean {
  return STATE.replBridgeActive
}

export function setReplBridgeActive(value: boolean): void {
  STATE.replBridgeActive = value
}

export function getStrictToolResultPairing(): boolean {
  return STATE.strictToolResultPairing
}

export function setStrictToolResultPairing(value: boolean): void {
  STATE.strictToolResultPairing = value
}

// 字段名使用 'userMsgOptIn'，是为了避开被排除的字符串子串
// （如 'BriefTool'、'SendUserMessage'，大小写不敏感）。
// 所有调用方本身都已包在 feature() guard 内，因此这些 accessor
// 不需要再额外套一层（与 getKairosActive 的处理一致）。
export function getUserMsgOptIn(): boolean {
  return STATE.userMsgOptIn
}

export function setUserMsgOptIn(value: boolean): void {
  STATE.userMsgOptIn = value
}

export function getSessionSource(): string | undefined {
  return STATE.sessionSource
}

export function setSessionSource(source: string): void {
  STATE.sessionSource = source
}

export function getQuestionPreviewFormat(): 'markdown' | 'html' | undefined {
  return STATE.questionPreviewFormat
}

export function setQuestionPreviewFormat(format: 'markdown' | 'html'): void {
  STATE.questionPreviewFormat = format
}

export function getAgentColorMap(): Map<string, AgentColorName> {
  return STATE.agentColorMap
}

export function getFlagSettingsPath(): string | undefined {
  return STATE.flagSettingsPath
}

export function setFlagSettingsPath(path: string | undefined): void {
  STATE.flagSettingsPath = path
}

export function getFlagSettingsInline(): Record<string, unknown> | null {
  return STATE.flagSettingsInline
}

export function setFlagSettingsInline(
  settings: Record<string, unknown> | null,
): void {
  STATE.flagSettingsInline = settings
}

export function getSessionIngressToken(): string | null | undefined {
  return STATE.sessionIngressToken
}

export function setSessionIngressToken(token: string | null): void {
  STATE.sessionIngressToken = token
}

export function getOauthTokenFromFd(): string | null | undefined {
  return STATE.oauthTokenFromFd
}

export function setOauthTokenFromFd(token: string | null): void {
  STATE.oauthTokenFromFd = token
}

export function getApiKeyFromFd(): string | null | undefined {
  return STATE.apiKeyFromFd
}

export function setApiKeyFromFd(key: string | null): void {
  STATE.apiKeyFromFd = key
}

export function setLastAPIRequest(
  params: Omit<BetaMessageStreamParams, 'messages'> | null,
): void {
  STATE.lastAPIRequest = params
}

export function getLastAPIRequest(): Omit<
  BetaMessageStreamParams,
  'messages'
> | null {
  return STATE.lastAPIRequest
}

export function setLastAPIRequestMessages(
  messages: BetaMessageStreamParams['messages'] | null,
): void {
  STATE.lastAPIRequestMessages = messages
}

export function getLastAPIRequestMessages():
  | BetaMessageStreamParams['messages']
  | null {
  return STATE.lastAPIRequestMessages
}

export function setLastClassifierRequests(requests: unknown[] | null): void {
  STATE.lastClassifierRequests = requests
}

export function getLastClassifierRequests(): unknown[] | null {
  return STATE.lastClassifierRequests
}

export function setCachedClaudeMdContent(content: string | null): void {
  STATE.cachedClaudeMdContent = content
}

export function getCachedClaudeMdContent(): string | null {
  return STATE.cachedClaudeMdContent
}

export function addToInMemoryErrorLog(errorInfo: {
  error: string
  timestamp: string
}): void {
  const MAX_IN_MEMORY_ERRORS = 100
  if (STATE.inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    STATE.inMemoryErrorLog.shift() // 移除最早的一条错误
  }
  STATE.inMemoryErrorLog.push(errorInfo)
}

export function getAllowedSettingSources(): SettingSource[] {
  return STATE.allowedSettingSources
}

export function setAllowedSettingSources(sources: SettingSource[]): void {
  STATE.allowedSettingSources = sources
}

export function preferThirdPartyAuthentication(): boolean {
  // 出于认证原因，IDE 扩展应按 1P 的行为处理。
  return getIsNonInteractiveSession() && STATE.clientType !== 'claude-vscode'
}

export function setInlinePlugins(plugins: Array<string>): void {
  STATE.inlinePlugins = plugins
}

export function getInlinePlugins(): Array<string> {
  return STATE.inlinePlugins
}

export function setChromeFlagOverride(value: boolean | undefined): void {
  STATE.chromeFlagOverride = value
}

export function getChromeFlagOverride(): boolean | undefined {
  return STATE.chromeFlagOverride
}

export function setUseCoworkPlugins(value: boolean): void {
  STATE.useCoworkPlugins = value
  resetSettingsCache()
}

export function getUseCoworkPlugins(): boolean {
  return STATE.useCoworkPlugins
}

export function setSessionBypassPermissionsMode(enabled: boolean): void {
  STATE.sessionBypassPermissionsMode = enabled
}

export function getSessionBypassPermissionsMode(): boolean {
  return STATE.sessionBypassPermissionsMode
}

export function setScheduledTasksEnabled(enabled: boolean): void {
  STATE.scheduledTasksEnabled = enabled
}

export function getScheduledTasksEnabled(): boolean {
  return STATE.scheduledTasksEnabled
}

export type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  /**
   * 设置后表示该任务由进程内 teammate 创建（而不是 team lead）。
   * 调度器会把触发结果投递到该 teammate 的 pendingUserMessages 队列，
   * 而不是主 REPL 命令队列。仅当前会话有效，永远不会写盘。
   */
  agentId?: string
  /** Human-readable task name. */
  name?: string
  /** Task description. */
  description?: string
  /** Working directory for the task execution. */
  folder?: string
  /** Model to use. */
  model?: string
  /** Permission mode. */
  permissionMode?: string
  /** Whether to use git worktree for execution. */
  worktree?: boolean
  /** Schedule frequency for UI display. */
  frequency?: string
  /** Time string for scheduled execution. */
  scheduledTime?: string
}

export function getSessionCronTasks(): SessionCronTask[] {
  return STATE.sessionCronTasks
}

export function addSessionCronTask(task: SessionCronTask): void {
  STATE.sessionCronTasks.push(task)
}

/**
 * 返回实际被移除的任务数量。
 * 调用方会据此判断是否可以跳过后续工作
 * （例如 removeCronTasks 中的磁盘读取），前提是所有 id 都已在这里处理完。
 */
export function removeSessionCronTasks(ids: readonly string[]): number {
  if (ids.length === 0) return 0
  const idSet = new Set(ids)
  const remaining = STATE.sessionCronTasks.filter(t => !idSet.has(t.id))
  const removed = STATE.sessionCronTasks.length - remaining.length
  if (removed === 0) return 0
  STATE.sessionCronTasks = remaining
  return removed
}

export function setSessionTrustAccepted(accepted: boolean): void {
  STATE.sessionTrustAccepted = accepted
}

export function getSessionTrustAccepted(): boolean {
  return STATE.sessionTrustAccepted
}

export function setSessionPersistenceDisabled(disabled: boolean): void {
  STATE.sessionPersistenceDisabled = disabled
}

export function isSessionPersistenceDisabled(): boolean {
  return STATE.sessionPersistenceDisabled
}

export function hasExitedPlanModeInSession(): boolean {
  return STATE.hasExitedPlanMode
}

export function setHasExitedPlanMode(value: boolean): void {
  STATE.hasExitedPlanMode = value
}

export function needsPlanModeExitAttachment(): boolean {
  return STATE.needsPlanModeExitAttachment
}

export function setNeedsPlanModeExitAttachment(value: boolean): void {
  STATE.needsPlanModeExitAttachment = value
}

export function handlePlanModeTransition(
  fromMode: string,
  toMode: string,
): void {
  // 如果是切换“进入” plan mode，就清掉任何待发送的退出附件。
  // 这样可避免用户快速切换时同时发出 plan_mode 与 plan_mode_exit。
  if (toMode === 'plan' && fromMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = false
  }

  // 如果是从 plan mode 切出，就触发 plan_mode_exit 附件。
  if (fromMode === 'plan' && toMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = true
  }
}

export function needsAutoModeExitAttachment(): boolean {
  return STATE.needsAutoModeExitAttachment
}

export function setNeedsAutoModeExitAttachment(value: boolean): void {
  STATE.needsAutoModeExitAttachment = value
}

export function handleAutoModeTransition(
  fromMode: string,
  toMode: string,
): void {
  // auto↔plan 的切换由 prepareContextForPlanMode 处理
  // （如果用户选择保留，auto 可在 plan 中继续活跃）以及 ExitPlanMode 恢复。
  // 这里把这两个方向都跳过，因此本函数只处理“直接”的 auto 切换。
  if (
    (fromMode === 'auto' && toMode === 'plan') ||
    (fromMode === 'plan' && toMode === 'auto')
  ) {
    return
  }
  const fromIsAuto = fromMode === 'auto'
  const toIsAuto = toMode === 'auto'

  // 如果是切换“进入” auto mode，就清掉任何待发送的退出附件。
  // 这样可避免用户快速切换时同时发出 auto_mode 与 auto_mode_exit。
  if (toIsAuto && !fromIsAuto) {
    STATE.needsAutoModeExitAttachment = false
  }

  // 如果是从 auto mode 切出，就触发 auto_mode_exit 附件。
  if (fromIsAuto && !toIsAuto) {
    STATE.needsAutoModeExitAttachment = true
  }
}

// 本会话内的 LSP 插件推荐展示跟踪。
export function hasShownLspRecommendationThisSession(): boolean {
  return STATE.lspRecommendationShownThisSession
}

export function setLspRecommendationShownThisSession(value: boolean): void {
  STATE.lspRecommendationShownThisSession = value
}

// SDK init event 状态。
export function setInitJsonSchema(schema: Record<string, unknown>): void {
  STATE.initJsonSchema = schema
}

export function getInitJsonSchema(): Record<string, unknown> | null {
  return STATE.initJsonSchema
}

export function registerHookCallbacks(
  hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>,
): void {
  if (!STATE.registeredHooks) {
    STATE.registeredHooks = {}
  }

  // `registerHookCallbacks` 可能会被调用多次，因此这里需要合并而不是覆盖。
  for (const [event, matchers] of Object.entries(hooks)) {
    const eventKey = event as HookEvent
    if (!STATE.registeredHooks[eventKey]) {
      STATE.registeredHooks[eventKey] = []
    }
    STATE.registeredHooks[eventKey]!.push(...matchers)
  }
}

export function getRegisteredHooks(): Partial<
  Record<HookEvent, RegisteredHookMatcher[]>
> | null {
  return STATE.registeredHooks
}

export function clearRegisteredHooks(): void {
  STATE.registeredHooks = null
}

export function clearRegisteredPluginHooks(): void {
  if (!STATE.registeredHooks) {
    return
  }

  const filtered: Partial<Record<HookEvent, RegisteredHookMatcher[]>> = {}
  for (const [event, matchers] of Object.entries(STATE.registeredHooks)) {
    // 只保留 callback hook（也就是没有 pluginRoot 的那些）。
    const callbackHooks = matchers.filter(m => !('pluginRoot' in m))
    if (callbackHooks.length > 0) {
      filtered[event as HookEvent] = callbackHooks
    }
  }

  STATE.registeredHooks = Object.keys(filtered).length > 0 ? filtered : null
}

export function resetSdkInitState(): void {
  STATE.initJsonSchema = null
  STATE.registeredHooks = null
}

export function getPlanSlugCache(): Map<string, string> {
  return STATE.planSlugCache
}

export function getSessionCreatedTeams(): Set<string> {
  return STATE.sessionCreatedTeams
}

// Teleported session 跟踪，用于可靠性日志。
export function setTeleportedSessionInfo(info: {
  sessionId: string | null
}): void {
  STATE.teleportedSessionInfo = {
    isTeleported: true,
    hasLoggedFirstMessage: false,
    sessionId: info.sessionId,
  }
}

export function getTeleportedSessionInfo(): {
  isTeleported: boolean
  hasLoggedFirstMessage: boolean
  sessionId: string | null
} | null {
  return STATE.teleportedSessionInfo
}

export function markFirstTeleportMessageLogged(): void {
  if (STATE.teleportedSessionInfo) {
    STATE.teleportedSessionInfo.hasLoggedFirstMessage = true
  }
}

// 已调用 skills 的跟踪，用于在 compaction 后继续保留。
export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  const key = `${agentId ?? ''}:${skillName}`
  STATE.invokedSkills.set(key, {
    skillName,
    skillPath,
    content,
    invokedAt: Date.now(),
    agentId,
  })
}

export function getInvokedSkills(): Map<string, InvokedSkillInfo> {
  return STATE.invokedSkills
}

export function getInvokedSkillsForAgent(
  agentId: string | undefined | null,
): Map<string, InvokedSkillInfo> {
  const normalizedId = agentId ?? null
  const filtered = new Map<string, InvokedSkillInfo>()
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === normalizedId) {
      filtered.set(key, skill)
    }
  }
  return filtered
}

export function clearInvokedSkills(
  preservedAgentIds?: ReadonlySet<string>,
): void {
  if (!preservedAgentIds || preservedAgentIds.size === 0) {
    STATE.invokedSkills.clear()
    return
  }
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === null || !preservedAgentIds.has(skill.agentId)) {
      STATE.invokedSkills.delete(key)
    }
  }
}

export function clearInvokedSkillsForAgent(agentId: string): void {
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === agentId) {
      STATE.invokedSkills.delete(key)
    }
  }
}

// 慢操作跟踪，用于 dev bar。
const MAX_SLOW_OPERATIONS = 10
const SLOW_OPERATION_TTL_MS = 10000

export function addSlowOperation(operation: string, durationMs: number): void {
  if (process.env.USER_TYPE !== 'ant') return
  // 跳过 editor session 的跟踪（用户正在 $EDITOR 中编辑 prompt 文件）。
  // 这类操作本来就是刻意偏慢的，因为用户正在撰写文本。
  if (operation.includes('exec') && operation.includes('claude-prompt-')) {
    return
  }
  const now = Date.now()
  // 清除已经过期的操作。
  STATE.slowOperations = STATE.slowOperations.filter(
    op => now - op.timestamp < SLOW_OPERATION_TTL_MS,
  )
  // 添加新的操作记录。
  STATE.slowOperations.push({ operation, durationMs, timestamp: now })
  // 只保留最近的若干条记录。
  if (STATE.slowOperations.length > MAX_SLOW_OPERATIONS) {
    STATE.slowOperations = STATE.slowOperations.slice(-MAX_SLOW_OPERATIONS)
  }
}

const EMPTY_SLOW_OPERATIONS: ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> = []

export function getSlowOperations(): ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> {
  // 最常见情况是没有任何记录。这里返回稳定引用，
  // 让调用方的 setState() 能通过 Object.is 直接 bail，而不是以 2fps 重渲染。
  if (STATE.slowOperations.length === 0) {
    return EMPTY_SLOW_OPERATIONS
  }
  const now = Date.now()
  // 只有在确实有项目过期时才分配新数组；否则在轮询期间保持引用稳定，
  // 只要这些操作仍然新鲜即可。
  if (
    STATE.slowOperations.some(op => now - op.timestamp >= SLOW_OPERATION_TTL_MS)
  ) {
    STATE.slowOperations = STATE.slowOperations.filter(
      op => now - op.timestamp < SLOW_OPERATION_TTL_MS,
    )
    if (STATE.slowOperations.length === 0) {
      return EMPTY_SLOW_OPERATIONS
    }
  }
  // 可以直接安全返回：addSlowOperation() 会先重绑定 STATE.slowOperations，
  // 再执行 push，因此 React state 持有的数组不会被原地修改。
  return STATE.slowOperations
}

export function getMainThreadAgentType(): string | undefined {
  return STATE.mainThreadAgentType
}

export function setMainThreadAgentType(agentType: string | undefined): void {
  STATE.mainThreadAgentType = agentType
}

export function getIsRemoteMode(): boolean {
  return STATE.isRemoteMode
}

export function setIsRemoteMode(value: boolean): void {
  STATE.isRemoteMode = value
}

// system prompt 分段缓存的访问器。

export function getSystemPromptSectionCache(): Map<string, string | null> {
  return STATE.systemPromptSectionCache
}

export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
): void {
  STATE.systemPromptSectionCache.set(name, value)
}

export function clearSystemPromptSectionState(): void {
  STATE.systemPromptSectionCache.clear()
}

// 最近发出日期的访问器（用于检测跨午夜日期变化）。

export function getLastEmittedDate(): string | null {
  return STATE.lastEmittedDate
}

export function setLastEmittedDate(date: string | null): void {
  STATE.lastEmittedDate = date
}

export function getAdditionalDirectoriesForClaudeMd(): string[] {
  return STATE.additionalDirectoriesForClaudeMd
}

export function setAdditionalDirectoriesForClaudeMd(
  directories: string[],
): void {
  STATE.additionalDirectoriesForClaudeMd = directories
}

export function getAllowedChannels(): ChannelEntry[] {
  return STATE.allowedChannels
}

export function setAllowedChannels(entries: ChannelEntry[]): void {
  STATE.allowedChannels = entries
}

export function getHasDevChannels(): boolean {
  return STATE.hasDevChannels
}

export function setHasDevChannels(value: boolean): void {
  STATE.hasDevChannels = value
}

export function getPromptCache1hAllowlist(): string[] | null {
  return STATE.promptCache1hAllowlist
}

export function setPromptCache1hAllowlist(allowlist: string[] | null): void {
  STATE.promptCache1hAllowlist = allowlist
}

export function getPromptCache1hEligible(): boolean | null {
  return STATE.promptCache1hEligible
}

export function setPromptCache1hEligible(eligible: boolean | null): void {
  STATE.promptCache1hEligible = eligible
}

export function getAfkModeHeaderLatched(): boolean | null {
  return STATE.afkModeHeaderLatched
}

export function setAfkModeHeaderLatched(v: boolean): void {
  STATE.afkModeHeaderLatched = v
}

export function getFastModeHeaderLatched(): boolean | null {
  return STATE.fastModeHeaderLatched
}

export function setFastModeHeaderLatched(v: boolean): void {
  STATE.fastModeHeaderLatched = v
}

export function getCacheEditingHeaderLatched(): boolean | null {
  return STATE.cacheEditingHeaderLatched
}

export function setCacheEditingHeaderLatched(v: boolean): void {
  STATE.cacheEditingHeaderLatched = v
}

export function getThinkingClearLatched(): boolean | null {
  return STATE.thinkingClearLatched
}

export function setThinkingClearLatched(v: boolean): void {
  STATE.thinkingClearLatched = v
}

/**
 * 把 beta header 锁存重置为 null。
 * 会在 /clear 与 /compact 时调用，以便新会话重新评估这些 header。
 */
export function clearBetaHeaderLatches(): void {
  STATE.afkModeHeaderLatched = null
  STATE.fastModeHeaderLatched = null
  STATE.cacheEditingHeaderLatched = null
  STATE.thinkingClearLatched = null
}

export function getPromptId(): string | null {
  return STATE.promptId
}

export function setPromptId(id: string | null): void {
  STATE.promptId = id
}
