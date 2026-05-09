/**
 * Adapters API — IM Adapter 配置读写
 *
 * GET  /api/adapters  → 返回配置（敏感字段脱敏）
 * PUT  /api/adapters  → 更新配置（浅合并），返回更新后的脱敏配置
 */

import { adapterService } from '../services/adapterService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  pollWechatLoginWithQr,
  startWechatLoginWithQr,
  WECHAT_DEFAULT_BASE_URL,
} from '../../../adapters/wechat/protocol.js'

const ALLOWED_TOP_KEYS = new Set(['serverUrl', 'defaultProjectDir', 'telegram', 'feishu', 'wechat', 'dingtalk', 'pairing'])

type RegistrationApiResponse<T extends Record<string, unknown>> = T & {
  errcode: number
  errmsg?: string
}

type RegistrationBeginPayload = {
  deviceCode: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete: string
  expiresInSeconds: number
  intervalSeconds: number
  qrDataUrl?: string
}

const DINGTALK_REGISTRATION_BASE_URL =
  process.env.DINGTALK_REGISTRATION_BASE_URL?.trim() || 'https://oapi.dingtalk.com'
const DINGTALK_REGISTRATION_SOURCE =
  process.env.DINGTALK_REGISTRATION_SOURCE?.trim() || 'DING_DWS_CLAW'

async function postDingtalkRegistration<T extends Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
  action: string,
): Promise<RegistrationApiResponse<T>> {
  const res = await fetch(`${DINGTALK_REGISTRATION_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null) as RegistrationApiResponse<T> | null
  if (!res.ok || !data || data.errcode !== 0) {
    throw ApiError.internal(`[DingTalk ${action}] ${data?.errmsg || res.statusText || 'unknown error'}`)
  }
  return data
}

async function createQrDataUrl(text: string): Promise<string | undefined> {
  try {
    const qr = await import('qrcode') as any
    return await qr.toDataURL(text, { margin: 1, width: 220 })
  } catch {
    return undefined
  }
}

async function beginDingtalkRegistration(): Promise<RegistrationBeginPayload> {
  const initData = await postDingtalkRegistration<{ nonce?: string }>(
    '/app/registration/init',
    { source: DINGTALK_REGISTRATION_SOURCE },
    'init',
  )
  const nonce = String(initData.nonce ?? '').trim()
  if (!nonce) throw ApiError.internal('[DingTalk init] missing nonce')

  const beginData = await postDingtalkRegistration<{
    device_code?: string
    user_code?: string
    verification_uri?: string
    verification_uri_complete?: string
    expires_in?: number
    interval?: number
  }>('/app/registration/begin', { nonce }, 'begin')

  const deviceCode = String(beginData.device_code ?? '').trim()
  const verificationUriComplete = String(beginData.verification_uri_complete ?? '').trim()
  if (!deviceCode) throw ApiError.internal('[DingTalk begin] missing device_code')
  if (!verificationUriComplete) throw ApiError.internal('[DingTalk begin] missing verification_uri_complete')

  const expiresInSeconds = Number(beginData.expires_in ?? 7200)
  const intervalSeconds = Number(beginData.interval ?? 3)

  return {
    deviceCode,
    userCode: String(beginData.user_code ?? '').trim() || undefined,
    verificationUri: String(beginData.verification_uri ?? '').trim() || undefined,
    verificationUriComplete,
    expiresInSeconds: Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 7200,
    intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 3,
    qrDataUrl: await createQrDataUrl(verificationUriComplete),
  }
}

async function pollDingtalkRegistration(deviceCode: string): Promise<Response> {
  if (!deviceCode) throw ApiError.badRequest('deviceCode is required')

  const pollData = await postDingtalkRegistration<{
    status?: string
    client_id?: string
    client_secret?: string
    fail_reason?: string
  }>('/app/registration/poll', { device_code: deviceCode }, 'poll')

  const status = String(pollData.status ?? '').trim().toUpperCase()
  if (status === 'SUCCESS') {
    const clientId = String(pollData.client_id ?? '').trim()
    const clientSecret = String(pollData.client_secret ?? '').trim()
    if (!clientId || !clientSecret) {
      throw ApiError.internal('DingTalk authorization succeeded but credentials are missing')
    }
    await adapterService.updateConfig({
      dingtalk: {
        clientId,
        clientSecret,
      },
    })
    return Response.json({
      status,
      config: await adapterService.getConfig(),
    })
  }

  return Response.json({
    status: status || 'UNKNOWN',
    failReason: String(pollData.fail_reason ?? '').trim() || undefined,
  })
}

/**
 * Feishu QR scan-to-create registration
 */
const FEISHU_ACCOUNTS_BASE_URL: Record<string, string> = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
}
const FEISHU_REGISTRATION_PATH = '/oauth/v1/app/registration'
const FEISHU_ONBOARD_REQUEST_TIMEOUT_MS = 15_000

async function postFeishuRegistration(
  baseUrl: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = `${baseUrl}${FEISHU_REGISTRATION_PATH}`
  const formBody = new URLSearchParams(body).toString()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
    signal: AbortSignal.timeout(FEISHU_ONBOARD_REQUEST_TIMEOUT_MS),
  })
  // Feishu returns JSON even on 4xx (e.g. poll returns authorization_pending as 400)
  const text = await res.text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    if (!res.ok) throw ApiError.internal(`[Feishu] HTTP ${res.status}: ${text.slice(0, 200)}`)
    throw ApiError.internal('[Feishu] invalid JSON response')
  }
}

async function beginFeishuRegistration(
  domain: string,
): Promise<RegistrationBeginPayload> {
  const baseUrl = FEISHU_ACCOUNTS_BASE_URL[domain] || FEISHU_ACCOUNTS_BASE_URL.feishu

  // Init — verify client_secret is supported
  const initRes = await postFeishuRegistration(baseUrl, { action: 'init' })
  const methods = (initRes.supported_auth_methods as string[]) || []
  if (!methods.includes('client_secret')) {
    throw ApiError.internal(
      `Feishu/Lark registration does not support client_secret auth. Supported: ${methods.join(', ')}`,
    )
  }

  // Begin — start device code flow
  const beginRes = await postFeishuRegistration(baseUrl, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  })

  const deviceCode = String(beginRes.device_code ?? '').trim()
  if (!deviceCode) throw ApiError.internal('[Feishu begin] missing device_code')

  let qrUrl = String(beginRes.verification_uri_complete ?? '').trim()
  if (!qrUrl) throw ApiError.internal('[Feishu begin] missing verification_uri_complete')

  const expiresInSeconds = Math.min(
    Number(beginRes.expire_in ?? 600),
    600, // cap at 10 minutes
  )

  return {
    deviceCode,
    userCode: String(beginRes.user_code ?? '').trim() || undefined,
    verificationUri: String(beginRes.verification_uri ?? '').trim() || undefined,
    verificationUriComplete: qrUrl,
    expiresInSeconds: Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 600,
    intervalSeconds: Math.max(1, Number(beginRes.interval ?? 5) || 5),
    qrDataUrl: await createQrDataUrl(qrUrl),
  }
}

async function pollFeishuRegistration(
  deviceCode: string,
  domain: string,
): Promise<Response> {
  if (!deviceCode) throw ApiError.badRequest('deviceCode is required')

  const baseUrl = FEISHU_ACCOUNTS_BASE_URL[domain] || FEISHU_ACCOUNTS_BASE_URL.feishu

  let pollRes: Record<string, unknown>
  try {
    pollRes = await postFeishuRegistration(baseUrl, {
      action: 'poll',
      device_code: deviceCode,
      tp: 'ob_app',
    })
  } catch {
    // Network error during poll — treat as still waiting
    return Response.json({ status: 'WAITING' })
  }

  // Domain auto-detection: if user scanned via Lark app, switch domain
  const userInfo = (pollRes.user_info as Record<string, unknown>) || {}
  const tenantBrand = String(userInfo.tenant_brand ?? '').trim()
  let effectiveDomain = domain
  if (tenantBrand === 'lark' && domain !== 'lark') {
    effectiveDomain = 'lark'
  }

  // Success
  if (pollRes.client_id && pollRes.client_secret) {
    const appId = String(pollRes.client_id).trim()
    const appSecret = String(pollRes.client_secret).trim()
    const openId = String(userInfo.open_id ?? '').trim() || undefined

    await adapterService.updateConfig({
      feishu: {
        appId,
        appSecret,
        domain: effectiveDomain,
        // Don't persist bot identity — resolved at runtime
      },
    })
    return Response.json({
      status: 'SUCCESS',
      domain: effectiveDomain,
      openId,
      config: await adapterService.getConfig(),
    })
  }

  // Terminal errors
  const error = String(pollRes.error ?? '').trim()
  if (error === 'access_denied') {
    return Response.json({ status: 'FAIL', failReason: 'User denied the authorization' })
  }
  if (error === 'expired_token') {
    return Response.json({ status: 'EXPIRED', failReason: 'Device code expired' })
  }

  // Still waiting (authorization_pending or unknown)
  return Response.json({ status: 'WAITING' })
}
export async function handleAdaptersApi(
  req: Request,
  _url: URL,
  _segments: string[],
): Promise<Response> {
  try {
    const tail = _segments.slice(2)
    if (tail[0] === 'wechat') {
      return handleWechatAdaptersApi(req, tail.slice(1))
    }
    if (tail[0] === 'dingtalk' && req.method === 'POST' && tail[1] === 'unbind') {
      await adapterService.updateConfig({
        dingtalk: {
          clientId: undefined,
          clientSecret: undefined,
          allowedUsers: [],
          pairedUsers: [],
          permissionCardTemplateId: undefined,
        },
      })
      return Response.json(await adapterService.getConfig())
    }
    if (tail[0] === 'dingtalk' && tail[1] === 'registration') {
      if (req.method === 'POST' && tail[2] === 'begin') {
        return Response.json(await beginDingtalkRegistration())
      }
      if (req.method === 'POST' && tail[2] === 'poll') {
        const body = await req.json().catch(() => ({})) as { deviceCode?: string }
        return pollDingtalkRegistration(String(body.deviceCode ?? '').trim())
      }
    }

    // -- Feishu --
    if (tail[0] === 'feishu' && req.method === 'POST' && tail[1] === 'unbind') {
      await adapterService.updateConfig({
        feishu: {
          appId: undefined,
          appSecret: undefined,
          domain: undefined,
          encryptKey: undefined,
          verificationToken: undefined,
          allowedUsers: [],
          pairedUsers: [],
          streamingCard: false,
        },
      })
      return Response.json(await adapterService.getConfig())
    }
    if (tail[0] === 'feishu' && tail[1] === 'setup') {
      if (req.method === 'POST' && tail[2] === 'begin') {
        const body = await req.json().catch(() => ({})) as { domain?: string }
        const domain = String(body.domain ?? 'feishu').trim() || 'feishu'
        return Response.json(await beginFeishuRegistration(domain))
      }
      if (req.method === 'POST' && tail[2] === 'poll') {
        const body = await req.json().catch(() => ({})) as { deviceCode?: string; domain?: string }
        return pollFeishuRegistration(
          String(body.deviceCode ?? '').trim(),
          String(body.domain ?? 'feishu').trim() || 'feishu',
        )
      }
    }
    if (req.method === 'GET') {
      const config = await adapterService.getConfig()
      return Response.json(config)
    }

    if (req.method === 'PUT') {
      const body = (await req.json()) as Record<string, unknown>
      // Basic validation: only allow known top-level keys
      for (const key of Object.keys(body)) {
        if (!ALLOWED_TOP_KEYS.has(key)) {
          throw ApiError.badRequest(`Unknown config key: ${key}`)
        }
      }
      await adapterService.updateConfig(body)
      const config = await adapterService.getConfig()
      return Response.json(config)
    }

    throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
  } catch (error) {
    return errorResponse(error)
  }
}

async function handleWechatAdaptersApi(req: Request, tail: string[]): Promise<Response> {
  if (req.method === 'POST' && tail[0] === 'login' && tail[1] === 'start') {
    const result = await startWechatLoginWithQr({ force: true })
    return Response.json(result)
  }

  if (req.method === 'POST' && tail[0] === 'login' && tail[1] === 'poll') {
    const body = (await req.json()) as { sessionKey?: string }
    if (!body.sessionKey) throw ApiError.badRequest('Missing sessionKey')
    const result = await pollWechatLoginWithQr({ sessionKey: body.sessionKey })
    if (result.connected) {
      await adapterService.updateConfig({
        wechat: {
          accountId: result.accountId,
          botToken: result.botToken,
          baseUrl: result.baseUrl || WECHAT_DEFAULT_BASE_URL,
          userId: result.userId,
          pairedUsers: [],
        },
      })
    }
    return Response.json(result.connected ? await adapterService.getConfig() : result)
  }

  if (req.method === 'POST' && tail[0] === 'unbind') {
    await adapterService.updateConfig({
      wechat: {
        accountId: undefined,
        botToken: undefined,
        baseUrl: WECHAT_DEFAULT_BASE_URL,
        userId: undefined,
        pairedUsers: [],
        allowedUsers: [],
      },
    })
    return Response.json(await adapterService.getConfig())
  }

  throw new ApiError(404, 'Unknown WeChat adapter endpoint', 'NOT_FOUND')
}
