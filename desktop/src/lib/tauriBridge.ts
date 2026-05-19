/**
 * tauriBridge — single dynamic-import gateway for every `@tauri-apps/*` package.
 *
 * Why this exists: the same source tree compiles to two targets — the Tauri
 * desktop bundle (where the `@tauri-apps/*` packages are present) and the web
 * bundle (where they are not). Centralising the imports here lets every caller
 * stay synchronous-shaped while we silently no-op or fall back to a Web API in
 * the browser. Components that need to short-circuit rendering should use
 * `isWebTarget()` from `./desktopRuntime` directly.
 */
import { isTauriRuntime } from './desktopRuntime'

export class TauriUnavailableError extends Error {
  constructor(public capability: string) {
    super(`Tauri capability "${capability}" is unavailable in this runtime.`)
    this.name = 'TauriUnavailableError'
  }
}

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) throw new TauriUnavailableError(`invoke:${cmd}`)
  // @ts-expect-error optional dep at build time
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke<T>(cmd, args)
}

export type UnlistenFn = () => void

export async function tauriListen(
  event: string,
  handler: (e: unknown) => void,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {}
  // @ts-expect-error optional dep at build time
  const mod = await import('@tauri-apps/api/event')
  return mod.listen(event, handler) as Promise<UnlistenFn>
}

export async function tauriShellOpen(url: string): Promise<void> {
  if (!isTauriRuntime()) {
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener')
    }
    return
  }
  // @ts-expect-error optional dep at build time
  const mod = await import('@tauri-apps/plugin-shell')
  await mod.open(url)
}

export async function tauriDialogOpen(opts: unknown): Promise<string | null> {
  if (!isTauriRuntime()) return null
  // @ts-expect-error optional dep at build time
  const mod = await import('@tauri-apps/plugin-dialog')
  const result = await mod.open(opts as never)
  return typeof result === 'string' ? result : null
}

// Window controls: returns null in web mode so callers can short-circuit.
export async function tauriGetCurrentWindow(): Promise<unknown | null> {
  if (!isTauriRuntime()) return null
  // @ts-expect-error optional dep at build time
  const mod = await import('@tauri-apps/api/window')
  return mod.getCurrentWindow()
}

// Updater
export async function tauriUpdaterCheck(): Promise<unknown | null> {
  if (!isTauriRuntime()) return null
  // @ts-expect-error optional dep at build time
  const mod = await import('@tauri-apps/plugin-updater')
  return mod.check()
}

export async function tauriProcessRelaunch(): Promise<void> {
  if (!isTauriRuntime()) return
  // @ts-expect-error optional dep at build time
  const mod = await import('@tauri-apps/plugin-process')
  await mod.relaunch()
}

// Notification (Tauri side; web side uses Web Notification API directly)
export async function tauriNotificationIsPermissionGranted(): Promise<boolean> {
  if (!isTauriRuntime()) return false
  // @ts-expect-error optional dep at build time
  const mod = await import('@tauri-apps/plugin-notification')
  return mod.isPermissionGranted()
}

export async function tauriNotificationRequestPermission(): Promise<'granted' | 'denied' | 'default'> {
  if (!isTauriRuntime()) return 'denied'
  // @ts-expect-error optional dep at build time
  const mod = await import('@tauri-apps/plugin-notification')
  return mod.requestPermission()
}

export async function tauriNotificationSend(opts: { title: string; body?: string }): Promise<void> {
  if (!isTauriRuntime()) return
  // @ts-expect-error optional dep at build time
  const mod = await import('@tauri-apps/plugin-notification')
  await mod.sendNotification(opts)
}

export async function tauriAppGetMetadata(): Promise<{ name: string; version: string } | null> {
  if (!isTauriRuntime()) return null
  // @ts-expect-error optional dep at build time
  const mod = await import('@tauri-apps/api/app')
  const [name, version] = await Promise.all([mod.getName(), mod.getVersion()])
  return { name, version }
}
