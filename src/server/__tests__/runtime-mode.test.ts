import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { detectRuntimeMode, getRuntimeMode, _resetRuntimeModeForTests } from '../config/runtimeMode.js'

describe('runtimeMode', () => {
  let originalRuntime: string | undefined
  let originalAppRoot: string | undefined

  beforeEach(() => {
    originalRuntime = process.env.CC_HAHA_RUNTIME
    originalAppRoot = process.env.CLAUDE_APP_ROOT
    delete process.env.CC_HAHA_RUNTIME
    delete process.env.CLAUDE_APP_ROOT
    _resetRuntimeModeForTests()
  })

  afterEach(() => {
    if (originalRuntime !== undefined) process.env.CC_HAHA_RUNTIME = originalRuntime
    else delete process.env.CC_HAHA_RUNTIME
    if (originalAppRoot !== undefined) process.env.CLAUDE_APP_ROOT = originalAppRoot
    else delete process.env.CLAUDE_APP_ROOT
    _resetRuntimeModeForTests()
  })

  test('returns web when CC_HAHA_RUNTIME=web', () => {
    process.env.CC_HAHA_RUNTIME = 'web'
    expect(detectRuntimeMode()).toBe('web')
  })

  test('returns desktop when CC_HAHA_RUNTIME=desktop', () => {
    process.env.CC_HAHA_RUNTIME = 'desktop'
    expect(detectRuntimeMode()).toBe('desktop')
  })

  test('falls back to desktop when CLAUDE_APP_ROOT is set', () => {
    process.env.CLAUDE_APP_ROOT = '/Applications/Foo.app'
    expect(detectRuntimeMode()).toBe('desktop')
  })

  test('falls back to web when neither hint is set', () => {
    expect(detectRuntimeMode()).toBe('web')
  })

  test('CC_HAHA_RUNTIME wins over CLAUDE_APP_ROOT', () => {
    process.env.CC_HAHA_RUNTIME = 'web'
    process.env.CLAUDE_APP_ROOT = '/Applications/Foo.app'
    expect(detectRuntimeMode()).toBe('web')
  })

  test('getRuntimeMode caches first detection', () => {
    process.env.CC_HAHA_RUNTIME = 'web'
    expect(getRuntimeMode()).toBe('web')
    process.env.CC_HAHA_RUNTIME = 'desktop'
    // cached
    expect(getRuntimeMode()).toBe('web')
  })
})
