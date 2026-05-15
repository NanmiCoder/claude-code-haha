import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleFilesystemRoute } from '../api/filesystem.js'
import { configureWorkspaceRoot } from '../services/workspaceRootInstance.js'

const cleanupDirs = new Set<string>()

beforeAll(() => {
  // Configure workspace root to allow access to the user's home directory and /tmp.
  configureWorkspaceRoot(os.homedir())
})

function makeUrl(route: string, params: Record<string, string>): URL {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url
}

afterEach(async () => {
  for (const dir of cleanupDirs) {
    await fsp.rm(dir, { recursive: true, force: true })
  }
  cleanupDirs.clear()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
}

describe('filesystem API', () => {
  it('allows browsing a directory under the user home directory', async () => {
    const homeFixtureDir = await fsp.mkdtemp(path.join(os.homedir(), 'claude-filesystem-test-'))
    cleanupDirs.add(homeFixtureDir)
    await fsp.writeFile(path.join(homeFixtureDir, 'note.txt'), 'hello')

    const res = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: homeFixtureDir,
        includeFiles: 'true',
      }),
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { entries: Array<{ name: string }> }
    expect(body.entries.some((entry) => entry.name === 'note.txt')).toBe(true)
  })

  it('fuzzy searches files and directories below the selected root', async () => {
    const homeFixtureDir = await fsp.mkdtemp(path.join(os.homedir(), 'claude-filesystem-test-'))
    cleanupDirs.add(homeFixtureDir)
    git(homeFixtureDir, 'init')
    await fsp.mkdir(path.join(homeFixtureDir, 'src', 'commands'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'src', 'commands', 'files'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'src', 'constants'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'src', 'hooks'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'desktop', 'src'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'scripts', 'quality-gate', 'baseline', 'fixtures', 'cross-module-refactor', 'src'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, '__pycache__'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'node_modules', 'pkg'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, '.venv', 'lib'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'tmp-ignore'), { recursive: true })
    await fsp.writeFile(path.join(homeFixtureDir, '.gitignore'), ['__pycache__/', 'node_modules/', '.venv/', 'venv/'].join('\n'))
    await fsp.writeFile(path.join(homeFixtureDir, '.ignore'), 'tmp-ignore/')
    await fsp.writeFile(path.join(homeFixtureDir, 'src', 'commands', 'files.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, 'src', 'commands', 'files', 'index.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, 'src', 'constants', 'fileSearch.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, 'src', 'hooks', 'useFileSearch.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, 'desktop', 'src', 'main.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, 'scripts', 'quality-gate', 'baseline', 'fixtures', 'cross-module-refactor', 'src', 'index.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, '__pycache__', 'fileSearch.cpython-311.pyc'), '')
    await fsp.writeFile(path.join(homeFixtureDir, 'node_modules', 'pkg', 'files.js'), '')
    await fsp.writeFile(path.join(homeFixtureDir, '.venv', 'lib', 'files.py'), '')
    await fsp.writeFile(path.join(homeFixtureDir, 'tmp-ignore', 'files.tmp'), '')

    const res = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: homeFixtureDir,
        search: 'files',
        includeFiles: 'true',
      }),
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { entries: Array<{ name: string; relativePath?: string; isDirectory: boolean }> }
    expect(body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'files.ts',
        relativePath: 'src/commands/files.ts',
        isDirectory: false,
      }),
    ]))
    expect(body.entries.some((entry) => entry.relativePath === 'src/constants/fileSearch.ts')).toBe(true)
    expect(body.entries.find((entry) => entry.relativePath === 'src/commands/files')?.isDirectory).toBe(true)
    expect(body.entries.some((entry) => entry.relativePath === '__pycache__/fileSearch.cpython-311.pyc')).toBe(false)
    expect(body.entries.some((entry) => entry.relativePath === 'node_modules/pkg/files.js')).toBe(false)
    expect(body.entries.some((entry) => entry.relativePath === '.venv/lib/files.py')).toBe(false)
    expect(body.entries.some((entry) => entry.relativePath === 'tmp-ignore/files.tmp')).toBe(false)

    const srcRes = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: homeFixtureDir,
        search: 'src',
        includeFiles: 'true',
      }),
    )

    expect(srcRes.status).toBe(200)
    const srcBody = await srcRes.json() as { entries: Array<{ relativePath?: string }> }
    const srcPaths = srcBody.entries.map(entry => entry.relativePath)
    expect(srcPaths[0]).toBe('src')
    expect(srcPaths.indexOf('src/hooks')).toBeGreaterThan(-1)
    expect(srcPaths.indexOf('desktop/src')).toBeGreaterThan(-1)
    expect(srcPaths.indexOf('scripts/quality-gate/baseline/fixtures/cross-module-refactor/src')).toBeGreaterThan(-1)
    expect(srcPaths.indexOf('src/hooks')).toBeLessThan(srcPaths.indexOf('desktop/src'))
    expect(srcPaths.indexOf('src/hooks')).toBeLessThan(srcPaths.indexOf('scripts/quality-gate/baseline/fixtures/cross-module-refactor/src'))
  })

  it('falls back to ripgrep search outside git and still respects ignore files', async () => {
    const homeFixtureDir = await fsp.mkdtemp(path.join(os.homedir(), 'claude-filesystem-test-'))
    cleanupDirs.add(homeFixtureDir)
    await fsp.mkdir(path.join(homeFixtureDir, 'app'), { recursive: true })
    await fsp.mkdir(path.join(homeFixtureDir, 'node_modules', 'pkg'), { recursive: true })
    await fsp.writeFile(path.join(homeFixtureDir, '.gitignore'), 'node_modules/')
    await fsp.writeFile(path.join(homeFixtureDir, 'app', 'cache-result.ts'), 'export {}')
    await fsp.writeFile(path.join(homeFixtureDir, 'node_modules', 'pkg', 'cache-result.js'), '')

    const res = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: homeFixtureDir,
        search: 'cache',
        includeFiles: 'true',
      }),
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { entries: Array<{ relativePath?: string; isDirectory: boolean }> }
    expect(body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: 'app/cache-result.ts',
        isDirectory: false,
      }),
    ]))
    expect(body.entries.some((entry) => entry.relativePath === 'node_modules/pkg/cache-result.js')).toBe(false)
  })

  it('accepts /private/tmp aliases on macOS for browsing and file serving', async () => {
    if (process.platform !== 'darwin') return

    const tmpFixtureDir = await fsp.mkdtemp('/tmp/claude-filesystem-test-')
    cleanupDirs.add(tmpFixtureDir)
    const canonicalTmpDir = fs.realpathSync(tmpFixtureDir)
    const imagePath = path.join(canonicalTmpDir, 'preview.png')
    await fsp.writeFile(
      imagePath,
      Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082', 'hex'),
    )

    const browseRes = await handleFilesystemRoute(
      '/api/filesystem/browse',
      makeUrl('/api/filesystem/browse', {
        path: canonicalTmpDir,
        includeFiles: 'true',
      }),
    )
    expect(browseRes.status).toBe(200)
    const browseBody = await browseRes.json() as { entries: Array<{ name: string }> }
    expect(browseBody.entries.some((entry) => entry.name === 'preview.png')).toBe(true)

    const fileRes = await handleFilesystemRoute(
      '/api/filesystem/file',
      makeUrl('/api/filesystem/file', {
        path: imagePath,
      }),
    )
    expect(fileRes.status).toBe(200)
    expect(fileRes.headers.get('Content-Type')).toBe('image/png')
  })
})
