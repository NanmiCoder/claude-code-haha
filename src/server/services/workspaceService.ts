import * as fs from 'node:fs/promises'
import chokidar from 'chokidar'
import { execFile as execFileCallback } from 'node:child_process'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { diffLines } from 'diff'
import type { MessageEntry } from './sessionService.js'
import type { FileHistorySnapshot } from '../../utils/fileHistory.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  isSameOrInsidePathForPlatform,
  normalizeDriveRootPathForPlatform,
} from './windowsDrivePath.js'

const MAX_PREVIEW_BYTES = 1024 * 1024
const MAX_UNTRACKED_STAT_BYTES = 256 * 1024
const GIT_TIMEOUT_MS = 5_000
const MAX_GIT_BUFFER_BYTES = 2_000_000
const VCS_METADATA_DIRECTORY_NAMES = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])
const execFile = promisify(execFileCallback)

function isVcsMetadataDirectoryName(name: string): boolean {
  return VCS_METADATA_DIRECTORY_NAMES.has(name.toLowerCase())
}

const LANGUAGE_MAP: Record<string, string> = {
  cjs: 'javascript',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'tsx',
  txt: 'text',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  apng: 'image/apng',
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
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

type StatusEntry = {
  path: string
  oldPath?: string
  code: string
  status: WorkspaceFileStatus
}

type ScopedStatusEntry = {
  repoPath: string
  repoOldPath?: string
  path: string
  oldPath?: string
  status: WorkspaceFileStatus
  absolutePath: string
  canonicalWorkspaceRoot: string
}

type GitRepoInfo =
  | {
      kind: 'not_git_repo'
    }
  | {
      kind: 'ok'
      repoRoot: string
      branch: string | null
    }
  | {
      kind: 'error'
      message: string
    }

type WorkspacePathResolution = {
  requestedPath: string
  relativePath: string
  absolutePath: string
  workspaceRoot: string
  canonicalWorkspaceRoot: string
  canonicalTargetPath: string
}

type WorkspaceStatResult =
  | {
      kind: 'ok'
      stat: Awaited<ReturnType<typeof fs.stat>>
    }
  | {
      kind: 'missing'
    }
  | {
      kind: 'error'
      message: string
    }

type GitCommandResult = {
  stdout: string
  stderr: string
  code: number
}

type DiffStatsResult =
  | {
      kind: 'ok'
      additions: number
      deletions: number
    }
  | {
      kind: 'error'
      message: string
    }

type DiffStatsByRepoPathResult =
  | {
      kind: 'ok'
      statsByRepoPath: Map<string, { additions: number; deletions: number }>
    }
  | {
      kind: 'error'
      message: string
    }

type UntrackedDiffResult =
  | {
      kind: 'ok'
      diff: string
    }
  | {
      kind: 'missing'
    }
  | {
      kind: 'error'
      message: string
  }

type SessionFileChange = WorkspaceChangedFile & {
  diff?: string
}

export function parseStatus(code: string): WorkspaceFileStatus {
  const x = code[0] ?? ' '
  const y = code[1] ?? ' '

  if (code === '??') return 'untracked'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'C' || y === 'C') return 'copied'
  if (x === 'T' || y === 'T') return 'type_changed'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A' || y === 'A') return 'added'
  if (x === 'M' || y === 'M') return 'modified'
  return 'unknown'
}

export class WorkspaceService {
  private readonly watchers = new Map<string, chokidar.FSWatcher>()

  constructor(
    private readonly resolveSessionWorkDir: (
      sessionId: string,
    ) => Promise<string | null>,
    private readonly resolveSessionMessages: (
      sessionId: string,
    ) => Promise<MessageEntry[]> = async () => [],
    private readonly resolveSessionFileHistorySnapshots: (
      sessionId: string,
    ) => Promise<FileHistorySnapshot[]> = async () => [],
  ) {}

  async getStatus(sessionId: string): Promise<WorkspaceStatusResult> {
    const workDir = await this.requireWorkDir(sessionId)
    const workspaceInfo = await this.getWorkspaceRoot(workDir)
    if (workspaceInfo.kind === 'missing') {
      return {
        state: 'missing_workdir',
        workDir,
        repoName: null,
        branch: null,
        isGitRepo: false,
        changedFiles: [],
      }
    }
    if (workspaceInfo.kind === 'error') {
      return {
        state: 'error',
        workDir,
        repoName: null,
        branch: null,
        isGitRepo: false,
        changedFiles: [],
        error: workspaceInfo.message,
      }
    }

    const repoInfo = await this.getGitRepoInfo(workDir)
    const sessionChanges = this.mergeSessionFileChanges(
      [
        ...await this.getSessionFileChanges(
          sessionId,
          workspaceInfo.workspaceRoot,
        ),
        ...await this.getFileHistoryChanges(
          sessionId,
          workspaceInfo.workspaceRoot,
        ),
      ],
    )

    if (repoInfo.kind === 'not_git_repo') {
      sessionChanges.sort((a, b) => a.path.localeCompare(b.path))
      return {
        state: 'ok',
        workDir,
        repoName: path.basename(workspaceInfo.workspaceRoot),
        branch: null,
        isGitRepo: false,
        changedFiles: sessionChanges.map(({ diff: _diff, ...change }) => change),
      }
    }
    if (repoInfo.kind === 'error') {
      return {
        state: 'error',
        workDir,
        repoName: null,
        branch: null,
        isGitRepo: false,
        changedFiles: [],
        error: repoInfo.message,
      }
    }

    const statusEntries = await this.getStatusEntries(repoInfo.repoRoot)
    if (statusEntries.kind === 'error') {
      return {
        state: 'error',
        workDir,
        repoName: path.basename(repoInfo.repoRoot),
        branch: repoInfo.branch,
        isGitRepo: true,
        changedFiles: [],
        error: statusEntries.message,
      }
    }
    const scopedEntries = this.scopeStatusEntries(
      statusEntries.entries,
      repoInfo.repoRoot,
      workspaceInfo.canonicalWorkspaceRoot,
    )
    const trackedStats = await this.getTrackedDiffStats(repoInfo.repoRoot, scopedEntries)
    if (trackedStats.kind === 'error') {
      return {
        state: 'error',
        workDir,
        repoName: path.basename(repoInfo.repoRoot),
        branch: repoInfo.branch,
        isGitRepo: true,
        changedFiles: [],
        error: trackedStats.message,
      }
    }

    const changedFiles = await Promise.all(
      scopedEntries.map(async (entry) => {
        const stats = entry.status === 'untracked'
          ? await this.getDiffStats(repoInfo.repoRoot, entry)
          : {
              kind: 'ok' as const,
              ...(trackedStats.statsByRepoPath.get(entry.repoPath) ?? {
                additions: 0,
                deletions: 0,
              }),
            }

        if (stats.kind === 'error') {
          throw new Error(stats.message)
        }

        return {
          path: entry.path,
          oldPath: entry.oldPath,
          status: entry.status,
          additions: stats.additions,
          deletions: stats.deletions,
        } satisfies WorkspaceChangedFile
      }),
    ).catch((error) => error as Error)

    if (changedFiles instanceof Error) {
      return {
        state: 'error',
        workDir,
        repoName: path.basename(repoInfo.repoRoot),
        branch: repoInfo.branch,
        isGitRepo: true,
        changedFiles: [],
        error: changedFiles.message,
      }
    }

    changedFiles.sort((a, b) => a.path.localeCompare(b.path))
    const changedFileByPath = new Map(changedFiles.map((file) => [file.path, file]))
    for (const change of sessionChanges) {
      if (!changedFileByPath.has(change.path)) {
        changedFileByPath.set(change.path, {
          path: change.path,
          oldPath: change.oldPath,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
        })
      }
    }
    const mergedChangedFiles = [...changedFileByPath.values()]
      .sort((a, b) => a.path.localeCompare(b.path))

    return {
      state: 'ok',
      workDir,
      repoName: path.basename(repoInfo.repoRoot),
      branch: repoInfo.branch,
      isGitRepo: true,
      changedFiles: mergedChangedFiles,
    }
  }

  async readFile(
    sessionId: string,
    filePath: string,
  ): Promise<WorkspaceReadFileResult> {
    const resolvedPath = await this.resolveWorkspacePath(sessionId, filePath)

    const stat = await this.safeStat(resolvedPath.absolutePath)
    if (stat.kind === 'error') {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        language: this.detectLanguage(resolvedPath.absolutePath),
        size: 0,
        error: stat.message,
      }
    }
    if (stat.kind === 'missing' || !stat.stat.isFile()) {
      return {
        state: 'missing',
        path: resolvedPath.relativePath,
        language: this.detectLanguage(resolvedPath.absolutePath),
        size: 0,
      }
    }

    // 软连接：解析目标路径以正确检测文件类型（如 .md 扩展名在目标路径上）
    const displayPath = await this.resolveSymlinkIfNeeded(resolvedPath.absolutePath)
    const language = this.detectLanguage(displayPath)
    const imageMimeType = this.detectImageMimeType(displayPath)

    let content: Buffer
    try {
      if (!imageMimeType && stat.stat.size > MAX_PREVIEW_BYTES) {
        const fileHandle = await fs.open(resolvedPath.absolutePath, 'r')
        try {
          const previewBuffer = Buffer.alloc(MAX_PREVIEW_BYTES)
          const { bytesRead } = await fileHandle.read(previewBuffer, 0, MAX_PREVIEW_BYTES, 0)
          content = previewBuffer.subarray(0, bytesRead)
        } finally {
          await fileHandle.close()
        }
      } else {
        content = await fs.readFile(resolvedPath.absolutePath)
      }
    } catch (error) {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        language,
        size: stat.stat.size,
        error: this.formatFsError(
          'Failed to read workspace file',
          resolvedPath.absolutePath,
          error,
        ),
      }
    }
    if (imageMimeType) {
      return {
        state: 'ok',
        path: resolvedPath.relativePath,
        previewType: 'image',
        dataUrl: `data:${imageMimeType};base64,${content.toString('base64')}`,
        mimeType: imageMimeType,
        language: 'image',
        size: stat.stat.size,
      }
    }

    if (content.includes(0)) {
      return {
        state: 'binary',
        path: resolvedPath.relativePath,
        language: 'binary',
        size: stat.stat.size,
      }
    }

    return {
      state: 'ok',
      path: resolvedPath.relativePath,
      previewType: 'text',
      content: content.toString('utf8'),
      language,
      size: stat.stat.size,
      truncated: content.length < stat.stat.size,
      readBytes: content.length,
    }
  }

  async readTree(
    sessionId: string,
    treePath = '',
    showHidden = false,
  ): Promise<WorkspaceTreeResult> {
    const resolvedPath = await this.resolveWorkspacePath(sessionId, treePath)

    const stat = await this.safeStat(resolvedPath.absolutePath)
    if (stat.kind === 'error') {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        entries: [],
        error: stat.message,
      }
    }
    if (stat.kind === 'missing' || !stat.stat.isDirectory()) {
      return { state: 'missing', path: resolvedPath.relativePath, entries: [] }
    }

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(resolvedPath.absolutePath, { withFileTypes: true })
    } catch (error) {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        entries: [],
        error: this.formatFsError(
          'Failed to read workspace directory',
          resolvedPath.absolutePath,
          error,
        ),
      }
    }
    // 隐藏文件逻辑：
    // showHidden=false（眼睛关闭）：过滤全部 . 开头文件
    // showHidden=true （眼睛打开）：只过滤 .git
    const hiddenSet = showHidden
      ? new Set(['.git'])
      : null // null 表示按 . 前缀过滤

    const visibleEntries = entries
      .filter((entry) => !(entry.isDirectory() && isVcsMetadataDirectoryName(entry.name)))
      .filter((entry) => {
        if (hiddenSet) return !hiddenSet.has(entry.name) // 眼睛打开：只过滤 .git
        return !entry.name.startsWith('.') // 眼睛关闭：过滤全部 . 开头
      })
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })
      .map((entry) => {
        const isSym = entry.isSymbolicLink()
        // macOS 下 Dirent.isDirectory() 对指向目录的 symlink 返回 false
        // 此处先标记，后续异步 stat 修正
        return {
          name: entry.name,
          fullPath: path.join(resolvedPath.absolutePath, entry.name),
          isDirectory: entry.isDirectory(),
          isSymlink: isSym,
        }
      })

    // 修正 symlink 的 isDirectory（stat 跟踪到目标）
    const resolvedEntries: WorkspaceTreeEntry[] = []
    for (const e of visibleEntries) {
      if (e.isSymlink) {
        try {
          const s = await fs.stat(e.fullPath)
          resolvedEntries.push({
            name: e.name,
            path: this.normalizeRelativePath(
              path.relative(resolvedPath.workspaceRoot, e.fullPath),
            ),
            isDirectory: s.isDirectory(),
            isSymlink: true,
          })
        } catch {
          resolvedEntries.push({
            name: e.name,
            path: this.normalizeRelativePath(
              path.relative(resolvedPath.workspaceRoot, e.fullPath),
            ),
            isDirectory: false,
            isSymlink: true,
          })
        }
      } else {
        resolvedEntries.push({
          name: e.name,
          path: this.normalizeRelativePath(
            path.relative(resolvedPath.workspaceRoot, e.fullPath),
          ),
          isDirectory: e.isDirectory,
          isSymlink: false,
        })
      }
    }

    // 修正 symlink 目录的排序（stat 后才确定 isDirectory）
    resolvedEntries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return {
      state: 'ok',
      path: resolvedPath.relativePath,
      entries: resolvedEntries,
    }
  }

  async getDiff(
    sessionId: string,
    filePath: string,
  ): Promise<WorkspaceDiffResult> {
    let resolvedPath: WorkspacePathResolution
    try {
      resolvedPath = await this.resolveWorkspacePath(sessionId, filePath)
    } catch (error) {
      return {
        state: 'error',
        path: this.normalizeRequestedPath(filePath),
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const sessionDiff = await this.getSessionDiff(sessionId, resolvedPath.relativePath)
    if (sessionDiff) {
      return { state: 'ok', path: resolvedPath.relativePath, diff: sessionDiff }
    }

    const fileHistoryDiff = await this.getFileHistoryDiff(
      sessionId,
      resolvedPath.workspaceRoot,
      resolvedPath.relativePath,
    )
    if (fileHistoryDiff) {
      return { state: 'ok', path: resolvedPath.relativePath, diff: fileHistoryDiff }
    }

    const repoInfo = await this.getGitRepoInfo(resolvedPath.workspaceRoot)
    if (repoInfo.kind === 'not_git_repo') {
      return { state: 'not_git_repo', path: resolvedPath.relativePath }
    }
    if (repoInfo.kind === 'error') {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        error: repoInfo.message,
      }
    }

    const statusEntries = await this.getStatusEntries(repoInfo.repoRoot)
    if (statusEntries.kind === 'error') {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        error: statusEntries.message,
      }
    }
    const scopedEntries = this.scopeStatusEntries(
      statusEntries.entries,
      repoInfo.repoRoot,
      resolvedPath.canonicalWorkspaceRoot,
    )
    const repoRelativePath = this.toRepoRelativePath(
      repoInfo.repoRoot,
      resolvedPath.canonicalTargetPath,
    )

    const statusEntry = scopedEntries.find(
      (entry) =>
        entry.repoPath === repoRelativePath ||
        entry.repoOldPath === repoRelativePath,
    )

    if (!statusEntry) {
      return { state: 'missing', path: resolvedPath.relativePath }
    }

    if (statusEntry.status === 'untracked') {
      const diff = await this.buildUntrackedDiff(
        resolvedPath.canonicalTargetPath,
        resolvedPath.relativePath,
      )
      if (diff.kind === 'missing') {
        return { state: 'missing', path: resolvedPath.relativePath }
      }
      if (diff.kind === 'error') {
        return {
          state: 'error',
          path: resolvedPath.relativePath,
          error: diff.message,
        }
      }
      return { state: 'ok', path: resolvedPath.relativePath, diff: diff.diff }
    }

    const targetPath = statusEntry.repoPath
    const diff = await this.runGitDiff(repoInfo.repoRoot, targetPath)
    if (diff.kind === 'error') {
      return {
        state: 'error',
        path: resolvedPath.relativePath,
        error: diff.message,
      }
    }
    if (!diff.diff.trim()) {
      return { state: 'missing', path: resolvedPath.relativePath }
    }

    return { state: 'ok', path: resolvedPath.relativePath, diff: diff.diff }
  }

  private async getSessionDiff(
    sessionId: string,
    relativePath: string,
  ): Promise<string | null> {
    const workDir = await this.requireWorkDir(sessionId)
    const changes = await this.getSessionFileChanges(sessionId, workDir)
    const change = changes.find((entry) => entry.path === relativePath)
    if (!change) return null
    if (change.diff?.trim()) return change.diff

    const file = await this.readFile(sessionId, relativePath)
    if (file.state !== 'ok' || file.previewType === 'image' || typeof file.content !== 'string') {
      return null
    }
    return this.buildSyntheticDiff('/dev/null', relativePath, '', file.content)
  }

  private async getSessionFileChanges(
    sessionId: string,
    workspaceRoot: string,
  ): Promise<SessionFileChange[]> {
    let messages: MessageEntry[]
    try {
      messages = await this.resolveSessionMessages(sessionId)
    } catch {
      return []
    }

    const changes = new Map<string, SessionFileChange>()

    for (const message of messages) {
      if (message.type !== 'tool_use' || !Array.isArray(message.content)) continue

      for (const block of message.content) {
        if (!block || typeof block !== 'object') continue
        const record = block as Record<string, unknown>
        if (record.type !== 'tool_use' || typeof record.name !== 'string') continue
        const input = record.input
        if (!input || typeof input !== 'object') continue

        for (const change of this.extractSessionChangesFromTool(
          record.name,
          input as Record<string, unknown>,
          workspaceRoot,
        )) {
          const existing = changes.get(change.path)
          if (!existing) {
            changes.set(change.path, change)
            continue
          }

          changes.set(change.path, {
            ...existing,
            status: existing.status === 'added' ? existing.status : change.status,
            additions: existing.additions + change.additions,
            deletions: existing.deletions + change.deletions,
            diff: [existing.diff, change.diff].filter(Boolean).join('\n'),
          })
        }
      }
    }

    return [...changes.values()]
  }

  private async getFileHistoryChanges(
    sessionId: string,
    workspaceRoot: string,
  ): Promise<SessionFileChange[]> {
    let snapshots: FileHistorySnapshot[]
    try {
      snapshots = await this.resolveSessionFileHistorySnapshots(sessionId)
    } catch {
      return []
    }
    if (snapshots.length === 0) return []

    const changes: SessionFileChange[] = []
    const trackedPaths = this.collectFileHistoryTrackedPaths(snapshots)

    for (const trackingPath of trackedPaths) {
      const relativePath = this.resolveFileHistoryRelativePath(trackingPath, workspaceRoot)
      if (!relativePath) continue

      const beforeContent = await this.readFileHistoryBackupContent(
        sessionId,
        this.getEarliestFileHistoryBackupName(trackingPath, snapshots),
      )
      if (beforeContent === undefined) continue

      const absolutePath = path.resolve(workspaceRoot, relativePath)
      const afterContent = await this.readTextFileOrNull(absolutePath)
      if (beforeContent === afterContent) continue

      const stats = this.countDiffStats(beforeContent ?? '', afterContent ?? '')
      changes.push({
        path: relativePath,
        status: beforeContent === null
          ? 'added'
          : afterContent === null
            ? 'deleted'
            : 'modified',
        additions: stats.additions,
        deletions: stats.deletions,
        diff: this.buildSyntheticDiff(
          beforeContent === null ? '/dev/null' : relativePath,
          afterContent === null ? '/dev/null' : relativePath,
          beforeContent ?? '',
          afterContent ?? '',
        ),
      })
    }

    return changes
  }

  private async getFileHistoryDiff(
    sessionId: string,
    workspaceRoot: string,
    relativePath: string,
  ): Promise<string | null> {
    const changes = await this.getFileHistoryChanges(sessionId, workspaceRoot)
    return changes.find((change) => change.path === relativePath)?.diff ?? null
  }

  private mergeSessionFileChanges(changes: SessionFileChange[]): SessionFileChange[] {
    const merged = new Map<string, SessionFileChange>()
    for (const change of changes) {
      const existing = merged.get(change.path)
      if (!existing) {
        merged.set(change.path, change)
        continue
      }

      merged.set(change.path, {
        ...existing,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        diff: change.diff ?? existing.diff,
      })
    }
    return [...merged.values()]
  }

  private collectFileHistoryTrackedPaths(snapshots: FileHistorySnapshot[]): Set<string> {
    const trackedPaths = new Set<string>()
    for (const snapshot of snapshots) {
      for (const trackingPath of Object.keys(snapshot.trackedFileBackups)) {
        trackedPaths.add(trackingPath)
      }
    }
    return trackedPaths
  }

  private getEarliestFileHistoryBackupName(
    trackingPath: string,
    snapshots: FileHistorySnapshot[],
  ): string | null | undefined {
    for (const snapshot of snapshots) {
      const backup = snapshot.trackedFileBackups[trackingPath]
      if (backup !== undefined) {
        return backup.backupFileName
      }
    }
    return undefined
  }

  private resolveFileHistoryRelativePath(
    trackingPath: string,
    workspaceRoot: string,
  ): string | null {
    const absolutePath = path.isAbsolute(trackingPath)
      ? path.resolve(trackingPath)
      : path.resolve(workspaceRoot, trackingPath)
    if (!this.isWithinRoot(absolutePath, workspaceRoot)) return null
    return this.normalizeRelativePath(path.relative(workspaceRoot, absolutePath))
  }

  private async readFileHistoryBackupContent(
    sessionId: string,
    backupFileName: string | null | undefined,
  ): Promise<string | null | undefined> {
    if (backupFileName === undefined) return undefined
    if (backupFileName === null) return null
    return await this.readTextFileOrNull(
      path.join(getClaudeConfigHomeDir(), 'file-history', sessionId, backupFileName),
    )
  }

  private async readTextFileOrNull(filePath: string): Promise<string | null> {
    try {
      const content = await fs.readFile(filePath)
      if (content.includes(0)) return null
      return content.toString('utf8')
    } catch {
      return null
    }
  }

  private countDiffStats(oldContent: string, newContent: string): { additions: number; deletions: number } {
    let additions = 0
    let deletions = 0
    for (const change of diffLines(oldContent, newContent)) {
      if (change.added) additions += change.count || 0
      if (change.removed) deletions += change.count || 0
    }
    return { additions, deletions }
  }

  private extractSessionChangesFromTool(
    toolName: string,
    input: Record<string, unknown>,
    workspaceRoot: string,
  ): SessionFileChange[] {
    const normalizedToolName = toolName.toLowerCase()
    if (normalizedToolName === 'write') {
      const filePath = this.resolveSessionToolPath(input.file_path ?? input.path, workspaceRoot)
      if (!filePath) return []
      const content = typeof input.content === 'string' ? input.content : ''
      return [{
        path: filePath,
        status: 'added',
        additions: this.countChangedLines(content),
        deletions: 0,
        diff: this.buildSyntheticDiff('/dev/null', filePath, '', content),
      }]
    }

    if (normalizedToolName === 'edit') {
      const filePath = this.resolveSessionToolPath(input.file_path ?? input.path, workspaceRoot)
      if (!filePath) return []
      return [this.buildEditSessionChange(filePath, input)]
    }

    if (normalizedToolName === 'multiedit') {
      const filePath = this.resolveSessionToolPath(input.file_path ?? input.path, workspaceRoot)
      if (!filePath || !Array.isArray(input.edits)) return []
      return input.edits
        .filter((edit): edit is Record<string, unknown> => !!edit && typeof edit === 'object')
        .map((edit) => this.buildEditSessionChange(filePath, edit))
    }

    if (normalizedToolName === 'notebookedit') {
      const filePath = this.resolveSessionToolPath(
        input.notebook_path ?? input.file_path ?? input.path,
        workspaceRoot,
      )
      if (!filePath) return []
      const oldString = typeof input.old_source === 'string' ? input.old_source : ''
      const newString = typeof input.new_source === 'string' ? input.new_source : ''
      return [{
        path: filePath,
        status: oldString ? 'modified' : 'added',
        additions: this.countChangedLines(newString),
        deletions: this.countChangedLines(oldString),
        diff: this.buildSyntheticDiff(filePath, filePath, oldString, newString),
      }]
    }

    if (normalizedToolName === 'apply_patch') {
      return this.extractApplyPatchSessionChanges(input.patch, workspaceRoot)
    }

    return []
  }

  private buildEditSessionChange(
    filePath: string,
    input: Record<string, unknown>,
  ): SessionFileChange {
    const oldString = typeof input.old_string === 'string' ? input.old_string : ''
    const newString = typeof input.new_string === 'string' ? input.new_string : ''
    return {
      path: filePath,
      status: oldString ? 'modified' : 'added',
      additions: this.countChangedLines(newString),
      deletions: this.countChangedLines(oldString),
      diff: this.buildSyntheticDiff(filePath, filePath, oldString, newString),
    }
  }

  private extractApplyPatchSessionChanges(
    patch: unknown,
    workspaceRoot: string,
  ): SessionFileChange[] {
    if (typeof patch !== 'string') return []
    const changes: SessionFileChange[] = []

    for (const line of patch.split('\n')) {
      const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
      if (!match?.[1]) continue
      const filePath = this.resolveSessionToolPath(match[1], workspaceRoot)
      if (!filePath) continue
      const status: WorkspaceFileStatus = line.includes('Add File')
        ? 'added'
        : line.includes('Delete File')
          ? 'deleted'
          : 'modified'
      changes.push({
        path: filePath,
        status,
        additions: 0,
        deletions: 0,
      })
    }

    return changes
  }

  private resolveSessionToolPath(
    filePath: unknown,
    workspaceRoot: string,
  ): string | null {
    if (typeof filePath !== 'string' || !filePath.trim()) return null
    const absolutePath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(workspaceRoot, filePath)
    if (!this.isWithinRoot(absolutePath, workspaceRoot)) return null
    return this.normalizeRelativePath(path.relative(workspaceRoot, absolutePath))
  }

  private countChangedLines(value: string): number {
    if (!value) return 0
    return value.endsWith('\n')
      ? value.split('\n').length - 1
      : value.split('\n').length
  }

  private buildSyntheticDiff(
    oldPath: string,
    newPath: string,
    oldContent: string,
    newContent: string,
  ): string {
    const oldLines = oldContent ? oldContent.split('\n') : []
    const newLines = newContent ? newContent.split('\n') : []
    if (oldLines.at(-1) === '') oldLines.pop()
    if (newLines.at(-1) === '') newLines.pop()

    return [
      `diff --session ${
        oldPath === '/dev/null' ? '/dev/null' : `a/${oldPath}`
      } ${
        newPath === '/dev/null' ? '/dev/null' : `b/${newPath}`
      }`,
      `--- ${oldPath === '/dev/null' ? '/dev/null' : `a/${oldPath}`}`,
      `+++ ${newPath === '/dev/null' ? '/dev/null' : `b/${newPath}`}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ].join('\n')
  }

  private async requireWorkDir(sessionId: string): Promise<string> {
    const workDir = await this.resolveSessionWorkDir(sessionId)
    if (!workDir) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return path.resolve(normalizeDriveRootPathForPlatform(workDir))
  }

  private async getWorkspaceRoot(
    workDir: string,
  ): Promise<
    | { kind: 'ok'; workspaceRoot: string; canonicalWorkspaceRoot: string }
    | { kind: 'missing' }
    | { kind: 'error'; message: string }
  > {
    const stat = await this.safeStat(workDir)
    if (stat.kind === 'missing') {
      return { kind: 'missing' }
    }
    if (stat.kind === 'error') {
      return { kind: 'error', message: stat.message }
    }

    try {
      return {
        kind: 'ok',
        workspaceRoot: workDir,
        canonicalWorkspaceRoot: normalizeDriveRootPathForPlatform(await fs.realpath(workDir)),
      }
    } catch (error) {
      return {
        kind: 'error',
        message: this.formatFsError(
          'Failed to canonicalize workspace root',
          workDir,
          error,
        ),
      }
    }
  }

  private async resolveWorkspacePath(
    sessionId: string,
    requestedPath: string,
  ): Promise<WorkspacePathResolution> {
    const workDir = await this.requireWorkDir(sessionId)
    const workspaceRoot = await this.getWorkspaceRoot(workDir)
    if (workspaceRoot.kind === 'missing') {
      throw new Error(`Workspace root is missing: ${workDir}`)
    }
    if (workspaceRoot.kind === 'error') {
      throw new Error(workspaceRoot.message)
    }

    const absolutePath = path.resolve(workDir, requestedPath || '.')
    if (!this.isWithinRoot(absolutePath, workDir)) {
      throw new Error(`Path is outside workspace: ${requestedPath}`)
    }

    // 软连接及其子路径：跳过 canonical 解析，避免目标路径逃逸到工作区外
    const hasSymlink = await this.pathHasSymlinkComponent(absolutePath)
    const canonicalTargetPath = hasSymlink
      ? absolutePath
      : await this.resolveCanonicalTargetPath(
          workspaceRoot.canonicalWorkspaceRoot,
          absolutePath,
          requestedPath,
        )

    return {
      absolutePath,
      requestedPath,
      workspaceRoot: workspaceRoot.workspaceRoot,
      canonicalWorkspaceRoot: workspaceRoot.canonicalWorkspaceRoot,
      canonicalTargetPath,
      relativePath: this.normalizeRelativePath(
        path.relative(workspaceRoot.workspaceRoot, absolutePath),
      ),
    }
  }

  private async validateCanonicalWorkspacePath(
    canonicalWorkspaceRoot: string,
    absolutePath: string,
    requestedPath: string,
  ): Promise<
    | { kind: 'ok'; canonicalTargetPath: string }
    | { kind: 'error'; message: string }
  > {
    try {
      return {
        kind: 'ok',
        canonicalTargetPath: await this.resolveCanonicalTargetPath(
          canonicalWorkspaceRoot,
          absolutePath,
          requestedPath,
        ),
      }
    } catch (error) {
      return {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async resolveCanonicalTargetPath(
    canonicalWorkspaceRoot: string,
    absolutePath: string,
    requestedPath: string,
  ): Promise<string> {
    let probePath = absolutePath
    const missingSuffix: string[] = []

    for (;;) {
      try {
        const canonicalBase = await fs.realpath(probePath)
        const canonicalTarget = path.resolve(canonicalBase, ...missingSuffix)
        if (!this.isWithinRoot(canonicalTarget, canonicalWorkspaceRoot)) {
          throw new Error(`Path is outside workspace: ${requestedPath}`)
        }
        return canonicalTarget
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
          if (probePath === canonicalWorkspaceRoot) {
            const candidate = path.resolve(canonicalWorkspaceRoot, ...missingSuffix)
            if (!this.isWithinRoot(candidate, canonicalWorkspaceRoot)) {
              throw new Error(`Path is outside workspace: ${requestedPath}`)
            }
            return candidate
          }

          missingSuffix.unshift(path.basename(probePath))
          const parentPath = path.dirname(probePath)
          if (parentPath === probePath) {
            throw err
          }
          probePath = parentPath
          continue
        }

        throw new Error(
          this.formatFsError(
            'Failed to canonicalize workspace path',
            absolutePath,
            error,
          ),
        )
      }
    }
  }

  private isWithinRoot(targetPath: string, rootPath: string): boolean {
    return isSameOrInsidePathForPlatform(targetPath, rootPath)
  }

  private async pathHasSymlinkComponent(absolutePath: string): Promise<boolean> {
    let current = absolutePath
    for (;;) {
      try {
        const lst = await fs.lstat(current)
        if (lst.isSymbolicLink()) return true
      } catch (error) {
        const errCode = (error as NodeJS.ErrnoException)?.code as string | undefined
        if (errCode && errCode !== 'ENOENT' && errCode !== 'ENOTDIR') {
          return false
        }
      }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return false
  }

  private normalizeRelativePath(filePath: string): string {
    if (!filePath || filePath === '.') return ''
    return filePath.split(path.sep).join('/')
  }

  private normalizeRequestedPath(filePath: string): string {
    if (!filePath) return ''
    return filePath.split(path.sep).join('/')
  }

  private scopeStatusEntries(
    entries: StatusEntry[],
    repoRoot: string,
    workDir: string,
  ): ScopedStatusEntry[] {
    const workDirFromRepo = this.normalizeRelativePath(path.relative(repoRoot, workDir))

    return entries.flatMap((entry) => {
      const scopedPath = this.rebaseRepoPathToWorkspacePath(entry.path, workDirFromRepo)
      if (scopedPath === null) {
        return []
      }

      const scopedOldPath = entry.oldPath
        ? this.rebaseRepoPathToWorkspacePath(entry.oldPath, workDirFromRepo)
        : undefined

      return [{
        repoPath: entry.path,
        repoOldPath: entry.oldPath,
        path: scopedPath,
        oldPath: scopedOldPath ?? undefined,
        status: entry.status,
        absolutePath: path.resolve(repoRoot, entry.path),
        canonicalWorkspaceRoot: workDir,
      }]
    })
  }

  private rebaseRepoPathToWorkspacePath(
    repoPath: string,
    workDirFromRepo: string,
  ): string | null {
    const normalizedRepoPath = this.normalizeRelativePath(repoPath)
    if (!workDirFromRepo) {
      return normalizedRepoPath
    }

    const rebasedPath = path.posix.relative(workDirFromRepo, normalizedRepoPath)
    if (
      !rebasedPath ||
      rebasedPath === '.' ||
      rebasedPath === '..' ||
      rebasedPath.startsWith('../')
    ) {
      return null
    }

    return rebasedPath
  }

  private toRepoRelativePath(
    repoRoot: string,
    canonicalTargetPath: string,
  ): string {
    return this.normalizeRelativePath(path.relative(repoRoot, canonicalTargetPath))
  }

  /** 若路径为软连接则解析到目标路径，否则返回原路径 */
  private async resolveSymlinkIfNeeded(filePath: string): Promise<string> {
    try {
      const lst = await fs.lstat(filePath)
      if (lst.isSymbolicLink()) {
        return await fs.realpath(filePath)
      }
    } catch { /* ignore */ }
    return filePath
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).slice(1).toLowerCase()
    return LANGUAGE_MAP[ext] || 'text'
  }

  private detectImageMimeType(filePath: string): string | null {
    const ext = path.extname(filePath).slice(1).toLowerCase()
    return IMAGE_MIME_BY_EXTENSION[ext] ?? null
  }

  private async safeStat(targetPath: string): Promise<WorkspaceStatResult> {
    try {
      return {
        kind: 'ok',
        stat: await fs.stat(targetPath),
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        return { kind: 'missing' }
      }
      return {
        kind: 'error',
        message: this.formatFsError('Failed to stat workspace path', targetPath, error),
      }
    }
  }

  private async getGitRepoInfo(workDir: string): Promise<GitRepoInfo> {
    const rootResult = await this.runGit(workDir, ['rev-parse', '--show-toplevel'])

    if (rootResult.code !== 0) {
      const stderr = rootResult.stderr.trim()
      if (stderr.includes('not a git repository')) {
        return { kind: 'not_git_repo' }
      }
      return {
        kind: 'error',
        message: this.formatGitError(
          'Failed to inspect git repository',
          ['rev-parse', '--show-toplevel'],
          workDir,
          rootResult,
        ),
      }
    }

    let repoRoot: string
    try {
      repoRoot = await fs.realpath(path.resolve(rootResult.stdout.trim()))
    } catch (error) {
      return {
        kind: 'error',
        message: this.formatFsError(
          'Failed to canonicalize git repository root',
          path.resolve(rootResult.stdout.trim()),
          error,
        ),
      }
    }
    const branchResult = await this.runGit(workDir, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ])

    return {
      kind: 'ok',
      repoRoot,
      branch:
        branchResult.code === 0
          ? branchResult.stdout.trim() || null
          : null,
    }
  }

  private async getStatusEntries(
    workDir: string,
  ): Promise<{ kind: 'ok'; entries: StatusEntry[] } | { kind: 'error'; message: string }> {
    const result = await this.runGit(workDir, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ])

    if (result.code !== 0) {
      return {
        kind: 'error',
        message: this.formatGitError(
          'Failed to read git status',
          ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
          workDir,
          result,
        ),
      }
    }

    const parts = result.stdout.split('\0')
    const entries: StatusEntry[] = []

    for (let i = 0; i < parts.length; i++) {
      const record = parts[i]
      if (!record) continue

      const code = record.slice(0, 2)
      const currentPath = this.normalizeRelativePath(record.slice(3))
      const status = parseStatus(code)

      if (status === 'renamed' || status === 'copied') {
        const oldPath = this.normalizeRelativePath(parts[++i] || '')
        entries.push({
          path: currentPath,
          oldPath,
          code,
          status,
        })
        continue
      }

      entries.push({
        path: currentPath,
        code,
        status,
      })
    }

    return { kind: 'ok', entries }
  }

  private async getDiffStats(
    workDir: string,
    entry: ScopedStatusEntry,
  ): Promise<DiffStatsResult> {
    if (entry.status === 'untracked') {
      const validatedPath = await this.validateCanonicalWorkspacePath(
        entry.canonicalWorkspaceRoot,
        entry.absolutePath,
        entry.path,
      )
      if (validatedPath.kind === 'error') {
        return { kind: 'error', message: validatedPath.message }
      }

      return this.getUntrackedStats(validatedPath.canonicalTargetPath)
    }

    const result = await this.runGit(workDir, [
      'diff',
      '--numstat',
      '--find-renames',
      '--find-copies',
      'HEAD',
      '--',
      entry.repoPath,
    ])

    if (result.code !== 0) {
      return {
        kind: 'error',
        message: this.formatGitError(
          'Failed to read git diff stats',
          [
            'diff',
            '--numstat',
            '--find-renames',
            '--find-copies',
            'HEAD',
            '--',
            entry.repoPath,
          ],
          workDir,
          result,
        ),
      }
    }

    const line = result.stdout.trim().split('\n').find(Boolean)
    if (!line) {
      return {
        kind: 'ok',
        additions: 0,
        deletions: 0,
      }
    }

    const [additions, deletions] = line.split('\t')
    return {
      kind: 'ok',
      additions: additions === '-' ? 0 : parseInt(additions || '0', 10) || 0,
      deletions: deletions === '-' ? 0 : parseInt(deletions || '0', 10) || 0,
    }
  }

  private async getTrackedDiffStats(
    workDir: string,
    entries: ScopedStatusEntry[],
  ): Promise<DiffStatsByRepoPathResult> {
    if (!entries.some((entry) => entry.status !== 'untracked')) {
      return { kind: 'ok', statsByRepoPath: new Map() }
    }

    const result = await this.runGit(workDir, [
      'diff',
      '--numstat',
      '--find-renames',
      '--find-copies',
      'HEAD',
      '--',
    ])

    if (result.code !== 0) {
      return {
        kind: 'error',
        message: this.formatGitError(
          'Failed to read git diff stats',
          [
            'diff',
            '--numstat',
            '--find-renames',
            '--find-copies',
            'HEAD',
            '--',
          ],
          workDir,
          result,
        ),
      }
    }

    const statsByRepoPath = new Map<string, { additions: number; deletions: number }>()
    for (const line of result.stdout.trim().split('\n')) {
      if (!line) continue
      const [additions, deletions, repoPath] = line.split('\t')
      if (!repoPath) continue
      statsByRepoPath.set(this.normalizeRelativePath(repoPath), {
        additions: additions === '-' ? 0 : parseInt(additions || '0', 10) || 0,
        deletions: deletions === '-' ? 0 : parseInt(deletions || '0', 10) || 0,
      })
    }

    return { kind: 'ok', statsByRepoPath }
  }

  private async getUntrackedStats(
    absolutePath: string,
  ): Promise<DiffStatsResult> {
    try {
      const stat = await fs.stat(absolutePath)
      if (!stat.isFile()) {
        return { kind: 'ok', additions: 0, deletions: 0 }
      }
      if (stat.size > MAX_UNTRACKED_STAT_BYTES) {
        return { kind: 'ok', additions: 0, deletions: 0 }
      }

      const content = await fs.readFile(absolutePath, 'utf8')
      return {
        kind: 'ok',
        additions: this.countTextLines(content),
        deletions: 0,
      }
    } catch (error) {
      return {
        kind: 'error',
        message: this.formatFsError(
          'Failed to read untracked workspace file',
          absolutePath,
          error,
        ),
      }
    }
  }

  private countTextLines(content: string): number {
    if (!content) return 0
    const lines = content.split(/\r\n|\r|\n/)
    if (lines[lines.length - 1] === '') {
      lines.pop()
    }
    return lines.length
  }

  private async runGitDiff(
    workDir: string,
    relativePath: string,
  ): Promise<{ kind: 'ok'; diff: string } | { kind: 'error'; message: string }> {
    const result = await this.runGit(workDir, [
      'diff',
      '--no-ext-diff',
      '--binary',
      '--find-renames',
      '--find-copies',
      'HEAD',
      '--',
      relativePath,
    ])

    if (result.code !== 0) {
      return {
        kind: 'error',
        message: this.formatGitError(
          'Failed to read git diff',
          [
            'diff',
            '--no-ext-diff',
            '--binary',
            '--find-renames',
            '--find-copies',
            'HEAD',
            '--',
            relativePath,
          ],
          workDir,
          result,
        ),
      }
    }

    return { kind: 'ok', diff: result.stdout }
  }

  private async runGit(
    workDir: string,
    args: string[],
  ): Promise<GitCommandResult> {
    try {
      const result = await execFile('git', args, {
        cwd: workDir,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_BUFFER_BYTES,
        encoding: 'utf8',
      })

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: 0,
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string | Buffer
        stderr?: string | Buffer
        code?: number | string
      }

      return {
        stdout:
          typeof err.stdout === 'string'
            ? err.stdout
            : Buffer.isBuffer(err.stdout)
              ? err.stdout.toString('utf8')
              : '',
        stderr:
          typeof err.stderr === 'string'
            ? err.stderr
            : Buffer.isBuffer(err.stderr)
              ? err.stderr.toString('utf8')
              : '',
        code: typeof err.code === 'number' ? err.code : 1,
      }
    }
  }

  private async buildUntrackedDiff(
    absolutePath: string,
    relativePath: string,
  ): Promise<UntrackedDiffResult> {
    const stat = await this.safeStat(absolutePath)
    if (stat.kind === 'error') {
      return { kind: 'error', message: stat.message }
    }
    if (stat.kind === 'missing' || !stat.stat.isFile()) {
      return { kind: 'missing' }
    }

    let buffer: Buffer
    try {
      buffer = await fs.readFile(absolutePath)
    } catch (error) {
      return {
        kind: 'error',
        message: this.formatFsError(
          'Failed to read untracked workspace file',
          absolutePath,
          error,
        ),
      }
    }
    if (buffer.includes(0)) {
      return {
        kind: 'ok',
        diff: [
          `diff --git a/${relativePath} b/${relativePath}`,
          'new file mode 100644',
          `Binary files /dev/null and b/${relativePath} differ`,
          '',
        ].join('\n'),
      }
    }

    const content = buffer.toString('utf8')
    const lines = content.split(/\r\n|\r|\n/)
    if (lines[lines.length - 1] === '') {
      lines.pop()
    }

    const hunkLines = lines.map((line) => `+${line}`)
    if (hunkLines.length === 0) {
      hunkLines.push('+')
    }

    return {
      kind: 'ok',
      diff: [
        `diff --git a/${relativePath} b/${relativePath}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${relativePath}`,
        `@@ -0,0 +1,${hunkLines.length} @@`,
        ...hunkLines,
        '',
      ].join('\n'),
    }
  }

  private formatFsError(
    prefix: string,
    targetPath: string,
    error: unknown,
  ): string {
    const err = error as NodeJS.ErrnoException
    const code = err.code ? `${err.code}: ` : ''
    return `${prefix} (${targetPath}): ${code}${err.message || 'unknown error'}`
  }

  startWatcher(sessionId: string, workDir: string): void {
    this.stopWatcher(sessionId)

    try {
      const w = chokidar.watch(workDir, {
        ignored: /(^|[\/\\])(\.git|node_modules)([\/\\]|$)/,
        ignoreInitial: true,
      })
      w.on('all', (_eventType, filename) => {
        if (!filename) return

        const fullPath = path.join(workDir, filename)
        // 防抖发送 — 使用 setTimeout + pending 标记
        if (this._watcherTimers == null) {
          ;(this as any)._watcherTimers = new Map<string, ReturnType<typeof setTimeout>>()
        }
        const timers: Map<string, ReturnType<typeof setTimeout>> = (this as any)._watcherTimers
        const existing = timers.get(sessionId)
        if (existing) clearTimeout(existing)
        timers.set(
          sessionId,
          setTimeout(() => {
            timers.delete(sessionId)
            const { sendToSession } = require('../ws/handler.js')
            sendToSession(sessionId, {
              type: 'file_changed',
              sessionId,
              path: fullPath,
            })
          }, 200),
        )
      })
      this.watchers.set(sessionId, w)
    } catch {
      // 如果 watch 启动失败（如目录不存在），静默忽略
    }
  }

  stopWatcher(sessionId: string): void {
    const w = this.watchers.get(sessionId)
    if (w) {
      try { w.close() } catch { /* ignore */ }
      this.watchers.delete(sessionId)
    }
    const timers: Map<string, ReturnType<typeof setTimeout>> | undefined = (this as any)._watcherTimers
    if (timers) {
      const t = timers.get(sessionId)
      if (t) { clearTimeout(t); timers.delete(sessionId) }
    }
  }

  stopAllWatchers(): void {
    for (const [sessionId] of this.watchers) {
      this.stopWatcher(sessionId)
    }
  }

  private formatGitError(
    prefix: string,
    args: string[],
    workDir: string,
    result: GitCommandResult,
  ): string {
    const stderr = result.stderr.trim() || result.stdout.trim() || 'unknown git failure'
    return `${prefix} (git ${args.join(' ')} in ${workDir}): ${stderr}`
  }
}
