// Stub for all @tauri-apps/* imports in web mode.
// Tauri APIs are never called at runtime, but Vite's import analysis
// (both dev dependency scan and production rollup) still needs a
// resolvable module for every import site.
//
// Every named export referenced anywhere in desktop/src must be listed here.
// New Tauri packages added in the future will fail the dev build unless they
// also get an entry below.

const noop = () => {}
const asyncNoop = () => Promise.resolve()
const asyncReject = (msg: string) => () => Promise.reject(new Error(msg))

const err = (name: string) => asyncReject(`Tauri ${name} is not available in web mode`)

// -- @tauri-apps/api/core --
export const invoke = err('invoke')

// -- @tauri-apps/api/event --
export const listen = err('listen')
export const emit = noop

// -- @tauri-apps/api/window --
export const getCurrentWindow = () => ({ onCloseRequested: () => ({ then: noop }) })
export const UserAttentionType = { Critical: 1 }

// -- @tauri-apps/api/app --
// (used only via dynamic import; default export is enough)

// -- @tauri-apps/plugin-shell --
export const open = err('plugin-shell:open')

// -- @tauri-apps/plugin-process --
export const relaunch = err('plugin-process:relaunch')

// -- @tauri-apps/plugin-notification --
export const sendNotification = err('plugin-notification:sendNotification')
export const isPermissionGranted = async () => false
export const requestPermission = async () => 'denied' as const
export const onAction = noop

// -- @tauri-apps/plugin-updater --
export const check = err('plugin-updater:check')

// -- @tauri-apps/plugin-dialog --
// (used only via dynamic import; default export is enough)

// Each @tauri-apps/* package is expected to also support default-import syntax.
const stub = {
  invoke,
  listen,
  emit,
  getCurrentWindow,
  UserAttentionType,
  open,
  relaunch,
  sendNotification,
  isPermissionGranted,
  requestPermission,
  onAction,
  check,
}
export default stub
