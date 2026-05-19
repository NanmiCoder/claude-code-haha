import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { _resetRuntimeModeForTests } from '../config/runtimeMode.js'
import { resolveSessionWorkspaceLaunch } from '../services/repositoryLaunchService.js'

describe('repositoryLaunchService web mode', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-launch-'))
    process.env.CC_HAHA_RUNTIME = 'web'
    _resetRuntimeModeForTests()
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
    delete process.env.CC_HAHA_RUNTIME
    _resetRuntimeModeForTests()
  })

  test('fails fast when web mode requests branch launch', async () => {
    await expect(
      resolveSessionWorkspaceLaunch(tmpRoot, { branch: 'main' }, 'sid'),
    ).rejects.toThrow(/web mode/i)
  })

  test('fails fast when web mode requests worktree launch', async () => {
    await expect(
      resolveSessionWorkspaceLaunch(tmpRoot, { worktree: true }, 'sid'),
    ).rejects.toThrow(/web mode/i)
  })

  test('passes through when no repository options', async () => {
    const result = await resolveSessionWorkspaceLaunch(tmpRoot, undefined, 'sid')
    expect(result.workDir).toBe(path.resolve(tmpRoot))
    expect(result.repository).toBeUndefined()
  })
})
