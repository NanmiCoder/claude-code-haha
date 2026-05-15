/**
 * Claude Code Desktop App — HTTP + WebSocket Server
 *
 * 为桌面端 UI 提供 REST API 和 WebSocket 实时通信。
 * 读写与 CLI 完全相同的文件系统，确保 CLI/UI 数据互通。
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { configureWorkspaceRoot } from './services/workspaceRootInstance.js'
import { handleApiRequest } from './router.js'
import { handleWebSocket, type WebSocketData } from './ws/handler.js'
import { resolveCors, type CorsResolution } from './middleware/cors.js'
import { requireAuth, requireH5Token } from './middleware/auth.js'
import { teamWatcher } from './services/teamWatcher.js'
import { cronScheduler } from './services/cronScheduler.js'
import { handleProxyRequest } from './proxy/handler.js'
import { ProviderService } from './services/providerService.js'
import { handleHahaOAuthCallback } from './api/haha-oauth.js'
import { handleHahaOpenAIOAuthCallback } from './api/haha-openai-oauth.js'
import { ensureDesktopCliLauncherInstalled } from './services/desktopCliLauncherService.js'
import { enableConfigs } from '../utils/config.js'
import { diagnosticsService } from './services/diagnosticsService.js'
import { ensurePersistentStorageUpgraded } from './services/persistentStorageMigrations.js'
import { handleStaticH5Request } from './staticH5.js'
import { classifyH5Request, shouldBlockDisabledH5Access, shouldRequireH5Token } from './h5AccessPolicy.js'
import { H5AccessService } from './services/h5AccessService.js'

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

function withCors(response: Response, cors: CorsResolution): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(cors.headers)) {
    headers.set(key, value)
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  })
}

function corsRejectedResponse(cors: CorsResolution): Response {
  return Response.json(
    { error: 'CORS origin not allowed' },
    { status: 403, headers: cors.headers },
  )
}

function h5AccessControlRejectedResponse(): Response {
  return Response.json(
    {
      error: 'Forbidden',
      message: 'H5 access settings can only be changed from the local desktop app.',
    },
    { status: 403 },
  )
}

function h5AccessDisabledResponse(): Response {
  return Response.json(
    {
      error: 'Forbidden',
      message: 'H5 access is disabled. Enable H5 access from the local desktop app first.',
    },
    { status: 403 },
  )
}

function isH5AccessControlRequest(
  req: Request,
  url: URL,
  context: { clientAddress: string | null },
): boolean {
  if (!url.pathname.startsWith('/api/h5-access')) {
    return false
  }

  if (url.pathname === '/api/h5-access/verify') {
    return false
  }

  return classifyH5Request(req, url, context) !== 'local-trusted'
}

function originFromUrl(value: string | null): string | null {
  if (!value) {
    return null
  }

  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export function startServer(port = PORT, host = HOST) {
  enableConfigs()
  const workspacesDir =
    process.env.CC_HAHA_WORKSPACES_ROOT ||
    path.resolve(process.cwd(), 'workspaces')
  const workspaceRoot = configureWorkspaceRoot(workspacesDir)
  fs.mkdirSync(workspaceRoot.getRoot(), { recursive: true })
  console.log(`[Server] Workspace root: ${workspaceRoot.getRoot()}`)
  diagnosticsService.installConsoleCapture()
  diagnosticsService.installProcessCapture()
  ProviderService.setServerPort(port)
  const localConnectHost =
    host === '0.0.0.0' || host === '127.0.0.1' || host === 'localhost'
      ? '127.0.0.1'
      : host

  /**
   * Explicit deployment auth remains a stronger override than H5-scoped
   * request gating.
   */
  const forceAuth =
    SERVER_OPTIONS.authRequired ||
    process.env.SERVER_AUTH_REQUIRED === '1'
  const h5AccessService = new H5AccessService()

  const server = Bun.serve<WebSocketData>({
    port,
    hostname: host,
    idleTimeout: 60,

    async fetch(req, server) {
      await ensurePersistentStorageUpgraded()
      const url = new URL(req.url)
      const origin = req.headers.get('Origin')
      const clientAddress = server.requestIP(req)?.address ?? null
      const h5RequestContext = { clientAddress }
      const h5Settings = await h5AccessService.getSettings()
      const h5PublicOrigin = originFromUrl(h5Settings.publicBaseUrl)
      const cors = await resolveCors(origin, url.origin, {
        h5Enabled: h5Settings.enabled,
        isOriginAllowed: async (candidateOrigin) =>
          candidateOrigin === h5PublicOrigin ||
          await h5AccessService.isOriginAllowed(candidateOrigin),
      })
      const authRequired = shouldRequireH5Token({
        request: req,
        url,
        h5Enabled: h5Settings.enabled,
        context: h5RequestContext,
      })
      const h5AccessDisabledBlocked = shouldBlockDisabledH5Access({
        request: req,
        url,
        h5Enabled: h5Settings.enabled,
        explicitAuthRequired: forceAuth,
        context: h5RequestContext,
      })
      const h5AccessControlBlocked = isH5AccessControlRequest(req, url, h5RequestContext)

      if (h5AccessControlBlocked) {
        return h5AccessControlRejectedResponse()
      }

      if (h5AccessDisabledBlocked) {
        return h5AccessDisabledResponse()
      }

      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        if (cors.rejected) {
          return corsRejectedResponse(cors)
        }
        return new Response(null, { status: 204, headers: cors.headers })
      }

      // WebSocket upgrade
      if (url.pathname.startsWith('/ws/')) {
        if (cors.rejected) {
          return corsRejectedResponse(cors)
        }

        // Enforce authentication when required
        if (authRequired) {
          const authError = await requireH5Token(req, url.searchParams.get('token'))
          if (authError) {
            return withCors(authError, cors)
          }
        } else if (forceAuth) {
          const authError = await requireAuth(req, url.searchParams.get('token'))
          if (authError) {
            return withCors(authError, cors)
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
        if (classifyH5Request(req, url, h5RequestContext) !== 'internal-sdk') {
          return h5AccessControlRejectedResponse()
        }

        if (cors.rejected) {
          return corsRejectedResponse(cors)
        }

        if (forceAuth) {
          const authError = await requireAuth(req, url.searchParams.get('token'))
          if (authError) {
            return withCors(authError, cors)
          }
        }

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
        if (cors.rejected) {
          return corsRejectedResponse(cors)
        }

        // Enforce authentication when required
        if (authRequired) {
          const authError = await requireH5Token(req)
          if (authError) {
            return withCors(authError, cors)
          }
        } else if (forceAuth) {
          const authError = await requireAuth(req)
          if (authError) {
            return withCors(authError, cors)
          }
        }

        try {
          const response = await handleApiRequest(req, url)
          return withCors(response, cors)
        } catch (error) {
          void diagnosticsService.recordEvent({
            type: 'api_request_failed',
            severity: 'error',
            summary: error instanceof Error ? error.message : String(error),
            details: { path: url.pathname, method: req.method, error },
          })
          console.error('[Server] API error:', error)
          return withCors(Response.json(
            { error: 'Internal server error' },
            { status: 500 },
          ), cors)
        }
      }

      // Proxy — protocol-translating reverse proxy for OpenAI-compatible APIs
      if (url.pathname.startsWith('/proxy/')) {
        if (cors.rejected) {
          return corsRejectedResponse(cors)
        }

        if (authRequired) {
          const authError = await requireH5Token(req)
          if (authError) {
            return withCors(authError, cors)
          }
        } else if (forceAuth) {
          const authError = await requireAuth(req)
          if (authError) {
            return withCors(authError, cors)
          }
        }
        try {
          const response = await handleProxyRequest(req, url)
          return withCors(response, cors)
        } catch (error) {
          void diagnosticsService.recordEvent({
            type: 'proxy_request_failed',
            severity: 'error',
            summary: error instanceof Error ? error.message : String(error),
            details: { path: url.pathname, method: req.method, error },
          })
          console.error('[Server] Proxy error:', error)
          return withCors(Response.json(
            { type: 'error', error: { type: 'api_error', message: 'Internal proxy error' } },
            { status: 500 },
          ), cors)
        }
      }

      // Health check
      if (url.pathname === '/health') {
        if (cors.rejected) {
          return corsRejectedResponse(cors)
        }

        return Response.json(
          { status: 'ok', timestamp: new Date().toISOString() },
          { headers: cors.headers },
        )
      }

      // Static H5 shell/assets are non-secret bootstrap content and must load
      // before the browser can read the QR token; API/proxy/ws stay protected above.
      const staticResponse = await handleStaticH5Request(req, url)
      if (staticResponse) {
        return staticResponse
      }

      return new Response('Not Found', { status: 404 })
    },

    websocket: handleWebSocket,
  })

  // Start watching ~/.claude/teams/ for real-time WebSocket push
  teamWatcher.start()

  // Start the cron scheduler to execute scheduled tasks
  cronScheduler.start()

  void ensureDesktopCliLauncherInstalled().catch((error) => {
    console.error(
      '[desktop-cli-launcher] failed to install bundled launcher:',
      error instanceof Error ? error.message : error,
    )
  })

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
