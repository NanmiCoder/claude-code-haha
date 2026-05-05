/**
 * CORS middleware for local browser clients.
 */

const ALLOWED_ORIGIN_RE =
  /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/

export function corsHeaders(origin?: string | null): Record<string, string> {
  const allowedOrigin =
    origin && ALLOWED_ORIGIN_RE.test(origin) ? origin : 'http://localhost:3000'
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}
