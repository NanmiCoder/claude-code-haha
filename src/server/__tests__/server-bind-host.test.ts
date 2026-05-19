import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'

describe('server bind host', () => {
  test('SERVER_HOST env is read by index.ts resolveServerOptions', async () => {
    // Inspect source to assert the env binding is present (cheap regression
    // guard since we cannot easily fork a server in unit test).
    const src = await Bun.file(
      path.resolve(__dirname, '..', 'index.ts'),
    ).text()
    expect(src).toContain("process.env.SERVER_HOST")
    expect(src).toContain("'127.0.0.1'")
  })
})
