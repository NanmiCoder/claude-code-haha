/**
 * Session REST API Routes
 *
 * 提供会话的 CRUD 操作接口，数据来自 CLI 共享的 JSONL 文件。
 *
 * Routes:
 *   GET    /api/sessions            — 列出会话
 *   GET    /api/sessions/:id        — 获取会话详情
 *   GET    /api/sessions/:id/messages — 获取会话消息
 *   GET    /api/sessions/:id/turn-checkpoints — 获取按轮次保留的 checkpoint 预览
 *   GET    /api/sessions/:id/turn-checkpoints/diff — 获取绑定到指定 checkpoint 的 diff
 *   POST   /api/sessions            — 创建新会话
 *   POST   /api/sessions/batch-delete — 批量删除会话
 *   DELETE /api/sessions/:id        — 删除会话
 *   PATCH  /api/sessions/:id        — 重命名会话
 */

import * as path from 'node:path'
import { sessionService } from '../services/sessionService.js'
import { conversationService } from '../services/conversationService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { closeSessionConnection, getSlashCommands } from '../ws/handler.js'
import { listSkillSlashCommands, type SkillSlashCommand } from './skills.js'
import { WorkspaceService } from '../services/workspaceService.js'
import {
  getRepositoryContext,
  type CreateSessionRepositoryOptions,
} from '../services/repositoryLaunchService.js'
import {
  executeSessionRewind,
  getSessionTurnCheckpointDiff,
  listSessionTurnCheckpoints,
  previewSessionRewind,
  type RewindTargetSelector,
} from '../services/sessionRewindService.js'
import { SessionStore } from '../../../adapters/common/session-store.js'
import {
  createSessionBranch,
  SessionBranchingError,
} from '../../utils/sessionBranching.js'
import { registerFilesystemAccessRoot } from '../services/filesystemAccessRoots.js'

const workspaceService = new WorkspaceService(
  async (sessionId) => (
    conversationService.getSessionWorkDir(sessionId) ||
    await sessionService.getSessionWorkDir(sessionId)
  ),
  async (sessionId) => sessionService.getSessionMessages(sessionId),
  async (sessionId) => sessionService.getSessionFileHistorySnapshots(sessionId),
)

export async function handleSessionsApi(
  req: Request,
  url: URL,
  segments: string[]
): Promise<Response> {
  try {
    // segments: ['api', 'sessions', ...rest]
    const sessionId = segments[2] // may be undefined
    const subResource = segments[3] // e.g. 'messages'

    // -----------------------------------------------------------------------
    // Collection routes: /api/sessions
    // -----------------------------------------------------------------------
    if (!sessionId) {
      switch (req.method) {
        case 'GET':
          return await listSessions(url)
        case 'POST':
          return await createSession(req)
        default:
          return Response.json(
            { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
            { status: 405 }
          )
      }
    }

    // Special collection route: /api/sessions/batch-delete
    if (sessionId === 'batch-delete') {
      if (req.method !== 'POST') {
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
          { status: 405 }
        )
      }
      return await batchDeleteSessions(req)
    }

    // Special collection route: /api/sessions/recent-projects
    if (sessionId === 'recent-projects' && req.method === 'GET') {
      return await getRecentProjects(url)
    }

    // Special collection route: /api/sessions/repository-context
    if (sessionId === 'repository-context' && req.method === 'GET') {
      return await getSessionRepositoryContext(url)
    }

    // -----------------------------------------------------------------------
    // Sub-resource routes: /api/sessions/:id/messages
    // -----------------------------------------------------------------------
    if (subResource === 'messages') {
      if (req.method !== 'GET') {
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
          { status: 405 }
        )
      }
      return await getSessionMessages(sessionId)
    }

    if (subResource === 'git-info') {
      if (req.method !== 'GET') {
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
          { status: 405 }
        )
      }
      return await getGitInfo(sessionId)
    }

    if (subResource === 'rewind') {
      if (req.method !== 'POST') {
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
          { status: 405 }
        )
      }
      return await rewindSession(req, sessionId)
    }

    if (subResource === 'branch') {
      if (req.method !== 'POST') {
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
          { status: 405 }
        )
      }
      return await branchSession(req, sessionId)
    }

    if (subResource === 'turn-checkpoints') {
      if (req.method !== 'GET') {
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
          { status: 405 }
        )
      }
      return segments[4] === 'diff'
        ? await getTurnCheckpointDiff(sessionId, url)
        : await getTurnCheckpoints(sessionId)
    }

    if (subResource === 'slash-commands') {
      if (req.method !== 'GET') {
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
          { status: 405 }
        )
      }
      return await getSessionSlashCommands(sessionId)
    }

    if (subResource === 'inspection') {
      if (req.method !== 'GET') {
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
          { status: 405 }
        )
      }
      return await getSessionInspection(sessionId, url)
    }

    if (subResource === 'workspace') {
      if (req.method !== 'GET') {
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
          { status: 405 }
        )
      }
      return await handleSessionWorkspaceRoute(sessionId, url, segments[4])
    }

    // Route to conversations handler if sub-resource is 'chat'
    if (subResource === 'chat') {
      // This is handled by the conversations API, but in case the router
      // forwards it here, we delegate to the conversations module.
      // Normally the router should route /api/sessions/:id/chat/* to conversations.
      return Response.json(
        { error: 'NOT_FOUND', message: 'Use /api/sessions/:id/chat via conversations API' },
        { status: 404 }
      )
    }

    // -----------------------------------------------------------------------
    // Item routes: /api/sessions/:id
    // -----------------------------------------------------------------------
    switch (req.method) {
      case 'GET':
        return await getSession(sessionId)
      case 'DELETE':
        return await deleteSession(sessionId)
      case 'PATCH':
        return await patchSession(req, sessionId)
      default:
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} not allowed` },
          { status: 405 }
        )
    }
  } catch (error) {
    return errorResponse(error)
  }
}

// ============================================================================
// Handler implementations
// ============================================================================

async function listSessions(url: URL): Promise<Response> {
  const project = url.searchParams.get('project') || undefined
  const limit = parseInt(url.searchParams.get('limit') || '20', 10)
  const offset = parseInt(url.searchParams.get('offset') || '0', 10)

  if (isNaN(limit) || limit < 0) {
    throw ApiError.badRequest('Invalid limit parameter')
  }
  if (isNaN(offset) || offset < 0) {
    throw ApiError.badRequest('Invalid offset parameter')
  }

  const result = await sessionService.listSessions({ project, limit, offset })
  return Response.json(result)
}

async function getSession(sessionId: string): Promise<Response> {
  const detail = await sessionService.getSession(sessionId)
  if (!detail) {
    throw ApiError.notFound(`Session not found: ${sessionId}`)
  }
  return Response.json(detail)
}

async function getSessionMessages(sessionId: string): Promise<Response> {
  const [messages, taskNotifications] = await Promise.all([
    sessionService.getSessionMessages(sessionId),
    sessionService.getSessionTaskNotifications(sessionId),
  ])
  return Response.json({ messages, taskNotifications })
}

async function handleSessionWorkspaceRoute(
  sessionId: string,
  url: URL,
  workspaceResource?: string,
): Promise<Response> {
  await requireSessionWorkspace(sessionId)

  switch (workspaceResource) {
    case 'status':
      return Response.json(await workspaceService.getStatus(sessionId))
    case 'tree':
      return await runWorkspaceRequest(() => workspaceService.readTree(
        sessionId,
        url.searchParams.get('path') || '',
        url.searchParams.get('showHidden') === 'true',
      ))
    case 'file':
      return await runWorkspaceRequest(() => workspaceService.readFile(
        sessionId,
        requireWorkspacePath(url, 'file'),
      ))
    case 'diff':
      return await runWorkspaceDiffRequest(() => workspaceService.getDiff(
        sessionId,
        requireWorkspacePath(url, 'diff'),
      ))
    default:
      throw ApiError.notFound(`Unknown workspace resource: ${workspaceResource || 'workspace'}`)
  }
}

async function createSession(req: Request): Promise<Response> {
  let body: { workDir?: string; repository?: CreateSessionRepositoryOptions; permissionMode?: string }
  try {
    body = (await req.json()) as { workDir?: string; repository?: CreateSessionRepositoryOptions; permissionMode?: string }
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }

  if (body.workDir && typeof body.workDir !== 'string') {
    throw ApiError.badRequest('workDir must be a string')
  }

  if (body.permissionMode !== undefined && typeof body.permissionMode !== 'string') {
    throw ApiError.badRequest('permissionMode must be a string')
  }

  if (body.repository !== undefined) {
    if (!body.repository || typeof body.repository !== 'object' || Array.isArray(body.repository)) {
      throw ApiError.badRequest('repository must be an object')
    }
    if (body.repository.branch !== undefined && body.repository.branch !== null && typeof body.repository.branch !== 'string') {
      throw ApiError.badRequest('repository.branch must be a string')
    }
    if (body.repository.worktree !== undefined && typeof body.repository.worktree !== 'boolean') {
      throw ApiError.badRequest('repository.worktree must be a boolean')
    }
  }

  const result = await sessionService.createSession(body.workDir, body.repository, body.permissionMode)
  recentProjectsCache = null
  return Response.json(result, { status: 201 })
}

async function getSessionRepositoryContext(url: URL): Promise<Response> {
  const workDir = url.searchParams.get('workDir')
  if (!workDir) {
    throw ApiError.badRequest('workDir query parameter is required')
  }

  const context = await getRepositoryContext(workDir)
  registerFilesystemAccessRoot(workDir)
  registerFilesystemAccessRoot(context.workDir)
  registerFilesystemAccessRoot(context.repoRoot)
  return Response.json(context)
}

async function requireSessionWorkspace(sessionId: string): Promise<string> {
  const workDir =
    conversationService.getSessionWorkDir(sessionId) ||
    await sessionService.getSessionWorkDir(sessionId)

  if (!workDir) {
    throw ApiError.notFound(`Session not found: ${sessionId}`)
  }

  return workDir
}

function requireWorkspacePath(url: URL, route: 'file' | 'diff'): string {
  const filePath = url.searchParams.get('path')
  if (!filePath) {
    throw ApiError.badRequest(`path query parameter is required for workspace ${route}`)
  }
  return filePath
}

async function runWorkspaceRequest<T>(operation: () => Promise<T>): Promise<Response> {
  try {
    return Response.json(await operation())
  } catch (error) {
    if (isOutsideWorkspaceError(error)) {
      throw new ApiError(403, error.message, 'FORBIDDEN')
    }
    if (isSessionNotFoundError(error)) {
      throw ApiError.notFound(error.message)
    }
    throw error
  }
}

async function runWorkspaceDiffRequest<T extends { state?: string; error?: string }>(
  operation: () => Promise<T>,
): Promise<Response> {
  const result = await runWorkspaceRequest(operation)
  const body = await result.clone().json() as T

  if (body.state === 'error' && typeof body.error === 'string' && body.error.includes('outside workspace')) {
    throw new ApiError(403, body.error, 'FORBIDDEN')
  }

  return result
}

function isOutsideWorkspaceError(error: unknown): error is Error {
  return error instanceof Error && error.message.includes('outside workspace')
}

function isSessionNotFoundError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('Session not found:')
}

async function deleteSession(sessionId: string): Promise<Response> {
  conversationService.markSessionDeleted(sessionId)
  try {
    await sessionService.deleteSession(sessionId)
  } catch (error) {
    conversationService.unmarkSessionDeleted(sessionId)
    throw error
  }
  closeSessionConnection(sessionId, 'session deleted')
  cleanupAdapterSessionMappings(sessionId)
  return Response.json({ ok: true })
}

async function batchDeleteSessions(req: Request): Promise<Response> {
  let body: { sessionIds?: unknown }
  try {
    body = (await req.json()) as { sessionIds?: unknown }
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }

  const sessionIds = normalizeSessionIds(body.sessionIds)
  conversationService.markSessionsDeleted(sessionIds)
  const result = await sessionService.deleteSessions(sessionIds)

  if (result.failures.length > 0) {
    conversationService.unmarkSessionsDeleted(result.failures.map((failure) => failure.sessionId))
  }

  for (const sessionId of result.successes) {
    closeSessionConnection(sessionId, 'session deleted')
    cleanupAdapterSessionMappings(sessionId)
  }

  return Response.json({
    ok: result.failures.length === 0,
    successes: result.successes,
    failures: result.failures,
  })
}

function normalizeSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw ApiError.badRequest('sessionIds must be an array')
  }

  const sessionIds: string[] = []
  for (const sessionId of value) {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw ApiError.badRequest('sessionIds must contain only non-empty strings')
    }
    sessionIds.push(sessionId.trim())
  }

  if (sessionIds.length === 0) {
    throw ApiError.badRequest('sessionIds must include at least one session id')
  }

  return [...new Set(sessionIds)]
}

function cleanupAdapterSessionMappings(sessionId: string): void {
  const removedChatIds = new SessionStore().deleteBySessionId(sessionId)
  if (removedChatIds.length > 0) {
    console.log(`[Sessions API] Removed ${removedChatIds.length} adapter session mapping(s) for ${sessionId}`)
  }
}

function mergeSessionSlashCommands(
  preferred: Array<{ name: string; description?: string; argumentHint?: string }>,
  fallback: SkillSlashCommand[],
): Array<{ name: string; description: string; argumentHint?: string }> {
  const merged = new Map<string, { name: string; description: string; argumentHint?: string }>()

  for (const command of preferred) {
    if (!command.name) continue
    merged.set(command.name, {
      name: command.name,
      description: command.description || '',
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    })
  }

  for (const command of fallback) {
    if (!command.name || merged.has(command.name)) continue
    merged.set(command.name, {
      name: command.name,
      description: command.description || '',
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    })
  }

  return [...merged.values()]
}

async function getSessionSlashCommands(sessionId: string): Promise<Response> {
  const cachedCommands = getSlashCommands(sessionId)
  const workDir = await sessionService.getSessionWorkDir(sessionId)
  if (!workDir) {
    throw ApiError.notFound(`Session not found: ${sessionId}`)
  }

  const skillCommands = await listSkillSlashCommands(workDir)
  const slashCommands = cachedCommands.length > 0
    ? mergeSessionSlashCommands(cachedCommands, skillCommands)
    : skillCommands

  return Response.json({ commands: slashCommands })
}

async function getSessionInspection(sessionId: string, url: URL): Promise<Response> {
  const includeContext = url.searchParams.get('includeContext') !== '0'
  const contextOnly = includeContext && url.searchParams.get('contextOnly') === '1'
  const workDir =
    conversationService.getSessionWorkDir(sessionId) ||
    await sessionService.getSessionWorkDir(sessionId)

  if (!workDir) {
    throw ApiError.notFound(`Session not found: ${sessionId}`)
  }

  const active = conversationService.hasSession(sessionId)
  const launchInfo = await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
  const permissionMode = active
    ? conversationService.getSessionPermissionMode(sessionId)
    : launchInfo?.permissionMode ?? 'default'
  const initMessage = conversationService.getSessionInitMessage(sessionId) ??
    [...conversationService.getRecentSdkMessages(sessionId)]
    .reverse()
    .find((message) => message?.type === 'system' && message.subtype === 'init')
  const transcriptMetadata = await sessionService.getTranscriptMetadata(sessionId)
  const cachedSlashCommands = getSlashCommands(sessionId)
  const skillSlashCommands = await listSkillSlashCommands(workDir)
  const fallbackSlashCommands = cachedSlashCommands.length > 0
    ? mergeSessionSlashCommands(cachedSlashCommands, skillSlashCommands)
    : skillSlashCommands
  const slashCommandCount = Array.isArray(initMessage?.slash_commands)
    ? initMessage.slash_commands.length
    : fallbackSlashCommands.length

  const response: Record<string, unknown> = {
    active,
    status: {
      sessionId,
      workDir,
      permissionMode,
      version: typeof initMessage?.claude_code_version === 'string' ? initMessage.claude_code_version : transcriptMetadata?.version,
      cwd: typeof initMessage?.cwd === 'string' ? initMessage.cwd : transcriptMetadata?.cwd ?? workDir,
      model: typeof initMessage?.model === 'string' ? initMessage.model : transcriptMetadata?.model,
      apiKeySource: typeof initMessage?.apiKeySource === 'string' ? initMessage.apiKeySource : undefined,
      outputStyle: typeof initMessage?.output_style === 'string' ? initMessage.output_style : undefined,
      tools: Array.isArray(initMessage?.tools) ? initMessage.tools : [],
      mcpServers: Array.isArray(initMessage?.mcp_servers) ? initMessage.mcp_servers : [],
      slashCommandCount,
      skillCount: Array.isArray(initMessage?.skills) ? initMessage.skills.length : 0,
    },
    errors: {},
  }
  const transcriptUsage = await sessionService.getTranscriptUsage(sessionId)
  const transcriptContextEstimate = await sessionService.getTranscriptContextEstimate(sessionId)
  if (transcriptContextEstimate) {
    response.contextEstimate = transcriptContextEstimate
  }

  if (!active) {
    if (transcriptUsage) {
      response.usage = transcriptUsage
    }
    response.errors = {
      ...(transcriptUsage ? {} : { usage: 'CLI session is not running' }),
      ...(includeContext ? { context: 'CLI session is not running' } : {}),
    }
    return Response.json(response)
  }

  const errors: Record<string, string> = {}
  if (contextOnly) {
    try {
      response.context = await conversationService.requestControl(
        sessionId,
        { subtype: 'get_context_usage', estimateOnly: true },
        20_000,
      )
    } catch (error) {
      errors.context = error instanceof Error ? error.message : String(error)
    }
  } else {
    const basicControlTimeoutMs = includeContext ? 10_000 : 4_000
    const [usageResult, contextResult, mcpResult] = await Promise.allSettled([
      conversationService.requestControl(sessionId, { subtype: 'get_session_usage' }, basicControlTimeoutMs),
      includeContext
        ? conversationService.requestControl(
            sessionId,
            { subtype: 'get_context_usage', estimateOnly: true },
            20_000,
          )
        : Promise.resolve(null),
      conversationService.requestControl(sessionId, { subtype: 'mcp_status' }, basicControlTimeoutMs),
    ])

    if (usageResult.status === 'fulfilled') {
      response.usage = chooseRicherUsage(
        { ...usageResult.value, source: 'current_process' },
        transcriptUsage,
      )
    } else {
      if (transcriptUsage) {
        response.usage = transcriptUsage
      } else {
        errors.usage = usageResult.reason instanceof Error ? usageResult.reason.message : String(usageResult.reason)
      }
    }

    if (!includeContext) {
      // Context can be expensive on large live sessions. The desktop UI loads it
      // separately when the context tab is actually selected.
    } else if (contextResult.status === 'fulfilled' && contextResult.value) {
      response.context = contextResult.value
    } else {
      errors.context = contextResult.reason instanceof Error ? contextResult.reason.message : String(contextResult.reason)
    }

    if (mcpResult.status === 'fulfilled' && response.status && typeof response.status === 'object') {
      response.status = {
        ...response.status,
        mcpServers: Array.isArray(mcpResult.value.mcpServers) ? mcpResult.value.mcpServers : (response.status as Record<string, unknown>).mcpServers,
      }
    }
  }

  response.errors = errors
  return Response.json(response)
}

function usageTokenTotal(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0
  const record = usage as Record<string, unknown>
  return [
    record.totalInputTokens,
    record.totalOutputTokens,
    record.totalCacheReadInputTokens,
    record.totalCacheCreationInputTokens,
  ].reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
}

function chooseRicherUsage(
  currentUsage: Record<string, unknown>,
  transcriptUsage: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!transcriptUsage) return currentUsage
  return usageTokenTotal(transcriptUsage) > usageTokenTotal(currentUsage)
    ? transcriptUsage
    : currentUsage
}

function sameResolvedPath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  return path.resolve(left) === path.resolve(right)
}

async function getGitInfo(sessionId: string): Promise<Response> {
  const workDir = conversationService.getSessionWorkDir(sessionId) || await sessionService.getSessionWorkDir(sessionId)
  if (!workDir) {
    throw ApiError.notFound(`Session not found: ${sessionId}`)
  }
  registerFilesystemAccessRoot(workDir)
  const launchInfo = await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
  const repository = launchInfo?.repository
  const worktreeSession = launchInfo?.worktreeSession
  // The visible business branch comes from Desktop's launch choice when present.
  // CLI originalBranch is the source checkout before creating the worktree, which
  // can differ from the selected base ref.
  const sessionBranch = repository?.branch || worktreeSession?.originalBranch || null
  const worktree = repository?.worktree || worktreeSession
    ? {
        enabled: true,
        path: worktreeSession?.worktreePath || workDir,
        plannedPath: worktreeSession?.worktreePath || repository?.worktreePath || null,
        sourceWorkDir: worktreeSession?.originalCwd || repository?.requestedWorkDir || repository?.repoRoot || null,
        slug: worktreeSession?.worktreeName || repository?.worktreeSlug || null,
        branch: worktreeSession?.worktreeBranch || repository?.worktreeBranch || null,
      }
    : null

  try {
    // Get branch name
    const branchProc = Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const branchText = await new Response(branchProc.stdout).text()
    const gitBranch = branchText.trim() || null
    const materializedWorktree = !!worktree && (
      sameResolvedPath(workDir, worktree.path) ||
      sameResolvedPath(workDir, worktree.plannedPath)
    )
    const branch = sessionBranch || (
      materializedWorktree
        ? (worktree.branch || gitBranch)
        : gitBranch
    )

    // Get repo name from remote or directory
    let repoName = ''
    try {
      const remoteProc = Bun.spawn(['git', 'remote', 'get-url', 'origin'], {
        cwd: workDir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const remoteText = await new Response(remoteProc.stdout).text()
      const remote = remoteText.trim()
      // Extract repo name from URL: git@github.com:user/repo.git or https://...repo.git
      const match = remote.match(/\/([^/]+?)(?:\.git)?$/) || remote.match(/:([^/]+\/[^/]+?)(?:\.git)?$/)
      repoName = match ? match[1]! : ''
    } catch {
      // No remote, use directory name
      const parts = workDir.split('/')
      repoName = parts[parts.length - 1] || ''
    }

    // Get short status
    const statusProc = Bun.spawn(['git', 'status', '--porcelain'], {
      cwd: workDir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const statusText = await new Response(statusProc.stdout).text()
    const changedFiles = statusText.trim().split('\n').filter(Boolean).length

    return Response.json({
      branch,
      repoName,
      workDir,
      changedFiles,
      worktree,
    })
  } catch {
    // Not a git repo or git not available
    return Response.json({
      branch: sessionBranch,
      repoName: null,
      workDir,
      changedFiles: 0,
      worktree,
    })
  }
}

async function rewindSession(req: Request, sessionId: string): Promise<Response> {
  let body: RewindTargetSelector & { dryRun?: boolean }
  try {
    body = (await req.json()) as RewindTargetSelector & { dryRun?: boolean }
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }

  if (
    (typeof body.targetUserMessageId !== 'string' || body.targetUserMessageId.length === 0) &&
    !Number.isInteger(body.userMessageIndex)
  ) {
    throw ApiError.badRequest('targetUserMessageId (string) or userMessageIndex (integer) is required')
  }

  const result = body.dryRun
    ? await previewSessionRewind(sessionId, body)
    : await executeSessionRewind(sessionId, body)

  return Response.json(result)
}

async function branchSession(req: Request, sessionId: string): Promise<Response> {
  let body: { targetMessageId?: unknown; title?: unknown }
  try {
    body = (await req.json()) as { targetMessageId?: unknown; title?: unknown }
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }

  if (typeof body.targetMessageId !== 'string' || body.targetMessageId.trim().length === 0) {
    throw ApiError.badRequest('targetMessageId (string) is required in request body')
  }

  if (body.title !== undefined && typeof body.title !== 'string') {
    throw ApiError.badRequest('title must be a string')
  }

  const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
  if (!launchInfo) {
    throw ApiError.notFound(`Session not found: ${sessionId}`)
  }

  try {
    const result = await createSessionBranch({
      sourceSessionId: sessionId,
      sourceTranscriptPath: launchInfo.filePath,
      targetMessageId: body.targetMessageId.trim(),
      title: body.title?.trim() || undefined,
      sourceWorkDir: launchInfo.workDir,
      sourceRepository: launchInfo.repository,
      sourceWorktreeSession: launchInfo.worktreeSession,
    })

    return Response.json({
      sessionId: result.sessionId,
      title: result.title,
      workDir: result.workDir ?? launchInfo.workDir,
      sourceSessionId: sessionId,
      targetMessageId: body.targetMessageId.trim(),
    }, { status: 201 })
  } catch (error) {
    if (error instanceof SessionBranchingError) {
      if (error.code === 'SOURCE_NOT_FOUND') {
        throw ApiError.notFound(error.message)
      }
      throw ApiError.badRequest(error.message)
    }
    throw error
  }
}

async function getTurnCheckpoints(sessionId: string): Promise<Response> {
  const checkpoints = await listSessionTurnCheckpoints(sessionId)
  return Response.json({ checkpoints })
}

async function getTurnCheckpointDiff(sessionId: string, url: URL): Promise<Response> {
  const targetUserMessageId = url.searchParams.get('targetUserMessageId') || undefined
  const userMessageIndexParam = url.searchParams.get('userMessageIndex')
  const path = url.searchParams.get('path')
  const userMessageIndex =
    userMessageIndexParam === null ? undefined : Number.parseInt(userMessageIndexParam, 10)

  if (
    (typeof targetUserMessageId !== 'string' || targetUserMessageId.length === 0) &&
    !Number.isInteger(userMessageIndex)
  ) {
    throw ApiError.badRequest('targetUserMessageId (string) or userMessageIndex (integer) is required')
  }

  if (!path) {
    throw ApiError.badRequest('path query parameter is required for turn checkpoint diff')
  }

  const result = await getSessionTurnCheckpointDiff(
    sessionId,
    {
      targetUserMessageId,
      userMessageIndex,
    },
    path,
  )

  return Response.json(result)
}

async function patchSession(req: Request, sessionId: string): Promise<Response> {
  let body: { title?: string }
  try {
    body = (await req.json()) as { title?: string }
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }

  if (!body.title || typeof body.title !== 'string') {
    throw ApiError.badRequest('title (string) is required in request body')
  }

  await sessionService.renameSession(sessionId, body.title)
  return Response.json({ ok: true })
}

type RecentProjectEntry = {
  projectPath: string
  realPath: string
  projectName: string
  isGit: boolean
  repoName: string | null
  branch: string | null
  modifiedAt: string
  sessionCount: number
}

// In-memory cache for recent projects (TTL: 30s)
let recentProjectsCache: { projects: RecentProjectEntry[]; timestamp: number } | null = null
const RECENT_PROJECTS_CACHE_TTL = 30_000
const DESKTOP_WORKTREE_MARKER = '/.claude/worktrees/'

function projectNameForRecentPath(realPath: string, fallback: string): string {
  const normalizedRealPath = realPath.replace(/\\/g, '/')
  const displayRoot = normalizedRealPath.includes(DESKTOP_WORKTREE_MARKER)
    ? normalizedRealPath.slice(0, normalizedRealPath.indexOf(DESKTOP_WORKTREE_MARKER))
    : normalizedRealPath
  return displayRoot.split('/').filter(Boolean).pop() || fallback
}

function isDesktopWorktreeBranchName(branch: string | null): boolean {
  return !!branch && branch.startsWith('worktree-desktop-')
}

async function getRecentProjects(url: URL): Promise<Response> {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 1), 500)
  const sessionScanLimit = Math.min(Math.max(limit * 8, 50), 200)

  // Return cached response if fresh
  if (recentProjectsCache && Date.now() - recentProjectsCache.timestamp < RECENT_PROJECTS_CACHE_TTL) {
    return Response.json({ projects: recentProjectsCache.projects.slice(0, limit) })
  }

  const { sessions } = await sessionService.listSessions({ limit: sessionScanLimit })
  const validSessions = sessions.filter((session) => session.workDirExists && session.workDir)

  // First pass: group by logical project root so worktrees stay under the same project.
  const realPathMap = new Map<string, { projectPath: string; modifiedAt: string; sessionCount: number; sessionId: string }>()
  for (const s of validSessions) {
    let realPath: string
    try {
      const workDir = await sessionService.getSessionWorkDir(s.id)
      realPath = s.projectRoot || workDir || sessionService.desanitizePath(s.projectPath)
    } catch {
      realPath = s.projectRoot || sessionService.desanitizePath(s.projectPath)
    }

    const existing = realPathMap.get(realPath)
    if (!existing || s.modifiedAt > existing.modifiedAt) {
      realPathMap.set(realPath, {
        projectPath: realPath,
        modifiedAt: s.modifiedAt,
        sessionCount: (existing?.sessionCount ?? 0) + 1,
        sessionId: s.id,
      })
    } else {
      existing.sessionCount++
    }
  }

  // Build project list with git info — parallelize git operations
  const entries = Array.from(realPathMap.entries())
  const projects = await Promise.all(
    entries.map(async ([realPath, info]) => {
      const projectName = projectNameForRecentPath(realPath, info.projectPath)

      let isGit = false
      let repoName: string | null = null
      let branch: string | null = null
      try {
        const proc = Bun.spawn(['git', 'rev-parse', '--is-inside-work-tree'], {
          cwd: realPath, stdout: 'pipe', stderr: 'pipe',
        })
        const out = await new Response(proc.stdout).text()
        isGit = out.trim() === 'true'

        if (isGit) {
          // Run branch + remote in parallel
          const [branchResult, remoteResult] = await Promise.all([
            (async () => {
              const branchProc = Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
                cwd: realPath, stdout: 'pipe', stderr: 'pipe',
              })
              return (await new Response(branchProc.stdout).text()).trim() || null
            })(),
            (async () => {
              try {
                const remoteProc = Bun.spawn(['git', 'remote', 'get-url', 'origin'], {
                  cwd: realPath, stdout: 'pipe', stderr: 'pipe',
                })
                const remote = (await new Response(remoteProc.stdout).text()).trim()
                const match = remote.match(/:([^/]+\/[^/]+?)(?:\.git)?$/) || remote.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/)
                return match ? match[1]! : null
              } catch { return null }
            })(),
          ])
          branch = isDesktopWorktreeBranchName(branchResult) ? null : branchResult
          repoName = remoteResult
        }
      } catch { /* not a git repo or dir doesn't exist */ }

      return {
        projectPath: info.projectPath, realPath, projectName, isGit, repoName, branch,
        modifiedAt: info.modifiedAt, sessionCount: info.sessionCount,
      }
    })
  )

  // Sort by most recent
  projects.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))

  recentProjectsCache = { projects, timestamp: Date.now() }
  return Response.json({ projects: projects.slice(0, limit) })
}
