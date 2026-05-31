import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type HoistedVi = typeof vi & {
  hoisted?: <T>(factory: () => T) => T
}

if (typeof (vi as HoistedVi).hoisted !== 'function') {
  ;(vi as HoistedVi).hoisted = <T>(factory: () => T) => factory()
}

const mocks = vi.hoisted(() => ({
  getWorkspaceStatusMock: vi.fn(),
  getWorkspaceTreeMock: vi.fn(),
  getWorkspaceFileMock: vi.fn(),
  getWorkspaceDiffMock: vi.fn(),
}))

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    getWorkspaceStatus: mocks.getWorkspaceStatusMock,
    getWorkspaceTree: mocks.getWorkspaceTreeMock,
    getWorkspaceFile: mocks.getWorkspaceFileMock,
    getWorkspaceDiff: mocks.getWorkspaceDiffMock,
  },
}))

import { sessionsApi } from '../api/sessions'
import {
  WORKSPACE_PANEL_DEFAULT_WIDTH,
  WORKSPACE_PANEL_MAX_WIDTH,
  WORKSPACE_PANEL_MIN_WIDTH,
  getWorkspacePreviewTabId,
  useWorkspacePanelStore,
} from './workspacePanelStore'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('workspacePanelStore', () => {
  const initialState = useWorkspacePanelStore.getInitialState()

  beforeEach(() => {
    vi.clearAllMocks()
    useWorkspacePanelStore.setState(initialState, true)
  })

  afterEach(() => {
    useWorkspacePanelStore.setState(initialState, true)
    vi.restoreAllMocks()
  })

  it('uses hoisted session api mocks', () => {
    expect(sessionsApi.getWorkspaceStatus).toBe(mocks.getWorkspaceStatusMock)
    expect(sessionsApi.getWorkspaceTree).toBe(mocks.getWorkspaceTreeMock)
    expect(sessionsApi.getWorkspaceFile).toBe(mocks.getWorkspaceFileMock)
    expect(sessionsApi.getWorkspaceDiff).toBe(mocks.getWorkspaceDiffMock)
  })

  it('keeps panel open state and active view isolated per session', () => {
    const store = useWorkspacePanelStore.getState()

    expect(store.isPanelOpen('session-a')).toBe(false)
    expect(store.getActiveView('session-a')).toBe('changed')
    expect(store.width).toBe(WORKSPACE_PANEL_DEFAULT_WIDTH)

    store.openPanel('session-a')
    store.setActiveView('session-a', 'all')

    expect(useWorkspacePanelStore.getState().isPanelOpen('session-a')).toBe(true)
    expect(useWorkspacePanelStore.getState().getActiveView('session-a')).toBe('all')
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-b')).toBe(false)
    expect(useWorkspacePanelStore.getState().getActiveView('session-b')).toBe('changed')

    store.togglePanel('session-b')
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-b')).toBe(true)
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-a')).toBe(true)

    store.closePanel('session-a')
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-a')).toBe(false)
    expect(useWorkspacePanelStore.getState().getActiveView('session-a')).toBe('all')

    store.setWidth(120)
    expect(useWorkspacePanelStore.getState().width).toBe(WORKSPACE_PANEL_MIN_WIDTH)
    store.setWidth(1200)
    expect(useWorkspacePanelStore.getState().width).toBe(WORKSPACE_PANEL_MAX_WIDTH)
  })

  it('loads workspace status successfully', async () => {
    mocks.getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [
        {
          path: 'src/a.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
        },
      ],
    })

    await useWorkspacePanelStore.getState().loadStatus('session-1')

    expect(mocks.getWorkspaceStatusMock).toHaveBeenCalledWith('session-1')
    expect(useWorkspacePanelStore.getState().statusBySession['session-1']).toMatchObject({
      branch: 'main',
      changedFiles: [{ path: 'src/a.ts' }],
    })
    expect(useWorkspacePanelStore.getState().loading.statusBySession['session-1']).toBe(false)
    expect(useWorkspacePanelStore.getState().errors.statusBySession['session-1']).toBeNull()
  })

  it('defaults an empty changed-files status to the all-files view', async () => {
    mocks.getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [],
    })

    useWorkspacePanelStore.getState().openPanel('session-empty-changes')
    expect(useWorkspacePanelStore.getState().getActiveView('session-empty-changes')).toBe('changed')

    await useWorkspacePanelStore.getState().loadStatus('session-empty-changes')

    expect(useWorkspacePanelStore.getState().statusBySession['session-empty-changes']?.changedFiles).toEqual([])
    expect(useWorkspacePanelStore.getState().getActiveView('session-empty-changes')).toBe('all')
  })

  it('keeps the changed-files view when status contains changes', async () => {
    mocks.getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [
        {
          path: 'src/app.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
        },
      ],
    })

    useWorkspacePanelStore.getState().openPanel('session-has-changes')
    await useWorkspacePanelStore.getState().loadStatus('session-has-changes')

    expect(useWorkspacePanelStore.getState().getActiveView('session-has-changes')).toBe('changed')
  })

  it('returns to changed-files when a refreshed default all-files view now has changes', async () => {
    mocks.getWorkspaceStatusMock
      .mockResolvedValueOnce({
        state: 'ok',
        workDir: '/repo',
        repoName: 'repo',
        branch: 'main',
        isGitRepo: true,
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        state: 'ok',
        workDir: '/repo',
        repoName: 'repo',
        branch: 'main',
        isGitRepo: true,
        changedFiles: [
          {
            path: 'src/app.ts',
            status: 'modified',
            additions: 2,
            deletions: 1,
          },
        ],
      })

    useWorkspacePanelStore.getState().openPanel('session-refresh-changes')
    await useWorkspacePanelStore.getState().loadStatus('session-refresh-changes')
    expect(useWorkspacePanelStore.getState().getActiveView('session-refresh-changes')).toBe('all')

    await useWorkspacePanelStore.getState().loadStatus('session-refresh-changes')

    expect(useWorkspacePanelStore.getState().getActiveView('session-refresh-changes')).toBe('changed')
  })

  it('does not override an explicit all-files selection when refreshed status has changes', async () => {
    mocks.getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [
        {
          path: 'src/app.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
        },
      ],
    })

    useWorkspacePanelStore.getState().openPanel('session-explicit-all')
    useWorkspacePanelStore.getState().setActiveView('session-explicit-all', 'all')
    await useWorkspacePanelStore.getState().loadStatus('session-explicit-all')

    expect(useWorkspacePanelStore.getState().getActiveView('session-explicit-all')).toBe('all')
  })

  it('does not override an explicit changed-files selection when status is empty', async () => {
    mocks.getWorkspaceStatusMock.mockResolvedValue({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'main',
      isGitRepo: true,
      changedFiles: [],
    })

    useWorkspacePanelStore.getState().openPanel('session-explicit-changed')
    useWorkspacePanelStore.getState().setActiveView('session-explicit-changed', 'changed')
    await useWorkspacePanelStore.getState().loadStatus('session-explicit-changed')

    expect(useWorkspacePanelStore.getState().getActiveView('session-explicit-changed')).toBe('changed')
  })

  it('captures workspace status request errors', async () => {
    mocks.getWorkspaceStatusMock.mockRejectedValue(new Error('status failed'))

    await useWorkspacePanelStore.getState().loadStatus('session-err')

    expect(useWorkspacePanelStore.getState().statusBySession['session-err']).toBeUndefined()
    expect(useWorkspacePanelStore.getState().loading.statusBySession['session-err']).toBe(false)
    expect(useWorkspacePanelStore.getState().errors.statusBySession['session-err']).toBe('status failed')
  })

  it('lazily loads tree nodes when expanding and reuses cached results', async () => {
    mocks.getWorkspaceTreeMock.mockResolvedValue({
      state: 'ok',
      path: '',
      entries: [
        { name: 'src', path: 'src', isDirectory: true, isSymlink: false },
        { name: 'README.md', path: 'README.md', isDirectory: false, isSymlink: false },
      ],
    })

    await useWorkspacePanelStore.getState().toggleTreeNode('session-tree', '')

    expect(mocks.getWorkspaceTreeMock).toHaveBeenCalledTimes(1)
    expect(mocks.getWorkspaceTreeMock).toHaveBeenCalledWith('session-tree', '', false)
    expect(useWorkspacePanelStore.getState().expandedPathsBySession['session-tree']).toEqual([''])
    expect(useWorkspacePanelStore.getState().treeBySessionPath['session-tree']?.['']).toMatchObject({
      entries: [{ path: 'src' }, { path: 'README.md' }],
    })

    await useWorkspacePanelStore.getState().toggleTreeNode('session-tree', '')
    expect(useWorkspacePanelStore.getState().expandedPathsBySession['session-tree']).toEqual([])

    await useWorkspacePanelStore.getState().toggleTreeNode('session-tree', '')
    expect(mocks.getWorkspaceTreeMock).toHaveBeenCalledTimes(1)
    expect(useWorkspacePanelStore.getState().expandedPathsBySession['session-tree']).toEqual([''])
  })

  it('ignores stale tree responses for the same session path', async () => {
    const first = deferred<{ state: 'ok'; path: string; entries: Array<{ name: string; path: string; isDirectory: boolean; isSymlink: boolean }> }>()
    const second = deferred<{ state: 'ok'; path: string; entries: Array<{ name: string; path: string; isDirectory: boolean; isSymlink: boolean }> }>()

    mocks.getWorkspaceTreeMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const firstLoad = useWorkspacePanelStore.getState().loadTree('session-tree-race', 'src')
    const secondLoad = useWorkspacePanelStore.getState().loadTree('session-tree-race', 'src')

    second.resolve({
      state: 'ok',
      path: 'src',
      entries: [{ name: 'new.ts', path: 'src/new.ts', isDirectory: false, isSymlink: false }],
    })
    await secondLoad

    first.resolve({
      state: 'ok',
      path: 'src',
      entries: [{ name: 'old.ts', path: 'src/old.ts', isDirectory: false, isSymlink: false }],
    })
    await firstLoad

    expect(useWorkspacePanelStore.getState().treeBySessionPath['session-tree-race']?.src?.entries).toEqual([
      { name: 'new.ts', path: 'src/new.ts', isDirectory: false, isSymlink: false },
    ])
  })

  it('openPreview opens the workspace panel when it was closed', async () => {
    mocks.getWorkspaceFileMock.mockResolvedValue({
      state: 'ok', path: 'src/a.ts', content: 'export const a = 1', language: 'typescript', size: 18,
    })
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-closed-preview')).toBe(false)
    await useWorkspacePanelStore.getState().openPreview('session-closed-preview', 'src/a.ts', 'file')
    expect(useWorkspacePanelStore.getState().isPanelOpen('session-closed-preview')).toBe(true)
  })

  it('defaults the workbench mode to "workspace"', () => {
    expect(useWorkspacePanelStore.getState().getMode('session-no-mode')).toBe('workspace')
  })

  it('setMode stores the workbench mode per session', () => {
    const store = useWorkspacePanelStore.getState()
    store.setMode('session-a', 'browser')
    store.setMode('session-b', 'workspace')
    expect(useWorkspacePanelStore.getState().getMode('session-a')).toBe('browser')
    expect(useWorkspacePanelStore.getState().getMode('session-b')).toBe('workspace')
    // Unrelated sessions still fall back to the default.
    expect(useWorkspacePanelStore.getState().getMode('session-c')).toBe('workspace')
  })

  it('openPreview opens the panel and forces "workspace" mode', async () => {
    mocks.getWorkspaceFileMock.mockResolvedValue({
      state: 'ok', path: 'src/a.ts', content: 'export const a = 1', language: 'typescript', size: 18,
    })
    // Start in browser mode (panel could already be showing the browser).
    useWorkspacePanelStore.getState().setMode('session-preview-mode', 'browser')
    expect(useWorkspacePanelStore.getState().getMode('session-preview-mode')).toBe('browser')

    await useWorkspacePanelStore.getState().openPreview('session-preview-mode', 'src/a.ts', 'file')

    expect(useWorkspacePanelStore.getState().isPanelOpen('session-preview-mode')).toBe(true)
    expect(useWorkspacePanelStore.getState().getMode('session-preview-mode')).toBe('workspace')
  })

  it('opens preview tabs, supports multiple kinds, and reuses duplicates without persistence', async () => {
    const storage = typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
    const setItemSpy = storage ? vi.spyOn(storage, 'setItem') : null

    mocks.getWorkspaceFileMock.mockResolvedValue({
      state: 'ok',
      path: 'src/a.ts',
      content: 'export const a = 1',
      language: 'typescript',
      size: 18,
    })
    mocks.getWorkspaceDiffMock.mockResolvedValue({
      state: 'ok',
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@',
    })

    useWorkspacePanelStore.getState().openPanel('session-preview')
    await useWorkspacePanelStore.getState().openPreview('session-preview', 'src/a.ts', 'file')
    await useWorkspacePanelStore.getState().openPreview('session-preview', 'src/a.ts', 'diff')
    await useWorkspacePanelStore.getState().openPreview('session-preview', 'src/a.ts', 'file')

    expect(mocks.getWorkspaceFileMock).toHaveBeenCalledTimes(1)
    expect(mocks.getWorkspaceDiffMock).toHaveBeenCalledTimes(1)

    const tabs = useWorkspacePanelStore.getState().previewTabsBySession['session-preview']
    expect(tabs).toBeDefined()
    expect(tabs).toHaveLength(2)
    expect(tabs![0]).toMatchObject({
      id: 'file:src/a.ts',
      kind: 'file',
      path: 'src/a.ts',
      content: 'export const a = 1',
      language: 'typescript',
    })
    expect(tabs![1]).toMatchObject({
      id: 'diff:src/a.ts',
      kind: 'diff',
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@',
    })
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-preview']).toBe('file:src/a.ts')
    if (setItemSpy) {
      expect(setItemSpy).not.toHaveBeenCalled()
    } else {
      expect(storage).toBeNull()
    }
  })

  it('closes exact tab id and preserves sibling preview for the same path', async () => {
    mocks.getWorkspaceFileMock.mockResolvedValue({
      state: 'ok',
      path: 'src/a.ts',
      content: 'export const a = 1',
      language: 'typescript',
      size: 18,
    })
    mocks.getWorkspaceDiffMock.mockResolvedValue({
      state: 'ok',
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@',
    })

    await useWorkspacePanelStore.getState().openPreview('session-close-path', 'src/a.ts', 'file')
    await useWorkspacePanelStore.getState().openPreview('session-close-path', 'src/a.ts', 'diff')

    useWorkspacePanelStore.getState().closePreview('session-close-path', 'diff:src/a.ts')

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-close-path']).toEqual([
      expect.objectContaining({ id: 'file:src/a.ts' }),
    ])
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-close-path']).toBe('file:src/a.ts')
  })

  it('chooses the next sensible active preview when closing the current tab', async () => {
    mocks.getWorkspaceFileMock
      .mockResolvedValueOnce({
        state: 'ok',
        path: 'src/a.ts',
        content: 'a',
        language: 'typescript',
        size: 1,
      })
      .mockResolvedValueOnce({
        state: 'ok',
        path: 'src/b.ts',
        content: 'b',
        language: 'typescript',
        size: 1,
      })
      .mockResolvedValueOnce({
        state: 'ok',
        path: 'src/c.ts',
        content: 'c',
        language: 'typescript',
        size: 1,
      })

    await useWorkspacePanelStore.getState().openPreview('session-close', 'src/a.ts', 'file')
    await useWorkspacePanelStore.getState().openPreview('session-close', 'src/b.ts', 'file')
    await useWorkspacePanelStore.getState().openPreview('session-close', 'src/c.ts', 'file')

    useWorkspacePanelStore.getState().closePreview('session-close', 'file:src/b.ts')

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-close']).toMatchObject([
      { id: 'file:src/a.ts' },
      { id: 'file:src/c.ts' },
    ])
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-close']).toBe('file:src/c.ts')

    useWorkspacePanelStore.getState().closePreview('session-close', 'file:src/c.ts')
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-close']).toBe('file:src/a.ts')
  })

  it('closes preview tabs by context-menu scope', () => {
    useWorkspacePanelStore.setState((state) => ({
      ...state,
      previewTabsBySession: {
        ...state.previewTabsBySession,
        'session-preview-scope': [
          { id: 'file:a.ts', path: 'a.ts', kind: 'file', title: 'a.ts', state: 'ok', language: 'typescript', size: 1 },
          { id: 'file:b.ts', path: 'b.ts', kind: 'file', title: 'b.ts', state: 'ok', language: 'typescript', size: 1 },
          { id: 'file:c.ts', path: 'c.ts', kind: 'file', title: 'c.ts', state: 'ok', language: 'typescript', size: 1 },
          { id: 'file:d.ts', path: 'd.ts', kind: 'file', title: 'd.ts', state: 'ok', language: 'typescript', size: 1 },
        ],
      },
      activePreviewTabIdBySession: {
        ...state.activePreviewTabIdBySession,
        'session-preview-scope': 'file:d.ts',
      },
      loading: {
        ...state.loading,
        previewByTabId: {
          ...state.loading.previewByTabId,
          'session-preview-scope::file:c.ts': true,
          'session-preview-scope::file:d.ts': true,
        },
      },
      errors: {
        ...state.errors,
        previewByTabId: {
          ...state.errors.previewByTabId,
          'session-preview-scope::file:c.ts': 'loading',
          'session-preview-scope::file:d.ts': 'loading',
        },
      },
    }))

    useWorkspacePanelStore.getState().closePreviewTabs('session-preview-scope', 'file:b.ts', 'right')

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preview-scope']).toMatchObject([
      { id: 'file:a.ts' },
      { id: 'file:b.ts' },
    ])
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-preview-scope']).toBe('file:b.ts')
    expect(useWorkspacePanelStore.getState().loading.previewByTabId['session-preview-scope::file:c.ts']).toBeUndefined()
    expect(useWorkspacePanelStore.getState().errors.previewByTabId['session-preview-scope::file:d.ts']).toBeUndefined()

    useWorkspacePanelStore.getState().closePreviewTabs('session-preview-scope', 'file:b.ts', 'others')

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preview-scope']).toMatchObject([
      { id: 'file:b.ts' },
    ])
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-preview-scope']).toBe('file:b.ts')

    useWorkspacePanelStore.getState().closePreviewTabs('session-preview-scope', 'file:b.ts', 'all')

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preview-scope']).toBeUndefined()
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-preview-scope']).toBeNull()
  })

  it('ignores stale status responses for the same session', async () => {
    const first = deferred<{
      state: 'ok'
      workDir: string
      repoName: string | null
      branch: string | null
      isGitRepo: boolean
      changedFiles: []
      error?: string
    }>()
    const second = deferred<{
      state: 'ok'
      workDir: string
      repoName: string | null
      branch: string | null
      isGitRepo: boolean
      changedFiles: []
      error?: string
    }>()

    mocks.getWorkspaceStatusMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const firstLoad = useWorkspacePanelStore.getState().loadStatus('session-race')
    const secondLoad = useWorkspacePanelStore.getState().loadStatus('session-race')

    second.resolve({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'new',
      isGitRepo: true,
      changedFiles: [],
    })
    await secondLoad

    first.resolve({
      state: 'ok',
      workDir: '/repo',
      repoName: 'repo',
      branch: 'old',
      isGitRepo: true,
      changedFiles: [],
    })
    await firstLoad

    expect(useWorkspacePanelStore.getState().statusBySession['session-race']?.branch).toBe('new')
  })

  it('ignores stale preview responses after close and reopen', async () => {
    const first = deferred<{ state: 'ok'; path: string; content: string; language: string; size: number }>()
    const second = deferred<{ state: 'ok'; path: string; content: string; language: string; size: number }>()

    mocks.getWorkspaceFileMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const firstOpen = useWorkspacePanelStore.getState().openPreview('session-preview-race', 'src/a.ts', 'file')
    useWorkspacePanelStore.getState().closePreview('session-preview-race', 'file:src/a.ts')
    const secondOpen = useWorkspacePanelStore.getState().openPreview('session-preview-race', 'src/a.ts', 'file')

    second.resolve({
      state: 'ok',
      path: 'src/a.ts',
      content: 'new',
      language: 'typescript',
      size: 3,
    })
    await secondOpen

    first.resolve({
      state: 'ok',
      path: 'src/a.ts',
      content: 'old',
      language: 'typescript',
      size: 3,
    })
    await firstOpen

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preview-race']).toEqual([
      expect.objectContaining({ id: 'file:src/a.ts', content: 'new' }),
    ])
  })

  it('does not recreate loading or error state when a loading preview is closed before completion', async () => {
    const pending = deferred<{ state: 'ok'; path: string; diff: string }>()
    const tabId = getWorkspacePreviewTabId('src/a.ts', 'diff')
    const previewKey = `session-preview-close::${tabId}`

    mocks.getWorkspaceDiffMock.mockReturnValueOnce(pending.promise)

    const openPromise = useWorkspacePanelStore.getState().openPreview('session-preview-close', 'src/a.ts', 'diff')
    useWorkspacePanelStore.getState().closePreview('session-preview-close', tabId)

    pending.resolve({
      state: 'ok',
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@',
    })
    await openPromise

    expect(useWorkspacePanelStore.getState().previewTabsBySession['session-preview-close']).toBeUndefined()
    expect(useWorkspacePanelStore.getState().activePreviewTabIdBySession['session-preview-close']).toBeNull()
    expect(useWorkspacePanelStore.getState().loading.previewByTabId[previewKey]).toBeUndefined()
    expect(useWorkspacePanelStore.getState().errors.previewByTabId[previewKey]).toBeUndefined()
  })

  it('clears session UI and cached data for clearSession and resetSessionUi', () => {
    useWorkspacePanelStore.setState((state) => ({
      ...state,
      panelBySession: {
        'session-clear': { isOpen: true, activeView: 'all' },
        'session-reset': { isOpen: true, activeView: 'all' },
      },
      modeBySession: {
        'session-clear': 'browser',
        'session-reset': 'browser',
      },
      statusBySession: {
        'session-clear': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
        'session-reset': {
          state: 'ok',
          workDir: '/repo',
          repoName: 'repo',
          branch: 'main',
          isGitRepo: true,
          changedFiles: [],
        },
      },
      expandedPathsBySession: {
        'session-clear': ['src'],
        'session-reset': ['src'],
      },
      treeBySessionPath: {
        'session-clear': {
          src: { state: 'ok', path: 'src', entries: [] },
        },
        'session-reset': {
          src: { state: 'ok', path: 'src', entries: [] },
        },
      },
      previewTabsBySession: {
        'session-clear': [
          { id: 'file:src/a.ts', path: 'src/a.ts', kind: 'file', title: 'a.ts' },
        ],
        'session-reset': [
          { id: 'file:src/b.ts', path: 'src/b.ts', kind: 'file', title: 'b.ts' },
        ],
      },
      activePreviewTabIdBySession: {
        'session-clear': 'file:src/a.ts',
        'session-reset': 'file:src/b.ts',
      },
      loading: {
        statusBySession: {
          'session-clear': true,
          'session-reset': true,
        },
        treeBySessionPath: {
          'session-clear::src': true,
          'session-reset::src': true,
        },
        previewByTabId: {
          'session-clear::file:src/a.ts': true,
          'session-reset::file:src/b.ts': true,
        },
      },
      errors: {
        statusBySession: {
          'session-clear': 'bad',
          'session-reset': 'bad',
        },
        treeBySessionPath: {
          'session-clear::src': 'bad',
          'session-reset::src': 'bad',
        },
        previewByTabId: {
          'session-clear::file:src/a.ts': 'bad',
          'session-reset::file:src/b.ts': 'bad',
        },
      },
    }))

    useWorkspacePanelStore.getState().clearSession('session-clear')
    useWorkspacePanelStore.getState().resetSessionUi('session-reset')

    const state = useWorkspacePanelStore.getState()
    expect(state.panelBySession['session-clear']).toBeUndefined()
    expect(state.panelBySession['session-reset']).toBeUndefined()
    expect(state.modeBySession['session-clear']).toBeUndefined()
    expect(state.modeBySession['session-reset']).toBeUndefined()
    expect(state.statusBySession['session-clear']).toBeUndefined()
    expect(state.statusBySession['session-reset']).toBeUndefined()
    expect(state.expandedPathsBySession['session-clear']).toBeUndefined()
    expect(state.expandedPathsBySession['session-reset']).toBeUndefined()
    expect(state.treeBySessionPath['session-clear']).toBeUndefined()
    expect(state.treeBySessionPath['session-reset']).toBeUndefined()
    expect(state.previewTabsBySession['session-clear']).toBeUndefined()
    expect(state.previewTabsBySession['session-reset']).toBeUndefined()
    expect(state.activePreviewTabIdBySession['session-clear']).toBeUndefined()
    expect(state.activePreviewTabIdBySession['session-reset']).toBeUndefined()
    expect(state.loading.statusBySession['session-clear']).toBeUndefined()
    expect(state.loading.statusBySession['session-reset']).toBeUndefined()
    expect(state.loading.treeBySessionPath['session-clear::src']).toBeUndefined()
    expect(state.loading.treeBySessionPath['session-reset::src']).toBeUndefined()
    expect(state.loading.previewByTabId['session-clear::file:src/a.ts']).toBeUndefined()
    expect(state.loading.previewByTabId['session-reset::file:src/b.ts']).toBeUndefined()
    expect(state.errors.statusBySession['session-clear']).toBeUndefined()
    expect(state.errors.statusBySession['session-reset']).toBeUndefined()
    expect(state.errors.treeBySessionPath['session-clear::src']).toBeUndefined()
    expect(state.errors.treeBySessionPath['session-reset::src']).toBeUndefined()
    expect(state.errors.previewByTabId['session-clear::file:src/a.ts']).toBeUndefined()
    expect(state.errors.previewByTabId['session-reset::file:src/b.ts']).toBeUndefined()
  })
})
