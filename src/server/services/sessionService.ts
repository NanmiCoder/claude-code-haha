/**
 * Session Service — 会话文件的读写操作封装
 *
 * 读写 CLI 持久化在 ~/.claude/projects/{sanitized_path}/{sessionId}.jsonl 的会话数据，
 * 确保 Desktop App 与 CLI 的数据完全互通。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { ApiError } from '../middleware/errorHandler.js'
import { sanitizePath as sanitizePortablePath } from '../../utils/sessionStoragePortable.js'
import type { FileHistorySnapshot } from '../../utils/fileHistory.js'
import { calculateModelCost, MODEL_COSTS } from '../../utils/modelCost.js'
import {
  MODEL_CONTEXT_WINDOW_DEFAULT,
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from '../../utils/context.js'
import { getCanonicalName } from '../../utils/model/model.js'

// ============================================================================
// Types
// ============================================================================

export type SessionListItem = {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
  workDir: string | null
  workDirExists: boolean
}

export type SessionDetail = SessionListItem & {
  messages: MessageEntry[]
}

export type SessionLaunchInfo = {
  filePath: string
  projectDir: string
  workDir: string
  transcriptMessageCount: number
  customTitle: string | null
}

export type TrimSessionResult = {
  removedCount: number
  removedMessageIds: string[]
}

export type MessageEntry = {
  id: string
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: unknown
  timestamp: string
  model?: string
  parentUuid?: string
  parentToolUseId?: string
  isSidechain?: boolean
}

export type TranscriptUsageSnapshot = {
  source: 'transcript'
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

export type TranscriptMetadataSnapshot = {
  model?: string
  cwd?: string
  version?: string
}

export type TranscriptContextEstimate = {
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
  agents: Array<{ agentType: string; source: string; tokens: number }>
  apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
}

/** Raw entry parsed from a single JSONL line */
type RawEntry = {
  type?: string
  uuid?: string
  messageId?: string
  parentUuid?: string | null
  parent_tool_use_id?: string | null
  isSidechain?: boolean
  isMeta?: boolean
  cwd?: string
  message?: {
    role?: string
    content?: unknown
    model?: string
    id?: string
    type?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      server_tool_use?: {
        web_search_requests?: number
      }
      speed?: string
    }
  }
  timestamp?: string
  version?: string
  snapshot?: {
    messageId?: string
    trackedFileBackups?: Record<string, unknown>
    timestamp?: string
  }
  customTitle?: string
  title?: string
  [key: string]: unknown
}

type ContentBlock = Record<string, unknown>

const USER_INTERRUPTION_TEXTS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
])

const NO_RESPONSE_REQUESTED_TEXT = 'No response requested.'

// ============================================================================
// Service
// ============================================================================

export class SessionService {
  // --------------------------------------------------------------------------
  // Config helpers
  // --------------------------------------------------------------------------

  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  private getProjectsDir(): string {
    return path.join(this.getConfigDir(), 'projects')
  }

  /**
   * Sanitize a path the same way the shared session storage does.
   * This must remain Windows-safe, so reserved characters such as ':' are normalized too.
   */
  private sanitizePath(dirPath: string): string {
    return sanitizePortablePath(dirPath)
  }

  // --------------------------------------------------------------------------
  // JSONL parsing
  // --------------------------------------------------------------------------

  private async readJsonlFile(filePath: string): Promise<RawEntry[]> {
    let content: string
    try {
      content = await fs.readFile(filePath, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }

    const entries: RawEntry[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed) as RawEntry)
      } catch {
        // skip malformed lines
      }
    }
    return entries
  }

  private async appendJsonlEntry(filePath: string, entry: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(entry) + '\n'
    await fs.appendFile(filePath, line, 'utf-8')
  }

  private resolveWorkDirFromEntries(
    entries: RawEntry[],
    fallbackProjectDir?: string,
  ): string | null {
    for (const entry of entries) {
      if (entry.type === 'session-meta' && typeof (entry as Record<string, unknown>).workDir === 'string') {
        return (entry as Record<string, unknown>).workDir as string
      }
    }

    for (let i = entries.length - 1; i >= 0; i--) {
      const cwd = entries[i]?.cwd
      if (typeof cwd === 'string' && cwd.trim()) {
        return cwd
      }
    }

    return fallbackProjectDir ? this.desanitizePath(fallbackProjectDir) : null
  }

  // --------------------------------------------------------------------------
  // Entry → MessageEntry conversion
  // --------------------------------------------------------------------------

  private entryToMessage(
    entry: RawEntry,
    parentToolUseId?: string,
  ): MessageEntry | null {
    const msg = entry.message
    if (!msg || !msg.role) return null

    // Determine our normalized type
    let type: MessageEntry['type']
    const role = msg.role

    if (role === 'user') {
      // Check if the content is a tool_result array
      if (Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some(
          (block: Record<string, unknown>) => block.type === 'tool_result'
        )
        if (hasToolResult) {
          type = 'tool_result'
        } else {
          type = 'user'
        }
      } else {
        type = 'user'
      }
    } else if (role === 'assistant') {
      // Check if the content contains tool_use blocks
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some(
          (block: Record<string, unknown>) => block.type === 'tool_use'
        )
        type = hasToolUse ? 'tool_use' : 'assistant'
      } else {
        type = 'assistant'
      }
    } else {
      type = 'system'
    }

    return {
      id: entry.uuid || crypto.randomUUID(),
      type,
      content: msg.content,
      timestamp: entry.timestamp || new Date().toISOString(),
      model: msg.model,
      parentUuid: entry.parentUuid ?? undefined,
      parentToolUseId,
      isSidechain: entry.isSidechain,
    }
  }

  private extractTextBlocks(content: unknown): string[] {
    if (typeof content === 'string') return [content]
    if (!Array.isArray(content)) return []

    return content
      .flatMap((block) => {
        if (!block || typeof block !== 'object') return []
        const record = block as Record<string, unknown>
        return record.type === 'text' && typeof record.text === 'string'
          ? [record.text]
          : []
      })
      .map((text) => text.trim())
      .filter(Boolean)
  }

  private isInternalCommandBreadcrumb(content: unknown): boolean {
    if (typeof content !== 'string') return false

    return (
      content.includes('<command-name>') ||
      content.includes('<command-message>') ||
      content.includes('<command-args>') ||
      content.includes('<local-command-caveat>')
    )
  }

  private isSyntheticUserInterruption(content: unknown): boolean {
    const textBlocks = this.extractTextBlocks(content)
    return (
      textBlocks.length > 0 &&
      textBlocks.every((text) => USER_INTERRUPTION_TEXTS.has(text))
    )
  }

  private isSyntheticNoResponseAssistant(content: unknown): boolean {
    const textBlocks = this.extractTextBlocks(content)
    return (
      textBlocks.length > 0 &&
      textBlocks.every((text) => text === NO_RESPONSE_REQUESTED_TEXT)
    )
  }

  private shouldHideTranscriptEntry(entry: RawEntry): boolean {
    const role = entry.message?.role
    const content = entry.message?.content

    if (role === 'user') {
      return (
        this.isInternalCommandBreadcrumb(content) ||
        this.isSyntheticUserInterruption(content)
      )
    }

    if (role === 'assistant') {
      return this.isSyntheticNoResponseAssistant(content)
    }

    return false
  }

  private extractAgentToolUseId(entry: RawEntry): string | undefined {
    const content = entry.message?.content
    if (!Array.isArray(content)) return undefined

    for (const block of content as Array<Record<string, unknown>>) {
      if (
        block.type === 'tool_use' &&
        block.name === 'Agent' &&
        typeof block.id === 'string'
      ) {
        return block.id
      }
    }

    return undefined
  }

  private extractAgentToolUseIdsFromMessage(message: MessageEntry): string[] {
    if (message.type !== 'tool_use' || !Array.isArray(message.content)) {
      return []
    }

    return (message.content as ContentBlock[])
      .filter((block) => block.type === 'tool_use' && block.name === 'Agent')
      .flatMap((block) => (typeof block.id === 'string' ? [block.id] : []))
  }

  private extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''

    return (content as ContentBlock[])
      .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
      .join('\n')
  }

  private extractAgentIdFromResultText(text: string): string | undefined {
    const match = text.match(/(?:^|\n)\s*agentId:\s*([A-Za-z0-9_-]+)/)
    return match?.[1]
  }

  private extractAgentResultLinks(messages: MessageEntry[]): Map<string, string> {
    const agentToolUseIds = new Set(
      messages.flatMap((message) => this.extractAgentToolUseIdsFromMessage(message)),
    )
    const resultLinks = new Map<string, string>()

    for (const message of messages) {
      if (message.type !== 'tool_result' || !Array.isArray(message.content)) {
        continue
      }

      for (const block of message.content as ContentBlock[]) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
          continue
        }
        if (!agentToolUseIds.has(block.tool_use_id)) {
          continue
        }

        const agentId = this.extractAgentIdFromResultText(
          this.extractTextFromContent(block.content),
        )
        if (agentId) {
          resultLinks.set(block.tool_use_id, agentId)
        }
      }
    }

    return resultLinks
  }

  private namespaceSubagentContentIds(content: unknown, namespace: string): unknown {
    if (!Array.isArray(content)) return content

    return (content as ContentBlock[]).map((block) => {
      if (!block || typeof block !== 'object') return block
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        return { ...block, id: `${namespace}/${block.id}` }
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        return { ...block, tool_use_id: `${namespace}/${block.tool_use_id}` }
      }
      return block
    })
  }

  private subagentTranscriptPath(
    projectDir: string,
    sessionId: string,
    agentId: string,
  ): string {
    const normalizedAgentId = agentId.startsWith('agent-') ? agentId : `agent-${agentId}`
    return path.join(
      this.getProjectsDir(),
      projectDir,
      sessionId,
      'subagents',
      `${normalizedAgentId}.jsonl`,
    )
  }

  private async loadSubagentToolMessages(
    projectDir: string,
    sessionId: string,
    parentToolUseId: string,
    agentId: string,
  ): Promise<MessageEntry[]> {
    const filePath = this.subagentTranscriptPath(projectDir, sessionId, agentId)
    const entries = await this.readJsonlFile(filePath)
    const namespace = `${parentToolUseId}/${agentId}`
    const messages: MessageEntry[] = []

    for (const entry of entries) {
      if (!entry.message?.role || entry.isMeta) continue
      if (this.shouldHideTranscriptEntry(entry)) continue
      if (entry.type !== 'user' && entry.type !== 'assistant' && entry.type !== 'system') {
        continue
      }

      const message = this.entryToMessage(
        {
          ...entry,
          message: {
            ...entry.message,
            content: this.namespaceSubagentContentIds(entry.message.content, namespace),
          },
        },
        parentToolUseId,
      )
      if (message && (message.type === 'tool_use' || message.type === 'tool_result')) {
        messages.push(message)
      }
    }

    return messages
  }

  private async appendSubagentToolMessages(
    projectDir: string,
    sessionId: string,
    messages: MessageEntry[],
  ): Promise<MessageEntry[]> {
    const resultLinks = this.extractAgentResultLinks(messages)
    if (resultLinks.size === 0) {
      return messages
    }

    const childMessages = await Promise.all(
      [...resultLinks.entries()].map(([parentToolUseId, agentId]) =>
        this.loadSubagentToolMessages(projectDir, sessionId, parentToolUseId, agentId),
      ),
    )
    return [...messages, ...childMessages.flat()]
  }

  private resolveParentToolUseId(
    entry: RawEntry,
    entriesByUuid: Map<string, RawEntry>,
    cache: Map<string, string | undefined>,
  ): string | undefined {
    if (
      typeof entry.parent_tool_use_id === 'string' &&
      entry.parent_tool_use_id.length > 0
    ) {
      return entry.parent_tool_use_id
    }

    if (entry.isSidechain !== true) {
      return undefined
    }

    const cacheKey = entry.uuid
    if (cacheKey && cache.has(cacheKey)) {
      return cache.get(cacheKey)
    }

    let resolved: string | undefined
    let currentParentUuid =
      typeof entry.parentUuid === 'string' ? entry.parentUuid : undefined
    const visited = new Set<string>()

    while (currentParentUuid && !visited.has(currentParentUuid)) {
      visited.add(currentParentUuid)
      const parentEntry = entriesByUuid.get(currentParentUuid)
      if (!parentEntry) break

      const directAgentToolUseId = this.extractAgentToolUseId(parentEntry)
      if (directAgentToolUseId) {
        resolved = directAgentToolUseId
        break
      }

      if (parentEntry.uuid && cache.has(parentEntry.uuid)) {
        resolved = cache.get(parentEntry.uuid)
        break
      }

      currentParentUuid =
        typeof parentEntry.parentUuid === 'string'
          ? parentEntry.parentUuid
          : undefined
    }

    if (cacheKey) {
      cache.set(cacheKey, resolved)
    }

    return resolved
  }

  // --------------------------------------------------------------------------
  // Title extraction
  // --------------------------------------------------------------------------

  private extractTitle(entries: RawEntry[]): string {
    // 1. Look for custom title entry (appended by renameSession) — highest priority
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!
      if (e.type === 'custom-title' && e.customTitle) {
        return e.customTitle
      }
    }

    // 2. Look for AI-generated title (written by titleService)
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!
      if (e.type === 'ai-title' && e.aiTitle) {
        return e.aiTitle as string
      }
    }

    // 3. Look for first non-meta user message as title
    for (const e of entries) {
      if (e.type === 'user' && !e.isMeta && e.message?.role === 'user') {
        const content = e.message.content
        let text: string | undefined
        if (typeof content === 'string') {
          text = content
        } else if (Array.isArray(content)) {
          const textBlock = content.find(
            (block: Record<string, unknown>) => block.type === 'text' && typeof block.text === 'string'
          )
          if (textBlock) text = textBlock.text as string
        }
        if (text) {
          return text.length > 80 ? text.slice(0, 80) + '...' : text
        }
      }
    }

    return 'Untitled Session'
  }

  // --------------------------------------------------------------------------
  // Session file discovery
  // --------------------------------------------------------------------------

  /**
   * Find all .jsonl session files across all project directories.
   * Returns an array of { filePath, projectDir, sessionId }.
   */
  private async discoverSessionFiles(projectFilter?: string): Promise<
    Array<{ filePath: string; projectDir: string; sessionId: string }>
  > {
    const projectsDir = this.getProjectsDir()
    let projectDirs: string[]

    try {
      projectDirs = await fs.readdir(projectsDir)
    } catch {
      return []
    }

    // Optionally filter to a specific project
    if (projectFilter) {
      const sanitized = this.sanitizePath(projectFilter)
      projectDirs = projectDirs.filter((d) => d === sanitized)
    }

    const results: Array<{ filePath: string; projectDir: string; sessionId: string }> = []

    for (const dir of projectDirs) {
      const dirPath = path.join(projectsDir, dir)

      // Ensure it's a directory
      try {
        const stat = await fs.stat(dirPath)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }

      let files: string[]
      try {
        files = await fs.readdir(dirPath)
      } catch {
        continue
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = file.replace('.jsonl', '')
        results.push({
          filePath: path.join(dirPath, file),
          projectDir: dir,
          sessionId,
        })
      }
    }

    return results
  }

  /**
   * Convert a sanitized directory name back to the original absolute path.
   * Reverses sanitizePath(): `-Users-nanmi-workspace` → `/Users/nanmi/workspace`.
   */
  desanitizePath(sanitized: string): string {
    // The sanitized form replaces all '/' (and '\') with '-'.
    // On POSIX the original path starts with '/', so the sanitized form starts with '-'.
    // We restore by replacing every '-' with '/' (the platform separator).
    // On Windows the leading character would be a drive letter, but we handle POSIX here.
    return sanitized.replace(/-/g, path.sep)
  }

  /**
   * Find the .jsonl file for a given session ID.
   * Searches across all project directories since sessions may belong to any project.
   */
  async findSessionFile(
    sessionId: string
  ): Promise<{ filePath: string; projectDir: string } | null> {
    // Validate sessionId format to prevent path traversal
    if (!this.isValidSessionId(sessionId)) {
      return null
    }

    const projectsDir = this.getProjectsDir()
    let projectDirs: string[]

    try {
      projectDirs = await fs.readdir(projectsDir)
    } catch {
      return null
    }

    for (const dir of projectDirs) {
      const filePath = path.join(projectsDir, dir, `${sessionId}.jsonl`)
      try {
        await fs.access(filePath)
        return { filePath, projectDir: dir }
      } catch {
        continue
      }
    }

    return null
  }

  private isValidSessionId(id: string): boolean {
    // UUID v4 format
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  }

  private formatCost(cost: number): string {
    return `$${cost > 0.5 ? (Math.round(cost * 100) / 100).toFixed(2) : cost.toFixed(4)}`
  }

  private getTranscriptContextWindow(model: string): number {
    try {
      return getContextWindowForModel(model)
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('Config accessed before allowed')
      ) {
        return MODEL_CONTEXT_WINDOW_DEFAULT
      }
      throw err
    }
  }

  async getTranscriptMetadata(sessionId: string): Promise<TranscriptMetadataSnapshot | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.readJsonlFile(found.filePath)
    const metadata: TranscriptMetadataSnapshot = {}

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!
      if (!metadata.model && typeof entry.message?.model === 'string') {
        metadata.model = entry.message.model
      }
      if (!metadata.cwd && typeof entry.cwd === 'string') {
        metadata.cwd = entry.cwd
      }
      if (!metadata.version && typeof entry.version === 'string') {
        metadata.version = entry.version
      }
      if (metadata.model && metadata.cwd && metadata.version) break
    }

    return metadata
  }

  async getTranscriptContextEstimate(sessionId: string): Promise<TranscriptContextEstimate | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.readJsonlFile(found.filePath)
    let latest: {
      model: string
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
    } | null = null

    for (const entry of entries) {
      const usage = entry.message?.usage
      const model = entry.message?.model
      if (!usage || typeof model !== 'string') continue

      const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
      const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
      const cacheReadInputTokens = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
      const cacheCreationInputTokens = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0
      const promptTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens
      if (promptTokens === 0 && outputTokens === 0) continue

      latest = {
        model,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
      }
    }

    if (!latest) return null

    const rawMaxTokens = this.getTranscriptContextWindow(latest.model)
    const totalTokens = latest.inputTokens + latest.cacheReadInputTokens + latest.cacheCreationInputTokens
    const percentage = rawMaxTokens > 0 ? Math.round((totalTokens / rawMaxTokens) * 100) : 0
    const categories: TranscriptContextEstimate['categories'] = [
      { name: 'Input tokens', tokens: latest.inputTokens, color: '#8f3217' },
      { name: 'Cache read', tokens: latest.cacheReadInputTokens, color: '#0f5c8f' },
      { name: 'Cache write', tokens: latest.cacheCreationInputTokens, color: '#7c3aed' },
      { name: 'Free space', tokens: Math.max(0, rawMaxTokens - totalTokens), color: '#a1a1aa', isDeferred: true },
    ].filter((category) => category.tokens > 0)

    const filledSquares = Math.max(0, Math.min(100, Math.round((totalTokens / Math.max(1, rawMaxTokens)) * 100)))
    const gridRows = Array.from({ length: 10 }, (_, row) =>
      Array.from({ length: 10 }, (_, col) => {
        const index = row * 10 + col
        const isFilled = index < filledSquares
        return {
          color: isFilled ? '#8f3217' : '#a1a1aa',
          isFilled,
          categoryName: isFilled ? 'Input context' : 'Free space',
          tokens: Math.round(rawMaxTokens / 100),
          percentage: 1,
          squareFullness: isFilled ? 1 : 0,
        }
      }),
    )

    return {
      categories,
      totalTokens,
      maxTokens: rawMaxTokens,
      rawMaxTokens,
      percentage,
      gridRows,
      model: latest.model,
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      apiUsage: {
        input_tokens: latest.inputTokens,
        output_tokens: latest.outputTokens,
        cache_creation_input_tokens: latest.cacheCreationInputTokens,
        cache_read_input_tokens: latest.cacheReadInputTokens,
      },
    }
  }

  async getTranscriptUsage(sessionId: string): Promise<TranscriptUsageSnapshot | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.readJsonlFile(found.filePath)
    const models = new Map<string, TranscriptUsageSnapshot['models'][number]>()
    let totalCostUSD = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadInputTokens = 0
    let totalCacheCreationInputTokens = 0
    let totalWebSearchRequests = 0
    let hasUnknownModelCost = false
    let firstUsageAt: number | null = null
    let lastUsageAt: number | null = null

    for (const entry of entries) {
      const usage = entry.message?.usage
      const model = entry.message?.model
      if (!usage || typeof model !== 'string') continue

      const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
      const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
      const cacheReadInputTokens = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
      const cacheCreationInputTokens = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0
      const webSearchRequests = typeof usage.server_tool_use?.web_search_requests === 'number'
        ? usage.server_tool_use.web_search_requests
        : 0

      if (
        inputTokens === 0 &&
        outputTokens === 0 &&
        cacheReadInputTokens === 0 &&
        cacheCreationInputTokens === 0 &&
        webSearchRequests === 0
      ) {
        continue
      }

      const canonical = getCanonicalName(model)
      if (!Object.prototype.hasOwnProperty.call(MODEL_COSTS, canonical)) {
        hasUnknownModelCost = true
      }

      const costUsage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
        cache_creation_input_tokens: cacheCreationInputTokens,
        server_tool_use: { web_search_requests: webSearchRequests },
        speed: usage.speed,
      } as Parameters<typeof calculateModelCost>[1]
      const costUSD = calculateModelCost(model, costUsage)

      let modelUsage = models.get(model)
      if (!modelUsage) {
        modelUsage = {
          model,
          displayName: canonical,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
          costDisplay: '$0.0000',
          contextWindow: this.getTranscriptContextWindow(model),
          maxOutputTokens: getModelMaxOutputTokens(model).default,
        }
        models.set(model, modelUsage)
      }

      modelUsage.inputTokens += inputTokens
      modelUsage.outputTokens += outputTokens
      modelUsage.cacheReadInputTokens += cacheReadInputTokens
      modelUsage.cacheCreationInputTokens += cacheCreationInputTokens
      modelUsage.webSearchRequests += webSearchRequests
      modelUsage.costUSD += costUSD
      modelUsage.costDisplay = this.formatCost(modelUsage.costUSD)

      totalCostUSD += costUSD
      totalInputTokens += inputTokens
      totalOutputTokens += outputTokens
      totalCacheReadInputTokens += cacheReadInputTokens
      totalCacheCreationInputTokens += cacheCreationInputTokens
      totalWebSearchRequests += webSearchRequests

      if (entry.timestamp) {
        const time = Date.parse(entry.timestamp)
        if (!Number.isNaN(time)) {
          firstUsageAt = firstUsageAt === null ? time : Math.min(firstUsageAt, time)
          lastUsageAt = lastUsageAt === null ? time : Math.max(lastUsageAt, time)
        }
      }
    }

    if (models.size === 0) return null

    return {
      source: 'transcript',
      totalCostUSD,
      costDisplay: this.formatCost(totalCostUSD),
      hasUnknownModelCost,
      totalAPIDuration: 0,
      totalDuration:
        firstUsageAt !== null && lastUsageAt !== null
          ? Math.max(0, Math.round((lastUsageAt - firstUsageAt) / 1000))
          : 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadInputTokens,
      totalCacheCreationInputTokens,
      totalWebSearchRequests,
      models: Array.from(models.values()),
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * List all sessions, optionally filtered by project path.
   */
  async listSessions(options?: {
    project?: string
    limit?: number
    offset?: number
  }): Promise<{ sessions: SessionListItem[]; total: number }> {
    const sessionFiles = await this.discoverSessionFiles(options?.project)

    // Build session list items with metadata from file stats & first entries
    const items: SessionListItem[] = []

    for (const { filePath, projectDir, sessionId } of sessionFiles) {
      try {
        const stat = await fs.stat(filePath)
        const entries = await this.readJsonlFile(filePath)
        const workDir = this.resolveWorkDirFromEntries(entries, projectDir)
        const workDirExists = await this.pathExists(workDir)

        // Count transcript messages only (user + assistant)
        const messageCount = entries.filter(
          (e) => (e.type === 'user' || e.type === 'assistant') && e.message?.role
        ).length

        const title = this.extractTitle(entries)

        // Find the earliest timestamp from entries, fallback to file birthtime
        let createdAt = stat.birthtime.toISOString()
        for (const e of entries) {
          if (e.timestamp) {
            createdAt = e.timestamp
            break
          }
        }

        items.push({
          id: sessionId,
          title,
          createdAt,
          modifiedAt: stat.mtime.toISOString(),
          messageCount,
          projectPath: projectDir,
          workDir,
          workDirExists,
        })
      } catch {
        // Skip unreadable files
      }
    }

    // Sort by modifiedAt descending (most recent first)
    items.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())

    const total = items.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 50
    const paginated = items.slice(offset, offset + limit)

    return { sessions: paginated, total }
  }

  /**
   * Get full session detail including all messages.
   */
  async getSession(sessionId: string): Promise<SessionDetail | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const { filePath, projectDir } = found
    const stat = await fs.stat(filePath)
    const entries = await this.readJsonlFile(filePath)

    const messages = await this.appendSubagentToolMessages(
      projectDir,
      sessionId,
      this.entriesToMessages(entries),
    )
    const title = this.extractTitle(entries)
    const workDir = this.resolveWorkDirFromEntries(entries, projectDir)
    const workDirExists = await this.pathExists(workDir)

    let createdAt = stat.birthtime.toISOString()
    for (const e of entries) {
      if (e.timestamp) {
        createdAt = e.timestamp
        break
      }
    }

    return {
      id: sessionId,
      title,
      createdAt,
      modifiedAt: stat.mtime.toISOString(),
      messageCount: messages.length,
      projectPath: projectDir,
      workDir,
      workDirExists,
      messages,
    }
  }

  /**
   * Get only the messages for a session (lighter than full detail).
   */
  async getSessionMessages(sessionId: string): Promise<MessageEntry[]> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readJsonlFile(found.filePath)
    return await this.appendSubagentToolMessages(
      found.projectDir,
      sessionId,
      this.entriesToMessages(entries),
    )
  }

  /**
   * Create a new session file for the given working directory.
   */
  async createSession(workDir?: string): Promise<{ sessionId: string }> {
    // Default to user home directory when no workDir specified
    const resolvedWorkDir = workDir || os.homedir()

    // Resolve to absolute path. NOTE: path.resolve() uses process.cwd() to
    // expand relative paths — in bundled sidecar mode the server's cwd is
    // typically '/'. Callers (IM adapters) already send absolute realPath,
    // but we log here so cwd regressions are caught early.
    const absWorkDir = path.resolve(resolvedWorkDir)
    console.log(
      `[SessionService] createSession: requested workDir=${JSON.stringify(
        workDir,
      )}, resolved=${absWorkDir} (process.cwd()=${process.cwd()})`,
    )
    let stat
    try {
      stat = await fs.stat(absWorkDir)
    } catch {
      throw ApiError.badRequest(`Working directory does not exist: ${absWorkDir}`)
    }
    if (!stat.isDirectory()) {
      throw ApiError.badRequest(`Working directory is not a directory: ${absWorkDir}`)
    }

    const sessionId = crypto.randomUUID()
    const sanitized = this.sanitizePath(absWorkDir)
    const dirPath = path.join(this.getProjectsDir(), sanitized)

    // Ensure the project directory exists
    await fs.mkdir(dirPath, { recursive: true })

    const filePath = path.join(dirPath, `${sessionId}.jsonl`)
    const now = new Date().toISOString()

    // Write an initial file-history-snapshot entry (matches CLI behavior)
    const initialEntry = {
      type: 'file-history-snapshot',
      messageId: crypto.randomUUID(),
      snapshot: {
        messageId: crypto.randomUUID(),
        trackedFileBackups: {},
        timestamp: now,
      },
      isSnapshotUpdate: false,
    }

    // Store actual workDir for later retrieval
    const metaEntry = {
      type: 'session-meta',
      isMeta: true,
      workDir: absWorkDir,
      timestamp: now,
    }

    await fs.writeFile(filePath, JSON.stringify(initialEntry) + '\n' + JSON.stringify(metaEntry) + '\n', 'utf-8')

    return { sessionId }
  }

  /**
   * Delete a session's JSONL file.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    await fs.unlink(found.filePath)
  }

  /**
   * Rename a session by appending a custom-title entry to its JSONL file.
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    if (!title || typeof title !== 'string') {
      throw ApiError.badRequest('title is required')
    }

    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entry = {
      type: 'custom-title',
      customTitle: title,
      timestamp: new Date().toISOString(),
    }

    await this.appendJsonlEntry(found.filePath, entry)
  }

  /**
   * Append an AI-generated title entry to a session's JSONL file.
   */
  async appendAiTitle(sessionId: string, title: string): Promise<void> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return

    await this.appendJsonlEntry(found.filePath, {
      type: 'ai-title',
      aiTitle: title,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Get the actual working directory for a session.
   * First checks for stored session-meta entry, then falls back to desanitizePath.
   */
  async getSessionWorkDir(sessionId: string): Promise<string | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.readJsonlFile(found.filePath)
    return this.resolveWorkDirFromEntries(entries, found.projectDir)
  }

  /**
   * Inspect how a session should be launched.
   * Placeholder desktop-created sessions have zero transcript messages.
   */
  async getSessionLaunchInfo(sessionId: string): Promise<SessionLaunchInfo | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.readJsonlFile(found.filePath)
    const workDir = this.resolveWorkDirFromEntries(entries, found.projectDir) || process.cwd()
    let customTitle: string | null = null
    let transcriptMessageCount = 0

    for (const entry of entries) {
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
        customTitle = entry.customTitle
      }
      if (
        !entry.isMeta &&
        entry.message?.role &&
        (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system')
      ) {
        transcriptMessageCount++
      }
    }

    return {
      filePath: found.filePath,
      projectDir: found.projectDir,
      workDir,
      transcriptMessageCount,
      customTitle,
    }
  }

  async deleteSessionFile(sessionId: string): Promise<void> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return
    await fs.unlink(found.filePath)
  }

  async clearSessionTranscript(sessionId: string, fallbackWorkDir?: string): Promise<void> {
    let found = await this.findSessionFile(sessionId)
    if (!found && fallbackWorkDir) {
      const absWorkDir = path.resolve(fallbackWorkDir)
      const dirPath = path.join(this.getProjectsDir(), this.sanitizePath(absWorkDir))
      await fs.mkdir(dirPath, { recursive: true })
      found = {
        filePath: path.join(dirPath, `${sessionId}.jsonl`),
        projectDir: this.sanitizePath(absWorkDir),
      }
    }
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readJsonlFile(found.filePath)
    const workDir = this.resolveWorkDirFromEntries(entries, found.projectDir) || fallbackWorkDir || process.cwd()
    const now = new Date().toISOString()

    const initialEntry = {
      type: 'file-history-snapshot',
      messageId: crypto.randomUUID(),
      snapshot: {
        messageId: crypto.randomUUID(),
        trackedFileBackups: {},
        timestamp: now,
      },
      isSnapshotUpdate: false,
    }

    const metaEntry = {
      type: 'session-meta',
      isMeta: true,
      workDir,
      timestamp: now,
    }

    await fs.writeFile(
      found.filePath,
      `${JSON.stringify(initialEntry)}\n${JSON.stringify(metaEntry)}\n`,
      'utf-8',
    )
  }

  async appendSessionMetadata(
    sessionId: string,
    metadata: { workDir: string; customTitle?: string | null }
  ): Promise<void> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return

    await this.appendJsonlEntry(found.filePath, {
      type: 'session-meta',
      isMeta: true,
      workDir: metadata.workDir,
      timestamp: new Date().toISOString(),
    })

    if (metadata.customTitle) {
      await this.appendJsonlEntry(found.filePath, {
        type: 'custom-title',
        customTitle: metadata.customTitle,
        timestamp: new Date().toISOString(),
      })
    }
  }

  async trimSessionMessagesFrom(
    sessionId: string,
    startMessageId: string,
  ): Promise<TrimSessionResult> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readJsonlFile(found.filePath)
    const activeMessages = this.entriesToMessages(entries)
    const startIndex = activeMessages.findIndex((message) => message.id === startMessageId)

    if (startIndex < 0) {
      throw ApiError.badRequest(`Message not found in active session chain: ${startMessageId}`)
    }

    const removedMessageIds = activeMessages
      .slice(startIndex)
      .map((message) => message.id)

    if (removedMessageIds.length === 0) {
      return { removedCount: 0, removedMessageIds: [] }
    }

    const removedIds = new Set(removedMessageIds)
    const filteredEntries = entries.filter(
      (entry) => !(typeof entry.uuid === 'string' && removedIds.has(entry.uuid)),
    )

    const content =
      filteredEntries.length > 0
        ? filteredEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
        : ''
    await fs.writeFile(found.filePath, content, 'utf-8')

    return {
      removedCount: removedMessageIds.length,
      removedMessageIds,
    }
  }

  async getSessionFileHistorySnapshots(
    sessionId: string,
  ): Promise<FileHistorySnapshot[]> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readJsonlFile(found.filePath)
    const snapshotsByMessageId = new Map<string, FileHistorySnapshot>()

    for (const entry of entries) {
      if (entry.type !== 'file-history-snapshot' || !entry.snapshot) continue

      const snapshotMessageId =
        typeof entry.snapshot.messageId === 'string'
          ? entry.snapshot.messageId
          : typeof entry.messageId === 'string'
            ? entry.messageId
            : null

      if (!snapshotMessageId) continue

      snapshotsByMessageId.set(snapshotMessageId, {
        messageId: snapshotMessageId as FileHistorySnapshot['messageId'],
        trackedFileBackups:
          entry.snapshot.trackedFileBackups &&
          typeof entry.snapshot.trackedFileBackups === 'object'
            ? (entry.snapshot.trackedFileBackups as FileHistorySnapshot['trackedFileBackups'])
            : {},
        timestamp: new Date(
          entry.snapshot.timestamp || entry.timestamp || new Date().toISOString(),
        ),
      })
    }

    return [...snapshotsByMessageId.values()]
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private entriesToMessages(entries: RawEntry[]): MessageEntry[] {
    const messages: MessageEntry[] = []
    const entriesByUuid = new Map<string, RawEntry>()
    const parentToolUseIdCache = new Map<string, string | undefined>()

    for (const entry of entries) {
      if (typeof entry.uuid === 'string' && entry.uuid.length > 0) {
        entriesByUuid.set(entry.uuid, entry)
      }
    }

    for (const entry of entries) {
      // Only process transcript entries (user / assistant / system with messages)
      if (!entry.message?.role) continue

      // Skip meta entries (CLI internal bookkeeping)
      if (entry.isMeta) continue

      if (this.shouldHideTranscriptEntry(entry)) continue

      // Skip non-transcript entry types
      const entryType = entry.type
      if (
        entryType !== 'user' &&
        entryType !== 'assistant' &&
        entryType !== 'system'
      ) {
        continue
      }

      const parentToolUseId = this.resolveParentToolUseId(
        entry,
        entriesByUuid,
        parentToolUseIdCache,
      )
      const msg = this.entryToMessage(entry, parentToolUseId)
      if (msg) {
        messages.push(msg)
      }
    }
    return messages
  }

  private async pathExists(targetPath: string | null): Promise<boolean> {
    if (!targetPath) return false

    try {
      const stat = await fs.stat(targetPath)
      return stat.isDirectory()
    } catch {
      return false
    }
  }
}

// Singleton instance for shared use across API handlers
export const sessionService = new SessionService()
