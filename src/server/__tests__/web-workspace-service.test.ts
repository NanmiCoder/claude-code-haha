import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  ensureWebWorkspace,
  getWebWorkspaceRoot,
  _setWebWorkspaceRootForTests,
} from '../services/webWorkspaceService.js'

describe('webWorkspaceService', () => {
  let tmpRoot: string

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-ws-'))
    _setWebWorkspaceRootForTests(tmpRoot)
  })

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
    _setWebWorkspaceRootForTests(null)
  })

  test('mkdir under workspaces/<sessionId>', async () => {
    const dir = await ensureWebWorkspace('abc123')
    expect(dir).toBe(path.join(tmpRoot, 'abc123'))
    const stat = await fs.stat(dir)
    expect(stat.isDirectory()).toBe(true)
  })

  test('idempotent on existing dir', async () => {
    const a = await ensureWebWorkspace('idempotent-id')
    const b = await ensureWebWorkspace('idempotent-id')
    expect(a).toBe(b)
  })

  test('rejects path traversal: ..', async () => {
    await expect(ensureWebWorkspace('..')).rejects.toThrow(/Invalid sessionId/)
  })

  test('rejects path traversal: nested', async () => {
    await expect(ensureWebWorkspace('a/b')).rejects.toThrow(/Invalid sessionId/)
  })

  test('rejects empty sessionId', async () => {
    await expect(ensureWebWorkspace('')).rejects.toThrow(/Invalid sessionId/)
  })

  test('rejects backslash', async () => {
    await expect(ensureWebWorkspace('a\\b')).rejects.toThrow(/Invalid sessionId/)
  })

  test('accepts UUID-shaped ids', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const dir = await ensureWebWorkspace(id)
    expect(path.basename(dir)).toBe(id)
  })

  test('getWebWorkspaceRoot returns absolute', () => {
    expect(path.isAbsolute(getWebWorkspaceRoot())).toBe(true)
  })
})
