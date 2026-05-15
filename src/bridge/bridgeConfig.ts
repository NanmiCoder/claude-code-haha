/**
 * 共享的 bridge 鉴权/URL 解析。把此前散落在十多个文件中的 ant-only
 * CLAUDE_BRIDGE_* 开发覆盖项统一收敛到这里，这些文件包括
 * 涉及的调用点包括 inboundAttachments、BriefTool/upload、bridgeMain、
 * 以及 initReplBridge、remoteBridgeCore、daemon workers、/rename、/remote-control 等位置。
 *
 * 分两层：*Override() 返回 ant-only 环境变量（或 undefined）；
 * 非 Override 版本则回退到真实的 OAuth 存储/配置。
 * 需要组合其他鉴权来源的调用方（例如使用 IPC 鉴权的 daemon workers）
 * 直接使用 Override getter。
 */

import { getOauthConfig } from '../constants/oauth.js'
import { getClaudeAIOAuthTokens } from '../utils/auth.js'

/** Ant-only 开发覆盖项：CLAUDE_BRIDGE_OAUTH_TOKEN，否则为 undefined。 */
export function getBridgeTokenOverride(): string | undefined {
  return (
    (process.env.USER_TYPE === 'ant' &&
      process.env.CLAUDE_BRIDGE_OAUTH_TOKEN) ||
    undefined
  )
}

/** Ant-only 开发覆盖项：CLAUDE_BRIDGE_BASE_URL，否则为 undefined。 */
export function getBridgeBaseUrlOverride(): string | undefined {
  return (
    (process.env.USER_TYPE === 'ant' && process.env.CLAUDE_BRIDGE_BASE_URL) ||
    undefined
  )
}

/**
 * bridge API 调用使用的 access token：优先开发覆盖项，其次 OAuth
 * keychain。undefined 表示“未登录”。
 */
export function getBridgeAccessToken(): string | undefined {
  return getBridgeTokenOverride() ?? getClaudeAIOAuthTokens()?.accessToken
}

/**
 * bridge API 调用使用的 Base URL：优先开发覆盖项，其次生产环境
 * OAuth 配置。始终返回一个 URL。
 */
export function getBridgeBaseUrl(): string {
  return getBridgeBaseUrlOverride() ?? getOauthConfig().BASE_API_URL
}
