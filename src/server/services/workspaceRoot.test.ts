import { describe, expect, it, beforeEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { WorkspaceRoot } from './workspaceRoot.js'

describe('WorkspaceRoot', () => {
  let tmpRoot: string
  let root: WorkspaceRoot

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-ws-'))
    root = new WorkspaceRoot(tmpRoot)
    await root.ensureRoot()
  })

  it('rejects names that try to escape the root', () => {
    expect(() => root.resolveWorkspaceDir('../escape')).toThrow(/invalid workspace name/i)
    expect(() => root.resolveWorkspaceDir('/etc')).toThrow(/invalid workspace name/i)
    expect(() => root.resolveWorkspaceDir('a/b')).toThrow(/invalid workspace name/i)
  })

  it('creates and reuses workspace directories with the given name', async () => {
    const a = await root.ensureWorkspaceDir('demo')
    const b = await root.ensureWorkspaceDir('demo')
    expect(a).toBe(b)
    expect(a.startsWith(tmpRoot)).toBe(true)
  })

  it('rejects paths that resolve outside of the root', () => {
    expect(root.isInsideRoot(path.join(tmpRoot, 'demo', 'file.txt'))).toBe(true)
    expect(root.isInsideRoot(path.join(tmpRoot, '..', 'evil.txt'))).toBe(false)
  })

  it('refuses absolute workspace names', () => {
    expect(() => root.resolveWorkspaceDir(path.join(tmpRoot, 'x'))).toThrow(/invalid workspace name/i)
  })
})

import { getWorkspaceRoot, configureWorkspaceRoot } from './workspaceRootInstance.js'

describe('workspace root singleton', () => {
  it('returns the configured singleton', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-ws-singleton-'))
    configureWorkspaceRoot(tmp)
    expect(getWorkspaceRoot().getRoot()).toBe(tmp)
  })
})
