// src/server/services/workspaceRootInstance.ts
import * as path from 'node:path'
import { WorkspaceRoot } from './workspaceRoot.js'

let instance: WorkspaceRoot | null = null

export function configureWorkspaceRoot(rootDir: string): WorkspaceRoot {
  const absolute = path.isAbsolute(rootDir) ? rootDir : path.resolve(process.cwd(), rootDir)
  instance = new WorkspaceRoot(absolute)
  return instance
}

export function getWorkspaceRoot(): WorkspaceRoot {
  if (!instance) {
    throw new Error('Workspace root not configured. Call configureWorkspaceRoot(...) at startup.')
  }
  return instance
}

export function resetWorkspaceRoot(): void {
  instance = null
}
