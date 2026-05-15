import { feature } from 'bun:bundle'
import {
  checkGate_CACHED_OR_BLOCKING,
  getDynamicConfig_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../services/analytics/growthbook.js'
// 使用命名空间导入可以打破 bridgeEnabled → auth → config → bridgeEnabled
// 的循环依赖。authModule.foo 是 live binding，因此等到下面的 helper 调用时，
// auth.js 已经完整加载。此前这里用 require() 做相同延迟，但在
// mock.module()（daemon/auth.test.ts）之后，require() 会命中与 ESM
// namespace 不一致的 CJS 缓存，从而破坏 spyOn。
import * as authModule from '../utils/auth.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { lt } from '../utils/semver.js'

/**
 * 运行时检查是否具备 bridge mode 权限。
 *
 * Remote Control 需要 claude.ai 订阅（bridge 会使用 claude.ai OAuth token
 * 向 CCR 鉴权）。isClaudeAISubscriber() 会排除 Bedrock/Vertex/Foundry、
 * apiKeyHelper/gateway 部署、环境变量 API key，以及 Console API 登录，
 * 因为这些场景都没有 CCR 所需的 OAuth token。
 * 参见 github.com/deshaw/anthropic-issues/issues/24。
 *
 * `feature('BRIDGE_MODE')` 这层保护可确保只有在构建期启用 bridge mode 时，
 * 才会引用对应的 GrowthBook 字符串字面量。
 */
export function isBridgeEnabled(): boolean {
  // 使用正向三元表达式模式，见 docs/feature-gating.md。
  // 负向模式（if (!feature(...)) return）无法从外部构建中消除
  // 内联字符串字面量。
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() &&
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_bridge', false)
    : false
}

/**
 * Remote Control 的阻塞式权限检查。
 *
 * 若缓存为 `true` 则立即返回（快速路径）。如果磁盘缓存为 `false` 或缺失，
 * 则等待 GrowthBook 初始化并拉取最新服务端值（慢路径，最长约 5 秒），
 * 然后写回磁盘。
 *
 * 适用于陈旧的 `false` 会不公平阻断访问的权限门控点。
 * 对用户可见的错误路径，优先使用 `getBridgeDisabledReason()` 获取更具体的诊断。
 * 对渲染主体的 UI 可见性检查，则改用 `isBridgeEnabled()`。
 */
export async function isBridgeEnabledBlocking(): Promise<boolean> {
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() &&
        (await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge'))
    : false
}

/**
 * 返回 Remote Control 不可用的诊断消息；如果已启用则返回 null。
 * 当你需要向用户展示可操作的错误提示时，应调用这里，而不是裸用
 * `isBridgeEnabledBlocking()` 检查。
 *
 * GrowthBook gate 以 organizationUUID 为目标，它来自 config.oauthAccount，
 * 而该字段在登录期间由 /api/oauth/profile 填充。这个接口要求 user:profile scope。
 * 如果 token 不带该 scope（如 setup-token、CLAUDE_CODE_OAUTH_TOKEN 环境变量，
 * 或 scope 扩展前的旧登录），oauthAccount 就不会被填充，于是 gate 会回落为
 * false，用户只能看到一条无解的“not enabled”消息，而不知道重新登录即可修复。
 * 参见 CC-1165 / gh-33105。
 */
export async function getBridgeDisabledReason(): Promise<string | null> {
  if (feature('BRIDGE_MODE')) {
    if (!isClaudeAISubscriber()) {
      return 'Remote Control requires a claude.ai subscription. Run `claude auth login` to sign in with your claude.ai account.'
    }
    if (!hasProfileScope()) {
      return 'Remote Control requires a full-scope login token. Long-lived tokens (from `claude setup-token` or CLAUDE_CODE_OAUTH_TOKEN) are limited to inference-only for security reasons. Run `claude auth login` to use Remote Control.'
    }
    if (!getOauthAccountInfo()?.organizationUuid) {
      return 'Unable to determine your organization for Remote Control eligibility. Run `claude auth login` to refresh your account information.'
    }
    if (!(await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge'))) {
      return 'Remote Control is not yet enabled for your account.'
    }
    return null
  }
  return 'Remote Control is not available in this build.'
}

// 之所以使用 try/catch：main.tsx:5698 在定义 Commander program 时就会调用
// isBridgeEnabled()，而那时 enableConfigs() 尚未运行。
// isClaudeAISubscriber() → getGlobalConfig() 会在那里抛出
// "Config accessed before allowed"。在配置初始化前，本来也不可能存在 OAuth token，
// 因此返回 false 是正确的。growthbook.ts:775-780 中的
// getFeatureValue_CACHED_MAY_BE_STALE 也已有相同的吞错处理。
function isClaudeAISubscriber(): boolean {
  try {
    return authModule.isClaudeAISubscriber()
  } catch {
    return false
  }
}
function hasProfileScope(): boolean {
  try {
    return authModule.hasProfileScope()
  } catch {
    return false
  }
}
function getOauthAccountInfo(): ReturnType<
  typeof authModule.getOauthAccountInfo
> {
  try {
    return authModule.getOauthAccountInfo()
  } catch {
    return undefined
  }
}

/**
 * 对 env-less（v2）REPL bridge 路径的运行时检查。
 * 当 GrowthBook flag `tengu_bridge_repl_v2` 开启时返回 true。
 *
 * 它控制 initReplBridge 选择哪套实现，而不是控制 bridge 是否可用
 * （见上方 isBridgeEnabled）。无论该 gate 如何，daemon/print 路径都继续使用
 * 基于 env 的实现。
 */
export function isEnvLessBridgeEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_bridge_repl_v2', false)
    : false
}

/**
 * 用于 `cse_*` → `session_*` 客户端重标记 shim 的 kill-switch。
 *
 * 该 shim 存在的原因是 compat/convert.go:27 会校验 TagSession，且 claude.ai
 * 前端路由依赖 `session_*`，而 v2 worker endpoint 返回的是 `cse_*`。
 * 一旦服务端改为按 environment_kind 打 tag，且前端也能直接接受 `cse_*`，
 * 就可以把它切为 false，让 toCompatSessionId 退化为 no-op。
 * 默认值为 true，即在显式关闭前 shim 一直有效。
 */
export function isCseShimEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_bridge_repl_v2_cse_shim_enabled',
        true,
      )
    : true
}

/**
 * 如果当前 CLI 版本低于 v1（基于 env）Remote Control 路径所需的最小版本，
 * 则返回错误消息；否则返回 null。v2（env-less）路径则改用
 * envLessBridgeConfig.ts 中的 checkEnvLessBridgeMinVersion()，两套实现的
 * 版本下限彼此独立。
 *
 * 使用缓存的（非阻塞）GrowthBook 配置。如果 GrowthBook 尚未加载，默认值
 * '0.0.0' 会让检查通过，这是安全的回退行为。
 */
export function checkBridgeMinVersion(): string | null {
  // 使用正向模式，见 docs/feature-gating.md。
  // 负向模式（if (!feature(...)) return）无法从外部构建中消除
  // 内联字符串字面量。
  if (feature('BRIDGE_MODE')) {
    const config = getDynamicConfig_CACHED_MAY_BE_STALE<{
      minVersion: string
    }>('tengu_bridge_min_version', { minVersion: '0.0.0' })
    if (config.minVersion && lt(MACRO.VERSION, config.minVersion)) {
      return `Your version of Claude Code (${MACRO.VERSION}) is too old for Remote Control.\nVersion ${config.minVersion} or higher is required. Run \`claude update\` to update.`
    }
  }
  return null
}

/**
 * 当用户未显式设置时，remoteControlAtStartup 的默认值。
 * 当存在 CCR_AUTO_CONNECT 构建 flag（ant-only）且
 * tengu_cobalt_harbor GrowthBook gate 开启时，所有 session 默认连接到 CCR。
 * 用户仍可通过在 config 中设置 remoteControlAtStartup=false 来显式退出，
 * 显式设置始终优先于该默认值。
 *
 * 之所以定义在这里而不是 config.ts 中，是为了避免直接形成
 * config.ts → growthbook.ts 的导入环（growthbook.ts → user.ts → config.ts）。
 */
export function getCcrAutoConnectDefault(): boolean {
  return feature('CCR_AUTO_CONNECT')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_harbor', false)
    : false
}

/**
 * 选择加入的 CCR mirror 模式。每个本地 session 都会派生一个仅出站的
 * Remote Control session，用于接收转发事件。它与
 * getCcrAutoConnectDefault（双向 Remote Control）是分开的。
 * 环境变量优先用于本地 opt-in；GrowthBook 控制 rollout。
 */
export function isCcrMirrorEnabled(): boolean {
  return feature('CCR_MIRROR')
    ? isEnvTruthy(process.env.CLAUDE_CODE_CCR_MIRROR) ||
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_mirror', false)
    : false
}
