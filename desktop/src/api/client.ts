const ENV_BASE_URL =
  typeof import.meta !== 'undefined' &&
  typeof import.meta.env?.VITE_DESKTOP_SERVER_URL === 'string' &&
  import.meta.env.VITE_DESKTOP_SERVER_URL.length > 0
    ? import.meta.env.VITE_DESKTOP_SERVER_URL
    : undefined

const DEFAULT_BASE_URL =
  ENV_BASE_URL ||
  (typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : 'http://127.0.0.1:3456')

let baseUrl = DEFAULT_BASE_URL
let authToken: string | null = null
const DIAGNOSTICS_PATH = '/api/diagnostics/events'

function getErrorMessage(status: number, body: unknown) {
  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
    return body.message
  }

  if (typeof body === 'string' && body.trim().length > 0) {
    return body
  }

  return `API error ${status}`
}

export function setBaseUrl(url: string) {
  baseUrl = url.replace(/\/$/, '')
}

export function getBaseUrl() {
  return baseUrl
}

export function setAuthToken(token: string | null) {
  const trimmed = token?.trim() ?? ''
  authToken = trimmed.length > 0 ? trimmed : null
}

export function getAuthToken() {
  return authToken
}

export function getDefaultBaseUrl() {
  return DEFAULT_BASE_URL
}

export function hasExplicitDefaultBaseUrl() {
  return Boolean(ENV_BASE_URL)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(getErrorMessage(status, body))
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, path: string, body?: unknown, options?: { timeout?: number }): Promise<T> {
  const url = `${baseUrl}${path}`
  const headers = buildHeaders()

  const controller = new AbortController()
  const timeoutMs = options?.timeout ?? 30_000
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const errorBody = await res.json().catch(() => res.text())
      throw new ApiError(res.status, errorBody)
    }

    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  } catch (err) {
    clearTimeout(timeout)
    if (controller.signal.aborted) {
      const timeoutError = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)
      reportApiFailure(method, path, timeoutError)
      throw timeoutError
    }
    reportApiFailure(method, path, err)
    throw err
  }
}

function reportApiFailure(method: string, path: string, error: unknown) {
  if (path.startsWith('/api/diagnostics')) return

  const details: Record<string, unknown> = {
    method,
    path,
    errorName: error instanceof Error ? error.name : typeof error,
    message: sanitizeDiagnosticValue(error instanceof Error ? error.message : String(error)),
  }

  if (error instanceof ApiError) {
    details.status = error.status
    details.response = sanitizeDiagnosticValue(error.body)
  }

  void rawRecordDiagnosticEvent({
    type: 'client_api_request_failed',
    severity: 'warn',
    summary: `${method} ${path} failed: ${details.message}`,
    details,
  })
}

export function rawRecordDiagnosticEvent(event: {
  type: string
  severity?: 'debug' | 'info' | 'warn' | 'error'
  summary: string
  sessionId?: string
  details?: unknown
}) {
  return fetch(`${baseUrl}${DIAGNOSTICS_PATH}`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(event),
  }).catch(() => undefined)
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`
  }

  return headers
}

function sanitizeDiagnosticValue(value: unknown): unknown {
  if (!authToken) return value

  if (typeof value === 'string') {
    return value.split(authToken).join('[redacted]')
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDiagnosticValue(entry))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeDiagnosticValue(entry)]),
    )
  }

  return value
}

export const api = {
  get: <T>(path: string, options?: { timeout?: number }) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: { timeout?: number }) => request<T>('POST', path, body, options),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}
