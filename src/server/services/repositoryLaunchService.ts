import { execFile as execFileCallback } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { ApiError } from '../middleware/errorHandler.js'
import { findCanonicalGitRoot, findGitRoot } from '../../utils/git.js'
import {
  ensureWorktreesDirExcluded,
  performPostCreationSetup,
  validateWorktreeSlug,
  worktreeBranchName,
} from '../../utils/worktree.js'
import { getRuntimeMode } from '../config/runtimeMode.js'

const execFile = promisify(execFileCallback)
const GIT_TIMEOUT_MS = 10_000
const WORKTREE_TIMEOUT_MS = 60_000
const MAX_GIT_BUFFER_BYTES = 2_000_000
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
}

const REPOSITORY_ERROR = {
  workdirMissing: 'WORKDIR_MISSING',
  workdirNotDirectory: 'WORKDIR_NOT_DIRECTORY',
  notGit: 'REPOSITORY_NOT_GIT',
  contextFailed: 'REPOSITORY_CONTEXT_ERROR',
  branchNotFound: 'REPOSITORY_BRANCH_NOT_FOUND',
  dirtyWorktree: 'REPOSITORY_DIRTY_WORKTREE',
  branchCheckedOut: 'REPOSITORY_BRANCH_CHECKED_OUT',
  worktreeCreateFailed: 'REPOSITORY_WORKTREE_CREATE_FAILED',
  switchFailed: 'REPOSITORY_SWITCH_FAILED',
} as const

type RepositoryErrorCode = typeof REPOSITORY_ERROR[keyof typeof REPOSITORY_ERROR]

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

export type CreateSessionRepositoryOptions = {
  branch?: string | null
  worktree?: boolean
}

export type PreparedSessionWorkspace = {
  workDir: string
  repository?: {
    requestedWorkDir: string
    repoRoot: string
    branch: string
    worktree: boolean
    baseRef: string
    worktreePath?: string
    worktreeBranch?: string
    worktreeSlug?: string
  }
}

export type RepositorySessionLaunchState = {
  workDir: string
  repository?: PreparedSessionWorkspace['repository']
  worktreeSession?: { worktreePath?: string | null } | null
  transcriptMessageCount: number
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  return path.resolve(left) === path.resolve(right)
}

export function isMaterializedWorktreeLaunch(
  launchInfo: RepositorySessionLaunchState,
): boolean {
  const worktreePath = launchInfo.repository?.worktreePath
  return (
    samePath(launchInfo.workDir, worktreePath) ||
    samePath(launchInfo.workDir, launchInfo.worktreeSession?.worktreePath) ||
    samePath(worktreePath, launchInfo.worktreeSession?.worktreePath)
  )
}

export function shouldCreateWorktreeForSessionLaunch(
  launchInfo: RepositorySessionLaunchState,
): boolean {
  return !!(
    launchInfo.repository?.worktree &&
    launchInfo.transcriptMessageCount === 0 &&
    !isMaterializedWorktreeLaunch(launchInfo)
  )
}

type GitResult = {
  stdout: string
  stderr: string
  code: number
}

type GitWorktreeRecord = {
  path: string
  branch: string | null
}

type ResolvedBranch = RepositoryBranchInfo & {
  baseRef: string
}

function repositoryBadRequest(code: RepositoryErrorCode, message: string): ApiError {
  return new ApiError(400, message, code)
}

async function runGit(
  cwd: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFile('git', args, {
      cwd,
      timeout,
      maxBuffer: MAX_GIT_BUFFER_BYTES,
      env: { ...process.env, ...GIT_NO_PROMPT_ENV },
    })
    return {
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
      code: 0,
    }
  } catch (error) {
    const err = error as {
      stdout?: string | Buffer
      stderr?: string | Buffer
      code?: unknown
      message?: string
    }
    return {
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
      code: typeof err.code === 'number' ? err.code : 1,
    }
  }
}

async function resolveDirectory(workDir: string): Promise<string> {
  const resolved = path.resolve(workDir)
  let realPath: string
  try {
    realPath = await fs.realpath(resolved)
  } catch {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.workdirMissing,
      `Working directory does not exist: ${resolved}`,
    )
  }

  const stat = await fs.stat(realPath)
  if (!stat.isDirectory()) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.workdirNotDirectory,
      `Working directory is not a directory: ${realPath}`,
    )
  }

  return realPath
}

function normalizeRemoteBranch(ref: string): { name: string; remoteRef: string } | null {
  if (!ref || ref.endsWith('/HEAD')) return null
  const slash = ref.indexOf('/')
  if (slash < 1) return null
  const remote = ref.slice(0, slash)
  const name = ref.slice(slash + 1)
  if (!name) return null
  return {
    name: remote === 'origin' ? name : ref,
    remoteRef: ref,
  }
}

function parseWorktreeList(stdout: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = []
  let current: GitWorktreeRecord | null = null

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current)
      current = { path: line.slice('worktree '.length).normalize('NFC'), branch: null }
      continue
    }
    if (current && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length)
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    }
  }

  if (current) records.push(current)
  return records
}

function branchSort(a: RepositoryBranchInfo, b: RepositoryBranchInfo): number {
  if (a.current !== b.current) return a.current ? -1 : 1
  if (a.local !== b.local) return a.local ? -1 : 1
  return a.name.localeCompare(b.name)
}

function isDesktopWorktreeBranch(name: string): boolean {
  return name.startsWith('worktree-desktop-')
}

async function listBranches(repoRoot: string, currentBranch: string | null, worktrees: GitWorktreeRecord[]): Promise<RepositoryBranchInfo[]> {
  const branches = new Map<string, RepositoryBranchInfo>()
  const checkedOutByBranch = new Map<string, string>()
  for (const worktree of worktrees) {
    if (worktree.branch) checkedOutByBranch.set(worktree.branch, worktree.path)
  }

  const localResult = await runGit(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  if (localResult.code === 0) {
    for (const name of localResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      const worktreePath = checkedOutByBranch.get(name)
      branches.set(name, {
        name,
        current: name === currentBranch,
        local: true,
        remote: false,
        checkedOut: !!worktreePath,
        worktreePath,
      })
    }
  }

  const remoteResult = await runGit(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
  if (remoteResult.code === 0) {
    for (const ref of remoteResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      const parsed = normalizeRemoteBranch(ref)
      if (!parsed) continue
      const existing = branches.get(parsed.name)
      if (existing) {
        branches.set(parsed.name, {
          ...existing,
          remote: true,
          remoteRef: parsed.remoteRef,
        })
      } else {
        branches.set(parsed.name, {
          name: parsed.name,
          current: parsed.name === currentBranch,
          local: false,
          remote: true,
          remoteRef: parsed.remoteRef,
          checkedOut: false,
        })
      }
    }
  }

  if (currentBranch && !branches.has(currentBranch)) {
    const worktreePath = checkedOutByBranch.get(currentBranch)
    branches.set(currentBranch, {
      name: currentBranch,
      current: true,
      local: true,
      remote: false,
      checkedOut: !!worktreePath,
      worktreePath,
    })
  }

  return [...branches.values()]
    .filter((branch) => !isDesktopWorktreeBranch(branch.name))
    .sort(branchSort)
}

async function getDefaultBranch(repoRoot: string): Promise<string | null> {
  const originHead = await runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (originHead.code === 0) {
    const value = originHead.stdout.trim()
    if (value.startsWith('origin/')) return value.slice('origin/'.length)
    if (value) return value
  }

  const current = await runGit(repoRoot, ['branch', '--show-current'])
  const currentBranch = current.stdout.trim()
  return currentBranch || null
}

export async function getRepositoryContext(workDir: string): Promise<RepositoryContextResult> {
  let absWorkDir: string
  try {
    absWorkDir = await resolveDirectory(workDir)
  } catch (error) {
    return {
      state: 'missing_workdir',
      workDir: path.resolve(workDir),
      repoRoot: null,
      repoName: null,
      currentBranch: null,
      defaultBranch: null,
      dirty: false,
      branches: [],
      worktrees: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const gitRoot = findGitRoot(absWorkDir)
  if (!gitRoot) {
    return {
      state: 'not_git_repo',
      workDir: absWorkDir,
      repoRoot: null,
      repoName: null,
      currentBranch: null,
      defaultBranch: null,
      dirty: false,
      branches: [],
      worktrees: [],
    }
  }

  try {
    const repoRoot = findCanonicalGitRoot(gitRoot) ?? gitRoot
    const [branchResult, defaultBranch, statusResult, worktreeResult] = await Promise.all([
      runGit(gitRoot, ['branch', '--show-current']),
      getDefaultBranch(gitRoot),
      runGit(gitRoot, ['--no-optional-locks', 'status', '--porcelain']),
      runGit(repoRoot, ['worktree', 'list', '--porcelain']),
    ])

    const currentBranch = branchResult.stdout.trim() || null
    const worktreeRecords = worktreeResult.code === 0 ? parseWorktreeList(worktreeResult.stdout) : []
    const worktrees = worktreeRecords.map((worktree) => ({
      path: worktree.path,
      branch: worktree.branch,
      current: absWorkDir === worktree.path || absWorkDir.startsWith(`${worktree.path}${path.sep}`),
    }))

    return {
      state: 'ok',
      workDir: absWorkDir,
      repoRoot,
      repoName: path.basename(repoRoot),
      currentBranch,
      defaultBranch,
      dirty: statusResult.code === 0 && statusResult.stdout.trim().length > 0,
      branches: await listBranches(repoRoot, currentBranch, worktreeRecords),
      worktrees,
    }
  } catch (error) {
    return {
      state: 'error',
      workDir: absWorkDir,
      repoRoot: gitRoot,
      repoName: path.basename(gitRoot),
      currentBranch: null,
      defaultBranch: null,
      dirty: false,
      branches: [],
      worktrees: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function resolveBranch(context: RepositoryContextResult, requestedBranch?: string | null): ResolvedBranch | null {
  if (context.state !== 'ok') return null
  const selectedName = requestedBranch || [
    context.currentBranch,
    context.defaultBranch,
    context.branches[0]?.name,
  ].find((name) => name && context.branches.some((candidate) => candidate.name === name))
  if (!selectedName) return null
  const branch = context.branches.find((candidate) => candidate.name === selectedName)
  if (!branch) return null
  return {
    ...branch,
    baseRef: branch.local ? branch.name : branch.remoteRef ?? branch.name,
  }
}

function safeWorktreeSlug(branchName: string, sessionId: string): string {
  const safeBranch = branchName
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 38) || 'branch'
  const slug = `desktop-${safeBranch}-${sessionId.slice(0, 8)}`
  validateWorktreeSlug(slug)
  return slug
}

async function createDesktopWorktree(
  context: RepositoryContextResult,
  branch: ResolvedBranch,
  sessionId: string,
): Promise<PreparedSessionWorkspace> {
  if (context.state !== 'ok' || !context.repoRoot) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.notGit,
      'Cannot create a worktree outside a Git repository',
    )
  }

  const slug = safeWorktreeSlug(branch.name, sessionId)
  const worktreePath = path.join(context.repoRoot, '.claude', 'worktrees', slug)
  const branchName = worktreeBranchName(slug)

  await ensureWorktreesDirExcluded(context.repoRoot)
  await fs.mkdir(path.dirname(worktreePath), { recursive: true })
  const result = await runGit(
    context.repoRoot,
    ['worktree', 'add', '-b', branchName, worktreePath, branch.baseRef],
    WORKTREE_TIMEOUT_MS,
  )
  if (result.code !== 0) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.worktreeCreateFailed,
      `Failed to create worktree: ${result.stderr.trim() || result.stdout.trim() || 'git worktree add failed'}`,
    )
  }

  await performPostCreationSetup(context.repoRoot, worktreePath)

  return {
    workDir: worktreePath,
    repository: {
      requestedWorkDir: context.workDir,
      repoRoot: context.repoRoot,
      branch: branch.name,
      worktree: true,
      baseRef: branch.baseRef,
      worktreePath,
      worktreeBranch: branchName,
      worktreeSlug: slug,
    },
  }
}

function planIsolatedWorktree(
  context: RepositoryContextResult,
  branch: ResolvedBranch,
  sessionId: string,
): PreparedSessionWorkspace {
  if (context.state !== 'ok' || !context.repoRoot) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.notGit,
      'Cannot create a worktree outside a Git repository',
    )
  }

  const slug = safeWorktreeSlug(branch.name, sessionId)
  const worktreePath = path.join(context.repoRoot, '.claude', 'worktrees', slug)
  const branchName = worktreeBranchName(slug)

  return {
    workDir: context.workDir,
    repository: {
      requestedWorkDir: context.workDir,
      repoRoot: context.repoRoot,
      branch: branch.name,
      worktree: true,
      baseRef: branch.baseRef,
      worktreePath,
      worktreeBranch: branchName,
      worktreeSlug: slug,
    },
  }
}

async function switchExistingCheckout(
  context: RepositoryContextResult,
  branch: ResolvedBranch,
): Promise<PreparedSessionWorkspace> {
  if (context.state !== 'ok' || !context.repoRoot) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.notGit,
      'Cannot switch branches outside a Git repository',
    )
  }

  if (branch.name === context.currentBranch) {
    return {
      workDir: context.workDir,
      repository: {
        requestedWorkDir: context.workDir,
        repoRoot: context.repoRoot,
        branch: branch.name,
        worktree: false,
        baseRef: branch.baseRef,
      },
    }
  }

  if (branch.checkedOut) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.branchCheckedOut,
      `Branch "${branch.name}" is already checked out in another worktree.`,
    )
  }

  const args = branch.local
    ? ['switch', branch.name]
    : ['switch', '--track', '-c', branch.name, branch.baseRef]
  const result = await runGit(context.workDir, args)
  if (result.code !== 0) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.switchFailed,
      `Failed to switch branch: ${result.stderr.trim() || result.stdout.trim() || 'git switch failed'}`,
    )
  }

  return {
    workDir: context.workDir,
    repository: {
      requestedWorkDir: context.workDir,
      repoRoot: context.repoRoot,
      branch: branch.name,
      worktree: false,
      baseRef: branch.baseRef,
    },
  }
}

export async function prepareSessionWorkspace(
  workDir: string,
  options: CreateSessionRepositoryOptions | undefined,
  sessionId: string,
): Promise<PreparedSessionWorkspace> {
  const absWorkDir = await resolveDirectory(workDir)

  if (!options?.branch && !options?.worktree) {
    return { workDir: absWorkDir }
  }

  const context = await getRepositoryContext(absWorkDir)
  if (context.state !== 'ok') {
    if (context.state === 'not_git_repo') {
      throw repositoryBadRequest(
        REPOSITORY_ERROR.notGit,
        'Selected directory is not a Git repository',
      )
    }
    if (context.state === 'missing_workdir') {
      throw repositoryBadRequest(
        REPOSITORY_ERROR.workdirMissing,
        context.error || 'Working directory does not exist',
      )
    }
    throw repositoryBadRequest(
      REPOSITORY_ERROR.contextFailed,
      context.error || 'Failed to inspect Git repository',
    )
  }

  const branch = resolveBranch(context, options.branch)
  if (!branch) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.branchNotFound,
      `Branch not found: ${options.branch || 'default branch'}`,
    )
  }

  return options.worktree
    ? createDesktopWorktree(context, branch, sessionId)
    : switchExistingCheckout(context, branch)
}

export async function resolveSessionWorkspaceLaunch(
  workDir: string,
  options: CreateSessionRepositoryOptions | undefined,
  sessionId: string,
): Promise<PreparedSessionWorkspace> {
  if ((options?.branch || options?.worktree) && getRuntimeMode() === 'web') {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.notGit,
      'Repository / worktree launch is not supported in web mode. Use the default workspace.',
    )
  }

  const absWorkDir = await resolveDirectory(workDir)

  if (!options?.branch && !options?.worktree) {
    return { workDir: absWorkDir }
  }

  const context = await getRepositoryContext(absWorkDir)
  if (context.state !== 'ok') {
    if (context.state === 'not_git_repo') {
      throw repositoryBadRequest(
        REPOSITORY_ERROR.notGit,
        'Selected directory is not a Git repository',
      )
    }
    if (context.state === 'missing_workdir') {
      throw repositoryBadRequest(
        REPOSITORY_ERROR.workdirMissing,
        context.error || 'Working directory does not exist',
      )
    }
    throw repositoryBadRequest(
      REPOSITORY_ERROR.contextFailed,
      context.error || 'Failed to inspect Git repository',
    )
  }

  const branch = resolveBranch(context, options.branch)
  if (!branch) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.branchNotFound,
      `Branch not found: ${options.branch || 'default branch'}`,
    )
  }

  return options.worktree
    ? planIsolatedWorktree(context, branch, sessionId)
    : {
        workDir: context.workDir,
        repository: {
          requestedWorkDir: context.workDir,
          repoRoot: context.repoRoot,
          branch: branch.name,
          worktree: false,
          baseRef: branch.baseRef,
        },
      }
}
