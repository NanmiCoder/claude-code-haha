import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import { hostname } from 'os'
import { getOauthConfig } from '../constants/oauth.js'
import {
  checkGate_CACHED_OR_BLOCKING,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../services/analytics/growthbook.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js'
import { getSecureStorage } from '../utils/secureStorage/index.js'
import { jsonStringify } from '../utils/slowOperations.js'

/**
 * bridge（remote-control）session 使用的 trusted device token 来源。
 *
 * bridge session 在服务端（CCR v2）具有 SecurityTier=ELEVATED。
 * 服务端通过自己的 flag 控制 ConnectBridgeWorker
 * （Anthropic Main 中的 sessions_elevated_auth_enforcement）；而 CLI 侧的
 * 这个 flag 则控制 CLI 是否发送 X-Trusted-Device-Token。
 * 分成两个 flag，便于分阶段 rollout：先打开 CLI 侧（header 开始带上，
 * 服务端暂时仍 no-op），再打开服务端侧。
 *
 * Enrollment（POST /auth/trusted_devices）在服务端受
 * account_session.created_at < 10min 限制，因此必须在 /login 期间完成。
 * Token 是持久的（90 天滚动过期），并存储在 keychain 中。
 *
 * 参见 anthropics/anthropic#274559（spec）、#310375（B1b tenant RPCs）、
 * #295987（B2 Python routes）、#307150（C1' CCR v2 gate）。
 */

const TRUSTED_DEVICE_GATE = 'tengu_sessions_elevated_auth_enforcement'

function isGateEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE(TRUSTED_DEVICE_GATE, false)
}

// 使用 memoize：secureStorage.read() 在 macOS 上会拉起 `security` 子进程
// （约 40ms）。bridgeApi.ts 会在每次 poll/heartbeat/ack 的 getHeaders()
// 中调用这里。缓存会在 enrollment 后（下方）以及 logout 时
// （clearAuthRelatedCaches）清空。
//
// 只有存储读取会被缓存；GrowthBook gate 仍然实时检查，确保在 GrowthBook
// 刷新后切换 gate 时无需重启即可生效。
const readStoredToken = memoize((): string | undefined => {
  // 环境变量优先，用于测试/canary。
  const envToken = process.env.CLAUDE_TRUSTED_DEVICE_TOKEN
  if (envToken) {
    return envToken
  }
  return getSecureStorage().read()?.trustedDeviceToken
})

export function getTrustedDeviceToken(): string | undefined {
  if (!isGateEnabled()) {
    return undefined
  }
  return readStoredToken()
}

export function clearTrustedDeviceTokenCache(): void {
  readStoredToken.cache?.clear?.()
}

/**
 * 从 secure storage 和 memo 缓存中清除已存储的 trusted device token。
 * 在 /login 期间会于 enrollTrustedDevice() 之前调用，以避免前一个账户的过期
 * token 在 enrollment 尚未完成时仍被作为 X-Trusted-Device-Token 发送出去
 * （enrollTrustedDevice 是异步的，否则 login 到 enrollment 完成之间的 bridge
 * API 调用仍会读到旧缓存 token）。
 */
export function clearTrustedDeviceToken(): void {
  if (!isGateEnabled()) {
    return
  }
  const secureStorage = getSecureStorage()
  try {
    const data = secureStorage.read()
    if (data?.trustedDeviceToken) {
      delete data.trustedDeviceToken
      secureStorage.update(data)
    }
  } catch {
    // Best-effort：如果存储不可访问，不要阻塞 login
  }
  readStoredToken.cache?.clear?.()
}

/**
 * 通过 POST /auth/trusted_devices 为当前设备完成 enrollment，并将 token
 * 持久化到 keychain。Best-effort：失败时只记录日志并返回，避免调用方
 * （post-login hooks）阻塞 login 流程。
 *
 * 服务端要求 enrollment 时 account_session.created_at < 10min，因此该函数
 * 必须在一次新的 /login 之后立即调用。更晚调用
 * （例如在 /bridge 403 时懒注册）会因 403 stale_session 失败。
 */
export async function enrollTrustedDevice(): Promise<void> {
  try {
    // checkGate_CACHED_OR_BLOCKING 会在读 gate 前等待任何正在进行中的
    // GrowthBook 重新初始化（由 login.tsx 中的 refreshGrowthBookAfterAuthChange
    // 触发），因此这里拿到的是刷新后的值。
    if (!(await checkGate_CACHED_OR_BLOCKING(TRUSTED_DEVICE_GATE))) {
      logForDebugging(
        `[trusted-device] Gate ${TRUSTED_DEVICE_GATE} is off, skipping enrollment`,
      )
      return
    }
    // 如果设置了 CLAUDE_TRUSTED_DEVICE_TOKEN（例如由企业包装器注入），
    // 则跳过 enrollment。因为 readStoredToken() 中环境变量优先，
    // 任何新注册的 token 都会被遮蔽且永远不会使用。
    if (process.env.CLAUDE_TRUSTED_DEVICE_TOKEN) {
      logForDebugging(
        '[trusted-device] CLAUDE_TRUSTED_DEVICE_TOKEN env var is set, skipping enrollment (env var takes precedence)',
      )
      return
    }
    // 延迟 require。utils/auth.ts 会传递引入约 1300 个模块
    // （config → file → permissions → sessionStorage → commands）。
    // 调用 getTrustedDeviceToken() 的 daemon 调用方不需要这些，只有 /login 需要。
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getClaudeAIOAuthTokens } =
      require('../utils/auth.js') as typeof import('../utils/auth.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const accessToken = getClaudeAIOAuthTokens()?.accessToken
    if (!accessToken) {
      logForDebugging('[trusted-device] No OAuth token, skipping enrollment')
      return
    }
    // 在 /login 时始终重新 enrollment。现有 token 可能属于另一个账户
    // （例如未 /logout 就切换账户）。如果跳过 enrollment，就会在新账户的
    // bridge 调用上发送旧账户 token。
    const secureStorage = getSecureStorage()

    if (isEssentialTrafficOnly()) {
      logForDebugging(
        '[trusted-device] Essential traffic only, skipping enrollment',
      )
      return
    }

    const baseUrl = getOauthConfig().BASE_API_URL
    let response
    try {
      response = await axios.post<{
        device_token?: string
        device_id?: string
      }>(
        `${baseUrl}/api/auth/trusted_devices`,
        { display_name: `Claude Code on ${hostname()} · ${process.platform}` },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 10_000,
          validateStatus: s => s < 500,
        },
      )
    } catch (err: unknown) {
      logForDebugging(
        `[trusted-device] Enrollment request failed: ${errorMessage(err)}`,
      )
      return
    }

    if (response.status !== 200 && response.status !== 201) {
      logForDebugging(
        `[trusted-device] Enrollment failed ${response.status}: ${jsonStringify(response.data).slice(0, 200)}`,
      )
      return
    }

    const token = response.data?.device_token
    if (!token || typeof token !== 'string') {
      logForDebugging(
        '[trusted-device] Enrollment response missing device_token field',
      )
      return
    }

    try {
      const storageData = secureStorage.read()
      if (!storageData) {
        logForDebugging(
          '[trusted-device] Cannot read storage, skipping token persist',
        )
        return
      }
      storageData.trustedDeviceToken = token
      const result = secureStorage.update(storageData)
      if (!result.success) {
        logForDebugging(
          `[trusted-device] Failed to persist token: ${result.warning ?? 'unknown'}`,
        )
        return
      }
      readStoredToken.cache?.clear?.()
      logForDebugging(
        `[trusted-device] Enrolled device_id=${response.data.device_id ?? 'unknown'}`,
      )
    } catch (err: unknown) {
      logForDebugging(
        `[trusted-device] Storage write failed: ${errorMessage(err)}`,
      )
    }
  } catch (err: unknown) {
    logForDebugging(`[trusted-device] Enrollment error: ${errorMessage(err)}`)
  }
}
