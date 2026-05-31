import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { WorkspaceService } from '../services/workspaceService.js'

const cleanupDirs = new Set<string>()
const ONE_MIB = 1024 * 1024

function trackDir(dir: string): string {
  cleanupDirs.add(dir)
  return dir
}

async function makeTempDir(prefix: string): Promise<string> {
  return trackDir(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
}

async function createGitWorkspace(): Promise<string> {
  const repoDir = await makeTempDir('workspace-service-git-')

  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'workspace-service@example.com')
  git(repoDir, 'config', 'user.name', 'Workspace Service')

  await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'before\n')
  await fs.writeFile(path.join(repoDir, 'deleted.txt'), 'delete me\n')
  await fs.writeFile(path.join(repoDir, 'clean.txt'), 'clean\n')
  git(repoDir, 'add', 'tracked.txt', 'deleted.txt', 'clean.txt')
  git(repoDir, 'commit', '-m', 'initial')

  await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'before\nafter\n')
  await fs.writeFile(path.join(repoDir, 'new.txt'), 'new file\n')
  git(repoDir, 'add', 'new.txt')
  await fs.unlink(path.join(repoDir, 'deleted.txt'))
  await fs.writeFile(path.join(repoDir, 'untracked.txt'), 'still untracked\n')

  return repoDir
}

async function createNestedGitWorkspace(): Promise<{
  repoDir: string
  workDir: string
}> {
  const repoDir = await makeTempDir('workspace-service-nested-git-')
  const workDir = path.join(repoDir, 'subdir')

  git(repoDir, 'init')
  git(repoDir, 'config', 'user.email', 'workspace-service@example.com')
  git(repoDir, 'config', 'user.name', 'Workspace Service')

  await fs.mkdir(workDir)
  await fs.writeFile(path.join(repoDir, 'root.txt'), 'root original\n')
  await fs.writeFile(path.join(workDir, 'sub.txt'), 'sub original\n')
  git(repoDir, 'add', 'root.txt', 'subdir/sub.txt')
  git(repoDir, 'commit', '-m', 'initial')

  await fs.writeFile(path.join(repoDir, 'root.txt'), 'root original\nroot changed\n')
  await fs.writeFile(path.join(workDir, 'sub.txt'), 'sub original\nsub changed\n')

  return { repoDir, workDir }
}

afterEach(async () => {
  for (const dir of cleanupDirs) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  cleanupDirs.clear()
})

describe('WorkspaceService', () => {
  it('returns git status for modified, added, deleted, and untracked files', async () => {
    const repoDir = await createGitWorkspace()
    const service = new WorkspaceService(async (sessionId) => sessionId === 'session-1' ? repoDir : null)

    const result = await service.getStatus('session-1')

    expect(result.state).toBe('ok')
    expect(result.workDir).toBe(repoDir)
    expect(result.isGitRepo).toBe(true)
    expect(result.repoName).toBe(path.basename(repoDir))
    expect(result.branch).toBeTruthy()

    const files = new Map(result.changedFiles.map((file) => [file.path, file]))
    expect(Array.from(files.keys()).sort()).toEqual([
      'deleted.txt',
      'new.txt',
      'tracked.txt',
      'untracked.txt',
    ])
    expect(files.get('tracked.txt')?.status).toBe('modified')
    expect(files.get('tracked.txt')?.additions).toBeGreaterThan(0)
    expect(files.get('new.txt')?.status).toBe('added')
    expect(files.get('new.txt')?.additions).toBeGreaterThan(0)
    expect(files.get('deleted.txt')?.status).toBe('deleted')
    expect(files.get('deleted.txt')?.deletions).toBeGreaterThan(0)
    expect(files.get('untracked.txt')).toMatchObject({
      status: 'untracked',
      additions: 1,
      deletions: 0,
    })
  })

  it('scopes git status and diff paths to a nested workDir inside a repo', async () => {
    const { repoDir, workDir } = await createNestedGitWorkspace()
    const service = new WorkspaceService(async (sessionId) => sessionId === 'session-1' ? workDir : null)

    const status = await service.getStatus('session-1')

    expect(status.state).toBe('ok')
    expect(status.workDir).toBe(workDir)
    expect(status.repoName).toBe(path.basename(repoDir))
    expect(status.changedFiles).toHaveLength(1)
    expect(status.changedFiles[0]).toMatchObject({
      path: 'sub.txt',
      status: 'modified',
    })
    expect(status.changedFiles[0]?.additions).toBeGreaterThan(0)
    expect(status.changedFiles[0]?.deletions).toBeGreaterThanOrEqual(0)
    expect(status.changedFiles.some((file) => file.path === 'root.txt')).toBe(false)

    const diff = await service.getDiff('session-1', 'sub.txt')
    expect(diff.state).toBe('ok')
    expect(diff.diff).toContain('subdir/sub.txt')
    expect(diff.diff?.length).toBeGreaterThan(0)
  })

  it('returns explicit non-git and missing-workdir states', async () => {
    const nonGitDir = await makeTempDir('workspace-service-non-git-')
    const missingDir = path.join(await makeTempDir('workspace-service-missing-parent-'), 'missing')
    const service = new WorkspaceService(async (sessionId) => {
      if (sessionId === 'non-git') return nonGitDir
      if (sessionId === 'missing') return missingDir
      return null
    })

    await expect(service.getStatus('unknown')).rejects.toThrow('Session not found: unknown')

    await expect(service.getStatus('non-git')).resolves.toMatchObject({
      state: 'ok',
      workDir: nonGitDir,
      repoName: path.basename(nonGitDir),
      isGitRepo: false,
      changedFiles: [],
    })

    await expect(service.getStatus('missing')).resolves.toMatchObject({
      state: 'missing_workdir',
      workDir: missingDir,
      isGitRepo: false,
      changedFiles: [],
    })
  })

  it('reports session tool edits without requiring a git repository', async () => {
    const nonGitDir = await makeTempDir('workspace-service-session-changes-')
    await fs.mkdir(path.join(nonGitDir, 'src'))
    await fs.writeFile(path.join(nonGitDir, 'src/App.jsx'), 'export default function App() { return <main>New</main> }\n')

    const service = new WorkspaceService(
      async () => nonGitDir,
      async () => [{
        id: 'assistant-1',
        type: 'tool_use',
        timestamp: new Date().toISOString(),
        content: [{
          type: 'tool_use',
          name: 'Edit',
          input: {
            file_path: 'src/App.jsx',
            old_string: 'export default function App() { return <main>Old</main> }\n',
            new_string: 'export default function App() { return <main>New</main> }\n',
          },
        }],
      }],
    )

    const status = await service.getStatus('session-1')

    expect(status).toMatchObject({
      state: 'ok',
      workDir: nonGitDir,
      isGitRepo: false,
      changedFiles: [{
        path: 'src/App.jsx',
        status: 'modified',
        additions: 1,
        deletions: 1,
      }],
    })

    const diff = await service.getDiff('session-1', 'src/App.jsx')
    expect(diff.state).toBe('ok')
    expect(diff.diff).toContain('diff --session a/src/App.jsx b/src/App.jsx')
    expect(diff.diff).toContain('-export default function App() { return <main>Old</main> }')
    expect(diff.diff).toContain('+export default function App() { return <main>New</main> }')
  })

  it('reports file-history changes without requiring a git repository', async () => {
    const nonGitDir = await makeTempDir('workspace-service-file-history-')
    const generatedFile = path.join(nonGitDir, 'aacc', 'src', 'App.tsx')
    await fs.mkdir(path.dirname(generatedFile), { recursive: true })
    await fs.writeFile(generatedFile, 'export default function App() { return <main>Tetris</main> }\n')

    const service = new WorkspaceService(
      async () => nonGitDir,
      async () => [],
      async () => [{
        messageId: '11111111-1111-4111-8111-111111111111',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
        trackedFileBackups: {
          'aacc/src/App.tsx': {
            backupFileName: null,
            version: 1,
            backupTime: new Date('2026-01-01T00:00:00.000Z'),
          },
        },
      }],
    )

    const status = await service.getStatus('session-1')

    expect(status).toMatchObject({
      state: 'ok',
      workDir: nonGitDir,
      isGitRepo: false,
      changedFiles: [{
        path: 'aacc/src/App.tsx',
        status: 'added',
        additions: 1,
        deletions: 0,
      }],
    })

    const diff = await service.getDiff('session-1', 'aacc/src/App.tsx')
    expect(diff.state).toBe('ok')
    expect(diff.diff).toContain('diff --session /dev/null b/aacc/src/App.tsx')
    expect(diff.diff).toContain('+export default function App() { return <main>Tetris</main> }')
  })

  it('matches Windows file-history paths case-insensitively inside the workspace', async () => {
    if (process.platform !== 'win32') return

    const nonGitDir = await makeTempDir('workspace-service-windows-paths-')
    const targetFile = path.join(nonGitDir, 'Child', 'index.ts')
    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.writeFile(targetFile, 'export const value = 1\n')

    const lowerDrivePath = targetFile[0]?.toLowerCase() + targetFile.slice(1)
    const service = new WorkspaceService(
      async () => nonGitDir,
      async () => [],
      async () => [{
        messageId: '22222222-2222-4222-8222-222222222222',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
        trackedFileBackups: {
          [lowerDrivePath]: {
            backupFileName: null,
            version: 1,
            backupTime: new Date('2026-01-01T00:00:00.000Z'),
          },
        },
      }],
    )

    const status = await service.getStatus('session-1')

    expect(status.changedFiles).toEqual([{
      path: 'Child/index.ts',
      oldPath: undefined,
      status: 'added',
      additions: 1,
      deletions: 0,
    }])
  })

  it('rejects traversal attempts for file, diff, and tree access', async () => {
    const repoDir = await createGitWorkspace()
    const service = new WorkspaceService(async () => repoDir)

    await expect(service.readFile('session-1', '../outside.txt')).rejects.toThrow(/outside workspace/)
    await expect(service.getDiff('session-1', '../outside.txt')).resolves.toMatchObject({
      state: 'error',
      path: '../outside.txt',
    })
    await expect(service.readTree('session-1', '../outside')).rejects.toThrow(/outside workspace/)
  })

  it('reads symlink targets that point outside the workspace', async () => {
    const workDir = await makeTempDir('workspace-service-symlink-')
    const outsideDir = await makeTempDir('workspace-service-symlink-outside-')
    const outsideFile = path.join(outsideDir, 'secret.txt')
    await fs.writeFile(outsideFile, 'top secret\n')
    await fs.symlink(outsideFile, path.join(workDir, 'escape.txt'))

    const service = new WorkspaceService(async () => workDir)

    // 软连接视为工作区内文件，可以正常读取
    await expect(service.readFile('session-1', 'escape.txt')).resolves.toMatchObject({
      state: 'ok',
      content: 'top secret\n',
    })
  })

  it('handles symlinks in git repos without outside-workspace errors', async () => {
    const repoDir = await makeTempDir('workspace-service-symlink-git-')
    const outsideDir = await makeTempDir('workspace-service-symlink-git-outside-')
    const outsideFile = path.join(outsideDir, 'secret.txt')

    git(repoDir, 'init')
    git(repoDir, 'config', 'user.email', 'workspace-service@example.com')
    git(repoDir, 'config', 'user.name', 'Workspace Service')
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'tracked\n')
    git(repoDir, 'add', 'tracked.txt')
    git(repoDir, 'commit', '-m', 'initial')

    await fs.writeFile(outsideFile, 'top secret\n')
    await fs.symlink(outsideFile, path.join(repoDir, 'escape.txt'))

    const service = new WorkspaceService(async () => repoDir)

    // 软连接 readFile 不再报 "outside workspace" 错误
    const result = await service.readFile('session-1', 'escape.txt')
    expect(result.state).toBe('ok')
    expect(result.content).toBe('top secret\n')
  })

  it('returns explicit readFile states for text, binary, large, and missing targets', async () => {
    const workDir = await makeTempDir('workspace-service-files-')
    const service = new WorkspaceService(async () => workDir)

    await fs.writeFile(path.join(workDir, 'note.ts'), 'export const answer = 42\n')
    await fs.writeFile(path.join(workDir, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    await fs.writeFile(path.join(workDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
    await fs.writeFile(
      path.join(workDir, 'large-image.png'),
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(ONE_MIB + 1, 0xff)]),
    )
    await fs.writeFile(path.join(workDir, 'large.txt'), Buffer.alloc(ONE_MIB + 1, 'a'))
    await fs.mkdir(path.join(workDir, 'folder'))

    await expect(service.readFile('session-1', 'note.ts')).resolves.toMatchObject({
      state: 'ok',
      language: 'typescript',
      size: 25,
      content: 'export const answer = 42\n',
    })
    await expect(service.readFile('session-1', 'binary.bin')).resolves.toMatchObject({
      state: 'binary',
      language: 'binary',
      size: 4,
    })
    await expect(service.readFile('session-1', 'image.png')).resolves.toMatchObject({
      state: 'ok',
      previewType: 'image',
      language: 'image',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORwA=',
      size: 5,
    })
    const largeImage = await service.readFile('session-1', 'large-image.png')
    expect(largeImage).toMatchObject({
      state: 'ok',
      previewType: 'image',
      language: 'image',
      mimeType: 'image/png',
      size: ONE_MIB + 5,
    })
    expect(largeImage.dataUrl).toStartWith('data:image/png;base64,')
    await expect(service.readFile('session-1', 'large.txt')).resolves.toMatchObject({
      state: 'ok',
      previewType: 'text',
      language: 'text',
      size: ONE_MIB + 1,
      readBytes: ONE_MIB,
      truncated: true,
      content: 'a'.repeat(ONE_MIB),
    })
    await expect(service.readFile('session-1', 'missing.txt')).resolves.toMatchObject({
      state: 'missing',
    })
    await expect(service.readFile('session-1', 'folder')).resolves.toMatchObject({
      state: 'missing',
    })
  })

  it('lists a single directory level with dotfiles included and directories first', async () => {
    const workDir = await makeTempDir('workspace-service-tree-')
    const service = new WorkspaceService(async () => workDir)

    await fs.mkdir(path.join(workDir, '.hidden-dir'))
    await fs.mkdir(path.join(workDir, '.git'))
    await fs.mkdir(path.join(workDir, 'b-dir'))
    await fs.mkdir(path.join(workDir, 'a-dir'))
    await fs.mkdir(path.join(workDir, 'a-dir', 'inner'))
    await fs.writeFile(path.join(workDir, 'a-dir', 'note.txt'), 'nested\n')
    await fs.writeFile(path.join(workDir, 'z-file.txt'), 'root file\n')
    await fs.writeFile(path.join(workDir, '.hidden.txt'), 'ignore\n')

    await expect(service.readTree('session-1')).resolves.toMatchObject({
      state: 'ok',
      path: '',
      entries: [
        { name: 'a-dir', path: 'a-dir', isDirectory: true, isSymlink: false },
        { name: 'b-dir', path: 'b-dir', isDirectory: true, isSymlink: false },
        { name: 'z-file.txt', path: 'z-file.txt', isDirectory: false, isSymlink: false },
      ],
    })

    await expect(service.readTree('session-1', 'a-dir')).resolves.toMatchObject({
      state: 'ok',
      path: 'a-dir',
      entries: [
        { name: 'inner', path: 'a-dir/inner', isDirectory: true, isSymlink: false },
        { name: 'note.txt', path: 'a-dir/note.txt', isDirectory: false, isSymlink: false },
      ],
    })
  })

  it('detects symlinks and marks them with isSymlink: true', async () => {
    const workDir = await makeTempDir('workspace-service-symlink-')
    const service = new WorkspaceService(async () => workDir)

    await fs.writeFile(path.join(workDir, 'real-file.txt'), 'real\n')
    await fs.mkdir(path.join(workDir, 'real-dir'))
    await fs.symlink('real-file.txt', path.join(workDir, 'link-to-file'))
    await fs.symlink('real-dir', path.join(workDir, 'link-to-dir'))

    const result = await service.readTree('session-1')
    expect(result.state).toBe('ok')
    const entries = result.entries!
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]))

    expect(byName['real-file.txt']).toMatchObject({ isDirectory: false, isSymlink: false })
    expect(byName['real-dir']).toMatchObject({ isDirectory: true, isSymlink: false })
    expect(byName['link-to-file']).toMatchObject({ isDirectory: false, isSymlink: true })
    expect(byName['link-to-dir']).toMatchObject({ isSymlink: true })
  })

  it('returns diffs for modified, added, deleted, and untracked files', async () => {
    const repoDir = await createGitWorkspace()
    const service = new WorkspaceService(async (sessionId) => sessionId === 'session-1' ? repoDir : null)

    const modified = await service.getDiff('session-1', 'tracked.txt')
    expect(modified.state).toBe('ok')
    expect(modified.diff).toContain('tracked.txt')
    expect(modified.diff.length).toBeGreaterThan(0)

    const added = await service.getDiff('session-1', 'new.txt')
    expect(added.state).toBe('ok')
    expect(added.diff).toContain('new.txt')
    expect(added.diff.length).toBeGreaterThan(0)

    const deleted = await service.getDiff('session-1', 'deleted.txt')
    expect(deleted.state).toBe('ok')
    expect(deleted.diff).toContain('deleted.txt')
    expect(deleted.diff.length).toBeGreaterThan(0)

    const untracked = await service.getDiff('session-1', 'untracked.txt')
    expect(untracked.state).toBe('ok')
    expect(untracked.diff).toContain('untracked.txt')
    expect(untracked.diff.length).toBeGreaterThan(0)

    await expect(service.getDiff('session-1', 'clean.txt')).resolves.toMatchObject({
      state: 'missing',
      path: 'clean.txt',
    })

    const nonGitDir = await makeTempDir('workspace-service-diff-non-git-')
    const nonGitService = new WorkspaceService(async () => nonGitDir)
    await expect(nonGitService.getDiff('session-1', 'whatever.txt')).resolves.toMatchObject({
      state: 'not_git_repo',
      path: 'whatever.txt',
    })
  })

  it('returns explicit error state when git status fails instead of ok-empty', async () => {
    const repoDir = await createGitWorkspace()
    const service = new WorkspaceService(async () => repoDir) as WorkspaceService & {
      runGit: (workDir: string, args: string[]) => Promise<{
        stdout: string
        stderr: string
        code: number
      }>
    }

    service.runGit = async (workDir, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: `${workDir}\n`, stderr: '', code: 0 }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { stdout: 'main\n', stderr: '', code: 0 }
      }
      if (args[0] === 'status') {
        return { stdout: '', stderr: 'fatal: synthetic git failure', code: 1 }
      }
      return { stdout: '', stderr: 'unexpected call', code: 1 }
    }

    await expect(service.getStatus('session-1')).resolves.toMatchObject({
      state: 'error',
      isGitRepo: true,
    })

    const result = await service.getStatus('session-1')
    expect(result.state).toBe('error')
    expect(result.changedFiles).toEqual([])
    expect(result.error).toContain('Failed to read git status')
    expect(result.error).toContain('synthetic git failure')
  })

  it('reads tracked diff stats in one bulk git call', async () => {
    const repoDir = await makeTempDir('workspace-service-bulk-stats-')
    await fs.writeFile(path.join(repoDir, 'a.txt'), 'a\n')
    await fs.writeFile(path.join(repoDir, 'b.txt'), 'b\n')
    const diffStatCalls: string[][] = []
    const service = new WorkspaceService(async () => repoDir) as WorkspaceService & {
      runGit: (workDir: string, args: string[]) => Promise<{
        stdout: string
        stderr: string
        code: number
      }>
    }

    service.runGit = async (_workDir, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: `${repoDir}\n`, stderr: '', code: 0 }
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { stdout: 'main\n', stderr: '', code: 0 }
      }
      if (args[0] === 'status') {
        return { stdout: ' M a.txt\0 M b.txt\0', stderr: '', code: 0 }
      }
      if (args[0] === 'diff' && args.includes('--numstat')) {
        diffStatCalls.push(args)
        return { stdout: '1\t0\ta.txt\n2\t3\tb.txt\n', stderr: '', code: 0 }
      }
      return { stdout: '', stderr: `unexpected git call: ${args.join(' ')}`, code: 1 }
    }

    const result = await service.getStatus('session-1')

    expect(result.state).toBe('ok')
    expect(diffStatCalls).toHaveLength(1)
    expect(result.changedFiles).toEqual([
      { path: 'a.txt', oldPath: undefined, status: 'modified', additions: 1, deletions: 0 },
      { path: 'b.txt', oldPath: undefined, status: 'modified', additions: 2, deletions: 3 },
    ])
  })

  it('starts and stops a file watcher without errors', async () => {
    const workDir = await makeTempDir('workspace-service-watcher-')
    const service = new WorkspaceService(async () => workDir)

    service.startWatcher('session-watcher', workDir)
    service.startWatcher('session-watcher', workDir)
    service.stopWatcher('session-watcher')
  })

  it('stopAllWatchers cleans up all active watchers', async () => {
    const workDir = await makeTempDir('workspace-service-watcher-all-')
    const service = new WorkspaceService(async () => workDir)

    service.startWatcher('session-1', workDir)
    service.startWatcher('session-2', workDir)
    service.stopAllWatchers()
  })
})
