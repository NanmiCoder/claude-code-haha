import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

let serverProc: ReturnType<typeof Bun.spawn> | null = null
const PORT = 38456
let WORKSPACES_ROOT = ''

describe('SaaS smoke', () => {
  beforeAll(async () => {
    WORKSPACES_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-saas-'))
    serverProc = Bun.spawn(['npx', 'bun', 'run', 'src/server/index.ts', '--port', String(PORT)], {
      env: {
        ...process.env,
        CC_HAHA_WORKSPACES_ROOT: WORKSPACES_ROOT,
        SERVER_PORT: String(PORT),
      },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    // Wait for the server to come up.
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/sessions`)
        if (res.ok || res.status === 404 || res.status === 200) break
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  })

  afterAll(async () => {
    serverProc?.kill()
    await serverProc?.exited
  })

  it('rejects out-of-root paths and accepts in-root workspaceName', async () => {
    const bad = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceName: '../escape' }),
    })
    expect(bad.status).toBe(400)

    const good = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceName: 'demo' }),
    })
    expect(good.status).toBe(201)
    const body = await good.json()
    expect(body.workDir.startsWith(WORKSPACES_ROOT)).toBe(true)
  })

  it('returns 404 for disabled resources', async () => {
    for (const p of ['/api/computer-use', '/api/h5-access', '/api/doctor']) {
      const res = await fetch(`http://127.0.0.1:${PORT}${p}`)
      expect(res.status).toBe(404)
    }
  })
})
