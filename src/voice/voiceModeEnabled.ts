import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  getClaudeAIOAuthTokens,
  isAnthropicAuthEnabled,
} from '../utils/auth.js'

/**
 * 语音模式的熔断检查。除非 `tengu_amber_quartz_disabled` 这个
 * GrowthBook 标记被打开（紧急关闭），否则返回 true。默认值 `false`
 * 表示缺失或过期的磁盘缓存会被视为“未熔断”，因此全新安装无需等待
 * GrowthBook 初始化即可立即使用语音功能。用它来决定语音模式是否
 * 应该“可见”（例如命令注册、配置 UI）。
 */
export function isVoiceGrowthBookEnabled(): boolean {
  // 使用正向三元模式——见 docs/feature-gating.md。
  // 负向模式（if (!feature(...)) return）不会从外部构建中消除
  // 内联字符串字面量。
  return feature('VOICE_MODE')
    ? !getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_quartz_disabled', false)
    : false
}

/**
 * 语音模式的纯认证检查。当用户拥有有效的 Anthropic OAuth token 时返回 true。
 * 它基于已 memoize 的 getClaudeAIOAuthTokens：在 macOS 上首次调用会拉起
 * `security`（约 20-50ms），后续调用命中缓存。token 刷新时（约每小时一次）
 * memoize 会清空，因此每次刷新出现一次冷启动是预期行为。对使用时检查来说足够便宜。
 */
export function hasVoiceAuth(): boolean {
  // 语音模式要求使用 Anthropic OAuth——它会调用 claude.ai 上的 voice_stream
  // 端点，而该端点不支持 API key、Bedrock、Vertex 或 Foundry。
  if (!isAnthropicAuthEnabled()) {
    return false
  }
  // isAnthropicAuthEnabled 只检查认证 *provider*，不检查 token 是否存在。
  // 没有这个检查时，语音 UI 会渲染出来，但用户未登录时
  // connectVoiceStream 会静默失败。
  const tokens = getClaudeAIOAuthTokens()
  return Boolean(tokens?.accessToken)
}

/**
 * 完整的运行时检查：认证 + GrowthBook 熔断开关。调用方包括 `/voice`
 *（voice.ts、voice/index.ts）、ConfigTool、VoiceModeNotice——这些都是
 * 命令时路径，可以接受一次新的 keychain 读取。React 渲染路径请改用
 * useVoiceEnabled()（它会 memoize 认证那一半）。
 */
export function isVoiceModeEnabled(): boolean {
  return hasVoiceAuth() && isVoiceGrowthBookEnabled()
}
