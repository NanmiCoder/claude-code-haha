import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { configureWorkspaceRoot, resetWorkspaceRoot } from '../services/workspaceRootInstance.js'
import { handleFilesystemRoute } from '../api/filesystem.js'

let tmpRoot: string

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-fs-'))
  configureWorkspaceRoot(tmpRoot)
  await fs.mkdir(path.join(tmpRoot, 'demo'), { recursive: true })
  await fs.writeFile(path.join(tmpRoot, 'demo', 'hello.txt'), 'hi', 'utf-8')
})

afterAll(() => {
  resetWorkspaceRoot()
})

describe('filesystem API sandbox', () => {
  it('refuses to read paths outside the workspace root', async () => {
    const url = new URL('http://localhost/api/filesystem/read?path=' + encodeURIComponent('/etc/passwd'))
    const res = await handleFilesystemRoute(url.pathname, url)
    expect(res.status).toBe(403)
  })

  it('reads files inside the workspace root', async () => {
    const target = path.join(tmpRoot, 'demo', 'hello.txt')
    const url = new URL('http://localhost/api/filesystem/read?path=' + encodeURIComponent(target))
    const res = await handleFilesystemRoute(url.pathname, url)
    expect(res.status).toBe(200)
  })
})
