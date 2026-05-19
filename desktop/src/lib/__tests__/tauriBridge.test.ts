import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  TauriUnavailableError,
  tauriInvoke,
  tauriListen,
  tauriShellOpen,
  tauriDialogOpen,
} from '../tauriBridge'

describe('tauriBridge (non-Tauri runtime)', () => {
  const originalWindow = globalThis.window

  beforeEach(() => {
    ;(globalThis as { window?: unknown }).window = {} as Window // no __TAURI_INTERNALS__
  })

  afterEach(() => {
    if (originalWindow) (globalThis as { window?: unknown }).window = originalWindow
    else delete (globalThis as { window?: unknown }).window
    vi.restoreAllMocks()
  })

  it('tauriInvoke throws TauriUnavailableError', async () => {
    await expect(tauriInvoke('any_cmd')).rejects.toBeInstanceOf(TauriUnavailableError)
  })

  it('tauriListen returns a noop unsubscribe', async () => {
    const unsub = await tauriListen('any-event', () => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  it('tauriShellOpen falls back to window.open', async () => {
    const spy = vi.fn()
    ;(globalThis as { window: Window }).window.open = spy as unknown as Window['open']
    await tauriShellOpen('https://example.com')
    expect(spy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener')
  })

  it('tauriDialogOpen returns null', async () => {
    expect(await tauriDialogOpen({ directory: true })).toBeNull()
  })

  it('TauriUnavailableError carries capability name', async () => {
    try {
      await tauriInvoke('foo')
    } catch (e) {
      expect(e).toBeInstanceOf(TauriUnavailableError)
      expect((e as TauriUnavailableError).capability).toContain('foo')
    }
  })
})
