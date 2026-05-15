import { logEvent } from '../services/analytics/index.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { errorMessage } from '../utils/errors.js'
import { jsonParse } from '../utils/slowOperations.js'

/** 将毫秒时长格式化为人类可读字符串（例如 "5m 30s"）。 */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

/**
 * 在不校验签名的前提下解码 JWT 的 payload 段。
 * 如果存在 `sk-ant-si-` session-ingress 前缀，则会先剥离。
 * 成功时返回解析后的 JSON payload（类型为 `unknown`），
 * 如果 token 格式错误或 payload 不是合法 JSON，则返回 `null`。
 */
export function decodeJwtPayload(token: string): unknown | null {
  const jwt = token.startsWith('sk-ant-si-')
    ? token.slice('sk-ant-si-'.length)
    : token
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    return jsonParse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * 在不校验签名的前提下，从 JWT 中解码 `exp`（过期时间）声明。
 * @returns `exp` 的 Unix 秒值；若无法解析则返回 `null`
 */
export function decodeJwtExpiry(token: string): number | null {
  const payload = decodeJwtPayload(token)
  if (
    payload !== null &&
    typeof payload === 'object' &&
    'exp' in payload &&
    typeof payload.exp === 'number'
  ) {
    return payload.exp
  }
  return null
}

/** 刷新缓冲时间：在过期前请求新 token。 */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

/** 当新 token 的过期时间未知时使用的回退刷新间隔。 */
const FALLBACK_REFRESH_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

/** 在放弃刷新链之前允许的最大连续失败次数。 */
const MAX_REFRESH_FAILURES = 3

/** 当 getAccessToken 返回 undefined 时的重试延迟。 */
const REFRESH_RETRY_DELAY_MS = 60_000

/**
 * 创建一个 token 刷新调度器，在 session token 过期前主动刷新。
 * 供 standalone bridge 和 REPL bridge 共同使用。
 *
 * 当 token 即将过期时，调度器会用 session ID 和 bridge 的 OAuth access token
 * 调用 `onRefresh`。调用方负责把该 token 送到对应 transport：
 * standalone bridge 写入子进程 stdin，REPL bridge 则触发 WebSocket 重连。
 */
export function createTokenRefreshScheduler({
  getAccessToken,
  onRefresh,
  label,
  refreshBufferMs = TOKEN_REFRESH_BUFFER_MS,
}: {
  getAccessToken: () => string | undefined | Promise<string | undefined>
  onRefresh: (sessionId: string, oauthToken: string) => void
  label: string
  /** 距离过期多久时触发刷新。默认 5 分钟。 */
  refreshBufferMs?: number
}): {
  schedule: (sessionId: string, token: string) => void
  scheduleFromExpiresIn: (sessionId: string, expiresInSeconds: number) => void
  cancel: (sessionId: string) => void
  cancelAll: () => void
} {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const failureCounts = new Map<string, number>()
  // 每个 session 一个 generation 计数器，由 schedule() 和 cancel() 递增，
  // 使进行中的异步 doRefresh() 能检测自己是否已过期，并跳过设置后续 timer。
  const generations = new Map<string, number>()

  function nextGeneration(sessionId: string): number {
    const gen = (generations.get(sessionId) ?? 0) + 1
    generations.set(sessionId, gen)
    return gen
  }

  function schedule(sessionId: string, token: string): void {
    const expiry = decodeJwtExpiry(token)
    if (!expiry) {
      // token 不是可解码的 JWT（例如由 REPL bridge WebSocket open handler
      // 传入的 OAuth token）。这里保留现有 timer
      // （例如 doRefresh 设置的后续刷新），避免刷新链被中断。
      logForDebugging(
        `[${label}:token] Could not decode JWT expiry for sessionId=${sessionId}, token prefix=${token.slice(0, 15)}…, keeping existing timer`,
      )
      return
    }

    // 清除现有刷新 timer，因为我们现在有了明确的过期时间可以替换它。
    const existing = timers.get(sessionId)
    if (existing) {
      clearTimeout(existing)
    }

    // 递增 generation，使正在进行中的异步 doRefresh 失效。
    const gen = nextGeneration(sessionId)

    const expiryDate = new Date(expiry * 1000).toISOString()
    const delayMs = expiry * 1000 - Date.now() - refreshBufferMs
    if (delayMs <= 0) {
      logForDebugging(
        `[${label}:token] Token for sessionId=${sessionId} expires=${expiryDate} (past or within buffer), refreshing immediately`,
      )
      void doRefresh(sessionId, gen)
      return
    }

    logForDebugging(
      `[${label}:token] Scheduled token refresh for sessionId=${sessionId} in ${formatDuration(delayMs)} (expires=${expiryDate}, buffer=${refreshBufferMs / 1000}s)`,
    )

    const timer = setTimeout(doRefresh, delayMs, sessionId, gen)
    timers.set(sessionId, timer)
  }

  /**
    * 使用显式 TTL（距离过期还剩多少秒）来安排刷新，而不是解码 JWT 的 exp claim。
    * 供 JWT 不透明的调用方使用
    * （例如 POST /v1/code/sessions/{id}/bridge 会直接返回 expires_in）。
   */
  function scheduleFromExpiresIn(
    sessionId: string,
    expiresInSeconds: number,
  ): void {
    const existing = timers.get(sessionId)
    if (existing) clearTimeout(existing)
    const gen = nextGeneration(sessionId)
    // 将下限钳制到 30s。如果 refreshBufferMs 超过服务端的 expires_in
    // （例如为了频繁刷新测试而使用很大的 buffer，或服务端意外缩短 expires_in），
    // 不加钳制时 delayMs ≤ 0 会导致紧密循环。
    const delayMs = Math.max(expiresInSeconds * 1000 - refreshBufferMs, 30_000)
    logForDebugging(
      `[${label}:token] Scheduled token refresh for sessionId=${sessionId} in ${formatDuration(delayMs)} (expires_in=${expiresInSeconds}s, buffer=${refreshBufferMs / 1000}s)`,
    )
    const timer = setTimeout(doRefresh, delayMs, sessionId, gen)
    timers.set(sessionId, timer)
  }

  async function doRefresh(sessionId: string, gen: number): Promise<void> {
    let oauthToken: string | undefined
    try {
      oauthToken = await getAccessToken()
    } catch (err) {
      logForDebugging(
        `[${label}:token] getAccessToken threw for sessionId=${sessionId}: ${errorMessage(err)}`,
        { level: 'error' },
      )
    }

    // 如果在等待期间 session 已被取消或重新调度，generation 就会改变。
    // 此时直接退出，避免留下孤儿 timer。
    if (generations.get(sessionId) !== gen) {
      logForDebugging(
        `[${label}:token] doRefresh for sessionId=${sessionId} stale (gen ${gen} vs ${generations.get(sessionId)}), skipping`,
      )
      return
    }

    if (!oauthToken) {
      const failures = (failureCounts.get(sessionId) ?? 0) + 1
      failureCounts.set(sessionId, failures)
      logForDebugging(
        `[${label}:token] No OAuth token available for refresh, sessionId=${sessionId} (failure ${failures}/${MAX_REFRESH_FAILURES})`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'bridge_token_refresh_no_oauth')
      // 安排一次重试，以便当 token 再次可用时（例如刷新期间缓存被短暂清空）
      // 刷新链还能恢复。限制重试次数，避免在真实失败时刷屏。
      if (failures < MAX_REFRESH_FAILURES) {
        const retryTimer = setTimeout(
          doRefresh,
          REFRESH_RETRY_DELAY_MS,
          sessionId,
          gen,
        )
        timers.set(sessionId, retryTimer)
      }
      return
    }

    // 成功获取 token 后重置失败计数器
    failureCounts.delete(sessionId)

    logForDebugging(
      `[${label}:token] Refreshing token for sessionId=${sessionId}: new token prefix=${oauthToken.slice(0, 15)}…`,
    )
    logEvent('tengu_bridge_token_refreshed', {})
    onRefresh(sessionId, oauthToken)

    // 安排后续刷新，确保长时间运行的 session 保持已鉴权状态。
    // 否则初始的一次性 timer 会让 session 在跑过首次刷新窗口后重新暴露于过期风险。
    const timer = setTimeout(
      doRefresh,
      FALLBACK_REFRESH_INTERVAL_MS,
      sessionId,
      gen,
    )
    timers.set(sessionId, timer)
    logForDebugging(
      `[${label}:token] Scheduled follow-up refresh for sessionId=${sessionId} in ${formatDuration(FALLBACK_REFRESH_INTERVAL_MS)}`,
    )
  }

  function cancel(sessionId: string): void {
    // 递增 generation，使进行中的异步 doRefresh 失效。
    nextGeneration(sessionId)
    const timer = timers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(sessionId)
    }
    failureCounts.delete(sessionId)
  }

  function cancelAll(): void {
    // 递增所有 generation，使正在进行中的 doRefresh 调用全部失效。
    for (const sessionId of generations.keys()) {
      nextGeneration(sessionId)
    }
    for (const timer of timers.values()) {
      clearTimeout(timer)
    }
    timers.clear()
    failureCounts.clear()
  }

  return { schedule, scheduleFromExpiresIn, cancel, cancelAll }
}
