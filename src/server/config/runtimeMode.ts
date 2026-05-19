/**
 * Runtime mode detection — chooses between desktop (Tauri sidecar) and web
 * (browser-driven, same `bun run src/server/index.ts` process).
 *
 * Priority:
 *   1. Explicit `CC_HAHA_RUNTIME=web|desktop` env wins.
 *   2. Otherwise, presence of `CLAUDE_APP_ROOT` (set by the Tauri sidecar) implies desktop.
 *   3. Default to web.
 *
 * Mode is cached on first detection so all services see a consistent answer.
 */
export type RuntimeMode = 'desktop' | 'web'

let cached: RuntimeMode | null = null

export function detectRuntimeMode(): RuntimeMode {
  if (process.env.CC_HAHA_RUNTIME === 'web') {
    cached = 'web'
    return 'web'
  }
  if (process.env.CC_HAHA_RUNTIME === 'desktop') {
    cached = 'desktop'
    return 'desktop'
  }
  cached = process.env.CLAUDE_APP_ROOT ? 'desktop' : 'web'
  return cached
}

export function getRuntimeMode(): RuntimeMode {
  return cached ?? detectRuntimeMode()
}

/** Test-only — clears cached result so each test sees fresh env. */
export function _resetRuntimeModeForTests(): void {
  cached = null
}
