import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTranslation } from '../../i18n'
import { ProjectFilter } from './ProjectFilter'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import type { SessionListItem } from '../../types/session'
import { useTabStore, SETTINGS_TAB_ID, SCHEDULED_TAB_ID } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'

const isTauri = typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
const isWindows = typeof navigator !== 'undefined' && /Win/.test(navigator.platform)

type TimeGroup = 'today' | 'yesterday' | 'last7days' | 'last30days' | 'older'

const TIME_GROUP_ORDER: TimeGroup[] = ['today', 'yesterday', 'last7days', 'last30days', 'older']

type SidebarProps = {
  isMobile?: boolean
  onRequestClose?: () => void
}

export function Sidebar({ isMobile = false, onRequestClose }: SidebarProps) {
  const t = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const selectedProjects = useSessionStore((s) => s.selectedProjects)
  const isLoading = useSessionStore((s) => s.isLoading)
  const error = useSessionStore((s) => s.error)
  const fetchSessions = useSessionStore((s) => s.fetchSessions)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const deleteSessions = useSessionStore((s) => s.deleteSessions)
  const isBatchMode = useSessionStore((s) => s.isBatchMode)
  const selectedSessionIds = useSessionStore((s) => s.selectedSessionIds)
  const enterBatchMode = useSessionStore((s) => s.enterBatchMode)
  const exitBatchMode = useSessionStore((s) => s.exitBatchMode)
  const toggleSessionSelected = useSessionStore((s) => s.toggleSessionSelected)
  const selectSessions = useSessionStore((s) => s.selectSessions)
  const deselectSessions = useSessionStore((s) => s.deselectSessions)
  const renameSession = useSessionStore((s) => s.renameSession)
  const addToast = useUIStore((s) => s.addToast)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const closeTab = useTabStore((s) => s.closeTab)
  const disconnectSession = useChatStore((s) => s.disconnectSession)
  const uiZoom = useSettingsStore((s) => s.uiZoom)
  const [searchQuery, setSearchQuery] = useState('')
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [rightClickedSessionId, setRightClickedSessionId] = useState<string | null>(null)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const [pendingBatchDeleteSessionIds, setPendingBatchDeleteSessionIds] = useState<string[] | null>(null)
  const [isBatchDeleting, setIsBatchDeleting] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [lastSelectedSessionId, setLastSelectedSessionId] = useState<string | null>(null)

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  useEffect(() => {
    if (!contextMenu) return
    if (!sidebarOpen) setContextMenu(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarOpen])

  useEffect(() => {
    if (!contextMenu) return
    const close = (e: MouseEvent) => {
      if (e.button !== 0) return
      setContextMenu(null)
      setRightClickedSessionId(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [contextMenu])

  const filteredSessions = useMemo(() => {
    let result = sessions
    if (selectedProjects.length > 0) {
      result = result.filter((s) => selectedProjects.includes(s.projectPath))
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter((s) => s.title.toLowerCase().includes(q))
    }
    return result
  }, [sessions, selectedProjects, searchQuery])

  const timeGroups = useMemo(() => groupByTime(filteredSessions), [filteredSessions])
  const showInitialLoading = isLoading && sessions.length === 0
  const filteredSessionIds = useMemo(() => filteredSessions.map((session) => session.id), [filteredSessions])
  const selectedCount = selectedSessionIds.size
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  )
  const pendingBatchDeleteSessions = useMemo(
    () => (pendingBatchDeleteSessionIds ?? [])
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is SessionListItem => Boolean(session)),
    [pendingBatchDeleteSessionIds, sessionsById],
  )

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault()
    if (isBatchMode) return
    setContextMenu({ id, x: e.clientX, y: e.clientY })
    setRightClickedSessionId(id)
  }, [isBatchMode])

  const handleDelete = useCallback((id: string) => {
    setContextMenu(null)
    setPendingDeleteSessionId(id)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!pendingDeleteSessionId) return
    await deleteSession(pendingDeleteSessionId)
    disconnectSession(pendingDeleteSessionId)
    closeTab(pendingDeleteSessionId)
    setPendingDeleteSessionId(null)
  }, [closeTab, deleteSession, disconnectSession, pendingDeleteSessionId])

  const handleBatchSessionClick = useCallback((event: React.MouseEvent, id: string) => {
    if (event.shiftKey && lastSelectedSessionId) {
      const start = filteredSessionIds.indexOf(lastSelectedSessionId)
      const end = filteredSessionIds.indexOf(id)
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start]
        selectSessions(filteredSessionIds.slice(from, to + 1))
        setLastSelectedSessionId(id)
        return
      }
    }

    toggleSessionSelected(id)
    setLastSelectedSessionId(id)
  }, [filteredSessionIds, lastSelectedSessionId, selectSessions, toggleSessionSelected])

  const handleExitBatchMode = useCallback(() => {
    exitBatchMode()
    setLastSelectedSessionId(null)
    setPendingBatchDeleteSessionIds(null)
  }, [exitBatchMode])

  const requestBatchDelete = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    setPendingBatchDeleteSessionIds([...new Set(ids)])
  }, [])

  const confirmBatchDelete = useCallback(async () => {
    const ids = pendingBatchDeleteSessionIds ?? []
    if (ids.length === 0) return

    setIsBatchDeleting(true)
    try {
      const result = await deleteSessions(ids)
      for (const sessionId of result.successes) {
        disconnectSession(sessionId)
        closeTab(sessionId)
      }

      if (result.failures.length > 0) {
        addToast({
          type: 'error',
          message: t('sidebar.batchDeleteFailed', { count: result.failures.length }),
        })
      } else {
        addToast({
          type: 'success',
          message: t('sidebar.batchDeleteSucceeded', { count: result.successes.length }),
        })
        handleExitBatchMode()
      }
      setPendingBatchDeleteSessionIds(null)
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('sidebar.batchDeleteFailed', { count: ids.length }),
      })
    } finally {
      setIsBatchDeleting(false)
    }
  }, [addToast, closeTab, deleteSessions, disconnectSession, handleExitBatchMode, pendingBatchDeleteSessionIds, t])

  const toggleGroupSelection = useCallback((ids: string[]) => {
    const allSelected = ids.every((id) => selectedSessionIds.has(id))
    if (allSelected) {
      deselectSessions(ids)
    } else {
      selectSessions(ids)
    }
  }, [deselectSessions, selectSessions, selectedSessionIds])

  const handleStartRename = useCallback((id: string, currentTitle: string) => {
    setContextMenu(null)
    setRenamingId(id)
    setRenameValue(currentTitle)
  }, [])

  const handleFinishRename = useCallback(async () => {
    if (renamingId && renameValue.trim()) {
      await renameSession(renamingId, renameValue.trim())
    }
    setRenamingId(null)
    setRenameValue('')
  }, [renamingId, renameValue, renameSession])

  const startDraggingRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    if (!isTauri) return
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => {
        const win = getCurrentWindow()
        startDraggingRef.current = () => win.startDragging()
      })
      .catch(() => {})
  }, [])

  const handleSidebarDrag = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, input, textarea, select, a, [role="button"]')) return
    startDraggingRef.current?.()
  }, [])

  const expanded = isMobile ? true : sidebarOpen
  const closeMobileDrawer = useCallback(() => {
    if (isMobile) onRequestClose?.()
  }, [isMobile, onRequestClose])

  const timeGroupLabels: Record<TimeGroup, string> = {
    today: t('sidebar.timeGroup.today'),
    yesterday: t('sidebar.timeGroup.yesterday'),
    last7days: t('sidebar.timeGroup.last7days'),
    last30days: t('sidebar.timeGroup.last30days'),
    older: t('sidebar.timeGroup.older'),
  }

  useEffect(() => {
    if (!isBatchMode) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return

      if (event.key === 'Escape') {
        handleExitBatchMode()
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selectSessions(filteredSessionIds)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [filteredSessionIds, handleExitBatchMode, isBatchMode, selectSessions])

  return (
    <aside
      onMouseDown={handleSidebarDrag}
      className="sidebar-panel relative h-full flex flex-col bg-[var(--color-surface-sidebar)] border-r border-[var(--color-border)] select-none"
      data-state={expanded ? 'open' : 'closed'}
      aria-label="Sidebar"
    >
      <div className={`px-3 pb-2 ${isTauri && !isWindows ? 'pt-[44px]' : 'pt-3'}`}>
        <div className={`flex ${expanded ? 'items-center justify-between gap-3' : 'flex-col items-center gap-2'}`}>
          <div className={`flex min-w-0 items-center ${expanded ? 'gap-2.5' : 'justify-center'}`}>
            <img src="/app-icon.png" alt="" className="h-8 w-8 flex-shrink-0" />
            <span
              className={`sidebar-copy ${expanded ? 'sidebar-copy--visible' : 'sidebar-copy--hidden'} text-[13px] font-semibold tracking-tight text-[var(--color-text-primary)]`}
              style={{ fontFamily: 'var(--font-headline)' }}
            >
              Claude Code <span className="text-[var(--color-primary-container)]">Haha</span>
            </span>
          </div>
          <div className={`flex items-center ${expanded ? 'gap-1.5' : 'flex-col gap-2'}`}>
            <a
              href="https://github.com/NanmiCoder/cc-haha"
              target="_blank"
              rel="noopener noreferrer"
              className={`sidebar-copy ${expanded ? 'sidebar-copy--visible' : 'sidebar-copy--hidden'} inline-flex items-center justify-center rounded-md p-1 text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]`}
              title="GitHub"
              tabIndex={expanded ? undefined : -1}
              aria-hidden={!expanded}
            >
              <GitHubIcon />
            </a>
            {isMobile ? (
              <button
                type="button"
                onClick={closeMobileDrawer}
                className="sidebar-toggle-button flex h-11 w-11 items-center justify-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-sidebar)]"
                aria-label={t('sidebar.collapse')}
                title={t('sidebar.collapse')}
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={toggleSidebar}
                data-testid={expanded ? 'sidebar-collapse-button' : 'sidebar-expand-button'}
                className={`sidebar-toggle-button ${expanded ? 'sidebar-toggle-button--open h-8 w-8' : 'sidebar-toggle-button--collapsed h-8 w-8'} flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-sidebar)]`}
                aria-label={expanded ? t('sidebar.collapse') : t('sidebar.expand')}
                title={expanded ? t('sidebar.collapse') : t('sidebar.expand')}
              >
                <SidebarToggleIcon collapsed={!expanded} />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className={`px-3 pb-3 flex flex-col ${expanded ? 'gap-0.5' : 'items-center gap-2'}`}>
        <NavItem
          active={false}
          collapsed={!expanded}
          label={t('sidebar.newSession')}
          touchFriendly={isMobile}
          onClick={async () => {
            try {
              const currentTabId = useTabStore.getState().activeTabId
              const currentSession = currentTabId
                ? useSessionStore.getState().sessions.find((s) => s.id === currentTabId)
                : null
              const workDir = currentSession?.workDir || undefined
              const sessionId = await useSessionStore.getState().createSession(workDir)
              useTabStore.getState().openTab(sessionId, t('sidebar.newSession'))
              useChatStore.getState().connectToSession(sessionId)
              closeMobileDrawer()
            } catch (error) {
              addToast({
                type: 'error',
                message: error instanceof Error ? error.message : t('sidebar.sessionListFailed'),
              })
            }
          }}
          icon={<PlusIcon />}
        >
          {t('sidebar.newSession')}
        </NavItem>
        {!isMobile && (
          <NavItem
            active={activeTabId === SCHEDULED_TAB_ID}
            collapsed={!expanded}
            label={t('sidebar.scheduled')}
            touchFriendly={isMobile}
            onClick={() => {
              useTabStore.getState().openTab(SCHEDULED_TAB_ID, t('sidebar.scheduled'), 'scheduled')
              closeMobileDrawer()
            }}
            icon={<ClockIcon />}
          >
            {t('sidebar.scheduled')}
          </NavItem>
        )}
      </div>

      {expanded ? (
        <>
          <div
            data-testid="sidebar-project-filter-section"
            className="sidebar-section sidebar-section--visible relative z-20 flex-none px-3 pb-2"
            style={{ overflow: 'visible' }}
          >
            <div className="flex items-center gap-1.5">
              <div className="flex h-9 min-w-0 flex-1 items-center rounded-[14px] border border-[var(--color-sidebar-search-border)] bg-[var(--color-sidebar-search-bg)] pl-1.5 pr-3 transition-colors focus-within:border-[var(--color-border-focus)]">
                <ProjectFilter variant="embedded" />
                <span className="mx-2 h-4 w-px bg-[var(--color-border)]/80" aria-hidden="true" />
                <span className="pointer-events-none flex shrink-0 items-center text-[var(--color-text-tertiary)]">
                  <SearchIcon />
                </span>
                <input
                  id="sidebar-search"
                  type="text"
                  placeholder={t('sidebar.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent pl-2 pr-0 text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none"
                />
              </div>
              <button
                type="button"
                onClick={isBatchMode ? handleExitBatchMode : enterBatchMode}
                className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[12px] border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                  isBatchMode
                    ? 'border-[var(--color-brand)] bg-[var(--color-sidebar-item-active)] text-[var(--color-brand)]'
                    : 'border-[var(--color-sidebar-search-border)] bg-[var(--color-sidebar-search-bg)] text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)]'
                }`}
                aria-label={isBatchMode ? t('sidebar.batchExit') : t('sidebar.batchManage')}
                title={isBatchMode ? t('sidebar.batchExit') : t('sidebar.batchManage')}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {isBatchMode ? 'close' : 'delete_sweep'}
                </span>
              </button>
            </div>
          </div>

          <div
            data-testid="sidebar-session-list-section"
            className="sidebar-section sidebar-section--visible flex flex-1 min-h-0 flex-col"
          >
            {isBatchMode && (
              <div className="mx-3 mb-2 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 text-xs font-medium text-[var(--color-text-primary)]">
                    {t('sidebar.batchSelectedCount', { count: selectedCount })}
                  </span>
                  <button
                    type="button"
                    onClick={handleExitBatchMode}
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
                    aria-label={t('sidebar.batchExit')}
                    title={t('sidebar.batchExit')}
                  >
                    <span className="material-symbols-outlined text-[17px]">close</span>
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (filteredSessionIds.every((id) => selectedSessionIds.has(id))) {
                        deselectSessions(filteredSessionIds)
                      } else {
                        selectSessions(filteredSessionIds)
                      }
                    }}
                    disabled={filteredSessionIds.length === 0}
                    className="rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
                  >
                    {filteredSessionIds.length > 0 && filteredSessionIds.every((id) => selectedSessionIds.has(id))
                      ? t('sidebar.batchDeselectAll')
                      : t('sidebar.batchSelectAll')}
                  </button>
                  <button
                    type="button"
                    onClick={() => requestBatchDelete([...selectedSessionIds])}
                    disabled={selectedCount === 0}
                    className="rounded-md bg-[var(--color-error)] px-2 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {t('sidebar.batchDeleteSelected', { count: selectedCount })}
                  </button>
                </div>
              </div>
            )}
            <div className="sidebar-scroll-area min-h-0 flex-1 overflow-y-auto px-3">
              {error && (
                <div className="mx-1 mt-2 rounded-[var(--radius-md)] border border-[var(--color-error)]/20 bg-[var(--color-error)]/5 px-3 py-2">
                  <div className="text-xs font-medium text-[var(--color-error)]">{t('sidebar.sessionListFailed')}</div>
                  <div className="mt-1 text-[11px] text-[var(--color-text-secondary)] break-words">{error}</div>
                  <button
                    onClick={() => fetchSessions()}
                    className="mt-2 text-[11px] font-medium text-[var(--color-brand)] hover:underline"
                  >
                    {t('common.retry')}
                  </button>
                </div>
              )}
              {showInitialLoading ? (
                <div className="px-3 py-4 text-center text-xs text-[var(--color-text-tertiary)]">
                  {t('common.loading')}
                </div>
              ) : filteredSessions.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-[var(--color-text-tertiary)]">
                  {searchQuery ? t('sidebar.noMatching') : t('sidebar.noSessions')}
                </div>
              )}
              {TIME_GROUP_ORDER.map((group) => {
                const items = timeGroups.get(group)
                if (!items || items.length === 0) return null
                const groupIds = items.map((session) => session.id)
                const groupSelectedCount = groupIds.filter((id) => selectedSessionIds.has(id)).length
                return (
                  <div key={group} className="mb-1">
                    <div className="flex items-center justify-between px-2 pb-1 pt-4">
                      <div className="text-[11px] font-semibold tracking-wide text-[var(--color-text-tertiary)]">
                        {timeGroupLabels[group]}
                      </div>
                      {isBatchMode && (
                        <button
                          type="button"
                          onClick={() => toggleGroupSelection(groupIds)}
                          className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
                            groupSelectedCount > 0
                              ? 'text-[var(--color-brand)] hover:bg-[var(--color-brand)]/10'
                              : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-secondary)]'
                          }`}
                          aria-label={t('sidebar.batchSelectGroup', { group: timeGroupLabels[group] })}
                        >
                          {groupSelectedCount === groupIds.length
                            ? t('sidebar.batchDeselectAll')
                            : t('sidebar.batchSelectAll')}
                        </button>
                      )}
                    </div>
                    {items.map((session) => (
                      <div key={session.id} className="relative mb-1.5 last:mb-0">
                        {renamingId === session.id ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={handleFinishRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleFinishRename()
                              if (e.key === 'Escape') {
                                setRenamingId(null)
                                setRenameValue('')
                              }
                            }}
                            className="ml-1 w-full rounded-[var(--radius-md)] border border-[var(--color-border-focus)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none"
                          />
                        ) : (
                          <button
                            onClick={(event) => {
                              if (isBatchMode) {
                                handleBatchSessionClick(event, session.id)
                                return
                              }
                              useTabStore.getState().openTab(session.id, session.title)
                              useChatStore.getState().connectToSession(session.id)
                              closeMobileDrawer()
                            }}
                            onContextMenu={(e) => handleContextMenu(e, session.id)}
                            className={`
                              group w-full rounded-[12px] border px-3 ${isMobile ? 'py-3' : 'py-2'} text-left text-sm transition-[background,border-color,box-shadow,filter,color] duration-200
                              ${selectedSessionIds.has(session.id)
                                ? 'sidebar-session-row--selected border-[var(--color-sidebar-item-active-border)] bg-[var(--color-sidebar-item-active)] text-[var(--color-text-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.72),0_3px_10px_rgba(143,72,47,0.07)] hover:brightness-[0.995]'
                                : session.id === activeTabId
                                ? 'sidebar-session-row--active border-transparent bg-[var(--color-sidebar-item-active)] text-[var(--color-text-primary)]'
                                : 'sidebar-session-row--idle border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-item-hover)]'
                              }
                              ${session.id === rightClickedSessionId ? 'ring-2 ring-[var(--color-brand)] ring-offset-1 ring-offset-[var(--color-surface)]' : ''}
                            `}
                            aria-pressed={isBatchMode ? selectedSessionIds.has(session.id) : undefined}
                          >
                            <span className="flex items-center gap-2.5">
                              {isBatchMode ? (
                                <span
                                  className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                                    selectedSessionIds.has(session.id)
                                      ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                                      : 'border-[var(--color-border)] bg-[var(--color-surface)]'
                                  }`}
                                  aria-hidden="true"
                                >
                                  {selectedSessionIds.has(session.id) && (
                                    <span className="material-symbols-outlined text-[12px]">check</span>
                                  )}
                                </span>
                              ) : (
                                <span
                                  className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                                  style={{
                                    backgroundColor: session.id === activeTabId ? 'var(--color-brand)' : 'var(--color-text-tertiary)',
                                    opacity: session.id === activeTabId ? 1 : 0.5,
                                  }}
                                />
                              )}
                              <span className="flex-1 truncate font-medium tracking-[-0.01em]">{session.title || 'Untitled'}</span>
                              {!session.workDirExists && (
                                <span
                                  className="flex-shrink-0 text-[10px] text-[var(--color-warning)]"
                                  title={session.workDir ?? ''}
                                >
                                  {t('sidebar.missingDir')}
                                </span>
                              )}
                              <span className="flex-shrink-0 text-[10px] text-[var(--color-text-tertiary)] opacity-0 transition-opacity group-hover:opacity-100">
                                {formatRelativeTime(session.modifiedAt)}
                              </span>
                            </span>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1" aria-hidden="true" />
      )}

      {!isMobile && (
        <div className={`absolute bottom-0 left-0 right-0 border-t border-[var(--color-border)] p-3 ${expanded ? '' : 'flex justify-center'}`}>
          <NavItem
            active={activeTabId === SETTINGS_TAB_ID}
            collapsed={!expanded}
            label={t('sidebar.settings')}
            touchFriendly={isMobile}
            onClick={() => {
              useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
              closeMobileDrawer()
            }}
            icon={<span className="material-symbols-outlined text-[18px]">settings</span>}
          >
            {t('sidebar.settings')}
          </NavItem>
        </div>
      )}

      {contextMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="fixed z-50 min-w-[140px] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] py-1"
          style={{ left: contextMenu.x / uiZoom, top: contextMenu.y / uiZoom, boxShadow: 'var(--shadow-dropdown)' }}
        >
          <button
            onClick={() => {
              const session = sessions.find((s) => s.id === contextMenu.id)
              handleStartRename(contextMenu.id, session?.title || '')
            }}
            className="w-full px-3 py-1.5 text-left text-xs text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('common.rename')}
          </button>
          <button
            onClick={() => handleDelete(contextMenu.id)}
            className="w-full px-3 py-1.5 text-left text-xs text-[var(--color-error)] transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            {t('common.delete')}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={pendingDeleteSessionId !== null}
        onClose={() => setPendingDeleteSessionId(null)}
        onConfirm={confirmDelete}
        title={t('common.delete')}
        body={pendingDeleteSessionId ? t('sidebar.confirmDelete') : ''}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
      />
      <ConfirmDialog
        open={pendingBatchDeleteSessionIds !== null}
        onClose={() => {
          if (!isBatchDeleting) setPendingBatchDeleteSessionIds(null)
        }}
        onConfirm={confirmBatchDelete}
        title={t('common.delete')}
        body={(
          <div className="space-y-3">
            <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
              {t('sidebar.batchDeleteConfirm', { count: pendingBatchDeleteSessionIds?.length ?? 0 })}
            </p>
            <div>
              <div className="mb-1.5 text-xs font-medium text-[var(--color-text-primary)]">
                {t('sidebar.batchDeleteConfirmBody')}
              </div>
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-2">
                {pendingBatchDeleteSessions.slice(0, 5).map((session) => (
                  <li key={session.id} className="truncate text-xs text-[var(--color-text-secondary)]">
                    {session.title || 'Untitled'}
                  </li>
                ))}
                {(pendingBatchDeleteSessionIds?.length ?? 0) > 5 && (
                  <li className="text-xs text-[var(--color-text-tertiary)]">
                    {t('sidebar.batchDeleteMore', { count: (pendingBatchDeleteSessionIds?.length ?? 0) - 5 })}
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isBatchDeleting}
      />
    </aside>
  )
}

function groupByTime(sessions: SessionListItem[]): Map<TimeGroup, SessionListItem[]> {
  const groups = new Map<TimeGroup, SessionListItem[]>()
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86400000
  const sevenDaysAgo = startOfToday - 7 * 86400000
  const thirtyDaysAgo = startOfToday - 30 * 86400000

  for (const session of sessions) {
    const ts = new Date(session.modifiedAt).getTime()
    let group: TimeGroup
    if (ts >= startOfToday) group = 'today'
    else if (ts >= startOfYesterday) group = 'yesterday'
    else if (ts >= sevenDaysAgo) group = 'last7days'
    else if (ts >= thirtyDaysAgo) group = 'last30days'
    else group = 'older'

    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push(session)
  }

  return groups
}

function NavItem({
  active,
  collapsed,
  label,
  touchFriendly,
  onClick,
  icon,
  children,
}: {
  active: boolean
  collapsed: boolean
  label: string
  touchFriendly?: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={collapsed ? label : undefined}
      className={`
        flex items-center transition-colors duration-200
        ${collapsed ? 'h-10 w-10 justify-center rounded-[var(--radius-md)] px-0 py-0' : `w-full gap-2.5 rounded-[12px] px-3 ${touchFriendly ? 'py-3' : 'py-2.5'} text-sm`}
        ${active
          ? 'bg-[var(--color-sidebar-item-active)] font-medium text-[var(--color-text-primary)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-item-hover)] hover:text-[var(--color-text-primary)]'
        }
      `}
    >
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className={`sidebar-copy ${collapsed ? 'sidebar-copy--hidden' : 'sidebar-copy--visible'}`}>
        {children}
      </span>
    </button>
  )
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d`
  return `${Math.floor(day / 30)}mo`
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width={collapsed ? 16 : 14}
      height={collapsed ? 16 : 14}
      viewBox="0 0 14 14"
      fill="none"
      className={`sidebar-toggle-icon ${collapsed ? 'sidebar-toggle-icon--collapsed' : 'sidebar-toggle-icon--open'}`}
      aria-hidden="true"
    >
      <path
        d={collapsed ? 'M5 3 9 7l-4 4' : 'M9 3 5 7l4 4'}
        className="sidebar-toggle-chevron"
      />
    </svg>
  )
}
