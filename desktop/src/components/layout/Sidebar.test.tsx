import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

const desktopUiPreferencesApiMock = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updateSidebarPreferences: vi.fn(),
}))

vi.mock('../../api/desktopUiPreferences', () => ({
  desktopUiPreferencesApi: desktopUiPreferencesApiMock,
}))

const openTargetStoreMock = vi.hoisted(() => ({
  ensureTargets: vi.fn(),
  openTarget: vi.fn(),
  targets: [{ id: 'finder', kind: 'file_manager', label: 'Finder', platform: 'darwin' }],
}))

vi.mock('../../stores/openTargetStore', () => ({
  useOpenTargetStore: {
    getState: () => openTargetStoreMock,
  },
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string, params?: Record<string, string | number>) => {
    const translations: Record<string, string> = {
      'sidebar.newSession': 'New Session',
      'sidebar.scheduled': 'Scheduled',
      'sidebar.settings': 'Settings',
      'sidebar.searchPlaceholder': 'Search sessions',
      'sidebar.noSessions': 'No sessions',
      'sidebar.noMatching': 'No matching sessions',
      'sidebar.sessionListFailed': 'Session list failed',
      'sidebar.refreshSessions': 'Refresh sessions',
      'sidebar.projects': 'Projects',
      'sidebar.projectMenu': 'Project menu',
      'sidebar.newProject': 'New project',
      'sidebar.archiveAllChats': 'Archive all chats',
      'sidebar.organizeSidebar': 'Organize sidebar',
      'sidebar.sortCondition': 'Sort condition',
      'sidebar.organizeByProject': 'By project',
      'sidebar.organizeByRecentProject': 'Recent projects',
      'sidebar.organizeByTime': 'By time',
      'sidebar.sortByCreatedAt': 'Created time',
      'sidebar.sortByUpdatedAt': 'Updated time',
      'sidebar.newBlankProject': 'New blank project',
      'sidebar.useExistingFolder': 'Use existing folder',
      'sidebar.chooseProjectFolderUnavailable': 'Folder selection is only available in the desktop app.',
      'sidebar.projectActions': 'Project actions for {project}',
      'sidebar.pinProject': 'Pin Project',
      'sidebar.unpinProject': 'Unpin Project',
      'sidebar.openInFinder': 'Open in Finder',
      'sidebar.openInFinderFailed': 'Could not open the project in Finder.',
      'sidebar.openInFinderUnavailable': 'No file manager is available.',
      'sidebar.hideProjectFromSidebar': 'Remove from Sidebar',
      'sidebar.restoreProjectToSidebar': 'Restore to Sidebar',
      'sidebar.projectHidden': '{project} was removed from the sidebar.',
      'sidebar.newSessionInProject': 'New session in {project}',
      'sidebar.showMoreSessions': 'Expand display',
      'sidebar.showFewerSessions': 'Collapse display',
      'sidebar.expandProject': 'Expand {project}',
      'sidebar.collapseProject': 'Collapse {project}',
      'sidebar.worktree': 'worktree',
      'common.retry': 'Retry',
      'common.loading': 'Loading...',
      'common.cancel': 'Cancel',
      'common.delete': 'Delete',
      'common.rename': 'Rename',
      'sidebar.timeGroup.today': 'Today',
      'sidebar.timeGroup.yesterday': 'Yesterday',
      'sidebar.timeGroup.last7days': 'Last 7 Days',
      'sidebar.timeGroup.last30days': 'Last 30 Days',
      'sidebar.timeGroup.older': 'Older',
      'sidebar.missingDir': 'Missing',
      'sidebar.confirmDelete': 'Delete this session? This cannot be undone.',
      'sidebar.batchManage': 'Batch manage',
      'sidebar.batchSelectedCount': '{count} selected',
      'sidebar.batchSelectAll': 'Select all',
      'sidebar.batchDeselectAll': 'Deselect all',
      'sidebar.batchSelectGroup': 'Select {group}',
      'sidebar.batchDeleteSelected': 'Delete selected ({count})',
      'sidebar.batchDeleteConfirm': 'Delete {count} sessions? This cannot be undone.',
      'sidebar.batchDeleteConfirmBody': 'The following sessions will be deleted:',
      'sidebar.batchDeleteMore': '...and {count} more',
      'sidebar.batchExit': 'Cancel batch mode',
      'sidebar.batchDeleteSucceeded': 'Deleted {count} sessions.',
      'sidebar.batchDeleteFailed': '{count} sessions could not be deleted.',
      'sidebar.collapse': 'Collapse sidebar',
      'sidebar.expand': 'Expand sidebar',
    }

    let text = translations[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) {
      text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
    }
    return text
  },
}))

import { Sidebar } from './Sidebar'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import type { SessionListItem } from '../../types/session'

const PROJECT_ORDER_STORAGE_KEY = 'cc-haha-sidebar-project-order'
const PROJECT_PINNED_STORAGE_KEY = 'cc-haha-sidebar-pinned-projects'
const PROJECT_HIDDEN_STORAGE_KEY = 'cc-haha-sidebar-hidden-projects'
const PROJECT_ORGANIZATION_STORAGE_KEY = 'cc-haha-sidebar-project-organization'
const PROJECT_SORT_STORAGE_KEY = 'cc-haha-sidebar-project-sort'

function makeSession(
  id: string,
  title: string,
  projectRoot: string,
  modifiedAt: string,
): SessionListItem {
  return {
    id,
    title,
    createdAt: modifiedAt,
    modifiedAt,
    messageCount: 1,
    projectPath: projectRoot,
    projectRoot,
    workDir: projectRoot,
    workDirExists: true,
  }
}

function makeDataTransfer() {
  const data = new Map<string, string>()
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: vi.fn((type: string, value: string) => data.set(type, value)),
    getData: vi.fn((type: string) => data.get(type) ?? ''),
  }
}

function projectGroupNames(): string[] {
  return screen
    .getAllByTestId(/^sidebar-project-group-/)
    .map((group) => group.textContent ?? '')
    .map((text) => {
      if (text.includes('alpha')) return 'alpha'
      if (text.includes('beta')) return 'beta'
      if (text.includes('gamma')) return 'gamma'
      return text
    })
}

describe('Sidebar', () => {
  const connectToSession = vi.fn()
  const disconnectSession = vi.fn()
  const fetchSessions = vi.fn()
  const createSession = vi.fn()
  const deleteSession = vi.fn()
  const deleteSessions = vi.fn()
  const addToast = vi.fn()

  beforeEach(() => {
    connectToSession.mockReset()
    disconnectSession.mockReset()
    fetchSessions.mockReset()
    createSession.mockReset()
    deleteSession.mockReset()
    deleteSessions.mockReset()
    addToast.mockReset()
    desktopUiPreferencesApiMock.getPreferences.mockReset()
    desktopUiPreferencesApiMock.updateSidebarPreferences.mockReset()
    desktopUiPreferencesApiMock.getPreferences.mockRejectedValue(new Error('server unavailable'))
    desktopUiPreferencesApiMock.updateSidebarPreferences.mockResolvedValue({
      ok: true,
      preferences: {
        schemaVersion: 1,
        sidebar: {
          projectOrder: [],
          pinnedProjects: [],
          hiddenProjects: [],
          projectOrganization: 'recentProject',
          projectSortBy: 'updatedAt',
        },
      },
    })
    openTargetStoreMock.ensureTargets.mockReset()
    openTargetStoreMock.openTarget.mockReset()
    openTargetStoreMock.targets = [{ id: 'finder', kind: 'file_manager', label: 'Finder', platform: 'darwin' }]
    window.localStorage.removeItem(PROJECT_ORDER_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_PINNED_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_HIDDEN_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_ORGANIZATION_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_SORT_STORAGE_KEY)

    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      error: null,
      isBatchMode: false,
      selectedSessionIds: new Set(),
      fetchSessions,
      createSession,
      deleteSession,
      deleteSessions,
    })
    useChatStore.setState({
      connectToSession,
      disconnectSession,
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useUIStore.setState({
      sidebarOpen: true,
      addToast,
    } as Partial<ReturnType<typeof useUIStore.getState>>)
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    useTabStore.setState({ tabs: [], activeTabId: null })
    window.localStorage.removeItem(PROJECT_ORDER_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_PINNED_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_HIDDEN_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_ORGANIZATION_STORAGE_KEY)
    window.localStorage.removeItem(PROJECT_SORT_STORAGE_KEY)
  })

  it('opens a new tab when creating a session from the sidebar', async () => {
    createSession.mockResolvedValue('session-new-1')

    render(<Sidebar />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    })

    await waitFor(() => {
      expect(createSession).toHaveBeenCalled()
      expect(connectToSession).toHaveBeenCalledWith('session-new-1')
    })

    expect(useTabStore.getState().tabs).toEqual([
      { sessionId: 'session-new-1', title: 'New Session', type: 'session', status: 'idle' },
    ])
    expect(useTabStore.getState().activeTabId).toBe('session-new-1')
    expect(screen.getByRole('complementary')).not.toHaveAttribute('data-tauri-drag-region')
  })

  it('groups sessions by project and expands overflow rows', () => {
    const base = new Date('2026-05-15T10:00:00.000Z').getTime()
    useSessionStore.setState({
      sessions: [
        ...Array.from({ length: 11 }, (_, index) => (
          makeSession(
            `alpha-${index + 1}`,
            index === 0 ? 'Alpha newest' : index === 10 ? 'Alpha hidden' : `Alpha ${index + 1}`,
            '/workspace/alpha',
            new Date(base - index * 1000).toISOString(),
          )
        )),
        makeSession('beta-1', 'Beta only', '/workspace/beta', new Date(base - 4000).toISOString()),
      ],
    })

    render(<Sidebar />)

    expect(screen.getByText('Projects')).toBeInTheDocument()
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByText('/workspace/alpha')).not.toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alpha newest/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Alpha hidden/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alpha newest/ }).closest('[class*="pl-0"]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Expand display' }))

    expect(screen.getByRole('button', { name: /Alpha hidden/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse display' })).toBeInTheDocument()
  })

  it('reorders project groups by dragging project headers while preserving expanded state', async () => {
    const base = new Date('2026-05-15T10:00:00.000Z').getTime()
    useSessionStore.setState({
      sessions: [
        ...Array.from({ length: 11 }, (_, index) => (
          makeSession(
            `alpha-${index + 1}`,
            index === 10 ? 'Alpha hidden' : `Alpha ${index + 1}`,
            '/workspace/alpha',
            new Date(base - index * 1000).toISOString(),
          )
        )),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', new Date(base - 20_000).toISOString()),
        makeSession('gamma-1', 'Gamma Session', '/workspace/gamma', new Date(base - 30_000).toISOString()),
      ],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Expand display' }))
    expect(screen.getByRole('button', { name: /Alpha hidden/ })).toBeInTheDocument()
    expect(projectGroupNames().slice(0, 3)).toEqual(['alpha', 'beta', 'gamma'])

    const dataTransfer = makeDataTransfer()
    const alphaGroup = screen.getByTestId('sidebar-project-group-workspace-alpha')
    vi.spyOn(alphaGroup, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 100,
      left: 0,
      right: 280,
      width: 280,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    fireEvent.dragStart(screen.getByRole('button', { name: 'Collapse gamma' }), { dataTransfer })
    fireEvent.dragOver(alphaGroup, { clientY: -10, dataTransfer })
    fireEvent.drop(alphaGroup, { clientY: -10, dataTransfer })

    await waitFor(() => {
      expect(projectGroupNames().slice(0, 3)).toEqual(['alpha', 'gamma', 'beta'])
    })
    expect(screen.getByRole('button', { name: /Alpha hidden/ })).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem(PROJECT_ORDER_STORAGE_KEY) ?? '[]').slice(0, 3)).toEqual([
      '/workspace/alpha',
      '/workspace/gamma',
      '/workspace/beta',
    ])
  })

  it('restores the saved project drag order on render', () => {
    window.localStorage.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify([
      '/workspace/beta',
      '/workspace/alpha',
    ]))
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', now),
        makeSession('gamma-1', 'Gamma Session', '/workspace/gamma', now),
      ],
    })

    render(<Sidebar />)

    expect(projectGroupNames().slice(0, 3)).toEqual(['beta', 'alpha', 'gamma'])
  })

  it('collapses a project group without removing the project header', () => {
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', now),
      ],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Collapse alpha' }))

    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Alpha Session/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Beta Session/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand alpha' })).toBeInTheDocument()
  })

  it('uses a bounded per-project session scroller for large expanded groups', () => {
    const base = new Date('2026-05-15T10:00:00.000Z').getTime()
    useSessionStore.setState({
      sessions: Array.from({ length: 14 }, (_, index) => (
        makeSession(`alpha-${index + 1}`, `Alpha ${index + 1}`, '/workspace/alpha', new Date(base - index * 1000).toISOString())
      )),
    })

    render(<Sidebar />)

    const expandButton = screen.getByRole('button', { name: 'Expand display' })
    expect(expandButton).toHaveAttribute('aria-expanded', 'false')
    expect(expandButton.parentElement).toHaveClass('justify-start')
    expect(expandButton).toHaveClass('text-[var(--color-text-tertiary)]', 'opacity-75')

    fireEvent.click(expandButton)

    expect(screen.getByTestId('sidebar-project-session-list-workspace-alpha')).toHaveClass('max-h-[420px]', 'overflow-y-auto')
    expect(screen.getByRole('button', { name: 'Collapse display' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('creates a new session from the project group context', async () => {
    createSession.mockResolvedValue('session-alpha-new')
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString()),
      ],
    })

    render(<Sidebar />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New session in alpha' }))
    })

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith('/workspace/alpha')
      expect(connectToSession).toHaveBeenCalledWith('session-alpha-new')
    })
  })

  it('shows project header menus and starts a blank project session', async () => {
    createSession.mockResolvedValue('session-blank-project')
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString()),
      ],
    })

    render(<Sidebar />)

    expect(screen.getByTestId('sidebar-projects-header')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(screen.getByRole('menuitem', { name: 'New blank project' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'New blank project' }))
    })

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith(undefined)
      expect(connectToSession).toHaveBeenCalledWith('session-blank-project')
    })
  })

  it('persists project header sort preferences through desktop UI settings', async () => {
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', '2026-03-01T00:00:00.000Z'),
        {
          ...makeSession('beta-1', 'Beta Session', '/workspace/beta', '2026-02-01T00:00:00.000Z'),
          createdAt: '2026-04-01T00:00:00.000Z',
        },
      ],
    })

    render(<Sidebar />)

    expect(projectGroupNames().slice(0, 2)).toEqual(['alpha', 'beta'])

    fireEvent.click(screen.getByRole('button', { name: 'Project menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sort condition' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Created time' }))

    await waitFor(() => {
      expect(desktopUiPreferencesApiMock.updateSidebarPreferences).toHaveBeenCalledWith({
        projectOrder: [],
        pinnedProjects: [],
        hiddenProjects: [],
        projectOrganization: 'recentProject',
        projectSortBy: 'createdAt',
      })
      expect(projectGroupNames().slice(0, 2)).toEqual(['beta', 'alpha'])
    })
    expect(window.localStorage.getItem(PROJECT_SORT_STORAGE_KEY)).toBe('createdAt')
  })

  it('hides archive-all from the project header menu', () => {
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', now),
      ],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Project menu' }))

    expect(screen.queryByRole('menuitem', { name: 'Archive all chats' })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Organize sidebar' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Sort condition' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps project row actions hidden until project hover or focus', () => {
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString()),
      ],
    })

    render(<Sidebar />)

    const actionButton = screen.getByRole('button', { name: 'Project actions for alpha' })
    expect(actionButton.parentElement).toHaveClass('opacity-0')
    expect(actionButton.parentElement).toHaveClass('group-hover/project:opacity-100')
    expect(actionButton.parentElement).toHaveClass('group-focus-within/project:opacity-100')
  })

  it('shows the project action menu with pin and Finder actions', async () => {
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
      ],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for alpha' }))

    expect(screen.getByRole('menuitem', { name: 'Pin Project' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Open in Finder' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Remove from Sidebar' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Create Permanent Worktree' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Rename Project' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Archive Conversations' })).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Finder' }))
    })

    expect(openTargetStoreMock.ensureTargets).toHaveBeenCalledTimes(1)
    expect(openTargetStoreMock.openTarget).toHaveBeenCalledWith('finder', '/workspace/alpha')
  })

  it('pins a project above the rest of the project list', async () => {
    const base = new Date('2026-05-15T10:00:00.000Z').getTime()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date(base).toISOString()),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', new Date(base - 20_000).toISOString()),
      ],
    })

    render(<Sidebar />)

    expect(projectGroupNames().slice(0, 2)).toEqual(['alpha', 'beta'])

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for beta' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin Project' }))

    await waitFor(() => {
      expect(projectGroupNames().slice(0, 2)).toEqual(['beta', 'alpha'])
    })
    expect(JSON.parse(window.localStorage.getItem(PROJECT_PINNED_STORAGE_KEY) ?? '[]')).toEqual(['/workspace/beta'])
  })

  it('removes a project from the sidebar without deleting its sessions', async () => {
    const base = new Date('2026-05-15T10:00:00.000Z').getTime()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date(base).toISOString()),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', new Date(base - 20_000).toISOString()),
      ],
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Project actions for beta' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from Sidebar' }))

    await waitFor(() => {
      expect(screen.queryByText('beta')).not.toBeInTheDocument()
    })
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(deleteSessions).not.toHaveBeenCalled()
    expect(deleteSession).not.toHaveBeenCalled()
    expect(JSON.parse(window.localStorage.getItem(PROJECT_HIDDEN_STORAGE_KEY) ?? '[]')).toEqual(['/workspace/beta'])
    expect(addToast).toHaveBeenCalledWith({
      type: 'info',
      message: 'beta was removed from the sidebar.',
    })
  })

  it('keeps hidden projects out of the sidebar without the removed project filter', () => {
    window.localStorage.setItem(PROJECT_HIDDEN_STORAGE_KEY, JSON.stringify(['/workspace/beta']))
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', now),
      ],
    })

    render(<Sidebar />)

    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByText('beta')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-filter')).not.toBeInTheDocument()
  })

  it('uses server sidebar preferences across browser and desktop storage contexts', async () => {
    desktopUiPreferencesApiMock.getPreferences.mockResolvedValueOnce({
      exists: true,
      preferences: {
        schemaVersion: 1,
        sidebar: {
          projectOrder: ['/workspace/beta', '/workspace/alpha'],
          pinnedProjects: ['/workspace/beta'],
          hiddenProjects: ['/workspace/alpha'],
          projectOrganization: 'recentProject',
          projectSortBy: 'updatedAt',
        },
      },
    })
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', now),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', now),
      ],
    })

    render(<Sidebar />)

    await waitFor(() => {
      expect(screen.queryByText('alpha')).not.toBeInTheDocument()
      expect(screen.getByText('beta')).toBeInTheDocument()
    })
    expect(JSON.parse(window.localStorage.getItem(PROJECT_ORDER_STORAGE_KEY) ?? '[]')).toEqual([
      '/workspace/beta',
      '/workspace/alpha',
    ])
    expect(JSON.parse(window.localStorage.getItem(PROJECT_PINNED_STORAGE_KEY) ?? '[]')).toEqual(['/workspace/beta'])
    expect(JSON.parse(window.localStorage.getItem(PROJECT_HIDDEN_STORAGE_KEY) ?? '[]')).toEqual(['/workspace/alpha'])
  })

  it('migrates cached local sidebar preferences when the server file is missing after update', async () => {
    desktopUiPreferencesApiMock.getPreferences.mockResolvedValueOnce({
      exists: false,
      preferences: {
        schemaVersion: 1,
        sidebar: {
          projectOrder: [],
          pinnedProjects: [],
          hiddenProjects: [],
          projectOrganization: 'recentProject',
          projectSortBy: 'updatedAt',
        },
      },
    })
    window.localStorage.setItem(PROJECT_HIDDEN_STORAGE_KEY, JSON.stringify(['/workspace/beta']))
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString()),
        makeSession('beta-1', 'Beta Session', '/workspace/beta', new Date().toISOString()),
      ],
    })

    render(<Sidebar />)

    await waitFor(() => {
      expect(desktopUiPreferencesApiMock.updateSidebarPreferences).toHaveBeenCalledWith({
        projectOrder: [],
        pinnedProjects: [],
        hiddenProjects: ['/workspace/beta'],
        projectOrganization: 'recentProject',
        projectSortBy: 'updatedAt',
      })
    })
    expect(screen.queryByText('beta')).not.toBeInTheDocument()
  })

  it('ignores corrupt hidden project storage for backward compatibility', () => {
    window.localStorage.setItem(PROJECT_HIDDEN_STORAGE_KEY, '{bad json')
    useSessionStore.setState({
      sessions: [
        makeSession('alpha-1', 'Alpha Session', '/workspace/alpha', new Date().toISOString()),
      ],
    })

    render(<Sidebar />)

    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alpha Session/ })).toBeInTheDocument()
  })

  it('keeps persisted worktree sessions under the source project group', () => {
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        makeSession('source-1', 'Source Session', '/workspace/repo', now),
        {
          ...makeSession('worktree-1', 'Worktree Session', '/workspace/repo/.claude/worktrees/desktop-main-12345678', now),
          projectRoot: '/workspace/repo',
        },
        {
          ...makeSession('subdir-1', 'Subdir Session', '/workspace/repo/packages/app', now),
          projectRoot: '/workspace/repo',
        },
      ],
    })

    render(<Sidebar />)

    expect(screen.getByText('repo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Source Session/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Worktree Session/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Subdir Session/ })).toBeInTheDocument()
    expect(screen.getAllByText('worktree')).toHaveLength(1)
  })

  it('shows a toast when session creation fails', async () => {
    createSession.mockRejectedValue(new Error('boom'))

    render(<Sidebar />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    })

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith({
        type: 'error',
        message: 'boom',
      })
    })

    expect(useTabStore.getState().tabs).toEqual([])
  })

  it('requires confirmation before deleting a session from the sidebar', async () => {
    deleteSession.mockResolvedValue(undefined)
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'Open Session',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
    })
    useTabStore.setState({
      tabs: [{ sessionId: 'session-1', title: 'Open Session', type: 'session', status: 'idle' }],
      activeTabId: 'session-1',
    })

    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /Open Session/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(deleteSession).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('Delete this session? This cannot be undone.')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    })

    await waitFor(() => {
      expect(deleteSession).toHaveBeenCalledWith('session-1')
      expect(disconnectSession).toHaveBeenCalledWith('session-1')
    })

    expect(useTabStore.getState().tabs).toEqual([])
    expect(useTabStore.getState().activeTabId).toBeNull()
  })

  it('selects and deletes multiple sessions from batch mode', async () => {
    deleteSessions.mockResolvedValue({
      ok: true,
      successes: ['session-1', 'session-2'],
      failures: [],
    })
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'First Session',
          createdAt: now,
          modifiedAt: now,
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
        {
          id: 'session-2',
          title: 'Second Session',
          createdAt: now,
          modifiedAt: now,
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
    })
    useTabStore.setState({
      tabs: [
        { sessionId: 'session-1', title: 'First Session', type: 'session', status: 'idle' },
        { sessionId: 'session-2', title: 'Second Session', type: 'session', status: 'idle' },
      ],
      activeTabId: 'session-1',
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Batch manage' }))
    fireEvent.click(screen.getByRole('button', { name: /First Session/ }))
    fireEvent.click(screen.getByRole('button', { name: /Second Session/ }))

    expect(screen.getByText('2 selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (2)' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Delete 2 sessions? This cannot be undone.')).toBeInTheDocument()
    expect(within(dialog).getByText('First Session')).toBeInTheDocument()
    expect(within(dialog).getByText('Second Session')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    })

    await waitFor(() => {
      expect(deleteSessions).toHaveBeenCalledWith(['session-1', 'session-2'])
      expect(disconnectSession).toHaveBeenCalledWith('session-1')
      expect(disconnectSession).toHaveBeenCalledWith('session-2')
    })
    expect(useTabStore.getState().tabs).toEqual([])
    expect(addToast).toHaveBeenCalledWith({
      type: 'success',
      message: 'Deleted 2 sessions.',
    })
  })

  it('renders batch-selected sessions as separated selected rows', () => {
    const now = new Date().toISOString()
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'First Session',
          createdAt: now,
          modifiedAt: now,
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
        {
          id: 'session-2',
          title: 'Second Session',
          createdAt: now,
          modifiedAt: now,
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
        {
          id: 'session-3',
          title: 'Third Session',
          createdAt: now,
          modifiedAt: now,
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
    })
    useTabStore.setState({
      tabs: [{ sessionId: 'session-2', title: 'Second Session', type: 'session', status: 'idle' }],
      activeTabId: 'session-2',
    })

    render(<Sidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'Batch manage' }))
    fireEvent.click(screen.getByRole('button', { name: /First Session/ }))

    expect(screen.getByRole('button', { name: /First Session/ }).parentElement).toHaveClass('mb-0.5')
    expect(screen.getByRole('button', { name: /First Session/ })).toHaveClass('sidebar-session-row--selected')
    expect(screen.getByRole('button', { name: /Second Session/ })).toHaveClass('sidebar-session-row--active')
    expect(screen.getByRole('button', { name: /Third Session/ })).toHaveClass('sidebar-session-row--idle')
  })

  it('collapses into an icon rail and expands back', async () => {
    render(<Sidebar />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    })

    expect(useUIStore.getState().sidebarOpen).toBe(false)
    expect(screen.queryByPlaceholderText('Search sessions')).not.toBeInTheDocument()
    expect(screen.getByRole('complementary')).toHaveAttribute('data-state', 'closed')
    expect(screen.getByTestId('sidebar-expand-button')).toHaveClass('sidebar-toggle-button--collapsed')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    })

    expect(useUIStore.getState().sidebarOpen).toBe(true)
    expect(screen.getByPlaceholderText('Search sessions')).toBeInTheDocument()
    expect(screen.getByRole('complementary')).toHaveAttribute('data-state', 'open')
  })

  it('renders search controls without the removed embedded project filter', () => {
    render(<Sidebar />)

    expect(screen.getByTestId('sidebar-search-controls-section')).toHaveStyle({ overflow: 'visible' })
    expect(screen.getByTestId('sidebar-search-controls-section')).toHaveClass('relative', 'z-20')
    expect(screen.getByPlaceholderText('Search sessions')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /All projects/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-filter')).not.toBeInTheDocument()
  })

  it('keeps the session list section in a constrained flex column for scrolling', () => {
    render(<Sidebar />)

    expect(screen.getByTestId('sidebar-session-list-section')).toHaveClass('flex', 'flex-1', 'min-h-0', 'flex-col')
  })

  it('keeps the settings dock opaque above the scrolling session list', () => {
    render(<Sidebar />)

    expect(screen.getByTestId('sidebar-settings-dock')).toHaveClass('sidebar-settings-dock')
    expect(screen.getByTestId('sidebar-settings-dock')).toHaveClass('absolute', 'bottom-0')
  })

  it('keeps mobile navigation focused on chat sessions', async () => {
    const onRequestClose = vi.fn()
    createSession.mockResolvedValue('session-mobile-new')
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          title: 'Open Session',
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString(),
          messageCount: 1,
          projectPath: '/workspace/project',
          workDir: '/workspace/project',
          workDirExists: true,
        },
      ],
    })

    render(<Sidebar isMobile onRequestClose={onRequestClose} />)

    expect(screen.queryByRole('button', { name: 'Scheduled' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Open Session/ }))
    expect(onRequestClose).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    })

    await waitFor(() => {
      expect(createSession).toHaveBeenCalled()
    })
    expect(onRequestClose).toHaveBeenCalledTimes(2)
  })

  it('shows a loading state instead of an empty session list while initial fetch is pending', () => {
    useSessionStore.setState({ isLoading: true, sessions: [] })

    render(<Sidebar />)

    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('No sessions')).not.toBeInTheDocument()
  })

  it('refreshes sessions manually and through low-frequency visible polling', async () => {
    vi.useFakeTimers()

    render(<Sidebar />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(fetchSessions).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }))
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(2)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(3)
  })

  it('does not poll for session changes while the document is hidden', async () => {
    vi.useFakeTimers()
    const originalVisibility = document.visibilityState
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })

    render(<Sidebar />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    expect(fetchSessions).toHaveBeenCalledTimes(2)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: originalVisibility,
    })
  })
})

describe('Sidebar observer session filtering', () => {
  const fetchSessions = vi.fn()

  beforeEach(() => {
    fetchSessions.mockReset()
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({
      sessions: [],
      activeSessionId: null,
      isLoading: false,
      error: null,
      selectedProjects: [],
      availableProjects: [],
      isBatchMode: false,
      selectedSessionIds: new Set(),
      fetchSessions,
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      deleteSessions: vi.fn(),
    })
    useUIStore.setState({
      sidebarOpen: true,
      addToast: vi.fn(),
    } as Partial<ReturnType<typeof useUIStore.getState>>)
    useSettingsStore.setState({ observerSessionsHidden: false })
  })

  afterEach(() => {
    cleanup()
  })

  const observerSession = {
    id: 'observer-1',
    title: 'Hello memory agent',
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    messageCount: 5,
    projectPath: '-Users-test--claude-mem-observer-sessions',
    workDir: '/Users/test/.claude-mem/observer-sessions',
    workDirExists: true,
  }

  const normalSession = {
    id: 'normal-1',
    title: 'Bug fix in auth',
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    messageCount: 3,
    projectPath: '-Users-test-my-project',
    workDir: '/Users/test/my-project',
    workDirExists: true,
  }

  it('shows observer sessions when toggle is off', () => {
    useSettingsStore.setState({ observerSessionsHidden: false })
    useSessionStore.setState({ sessions: [normalSession, observerSession] })

    render(<Sidebar />)

    expect(screen.getByText('Hello memory agent')).toBeInTheDocument()
    expect(screen.getByText('Bug fix in auth')).toBeInTheDocument()
  })

  it('hides observer sessions when toggle is on', () => {
    useSettingsStore.setState({ observerSessionsHidden: true })
    useSessionStore.setState({ sessions: [normalSession, observerSession] })

    render(<Sidebar />)

    expect(screen.queryByText('Hello memory agent')).not.toBeInTheDocument()
    expect(screen.getByText('Bug fix in auth')).toBeInTheDocument()
  })

  it('shows no sessions message when all sessions are filtered out', () => {
    useSettingsStore.setState({ observerSessionsHidden: true })
    useSessionStore.setState({ sessions: [observerSession] })

    render(<Sidebar />)

    expect(screen.queryByText('Hello memory agent')).not.toBeInTheDocument()
    expect(screen.getByText('No sessions')).toBeInTheDocument()
  })
})
