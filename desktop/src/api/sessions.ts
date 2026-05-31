import { api } from './client'
import type { AgentTaskNotification } from '../types/chat'
import type { SessionListItem, MessageEntry } from '../types/session'
import type { PermissionMode } from '../types/settings'

type SessionsResponse = { sessions: SessionListItem[]; total: number }
type MessagesResponse = {
  messages: MessageEntry[]
  taskNotifications?: AgentTaskNotification[]
}
type CreateSessionResponse = { sessionId: string; workDir?: string }
export type BatchDeleteSessionsResponse = {
  ok: boolean
  successes: string[]
  failures: Array<{
    sessionId: string
    message: string
    code?: string
  }>
}
export type SessionGitWorktreeInfo = {
  enabled: boolean
  path: string | null
  plannedPath: string | null
  sourceWorkDir: string | null
  slug: string | null
  branch: string | null
}
export type SessionGitInfo = {
  branch: string | null
  repoName: string | null
  workDir: string
  changedFiles: number
  worktree: SessionGitWorktreeInfo | null
}
export type CreateSessionRepositoryOptions = {
  branch?: string | null
  worktree?: boolean
}
export type CreateSessionRequest = {
  workDir?: string
  repository?: CreateSessionRepositoryOptions
  permissionMode?: PermissionMode
}
export type BranchSessionRequest = {
  targetMessageId: string
  title?: string
}
export type BranchSessionResponse = {
  sessionId: string
  title: string
  workDir: string | null
  sourceSessionId: string
  targetMessageId: string
}
export type RepositoryBranchInfo = {
  name: string
  current: boolean
  local: boolean
  remote: boolean
  remoteRef?: string
  checkedOut: boolean
  worktreePath?: string
}
export type RepositoryWorktreeInfo = {
  path: string
  branch: string | null
  current: boolean
}
export type RepositoryContextResult = {
  state: 'ok' | 'not_git_repo' | 'missing_workdir' | 'error'
  workDir: string
  repoRoot: string | null
  repoName: string | null
  currentBranch: string | null
  defaultBranch: string | null
  dirty: boolean
  branches: RepositoryBranchInfo[]
  worktrees: RepositoryWorktreeInfo[]
  error?: string
}
export type SessionRewindResponse = {
  target: {
    targetUserMessageId: string
    userMessageIndex: number
    userMessageCount: number
  }
  conversation: {
    messagesRemoved: number
    removedMessageIds?: string[]
  }
  code: {
    available: boolean
    reason?: string
    filesChanged: string[]
    insertions: number
    deletions: number
  }
}

export type RecentProject = {
  projectPath: string
  realPath: string
  projectName: string
  isGit: boolean
  repoName: string | null
  branch: string | null
  modifiedAt: string
  sessionCount: number
}

export type SessionUsageSnapshot = {
  source?: 'current_process' | 'transcript'
  totalCostUSD: number
  costDisplay: string
  hasUnknownModelCost: boolean
  totalAPIDuration: number
  totalDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadInputTokens: number
  totalCacheCreationInputTokens: number
  totalWebSearchRequests: number
  models: Array<{
    model: string
    displayName: string
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    webSearchRequests: number
    costUSD: number
    costDisplay: string
    contextWindow: number
    maxOutputTokens: number
  }>
}

export type SessionContextSnapshot = {
  categories: Array<{
    name: string
    tokens: number
    color: string
    isDeferred?: boolean
  }>
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  gridRows: Array<Array<{
    color: string
    isFilled: boolean
    categoryName: string
    tokens: number
    percentage: number
    squareFullness: number
  }>>
  model: string
  memoryFiles: Array<{ path: string; type: string; tokens: number }>
  mcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>
  deferredBuiltinTools?: Array<{ name: string; tokens: number; isLoaded: boolean }>
  systemTools?: Array<{ name: string; tokens: number }>
  systemPromptSections?: Array<{ name: string; tokens: number }>
  agents: Array<{ agentType: string; source: string; tokens: number }>
  slashCommands?: {
    totalCommands: number
    includedCommands: number
    tokens: number
  }
  skills?: {
    totalSkills: number
    includedSkills: number
    tokens: number
    skillFrontmatter: Array<{ name: string; source: string; tokens: number }>
  }
  messageBreakdown?: {
    toolCallTokens: number
    toolResultTokens: number
    attachmentTokens: number
    assistantMessageTokens: number
    userMessageTokens: number
    toolCallsByType: Array<{ name: string; callTokens: number; resultTokens: number }>
    attachmentsByType: Array<{ name: string; tokens: number }>
  }
  apiUsage?: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null
}

export type SessionInspectionResponse = {
  active: boolean
  status: {
    sessionId: string
    workDir: string
    permissionMode: string
    version?: string
    cwd?: string
    model?: string
    apiKeySource?: string
    outputStyle?: string
    tools?: string[]
    mcpServers?: Array<{ name: string; status: string }>
    slashCommandCount?: number
    skillCount?: number
  }
  usage?: SessionUsageSnapshot
  context?: SessionContextSnapshot
  contextEstimate?: SessionContextSnapshot
  errors?: Record<string, string>
}

export type WorkspaceFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'copied'
  | 'type_changed'
  | 'unknown'

export type WorkspaceChangedFile = {
  path: string
  oldPath?: string
  status: WorkspaceFileStatus
  additions: number
  deletions: number
}

export type WorkspaceStatusResult = {
  state: 'ok' | 'not_git_repo' | 'missing_workdir' | 'error'
  workDir: string
  repoName: string | null
  branch: string | null
  isGitRepo: boolean
  changedFiles: WorkspaceChangedFile[]
  error?: string
}

export type WorkspaceReadFileResult = {
  state: 'ok' | 'binary' | 'too_large' | 'missing' | 'error'
  path: string
  previewType?: 'text' | 'image'
  content?: string
  dataUrl?: string
  mimeType?: string
  language: string
  size: number
  truncated?: boolean
  readBytes?: number
  error?: string
}

export type WorkspaceTreeEntry = {
  name: string
  path: string
  isDirectory: boolean
  isSymlink: boolean
}

export type WorkspaceTreeResult = {
  state: 'ok' | 'missing' | 'error'
  path: string
  entries: WorkspaceTreeEntry[]
  error?: string
}

export type WorkspaceDiffResult = {
  state: 'ok' | 'missing' | 'not_git_repo' | 'error'
  path: string
  diff?: string
  error?: string
}

export type SessionTurnCheckpoint = {
  target: SessionRewindResponse['target']
  conversation?: SessionRewindResponse['conversation']
  code: SessionRewindResponse['code']
  workDir?: string
}

export type SessionTurnCheckpointsResponse = {
  checkpoints: SessionTurnCheckpoint[]
}

export type TurnCheckpointDiffResult = WorkspaceDiffResult & {
  target?: SessionRewindResponse['target']
  workDir?: string
}

function buildWorkspacePath(
  sessionId: string,
  resource: 'status' | 'tree' | 'file' | 'diff',
  workspacePath?: string,
  extraParams?: Record<string, string>,
) {
  const query = new URLSearchParams()
  if (typeof workspacePath === 'string' && workspacePath.length > 0) {
    query.set('path', workspacePath)
  }
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      if (value) query.set(key, value)
    }
  }

  const qs = query.toString()
  return `/api/sessions/${sessionId}/workspace/${resource}${qs ? `?${qs}` : ''}`
}

export const sessionsApi = {
  list(params?: { project?: string; limit?: number; offset?: number }) {
    const query = new URLSearchParams()
    if (params?.project) query.set('project', params.project)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return api.get<SessionsResponse>(`/api/sessions${qs ? `?${qs}` : ''}`)
  },

  getMessages(sessionId: string) {
    return api.get<MessagesResponse>(`/api/sessions/${sessionId}/messages`)
  },

  create(input?: string | CreateSessionRequest) {
    const body = typeof input === 'string'
      ? (input ? { workDir: input } : {})
      : (input ?? {})
    return api.post<CreateSessionResponse>('/api/sessions', body)
  },

  branch(sessionId: string, body: BranchSessionRequest) {
    return api.post<BranchSessionResponse>(`/api/sessions/${sessionId}/branch`, body)
  },

  delete(sessionId: string) {
    return api.delete<{ ok: true }>(`/api/sessions/${sessionId}`)
  },

  batchDelete(sessionIds: string[]) {
    return api.post<BatchDeleteSessionsResponse>('/api/sessions/batch-delete', { sessionIds })
  },

  rename(sessionId: string, title: string) {
    return api.patch<{ ok: true }>(`/api/sessions/${sessionId}`, { title })
  },

  getRecentProjects(limit?: number) {
    const query = typeof limit === 'number' ? `?limit=${limit}` : ''
    return api.get<{ projects: RecentProject[] }>(`/api/sessions/recent-projects${query}`)
  },

  getRepositoryContext(workDir: string) {
    const query = new URLSearchParams({ workDir })
    return api.get<RepositoryContextResult>(`/api/sessions/repository-context?${query.toString()}`)
  },

  getGitInfo(sessionId: string) {
    return api.get<SessionGitInfo>(`/api/sessions/${sessionId}/git-info`)
  },

  getSlashCommands(sessionId: string) {
    return api.get<{ commands: Array<{ name: string; description: string; argumentHint?: string }> }>(`/api/sessions/${sessionId}/slash-commands`)
  },

  getInspection(sessionId: string, options?: { includeContext?: boolean; timeout?: number; contextOnly?: boolean }) {
    const query = new URLSearchParams()
    if (options?.includeContext !== undefined) {
      query.set('includeContext', options.includeContext ? '1' : '0')
    }
    if (options?.contextOnly) {
      query.set('contextOnly', '1')
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return api.get<SessionInspectionResponse>(`/api/sessions/${sessionId}/inspection${suffix}`, {
      timeout: options?.timeout ?? (options?.includeContext ? 45_000 : 25_000),
    })
  },

  getWorkspaceStatus(sessionId: string) {
    return api.get<WorkspaceStatusResult>(buildWorkspacePath(sessionId, 'status'))
  },

  getWorkspaceTree(sessionId: string, workspacePath = '', showHidden = false) {
    return api.get<WorkspaceTreeResult>(
      buildWorkspacePath(sessionId, 'tree', workspacePath, showHidden ? { showHidden: 'true' } : undefined),
    )
  },

  getWorkspaceFile(sessionId: string, workspacePath: string) {
    return api.get<WorkspaceReadFileResult>(buildWorkspacePath(sessionId, 'file', workspacePath))
  },

  getWorkspaceDiff(sessionId: string, workspacePath: string) {
    return api.get<WorkspaceDiffResult>(buildWorkspacePath(sessionId, 'diff', workspacePath))
  },

  getTurnCheckpoints(sessionId: string) {
    return api.get<SessionTurnCheckpointsResponse>(`/api/sessions/${sessionId}/turn-checkpoints`)
  },

  getTurnCheckpointDiff(
    sessionId: string,
    targetUserMessageId: string,
    workspacePath: string,
    userMessageIndex?: number,
  ) {
    const query = new URLSearchParams()
    query.set('targetUserMessageId', targetUserMessageId)
    if (Number.isInteger(userMessageIndex)) {
      query.set('userMessageIndex', String(userMessageIndex))
    }
    query.set('path', workspacePath)
    return api.get<TurnCheckpointDiffResult>(
      `/api/sessions/${sessionId}/turn-checkpoints/diff?${query.toString()}`,
    )
  },

  rewind(sessionId: string, body: {
    targetUserMessageId?: string
    userMessageIndex?: number
    expectedContent?: string
    dryRun?: boolean
  }) {
    return api.post<SessionRewindResponse>(`/api/sessions/${sessionId}/rewind`, body, {
      timeout: 60_000,
    })
  },
}
