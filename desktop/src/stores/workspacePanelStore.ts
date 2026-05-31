import { create } from 'zustand'
import {
  sessionsApi,
  type WorkspaceDiffResult,
  type WorkspaceReadFileResult,
  type WorkspaceStatusResult,
  type WorkspaceTreeResult,
} from '../api/sessions'

export const WORKSPACE_PANEL_DEFAULT_WIDTH = 860
export const WORKSPACE_PANEL_MIN_WIDTH = 640
export const WORKSPACE_PANEL_MAX_WIDTH = 1120

export type WorkspacePanelView = 'changed' | 'all'
export type WorkbenchMode = 'workspace' | 'browser'
export type WorkspacePreviewKind = 'file' | 'diff'
export type WorkspacePreviewCloseScope = 'current' | 'others' | 'left' | 'right' | 'all'
export type WorkspacePreviewState =
  | 'loading'
  | WorkspaceReadFileResult['state']
  | WorkspaceDiffResult['state']

export type WorkspacePreviewTab = {
  id: string
  path: string
  kind: WorkspacePreviewKind
  title: string
  language?: string
  content?: string
  dataUrl?: string
  mimeType?: string
  previewType?: 'text' | 'image'
  diff?: string
  state?: WorkspacePreviewState
  error?: string
  size?: number
}

export type WorkspacePanelSessionState = {
  isOpen: boolean
  activeView: WorkspacePanelView
  hasUserSelectedView?: boolean
}

type WorkspacePanelLoadingState = {
  statusBySession: Record<string, boolean | undefined>
  treeBySessionPath: Record<string, boolean | undefined>
  previewByTabId: Record<string, boolean | undefined>
}

type WorkspacePanelErrorState = {
  statusBySession: Record<string, string | null | undefined>
  treeBySessionPath: Record<string, string | null | undefined>
  previewByTabId: Record<string, string | null | undefined>
}

type WorkspacePanelStore = {
  panelBySession: Record<string, WorkspacePanelSessionState | undefined>
  modeBySession: Record<string, WorkbenchMode | undefined>
  width: number
  showHiddenFiles: boolean
  statusBySession: Record<string, WorkspaceStatusResult | undefined>
  expandedPathsBySession: Record<string, string[] | undefined>
  treeBySessionPath: Record<string, Record<string, WorkspaceTreeResult | undefined> | undefined>
  previewTabsBySession: Record<string, WorkspacePreviewTab[] | undefined>
  activePreviewTabIdBySession: Record<string, string | null | undefined>
  loading: WorkspacePanelLoadingState
  errors: WorkspacePanelErrorState

  isPanelOpen: (sessionId: string) => boolean
  getActiveView: (sessionId: string) => WorkspacePanelView
  getMode: (sessionId: string) => WorkbenchMode
  setMode: (sessionId: string, mode: WorkbenchMode) => void
  openPanel: (sessionId: string) => void
  closePanel: (sessionId: string) => void
  togglePanel: (sessionId: string) => void
  setWidth: (width: number) => void
  setActiveView: (sessionId: string, view: WorkspacePanelView) => void
  toggleShowHiddenFiles: () => void
  loadStatus: (sessionId: string) => Promise<void>
  loadTree: (sessionId: string, path?: string, options?: { showHidden?: boolean }) => Promise<void>
  toggleTreeNode: (sessionId: string, path: string) => Promise<void>
  openPreview: (sessionId: string, path: string, kind: WorkspacePreviewKind) => Promise<void>
  closePreview: (sessionId: string, tabId: string) => void
  closePreviewTabs: (sessionId: string, tabId: string, scope: WorkspacePreviewCloseScope) => void
  clearSession: (sessionId: string) => void
  resetSessionUi: (sessionId: string) => void
  invalidateExpandedTreeCache: (sessionId: string) => void
  handleFileChanged: (sessionId: string, filePath: string) => Promise<void>
}

const DEFAULT_PANEL_STATE: WorkspacePanelSessionState = {
  isOpen: false,
  activeView: 'changed',
}

const DEFAULT_WORKBENCH_MODE: WorkbenchMode = 'workspace'

const statusRequestIds = new Map<string, number>()
const treeRequestIds = new Map<string, number>()
const previewRequestIds = new Map<string, number>()
const fileChangeTimers = new Map<string, ReturnType<typeof setTimeout>>()

function nextRequestId(store: Map<string, number>, key: string) {
  const requestId = (store.get(key) ?? 0) + 1
  store.set(key, requestId)
  return requestId
}

function invalidateRequest(store: Map<string, number>, key: string) {
  store.set(key, (store.get(key) ?? 0) + 1)
}

function isLatestRequest(store: Map<string, number>, key: string, requestId: number) {
  return store.get(key) === requestId
}

export function clampWorkspacePanelWidth(width: number) {
  if (!Number.isFinite(width)) return WORKSPACE_PANEL_DEFAULT_WIDTH
  const rounded = Math.round(width)
  return Math.min(WORKSPACE_PANEL_MAX_WIDTH, Math.max(WORKSPACE_PANEL_MIN_WIDTH, rounded))
}

function getSessionPanelState(
  panelBySession: Record<string, WorkspacePanelSessionState | undefined>,
  sessionId: string,
) {
  return panelBySession[sessionId] ?? DEFAULT_PANEL_STATE
}

function makeTreeKey(sessionId: string, path: string) {
  return `${sessionId}::${path}`
}

export function getWorkspacePreviewTabId(path: string, kind: WorkspacePreviewKind) {
  return `${kind}:${path}`
}

function makePreviewKey(sessionId: string, tabId: string) {
  return `${sessionId}::${tabId}`
}

function getPathTitle(path: string) {
  if (!path) return 'Workspace'
  const segments = path.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

function stripSessionKeys<T>(record: Record<string, T>, sessionId: string) {
  const prefix = `${sessionId}::`
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !key.startsWith(prefix)),
  ) as Record<string, T>
}

function removeRecordKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) return record
  const { [key]: _removed, ...rest } = record
  return rest
}

function removeRecordKeys<T>(record: Record<string, T>, keys: string[]) {
  let next = record
  for (const key of keys) {
    next = removeRecordKey(next, key)
  }
  return next
}

function invalidateSessionScopedRequests(store: Map<string, number>, sessionId: string) {
  const prefix = `${sessionId}::`
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      invalidateRequest(store, key)
    }
  }
}

function upsertPreviewTab(
  tabs: WorkspacePreviewTab[],
  tabId: string,
  update: WorkspacePreviewTab | ((current: WorkspacePreviewTab) => WorkspacePreviewTab),
) {
  const index = tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return tabs

  const current = tabs[index]!
  const next = typeof update === 'function' ? update(current) : update
  const nextTabs = [...tabs]
  nextTabs[index] = next
  return nextTabs
}

export const useWorkspacePanelStore = create<WorkspacePanelStore>((set, get) => ({
  panelBySession: {},
  modeBySession: {},
  width: WORKSPACE_PANEL_DEFAULT_WIDTH,
  showHiddenFiles: true,
  statusBySession: {},
  expandedPathsBySession: {},
  treeBySessionPath: {},
  previewTabsBySession: {},
  activePreviewTabIdBySession: {},
  loading: {
    statusBySession: {},
    treeBySessionPath: {},
    previewByTabId: {},
  },
  errors: {
    statusBySession: {},
    treeBySessionPath: {},
    previewByTabId: {},
  },

  isPanelOpen: (sessionId) => getSessionPanelState(get().panelBySession, sessionId).isOpen,
  getActiveView: (sessionId) => getSessionPanelState(get().panelBySession, sessionId).activeView,
  getMode: (sessionId) => get().modeBySession[sessionId] ?? DEFAULT_WORKBENCH_MODE,

  setMode: (sessionId, mode) =>
    set((state) => ({
      modeBySession: {
        ...state.modeBySession,
        [sessionId]: mode,
      },
    })),

  openPanel: (sessionId) =>
    set((state) => ({
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: {
          ...getSessionPanelState(state.panelBySession, sessionId),
          isOpen: true,
        },
      },
    })),

  closePanel: (sessionId) =>
    set((state) => ({
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: {
          ...getSessionPanelState(state.panelBySession, sessionId),
          isOpen: false,
        },
      },
    })),

  togglePanel: (sessionId) =>
    set((state) => {
      const panel = getSessionPanelState(state.panelBySession, sessionId)
      return {
        panelBySession: {
          ...state.panelBySession,
          [sessionId]: {
            ...panel,
            isOpen: !panel.isOpen,
          },
        },
      }
    }),

  setWidth: (width) => set({ width: clampWorkspacePanelWidth(width) }),

  setActiveView: (sessionId, view) =>
    set((state) => ({
      panelBySession: {
        ...state.panelBySession,
        [sessionId]: {
          ...getSessionPanelState(state.panelBySession, sessionId),
          activeView: view,
          hasUserSelectedView: true,
        },
      },
    })),

  loadStatus: async (sessionId) => {
    const requestId = nextRequestId(statusRequestIds, sessionId)

    set((state) => ({
      loading: {
        ...state.loading,
        statusBySession: {
          ...state.loading.statusBySession,
          [sessionId]: true,
        },
      },
      errors: {
        ...state.errors,
        statusBySession: {
          ...state.errors.statusBySession,
          [sessionId]: null,
        },
      },
    }))

    try {
      const result = await sessionsApi.getWorkspaceStatus(sessionId)
      if (!isLatestRequest(statusRequestIds, sessionId, requestId)) return

      set((state) => {
        const panel = getSessionPanelState(state.panelBySession, sessionId)
        const nextActiveView =
          !panel.hasUserSelectedView && result.state === 'ok'
            ? result.changedFiles.length > 0 ? 'changed' : 'all'
            : panel.activeView

        return {
          panelBySession: {
            ...state.panelBySession,
            [sessionId]: {
              ...panel,
              activeView: nextActiveView,
            },
          },
          statusBySession: {
            ...state.statusBySession,
            [sessionId]: result,
          },
          loading: {
            ...state.loading,
            statusBySession: {
              ...state.loading.statusBySession,
              [sessionId]: false,
            },
          },
          errors: {
            ...state.errors,
            statusBySession: {
              ...state.errors.statusBySession,
              [sessionId]: result.error ?? null,
            },
          },
        }
      })
    } catch (error) {
      if (!isLatestRequest(statusRequestIds, sessionId, requestId)) return

      set((state) => ({
        loading: {
          ...state.loading,
          statusBySession: {
            ...state.loading.statusBySession,
            [sessionId]: false,
          },
        },
        errors: {
          ...state.errors,
          statusBySession: {
            ...state.errors.statusBySession,
            [sessionId]: error instanceof Error ? error.message : 'Failed to load workspace status',
          },
        },
      }))
    }
  },

  loadTree: async (sessionId, path = '', options) => {
    const showHidden = options?.showHidden ?? get().showHiddenFiles
    const treeKey = makeTreeKey(sessionId, path)
    const requestId = nextRequestId(treeRequestIds, treeKey)

    set((state) => ({
      loading: {
        ...state.loading,
        treeBySessionPath: {
          ...state.loading.treeBySessionPath,
          [treeKey]: true,
        },
      },
      errors: {
        ...state.errors,
        treeBySessionPath: {
          ...state.errors.treeBySessionPath,
          [treeKey]: null,
        },
      },
    }))

    try {
      const result = await sessionsApi.getWorkspaceTree(sessionId, path, showHidden)
      if (!isLatestRequest(treeRequestIds, treeKey, requestId)) return

      set((state) => ({
        treeBySessionPath: {
          ...state.treeBySessionPath,
          [sessionId]: {
            ...state.treeBySessionPath[sessionId],
            [path]: result,
          },
        },
        loading: {
          ...state.loading,
          treeBySessionPath: {
            ...state.loading.treeBySessionPath,
            [treeKey]: false,
          },
        },
        errors: {
          ...state.errors,
          treeBySessionPath: {
            ...state.errors.treeBySessionPath,
            [treeKey]: result.error ?? null,
          },
        },
      }))
    } catch (error) {
      if (!isLatestRequest(treeRequestIds, treeKey, requestId)) return

      set((state) => ({
        loading: {
          ...state.loading,
          treeBySessionPath: {
            ...state.loading.treeBySessionPath,
            [treeKey]: false,
          },
        },
        errors: {
          ...state.errors,
          treeBySessionPath: {
            ...state.errors.treeBySessionPath,
            [treeKey]: error instanceof Error ? error.message : 'Failed to load workspace tree',
          },
        },
      }))
    }
  },

  toggleTreeNode: async (sessionId, path) => {
    let shouldLoad = false

    set((state) => {
      const expanded = new Set(state.expandedPathsBySession[sessionId] ?? [])
      if (expanded.has(path)) {
        expanded.delete(path)
      } else {
        expanded.add(path)
        if (!state.treeBySessionPath[sessionId]?.[path]) {
          shouldLoad = true
        }
      }

      return {
        expandedPathsBySession: {
          ...state.expandedPathsBySession,
          [sessionId]: [...expanded],
        },
      }
    })

    if (shouldLoad) {
      await get().loadTree(sessionId, path)
    }
  },

  toggleShowHiddenFiles: () => {
    set((state) => ({ showHiddenFiles: !state.showHiddenFiles }))
  },

  openPreview: async (sessionId, path, kind) => {
    // Ensure the workspace panel is visible — openPreview is now triggered from places
    // where the panel may be closed (e.g. the chat "打开方式" menu / turn-changes card),
    // not only from inside the already-open file tree. Opening a file always switches the
    // unified workbench into file ("workspace") mode.
    get().openPanel(sessionId)
    get().setMode(sessionId, 'workspace')
    const tabId = getWorkspacePreviewTabId(path, kind)
    const requestKey = makePreviewKey(sessionId, tabId)
    const requestId = nextRequestId(previewRequestIds, requestKey)
    const existing = get().previewTabsBySession[sessionId]?.find((tab) => tab.id === tabId)

    if (!existing) {
      const baseTab: WorkspacePreviewTab = {
        id: tabId,
        path,
        kind,
        title: getPathTitle(path),
        state: 'loading',
      }

      set((state) => ({
        previewTabsBySession: {
          ...state.previewTabsBySession,
          [sessionId]: [...(state.previewTabsBySession[sessionId] ?? []), baseTab],
        },
      }))
    }

    // Set active tab and mark loading (regardless of whether tab existed)
    set((state) => ({
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        [sessionId]: tabId,
      },
      loading: {
        ...state.loading,
        previewByTabId: {
          ...state.loading.previewByTabId,
          [requestKey]: true,
        },
      },
      errors: {
        ...state.errors,
        previewByTabId: {
          ...state.errors.previewByTabId,
          [requestKey]: null,
        },
      },
    }))

    // Shared fetch-and-upsert logic
    const applyResult = <T extends { state?: string; error?: string }>(
      result: T,
      updater: (current: WorkspacePreviewTab) => Partial<WorkspacePreviewTab>,
    ) => {
      set((state) => {
        const tabs = state.previewTabsBySession[sessionId] ?? []
        return {
          previewTabsBySession: {
            ...state.previewTabsBySession,
            [sessionId]: upsertPreviewTab(tabs, tabId, (current) => ({
              ...current,
              ...updater(current),
            })),
          },
          loading: {
            ...state.loading,
            previewByTabId: {
              ...state.loading.previewByTabId,
              [requestKey]: false,
            },
          },
          errors: {
            ...state.errors,
            previewByTabId: {
              ...state.errors.previewByTabId,
              [requestKey]: result.error ?? null,
            },
          },
        }
      })
    }

    try {
      if (kind === 'diff') {
        const result = await sessionsApi.getWorkspaceDiff(sessionId, path)
        if (!isLatestRequest(previewRequestIds, requestKey, requestId)) return
        if (!get().previewTabsBySession[sessionId]?.some((tab) => tab.id === tabId)) return
        applyResult(result, () => ({
          diff: result.diff ?? '',
          content: undefined,
          language: undefined,
          size: undefined,
          state: result.state,
          error: result.error,
        }))
        return
      }

      const result = await sessionsApi.getWorkspaceFile(sessionId, path)
      if (!isLatestRequest(previewRequestIds, requestKey, requestId)) return
      if (!get().previewTabsBySession[sessionId]?.some((tab) => tab.id === tabId)) return
      applyResult(result, () => ({
        content: result.content,
        dataUrl: result.dataUrl,
        mimeType: result.mimeType,
        previewType: result.previewType ?? 'text',
        diff: undefined,
        language: result.language,
        size: result.size,
        state: result.state,
        error: result.error,
      }))
    } catch (error) {
      if (!isLatestRequest(previewRequestIds, requestKey, requestId)) return
      if (!get().previewTabsBySession[sessionId]?.some((tab) => tab.id === tabId)) return

      const message = error instanceof Error ? error.message : 'Failed to load workspace preview'
      set((state) => {
        const tabs = state.previewTabsBySession[sessionId] ?? []
        return {
          previewTabsBySession: {
            ...state.previewTabsBySession,
            [sessionId]: upsertPreviewTab(tabs, tabId, (current) => ({
              ...current,
              state: 'error' as const,
              error: message,
            })),
          },
          loading: {
            ...state.loading,
            previewByTabId: {
              ...state.loading.previewByTabId,
              [requestKey]: false,
            },
          },
          errors: {
            ...state.errors,
            previewByTabId: {
              ...state.errors.previewByTabId,
              [requestKey]: message,
            },
          },
        }
      })
    }
  },


  closePreview: (sessionId, tabId) => {
    get().closePreviewTabs(sessionId, tabId, 'current')
  },

  closePreviewTabs: (sessionId, tabId, scope) => {
    set((state) => {
      const tabs = state.previewTabsBySession[sessionId] ?? []
      const index = tabs.findIndex((tab) => tab.id === tabId)
      if (index < 0) {
        const requestKey = makePreviewKey(sessionId, tabId)
        invalidateRequest(previewRequestIds, requestKey)
        return {
          loading: {
            ...state.loading,
            previewByTabId: removeRecordKey(state.loading.previewByTabId, requestKey),
          },
          errors: {
            ...state.errors,
            previewByTabId: removeRecordKey(state.errors.previewByTabId, requestKey),
          },
        }
      }

      let nextTabs: WorkspacePreviewTab[]
      switch (scope) {
        case 'others':
          nextTabs = [tabs[index]!]
          break
        case 'left':
          nextTabs = tabs.slice(index)
          break
        case 'right':
          nextTabs = tabs.slice(0, index + 1)
          break
        case 'all':
          nextTabs = []
          break
        case 'current':
        default:
          nextTabs = tabs.filter((tab) => tab.id !== tabId)
          break
      }

      const nextTabIds = new Set(nextTabs.map((tab) => tab.id))
      const closingTabIds = tabs.map((tab) => tab.id).filter((id) => !nextTabIds.has(id))
      const requestKeys = closingTabIds.map((id) => makePreviewKey(sessionId, id))
      for (const key of requestKeys) {
        invalidateRequest(previewRequestIds, key)
      }

      const activeTabId = state.activePreviewTabIdBySession[sessionId] ?? null

      let nextActiveTabId = activeTabId
      if (scope === 'all' || nextTabs.length === 0) {
        nextActiveTabId = null
      } else if (!activeTabId || !nextTabIds.has(activeTabId)) {
        const targetTab = nextTabs.find((tab) => tab.id === tabId)
        nextActiveTabId = targetTab?.id ?? nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? null
      } else if (scope === 'others') {
        nextActiveTabId = tabId
      } else if (activeTabId === tabId && scope === 'current') {
        if (nextTabs.length === 0) {
          nextActiveTabId = null
        } else if (index >= nextTabs.length) {
          nextActiveTabId = nextTabs[nextTabs.length - 1]!.id
        } else {
          nextActiveTabId = nextTabs[index]!.id
        }
      }

      return {
        previewTabsBySession: {
          ...state.previewTabsBySession,
          [sessionId]: nextTabs.length > 0 ? nextTabs : undefined,
        },
        activePreviewTabIdBySession: {
          ...state.activePreviewTabIdBySession,
          [sessionId]: nextActiveTabId,
        },
        loading: {
          ...state.loading,
          previewByTabId: removeRecordKeys(state.loading.previewByTabId, requestKeys),
        },
        errors: {
          ...state.errors,
          previewByTabId: removeRecordKeys(state.errors.previewByTabId, requestKeys),
        },
      }
    })
  },

  invalidateExpandedTreeCache: (sessionId) => {
    set((state) => {
      const expanded = new Set(state.expandedPathsBySession[sessionId] ?? [])
      if (expanded.size === 0) return state
      const sessionTree = state.treeBySessionPath[sessionId]
      if (!sessionTree) return state
      const cleaned: Record<string, WorkspaceTreeResult | undefined> = {}
      for (const key of Object.keys(sessionTree)) {
        if (key === '' || !expanded.has(key)) {
          cleaned[key] = sessionTree[key]
        }
      }
      return {
        treeBySessionPath: {
          ...state.treeBySessionPath,
          [sessionId]: Object.keys(cleaned).length > 0 ? cleaned : undefined,
        },
      }
    })
  },

  handleFileChanged: async (sessionId, filePath) => {
    const parentDir = filePath.substring(0, filePath.lastIndexOf('/')) || ''

    // 防抖：合并 200ms 内的同 session 变化
    const existing = fileChangeTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    fileChangeTimers.set(
      sessionId,
      setTimeout(async () => {
        fileChangeTimers.delete(sessionId)

        const expanded = get().expandedPathsBySession[sessionId] ?? []
        if (parentDir === '' || expanded.includes(parentDir)) {
          await get().loadTree(sessionId, parentDir)
        }

        const tabs = get().previewTabsBySession[sessionId] ?? []
        const fileTabId = getWorkspacePreviewTabId(filePath, 'file')
        const diffTabId = getWorkspacePreviewTabId(filePath, 'diff')
        const matchingTab = tabs.find((t) => t.id === fileTabId || t.id === diffTabId)
        if (matchingTab) {
          await get().openPreview(sessionId, filePath, matchingTab.kind)
        }
      }, 200),
    )
  },

  clearSession: (sessionId) => {
    invalidateRequest(statusRequestIds, sessionId)
    invalidateSessionScopedRequests(treeRequestIds, sessionId)
    invalidateSessionScopedRequests(previewRequestIds, sessionId)

    set((state) => ({
      panelBySession: removeRecordKey(state.panelBySession, sessionId),
      modeBySession: removeRecordKey(state.modeBySession, sessionId),
      statusBySession: removeRecordKey(state.statusBySession, sessionId),
      expandedPathsBySession: removeRecordKey(state.expandedPathsBySession, sessionId),
      treeBySessionPath: removeRecordKey(state.treeBySessionPath, sessionId),
      previewTabsBySession: removeRecordKey(state.previewTabsBySession, sessionId),
      activePreviewTabIdBySession: removeRecordKey(state.activePreviewTabIdBySession, sessionId),
      loading: {
        statusBySession: removeRecordKey(state.loading.statusBySession, sessionId),
        treeBySessionPath: stripSessionKeys(state.loading.treeBySessionPath, sessionId),
        previewByTabId: stripSessionKeys(state.loading.previewByTabId, sessionId),
      },
      errors: {
        statusBySession: removeRecordKey(state.errors.statusBySession, sessionId),
        treeBySessionPath: stripSessionKeys(state.errors.treeBySessionPath, sessionId),
        previewByTabId: stripSessionKeys(state.errors.previewByTabId, sessionId),
      },
    }))
  },

  resetSessionUi: (sessionId) => {
    get().clearSession(sessionId)
  },
}))
