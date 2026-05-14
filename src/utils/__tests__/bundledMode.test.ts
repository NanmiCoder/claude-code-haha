import { afterEach, describe, expect, test } from 'bun:test'
import { isBunVirtualPath, isInBundledMode } from '../bundledMode.js'

const originalArgv = [...process.argv]

afterEach(() => {
  process.argv = [...originalArgv]
})

describe('isBunVirtualPath', () => {
  test('detects POSIX bun virtual filesystem paths', () => {
    expect(isBunVirtualPath('/$bunfs/root/claude-sidecar')).toBe(true)
  })

  test('detects Windows bun virtual filesystem paths', () => {
    expect(isBunVirtualPath('B:\\~BUN\\root\\claude-sidecar.exe')).toBe(true)
  })

  test('ignores regular filesystem paths', () => {
    expect(isBunVirtualPath('/Applications/Claude.app/Contents/MacOS/claude-sidecar')).toBe(false)
  })
})

describe('isInBundledMode', () => {
  test('treats bun-compile virtual entrypoints as bundled even when embeddedFiles is empty', () => {
    process.argv = ['bun', '/$bunfs/root/claude-sidecar']

    expect(Array.isArray(Bun.embeddedFiles)).toBe(true)
    expect(Bun.embeddedFiles.length).toBe(0)
    expect(isInBundledMode()).toBe(true)
  })
})
