import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { handleStaticH5Request } from '../staticH5.js'

const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  // Clear env vars that could interfere with web/dist lookup
  for (const key of ['CLAUDE_H5_DIST_DIR', 'CLAUDE_APP_ROOT']) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  const distRoot = path.resolve(process.cwd(), 'web', 'dist')
  await fs.mkdir(distRoot, { recursive: true })
  await fs.writeFile(path.join(distRoot, 'index.html'), '<html>web</html>', 'utf-8')
})

afterAll(() => {
  for (const key of ['CLAUDE_H5_DIST_DIR', 'CLAUDE_APP_ROOT']) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key]
    }
  }
})

describe('staticH5 (SaaS profile)', () => {
  it('serves web/dist/index.html for /', async () => {
    const url = new URL('http://localhost/')
    const res = await handleStaticH5Request(new Request(url, { method: 'GET' }), url)
    expect(res?.status).toBe(200)
    const body = await res!.text()
    expect(body).toContain('web')
  })
})
