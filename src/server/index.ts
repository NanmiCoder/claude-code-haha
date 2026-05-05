/**
 * Claude Code Haha local HTTP + WebSocket server.
 *
 * Provides REST APIs, WebSocket sessions, adapter bridges, and local CLI
 * subprocess orchestration.
 */

import { handleApiRequest } from './router.js'
import { handleWebSocket, type WebSocketData } from './ws/handler.js'
import { corsHeaders } from './middleware/cors.js'
import { requireAuth } from './middleware/auth.js'
import { teamWatcher } from './services/teamWatcher.js'
import { cronScheduler } from './services/cronScheduler.js'
import { handleProxyRequest } from './proxy/handler.js'
import { ProviderService } from './services/providerService.js'
import { handleHahaOAuthCallback } from './api/haha-oauth.js'
import { handleHahaOpenAIOAuthCallback } from './api/haha-openai-oauth.js'
import { enableConfigs } from '../utils/config.js'
import { diagnosticsService } from './services/diagnosticsService.js'

function readArgValue(flag: string): string | undefined {
  const args = process.argv.slice(2)
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  return args[index + 1]
}

function hasArgFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag)
}

function resolveServerOptions() {
  const portArg = readArgValue('--port')
  const port = Number.parseInt(portArg || process.env.SERVER_PORT || '3456', 10)
  const host = readArgValue('--host') || process.env.SERVER_HOST || '127.0.0.1'
  const cliPath = readArgValue('--cli-path')
  const authRequired = hasArgFlag('--auth-required')

  if (cliPath) {
    process.env.CLAUDE_CLI_PATH = cliPath
  }

  return { port, host, authRequired }
}

const SERVER_OPTIONS = resolveServerOptions()
const PORT = SERVER_OPTIONS.port
const HOST = SERVER_OPTIONS.host

export function startServer(port = PORT, host = HOST) {
  enableConfigs()
  diagnosticsService.installConsoleCapture()
  ProviderService.setServerPort(port)
  const localConnectHost =
    host === '0.0.0.0' || host === '127.0.0.1' || host === 'localhost'
      ? '127.0.0.1'
      : host

  /**
   * Auth is required when explicitly opted in or when bound to a non-localhost address.
   * - Default localhost dev: no auth needed (tests pass as-is).
   * - Production / non-localhost (e.g. 0.0.0.0): auth enforced automatically.
   * - Explicit opt-in: SERVER_AUTH_REQUIRED=1 forces auth even on localhost.
   */
  const authRequired =
    SERVER_OPTIONS.authRequired ||
    process.env.SERVER_AUTH_REQUIRED === '1' ||
    host !== '127.0.0.1'

  const server = Bun.serve<WebSocketData>({
    port,
    hostname: host,
    idleTimeout: 60,

    async fetch(req, server) {
      const url = new URL(req.url)

      const origin = req.headers.get('Origin')

      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) })
      }

      // WebSocket upgrade
      if (url.pathname.startsWith('/ws/')) {
        // Enforce authentication when required
        if (authRequired) {
          const authError = requireAuth(req)
          if (authError) {
            const headers = new Headers(authError.headers)
            for (const [key, value] of Object.entries(corsHeaders(origin))) {
              headers.set(key, value)
            }
            return new Response(authError.body, { status: authError.status, headers })
          }
        }

        // Validate session ID format
        const sessionId = url.pathname.split('/').pop() || ''
        if (!sessionId || !/^[0-9a-zA-Z_-]{1,64}$/.test(sessionId)) {
          return new Response('Invalid session ID', { status: 400 })
        }
        const upgraded = server.upgrade(req, {
          data: {
            sessionId,
            connectedAt: Date.now(),
            channel: 'client',
            sdkToken: null,
            serverPort: port,
            serverHost: localConnectHost,
          },
        })
        if (upgraded) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      // Internal SDK WebSocket used by the spawned Claude CLI.
      if (url.pathname.startsWith('/sdk/')) {
        const sessionId = url.pathname.split('/').pop() || ''
        if (!sessionId || !/^[0-9a-zA-Z_-]{1,64}$/.test(sessionId)) {
          return new Response('Invalid session ID', { status: 400 })
        }
        const upgraded = server.upgrade(req, {
          data: {
            sessionId,
            connectedAt: Date.now(),
            channel: 'sdk',
            sdkToken: url.searchParams.get('token'),
            serverPort: port,
            serverHost: localConnectHost,
          },
        })
        if (upgraded) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      if (url.pathname === '/callback') {
        return handleHahaOAuthCallback(url)
      }

      if (url.pathname === '/callback/openai') {
        return handleHahaOpenAIOAuthCallback(url)
      }

      // REST API
      if (url.pathname.startsWith('/api/')) {
        // Enforce authentication when required
        if (authRequired) {
          const authError = requireAuth(req)
          if (authError) {
            const headers = new Headers(authError.headers)
            for (const [key, value] of Object.entries(corsHeaders(origin))) {
              headers.set(key, value)
            }
            return new Response(authError.body, { status: authError.status, headers })
          }
        }

        try {
          const response = await handleApiRequest(req, url)
          // Add CORS headers to all responses
          const headers = new Headers(response.headers)
          for (const [key, value] of Object.entries(corsHeaders(origin))) {
            headers.set(key, value)
          }
          return new Response(response.body, {
            status: response.status,
            headers,
          })
        } catch (error) {
          void diagnosticsService.recordEvent({
            type: 'api_request_failed',
            severity: 'error',
            summary: error instanceof Error ? error.message : String(error),
            details: { path: url.pathname, method: req.method, error },
          })
          console.error('[Server] API error:', error)
          return Response.json(
            { error: 'Internal server error' },
            { status: 500, headers: corsHeaders() }
          )
        }
      }

      // Proxy — protocol-translating reverse proxy for OpenAI-compatible APIs
      if (url.pathname.startsWith('/proxy/')) {
        if (authRequired) {
          const authError = requireAuth(req)
          if (authError) {
            const headers = new Headers(authError.headers)
            for (const [key, value] of Object.entries(corsHeaders(origin))) {
              headers.set(key, value)
            }
            return new Response(authError.body, { status: authError.status, headers })
          }
        }
        try {
          const response = await handleProxyRequest(req, url)
          const headers = new Headers(response.headers)
          for (const [key, value] of Object.entries(corsHeaders(origin))) {
            headers.set(key, value)
          }
          return new Response(response.body, {
            status: response.status,
            headers,
          })
        } catch (error) {
          void diagnosticsService.recordEvent({
            type: 'proxy_request_failed',
            severity: 'error',
            summary: error instanceof Error ? error.message : String(error),
            details: { path: url.pathname, method: req.method, error },
          })
          console.error('[Server] Proxy error:', error)
          return Response.json(
            { type: 'error', error: { type: 'api_error', message: 'Internal proxy error' } },
            { status: 500, headers: corsHeaders() },
          )
        }
      }

      // Health check
      if (url.pathname === '/health') {
        return Response.json(
          { status: 'ok', timestamp: new Date().toISOString() },
          { headers: corsHeaders(origin) },
        )
      }

      return new Response('Not Found', { status: 404 })
    },

    websocket: handleWebSocket,
  })

  // Start watching ~/.claude/teams/ for real-time WebSocket push
  teamWatcher.start()

  // Start the cron scheduler to execute scheduled tasks
  cronScheduler.start()

  console.log(`[Server] Claude Code API server running at http://${host}:${port}`)
  return server
}

// ─── Graceful shutdown: kill all CLI subprocesses on exit ────────────────────
import { conversationService } from './services/conversationService.js'

function cleanupAllSessions() {
  const active = conversationService.getActiveSessions()
  if (active.length > 0) {
    console.log(`[Server] Shutting down — killing ${active.length} CLI subprocess(es)`)
    for (const sessionId of active) {
      conversationService.stopSession(sessionId)
    }
  }
}

process.on('SIGTERM', () => {
  console.log('[Server] Received SIGTERM')
  cleanupAllSessions()
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('[Server] Received SIGINT')
  cleanupAllSessions()
  process.exit(0)
})

process.on('exit', () => {
  cleanupAllSessions()
})

// Direct execution
if (import.meta.main) {
  startServer()
}
