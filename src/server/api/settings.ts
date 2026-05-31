/**
 * Settings REST API
 *
 * GET  /api/settings            — 获取合并后的设置
 * GET  /api/settings/user       — 获取用户设置
 * GET  /api/settings/project    — 获取项目设置
 * PUT  /api/settings/user       — 更新用户设置
 * PUT  /api/settings/project    — 更新项目设置
 * GET  /api/permissions/mode    — 获取权限模式
 * PUT  /api/permissions/mode    — 设置权限模式
 */

import { SettingsService } from '../services/settingsService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { ensureDesktopCliLauncherInstalled } from '../services/desktopCliLauncherService.js'
import { conversationService } from '../services/conversationService.js'
import { spawn } from 'node:child_process'

const settingsService = new SettingsService()

export async function handleSettingsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const resource = segments[1] // 'settings' | 'permissions'
    const sub = segments[2] // 'user' | 'project' | 'mode' | undefined

    // ── /api/permissions/* ──────────────────────────────────────────────
    if (resource === 'permissions') {
      if (sub === 'mode') {
        return await handlePermissionMode(req)
      }
      throw ApiError.notFound(`Unknown permissions endpoint: ${sub}`)
    }

    // ── /api/settings/* ─────────────────────────────────────────────────
    const method = req.method

    switch (sub) {
      case undefined:
        // GET /api/settings
        if (method !== 'GET') throw methodNotAllowed(method)
        return Response.json(await settingsService.getSettings())

      case 'user':
        return await handleUserSettings(req)

      case 'project':
        return await handleProjectSettings(req, url)

      case 'plantuml':
        return await handlePlantumlRender(req)

      case 'cli-launcher':
        if (method !== 'GET') throw methodNotAllowed(method)
        return Response.json(await ensureDesktopCliLauncherInstalled())

      default:
        throw ApiError.notFound(`Unknown settings endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleUserSettings(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return Response.json(await settingsService.getUserSettings())
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    await settingsService.updateUserSettings(body)
    syncThinkingSettingToActiveSessions(body)
    return Response.json({ ok: true })
  }

  throw methodNotAllowed(req.method)
}

async function handleProjectSettings(req: Request, url: URL): Promise<Response> {
  const projectRoot = url.searchParams.get('projectRoot') || undefined

  if (req.method === 'GET') {
    return Response.json(await settingsService.getProjectSettings(projectRoot))
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    await settingsService.updateProjectSettings(body, projectRoot)
    return Response.json({ ok: true })
  }

  throw methodNotAllowed(req.method)
}

async function handlePermissionMode(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const mode = await settingsService.getPermissionMode()
    return Response.json({ mode })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const mode = body.mode
    if (typeof mode !== 'string') {
      throw ApiError.badRequest('Missing or invalid "mode" in request body')
    }
    await settingsService.setPermissionMode(mode)
    return Response.json({ ok: true, mode })
  }

  throw methodNotAllowed(req.method)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}

function syncThinkingSettingToActiveSessions(settings: Record<string, unknown>): void {
  if (
    !Object.prototype.hasOwnProperty.call(settings, 'alwaysThinkingEnabled') ||
    typeof settings.alwaysThinkingEnabled !== 'boolean'
  ) {
    return
  }

  conversationService.setMaxThinkingTokensForActiveSessions(
    settings.alwaysThinkingEnabled ? null : 0,
  )
}

// ── PlantUML Pipe Render ────────────────────────────────────────────────────
//
// 使用 -pipe 模式 (stdin → stdout)，不写临时文件
// -Djava.awt.headless=true 避免 macOS Dock 图标

function pipeRender(jarPath: string, code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('java', [
      '-Djava.awt.headless=true',
      '-jar',
      jarPath,
      '-tsvg',
      '-pipe',
    ])

    let stderr = ''
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

    child.on('error', reject)
    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(stderr || `PlantUML exited ${exitCode}`))
      }
    })

    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stdout?.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))

    child.stdin?.write(`@startuml\n${code}\n@enduml`)
    child.stdin?.end()
  })
}

async function handlePlantumlRender(req: Request): Promise<Response> {
  if (req.method !== 'POST') throw methodNotAllowed(req.method)

  const { code } = (await req.json()) as { code?: string }
  if (!code || typeof code !== 'string') {
    throw ApiError.badRequest('Missing "code" in request body')
  }

  const userSettings = await settingsService.getUserSettings()
  const jarPath = typeof userSettings.plantumlJarPath === 'string' ? userSettings.plantumlJarPath : ''

  if (!jarPath) {
    return Response.json({ svg: null })
  }

  try {
    const svg = await pipeRender(jarPath, code)
    return Response.json({ svg })
  } catch (error) {
    return Response.json({ svg: null, error: `PlantUML render failed: ${error}` })
  }
}
