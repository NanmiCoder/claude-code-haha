/**
 * Filesystem browser & search API — supports directory browsing and file search
 * for the DirectoryPicker component and @-triggered file search popup.
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import ignore from 'ignore'
import { getGlobalConfig } from '../../utils/config.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { findGitRoot, gitExe } from '../../utils/git.js'
import { ripGrep } from '../../utils/ripgrep.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { getWorkspaceRoot } from '../services/workspaceRootInstance.js'

function ensureInsideWorkspaceRoot(targetPath: string): string | null {
  let root
  try {
    root = getWorkspaceRoot()
  } catch {
    // Workspace root not configured — allow all paths (used in non-SaaS test scenarios)
    return null
  }
  if (!root.isInsideRoot(targetPath)) {
    return 'Access denied: path outside workspace root'
  }
  return null
}

type FilesystemEntry = {
  name: string
  path: string
  isDirectory: boolean
  relativePath?: string
}

type ScoredFilesystemEntry = FilesystemEntry & {
  score: number
}

const FILE_SEARCH_TIMEOUT_MS = 10_000

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const target = normalizeComparablePath(targetPath)
  const root = normalizeComparablePath(rootPath)
  return target === root || target.startsWith(`${root}${path.sep}`)
}

function normalizeComparablePath(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isAllowedFilesystemPath(targetPath: string): boolean {
  const resolvedPath = path.resolve(targetPath)
  const homeDir = path.resolve(os.homedir())

  if (isWithinRoot(resolvedPath, homeDir) || isWithinRoot(resolvedPath, '/tmp')) {
    return true
  }

  // macOS reports /tmp as /private/tmp via native folder pickers and realpath().
  if (process.platform === 'darwin' && isWithinRoot(resolvedPath, '/private/tmp')) {
    return true
  }

  return false
}

export async function handleFilesystemRoute(pathname: string, url: URL): Promise<Response> {
  if (pathname === '/api/filesystem/browse') {
    return handleBrowse(url)
  }

  if (pathname === '/api/filesystem/file') {
    return handleServeFile(url)
  }

  if (pathname === '/api/filesystem/read') {
    return handleRead(url)
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
}

async function handleServeFile(url: URL): Promise<Response> {
  const filePath = url.searchParams.get('path')
  if (!filePath) {
    return json({ error: 'Missing path parameter' }, 400)
  }

  const resolvedPath = path.resolve(filePath)

  const guard = ensureInsideWorkspaceRoot(resolvedPath)
  if (guard) return json({ error: guard }, 403)

  if (!isAllowedFilesystemPath(resolvedPath)) {
    return json({ error: 'Access denied: path outside allowed directory' }, 403)
  }

  const ext = path.extname(resolvedPath).toLowerCase()
  const mimeType = IMAGE_MIME_TYPES[ext]

  if (!mimeType) {
    return json({ error: 'Unsupported file type' }, 400)
  }

  try {
    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) {
      return json({ error: 'Not a file' }, 400)
    }
    // Limit to 50MB
    if (stat.size > 50 * 1024 * 1024) {
      return json({ error: 'File too large' }, 400)
    }

    const data = fs.readFileSync(resolvedPath)
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(stat.size),
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return json({ error: 'File not found' }, 404)
  }
}

async function handleRead(url: URL): Promise<Response> {
  const filePath = url.searchParams.get('path')
  if (!filePath) {
    return json({ error: 'Missing path parameter' }, 400)
  }

  const resolvedPath = path.resolve(filePath)

  const guard = ensureInsideWorkspaceRoot(resolvedPath)
  if (guard) return json({ error: guard }, 403)

  try {
    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) {
      return json({ error: 'Not a file' }, 400)
    }
    const data = fs.readFileSync(resolvedPath, 'utf-8')
    return json({ path: resolvedPath, content: data }, 200)
  } catch {
    return json({ error: 'File not found' }, 404)
  }
}

async function handleBrowse(url: URL): Promise<Response> {
  const targetPath = url.searchParams.get('path') || os.homedir() || '/'
  const resolvedPath = path.resolve(targetPath)

  const guard = ensureInsideWorkspaceRoot(resolvedPath)
  if (guard) return json({ error: guard }, 403)

  if (!isAllowedFilesystemPath(resolvedPath)) {
    return json({ error: 'Access denied: path outside allowed directory' }, 403)
  }

  const searchQuery = url.searchParams.get('search') || ''
  const includeFiles = url.searchParams.get('includeFiles') === 'true'
  const maxResults = Math.min(parseInt(url.searchParams.get('maxResults') || '200', 10), 200)

  try {
    const stat = fs.statSync(resolvedPath)
    if (!stat.isDirectory()) {
      return json({ error: 'Not a directory', path: resolvedPath }, 400)
    }

    if (searchQuery) {
      const results = await searchFilesystemEntries(resolvedPath, searchQuery, {
        includeFiles,
        maxResults,
      })

      return json({
        currentPath: resolvedPath,
        parentPath: path.dirname(resolvedPath),
        entries: results,
        query: searchQuery,
      })
    }

    const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })

    // Browse mode: show all directories (and optionally files)
    const filtered = entries.filter((e) => {
      if (e.name.startsWith('.')) return false
      if (e.isDirectory()) return true
      return includeFiles
    })

    const entries_list = filtered
      .map((e) => ({
        name: e.name,
        path: path.join(resolvedPath, e.name),
        isDirectory: e.isDirectory(),
        relativePath: e.name,
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

    return json({
      currentPath: resolvedPath,
      parentPath: path.dirname(resolvedPath),
      entries: entries_list,
    })
  } catch (err) {
    return json({ error: `Cannot read directory: ${err}`, path: resolvedPath }, 500)
  }
}

async function searchFilesystemEntries(
  rootPath: string,
  searchQuery: string,
  options: { includeFiles: boolean; maxResults: number },
): Promise<FilesystemEntry[]> {
  const normalizedQuery = normalizeSearchText(searchQuery)
  if (!normalizedQuery) return []

  const candidates = await getSearchCandidates(rootPath, options.includeFiles)
  const results = candidates
    .map((entry): ScoredFilesystemEntry | null => {
      const relativePath = entry.relativePath ?? entry.name
      const score = scoreFilesystemEntry(entry.name, relativePath, normalizedQuery, entry.isDirectory)
      return score > 0 ? { ...entry, score } : null
    })
    .filter((entry): entry is ScoredFilesystemEntry => entry !== null)

  return results
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      const aPath = a.relativePath ?? a.name
      const bPath = b.relativePath ?? b.name
      const aDepth = pathDepth(aPath)
      const bDepth = pathDepth(bPath)
      if (aDepth !== bDepth) return aDepth - bDepth
      return (a.relativePath ?? a.name).localeCompare(b.relativePath ?? b.name)
    })
    .slice(0, options.maxResults)
    .map(({ score: _score, ...entry }) => entry)
}

async function getSearchCandidates(rootPath: string, includeFiles: boolean): Promise<FilesystemEntry[]> {
  const files = await getProjectSearchFiles(rootPath)
  const entries = new Map<string, FilesystemEntry>()

  for (const filePath of files) {
    const normalizedFile = normalizeRelativePath(filePath)
    if (!normalizedFile || !isRelativeInsideRoot(normalizedFile)) continue

    let currentDir = path.posix.dirname(normalizedFile)
    while (currentDir !== '.') {
      addCandidate(entries, rootPath, currentDir, true)
      const parent = path.posix.dirname(currentDir)
      if (parent === currentDir) break
      currentDir = parent
    }

    if (includeFiles) {
      addCandidate(entries, rootPath, normalizedFile, false)
    }
  }

  return [...entries.values()]
}

function addCandidate(entries: Map<string, FilesystemEntry>, rootPath: string, relativePath: string, isDirectory: boolean): void {
  if (entries.has(relativePath)) return
  entries.set(relativePath, {
    name: path.posix.basename(relativePath),
    path: path.join(rootPath, ...relativePath.split('/')),
    isDirectory,
    relativePath,
  })
}

async function getProjectSearchFiles(rootPath: string): Promise<string[]> {
  const respectGitignore = shouldRespectGitignore()
  const gitFiles = await getFilesUsingGit(rootPath, respectGitignore)
  if (gitFiles !== null) {
    return gitFiles
  }

  return getFilesUsingRipgrep(rootPath, respectGitignore)
}

function shouldRespectGitignore(): boolean {
  const projectSettings = getInitialSettings()
  const globalConfig = getGlobalConfig()
  return projectSettings.respectGitignore ?? globalConfig.respectGitignore ?? true
}

async function getFilesUsingGit(rootPath: string, respectGitignore: boolean): Promise<string[] | null> {
  const repoRoot = findGitRoot(rootPath)
  if (!repoRoot) return null

  const trackedResult = await execFileNoThrowWithCwd(
    gitExe(),
    ['-c', 'core.quotepath=false', 'ls-files', '--recurse-submodules'],
    { timeout: FILE_SEARCH_TIMEOUT_MS, cwd: repoRoot },
  )
  if (trackedResult.code !== 0) return null

  const untrackedArgs = respectGitignore
    ? ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']
    : ['-c', 'core.quotepath=false', 'ls-files', '--others']
  const untrackedResult = await execFileNoThrowWithCwd(gitExe(), untrackedArgs, {
    timeout: FILE_SEARCH_TIMEOUT_MS,
    cwd: repoRoot,
  })

  const files = [
    ...lines(trackedResult.stdout),
    ...(untrackedResult.code === 0 ? lines(untrackedResult.stdout) : []),
  ]
  let normalized = files
    .map(filePath => normalizeGitPath(filePath, repoRoot, rootPath))
    .filter((filePath): filePath is string => filePath !== null)

  const ignorePatterns = loadSearchIgnorePatterns(repoRoot, rootPath, false)
  if (ignorePatterns) {
    normalized = ignorePatterns.filter(normalized)
  }

  return [...new Set(normalized)]
}

async function getFilesUsingRipgrep(rootPath: string, respectGitignore: boolean): Promise<string[]> {
  const rgArgs = [
    '--files',
    '--follow',
    '--hidden',
    '--glob',
    '!.git/',
    '--glob',
    '!.svn/',
    '--glob',
    '!.hg/',
    '--glob',
    '!.bzr/',
    '--glob',
    '!.jj/',
    '--glob',
    '!.sl/',
  ]
  if (!respectGitignore) {
    rgArgs.push('--no-ignore-vcs')
  }

  const files = await ripGrep(rgArgs, rootPath, AbortSignal.timeout(FILE_SEARCH_TIMEOUT_MS))
  let normalized = files
    .map(filePath => normalizeRipgrepPath(filePath, rootPath))
    .filter((filePath): filePath is string => filePath !== null)

  const ignorePatterns = loadSearchIgnorePatterns(rootPath, rootPath, true)
  if (ignorePatterns) {
    normalized = ignorePatterns.filter(normalized)
  }

  return normalized
}

function normalizeGitPath(filePath: string, repoRoot: string, rootPath: string): string | null {
  const relativePath = path.relative(rootPath, path.join(repoRoot, filePath))
  const normalized = normalizeRelativePath(relativePath)
  return isRelativeInsideRoot(normalized) ? normalized : null
}

function normalizeRipgrepPath(filePath: string, rootPath: string): string | null {
  const relativePath = path.isAbsolute(filePath) ? path.relative(rootPath, filePath) : filePath
  const normalized = normalizeRelativePath(relativePath)
  return isRelativeInsideRoot(normalized) ? normalized : null
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function isRelativeInsideRoot(filePath: string): boolean {
  return !!filePath && filePath !== '.' && !filePath.startsWith('../') && !path.isAbsolute(filePath)
}

function lines(output: string): string[] {
  return output.trim().split('\n').map(line => line.trim()).filter(Boolean)
}

function loadSearchIgnorePatterns(repoRoot: string, rootPath: string, includeGitignore: boolean): ReturnType<typeof ignore> | null {
  const ig = ignore()
  let hasPatterns = false
  const ignoreFiles = includeGitignore ? ['.gitignore', '.ignore', '.rgignore'] : ['.ignore', '.rgignore']
  const paths = [...new Set([repoRoot, rootPath])].flatMap(dir => ignoreFiles.map(fileName => path.join(dir, fileName)))

  for (const ignorePath of paths) {
    try {
      ig.add(fs.readFileSync(ignorePath, 'utf8'))
      hasPatterns = true
    } catch {
      // Missing or unreadable ignore files should not break suggestions.
    }
  }

  return hasPatterns ? ig : null
}

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^@+/, '')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function scoreFilesystemEntry(name: string, relativePath: string, query: string, isDirectory: boolean): number {
  const normalizedName = normalizeSearchText(name)
  const normalizedPath = normalizeSearchText(relativePath)
  const pathNoExtension = normalizedPath.replace(/\.[^/.]+$/, '')
  const pathPrefix = `${query}/`
  const baseBoost = isDirectory ? 4 : 0
  const depthPenalty = Math.min(relativePath.split('/').length - 1, 8) * 2

  if (normalizedPath === query) return 150 + baseBoost - depthPenalty
  if (pathNoExtension === query) return 144 + baseBoost - depthPenalty
  if (normalizedPath.startsWith(pathPrefix)) return 136 + baseBoost - depthPenalty
  if (normalizedPath.startsWith(query)) return 112 + baseBoost - depthPenalty
  if (normalizedName === query) return 96 + baseBoost - depthPenalty
  if (normalizedName.startsWith(query)) return 88 + baseBoost - depthPenalty
  if (normalizedName.includes(query)) return 72 + baseBoost - depthPenalty
  if (normalizedPath.includes(query)) return 60 + baseBoost - depthPenalty

  const nameFuzzy = fuzzyScore(normalizedName, query)
  if (nameFuzzy > 0) return 44 + nameFuzzy + baseBoost - depthPenalty

  const pathFuzzy = fuzzyScore(normalizedPath, query)
  if (pathFuzzy > 0) return 28 + pathFuzzy + baseBoost - depthPenalty

  return 0
}

function pathDepth(relativePath: string): number {
  return relativePath.split('/').length
}

function fuzzyScore(value: string, query: string): number {
  let queryIndex = 0
  let runLength = 0
  let score = 0

  for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      runLength = 0
      continue
    }

    const boundaryBoost = valueIndex === 0 || ['/', '-', '_', '.', ' '].includes(value[valueIndex - 1] ?? '')
      ? 3
      : 0
    runLength += 1
    score += 2 + boundaryBoost + Math.min(runLength, 4)
    queryIndex += 1
  }

  return queryIndex === query.length ? score : 0
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
