import { create } from 'zustand'
import type { Update } from '@tauri-apps/plugin-updater'
import { isTauriRuntime } from '../lib/desktopRuntime'
// NOTE: in web target isTauriRuntime() returns false, so every action below
// short-circuits before touching @tauri-apps/* — there is no need for an
// explicit isWebTarget() branch here. See `lib/tauriBridge.ts` for the
// shared rationale.

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'restarting'
  | 'error'

type CheckOptions = {
  silent?: boolean
}

const DISMISSED_UPDATE_VERSION_KEY = 'cc-haha-dismissed-update-version'

type UpdateStore = {
  status: UpdateStatus
  availableVersion: string | null
  releaseNotes: string | null
  progressPercent: number
  downloadedBytes: number
  totalBytes: number | null
  error: string | null
  checkedAt: number | null
  shouldPrompt: boolean
  initialize: () => Promise<void>
  checkForUpdates: (options?: CheckOptions) => Promise<Update | null>
  installUpdate: () => Promise<void>
  dismissPrompt: () => void
}

let pendingUpdate: Update | null = null
let startupCheckPromise: Promise<void> | null = null

function readDismissedUpdateVersion(): string | null {
  if (typeof window === 'undefined') return null

  try {
    return window.localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY)
  } catch {
    return null
  }
}

function writeDismissedUpdateVersion(version: string | null) {
  if (typeof window === 'undefined') return

  try {
    if (version) {
      window.localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, version)
    } else {
      window.localStorage.removeItem(DISMISSED_UPDATE_VERSION_KEY)
    }
  } catch {
    // Ignore storage write failures.
  }
}

async function setPendingUpdate(next: Update | null) {
  const previous = pendingUpdate
  pendingUpdate = next

  if (previous && previous !== next) {
    try {
      await previous.close()
    } catch {
      // Ignore stale resource cleanup failures.
    }
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: 'idle',
  availableVersion: null,
  releaseNotes: null,
  progressPercent: 0,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
  checkedAt: null,
  shouldPrompt: false,

  initialize: async () => {
    if (!isTauriRuntime()) return
    if (!startupCheckPromise) {
      startupCheckPromise = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        await get().checkForUpdates({ silent: true })
      })().finally(() => {
        startupCheckPromise = null
      })
    }

    await startupCheckPromise
  },

  checkForUpdates: async ({ silent = false } = {}) => {
    if (!isTauriRuntime()) return null

    set((state) => ({
      ...state,
      status: 'checking',
      error: null,
    }))

    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      await setPendingUpdate(update)

      const checkedAt = Date.now()

      if (!update) {
        writeDismissedUpdateVersion(null)
        set((state) => ({
          ...state,
          status: 'up-to-date',
          availableVersion: null,
          releaseNotes: null,
          progressPercent: 0,
          downloadedBytes: 0,
          totalBytes: null,
          checkedAt,
          error: null,
          shouldPrompt: false,
        }))
        return null
      }

      const dismissedVersion = readDismissedUpdateVersion()
      const shouldPrompt = dismissedVersion !== update.version

      set((state) => ({
        ...state,
        status: 'available',
        availableVersion: update.version,
        releaseNotes: update.body ?? null,
        progressPercent: 0,
        downloadedBytes: 0,
        totalBytes: null,
        checkedAt,
        error: null,
        shouldPrompt,
      }))
      return update
    } catch (error) {
      if (!silent) {
        set((state) => ({
          ...state,
          status: 'error',
          error: getErrorMessage(error),
          checkedAt: Date.now(),
        }))
      } else {
        set((state) => ({
          ...state,
          status: state.availableVersion ? 'available' : 'idle',
          checkedAt: Date.now(),
        }))
      }
      return null
    }
  },

  installUpdate: async () => {
    if (!isTauriRuntime()) return

    let update = pendingUpdate
    if (!update) {
      update = await get().checkForUpdates()
      if (!update) return
    }

    set((state) => ({
      ...state,
      status: 'downloading',
      error: null,
      shouldPrompt: true,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: null,
    }))

    let prepareInstallAttempted = false
    try {
      writeDismissedUpdateVersion(null)
      const { invoke } = await import('@tauri-apps/api/core')
      const { relaunch } = await import('@tauri-apps/plugin-process')
      let totalBytes: number | null = null
      let downloadedBytes = 0

      await update.download((event) => {
        if (event.event === 'Started') {
          totalBytes = event.data.contentLength ?? null
          downloadedBytes = 0
          set((state) => ({
            ...state,
            totalBytes,
            downloadedBytes: 0,
            progressPercent: 0,
          }))
        } else if (event.event === 'Progress') {
          downloadedBytes += event.data.chunkLength
          const progressPercent =
            totalBytes && totalBytes > 0
              ? Math.min(Math.round((downloadedBytes / totalBytes) * 100), 100)
              : 0

          set((state) => ({
            ...state,
            downloadedBytes,
            totalBytes,
            progressPercent,
          }))
        } else if (event.event === 'Finished') {
          set((state) => ({
            ...state,
            progressPercent: 100,
          }))
        }
      })

      prepareInstallAttempted = true
      await invoke('prepare_for_update_install')
      await update.install()

      set((state) => ({
        ...state,
        status: 'restarting',
        progressPercent: 100,
      }))

      await relaunch()
    } catch (error) {
      if (prepareInstallAttempted) {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          await invoke('cancel_update_install')
        } catch {
          // Best effort: keep the update prompt recoverable even if native reset fails.
        }
      }
      set((state) => ({
        ...state,
        status: 'available',
        error: getErrorMessage(error),
        shouldPrompt: true,
      }))
    }
  },

  dismissPrompt: () => {
    writeDismissedUpdateVersion(get().availableVersion)
    set((state) => ({
      ...state,
      shouldPrompt: false,
    }))
  },
}))
