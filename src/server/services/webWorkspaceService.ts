/**
 * Web Workspace Service — manages per-session cwd directories under
 * `workspaces/<sessionId>/` for the web target. Desktop sessions still pass an
 * explicit workDir; this service is consulted only when `getRuntimeMode() === 'web'`
 * and the caller did not provide one.
 *
 * Directories are created lazily and **never** auto-deleted.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const DEFAULT_ROOT = path.resolve(process.cwd(), 'workspaces')
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/

let workspacesRoot: string = DEFAULT_ROOT

export function getWebWorkspaceRoot(): string {
  return workspacesRoot
}

export async function ensureWebWorkspace(sessionId: string): Promise<string> {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId for web workspace: ${JSON.stringify(sessionId)}`)
  }
  const dir = path.join(workspacesRoot, sessionId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** Test-only override; pass null to restore the default. */
export function _setWebWorkspaceRootForTests(root: string | null): void {
  workspacesRoot = root ?? DEFAULT_ROOT
}
