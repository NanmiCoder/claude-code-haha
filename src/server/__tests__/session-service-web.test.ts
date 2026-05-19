import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { _resetRuntimeModeForTests } from '../config/runtimeMode.js'
import { _setWebWorkspaceRootForTests } from '../services/webWorkspaceService.js'
import { SessionService } from '../services/sessionService.js'

describe('sessionService createSession (web mode)', () => {
  let tmpRoot: string
  let homeDir: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-ws-'))
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-home-'))
    _setWebWorkspaceRootForTests(tmpRoot)
    process.env.CC_HAHA_RUNTIME = 'web'
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    process.env.HOME = homeDir
    process.env.USERPROFILE = homeDir
    _resetRuntimeModeForTests()
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
    await fs.rm(homeDir, { recursive: true, force: true })
    _setWebWorkspaceRootForTests(null)
    delete process.env.CC_HAHA_RUNTIME
    if (originalHome !== undefined) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile
    else delete process.env.USERPROFILE
    _resetRuntimeModeForTests()
  })

  test('uses workspaces/<sessionId> as cwd when no workDir', async () => {
    const svc = new SessionService()
    const result = await svc.createSession()
    expect(result.workDir).toBe(path.join(tmpRoot, result.sessionId))
    const stat = await fs.stat(result.workDir)
    expect(stat.isDirectory()).toBe(true)
  })

  test('respects explicit workDir even in web mode', async () => {
    const svc = new SessionService()
    const explicit = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-explicit-'))
    try {
      const result = await svc.createSession(explicit)
      expect(result.workDir).toBe(path.resolve(explicit))
      // workspaces/<sid> NOT created
      await expect(fs.stat(path.join(tmpRoot, result.sessionId))).rejects.toThrow()
    } finally {
      await fs.rm(explicit, { recursive: true, force: true })
    }
  })

  test('desktop mode falls back to homedir', async () => {
    process.env.CC_HAHA_RUNTIME = 'desktop'
    _resetRuntimeModeForTests()
    const svc = new SessionService()
    const result = await svc.createSession()
    expect(result.workDir).toBe(path.resolve(homeDir))
  })
})
