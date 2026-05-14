import { forwardRef, useRef, useState, useEffect, useCallback } from 'react'
import {
  SCHEDULED_TAB_ID,
  SETTINGS_TAB_ID,
  TERMINAL_TAB_PREFIX,
  useTabStore,
  type Tab,
} from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { useTranslation } from '../../i18n'
import { WindowControls, showWindowControls } from './WindowControls'
import { Folder, FolderOpen, SquareTerminal } from 'lucide-react'

const TAB_WIDTH = 180
const DRAG_START_THRESHOLD = 4
const isTauri = typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

function isSessionTab(tab: Tab | null) {
  if (!tab) return false
  const tabType = (tab as Partial<Tab>).type
  if (tabType === 'session') return true
  if (tabType) return false
  return isSessionTabId(tab.sessionId)
}

function isSessionTabId(tabId: string | null) {
  if (!tabId) return false
  return tabId !== SETTINGS_TAB_ID &&
    tabId !== SCHEDULED_TAB_ID &&
    !tabId.startsWith(TERMINAL_TAB_PREFIX)
}

export function TabBar() {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const setActiveTab = useTabStore((s) => s.setActiveTab)
  const closeTab = useTabStore((s) => s.closeTab)
  const disconnectSession = useChatStore((s) => s.disconnectSession)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId) ?? null
  const isActiveSessionTab = isSessionTab(activeTab) || isSessionTabId(activeTabId)
  const isWorkspacePanelOpen = useWorkspacePanelStore((state) =>
    activeTabId && isActiveSessionTab ? state.isPanelOpen(activeTabId) : false,
  )
  const isTerminalPanelOpen = useTerminalPanelStore((state) =>
    activeTabId && isActiveSessionTab ? state.isPanelOpen(activeTabId) : false,
  )
  const uiZoom = useSettingsStore((s) => s.uiZoom)

  const moveTab = useTabStore((s) => s.moveTab)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const [rightClickedTabId, setRightClickedTabId] = useState<string | null>(null)
  const [closingTabId, setClosingTabId] = useState<string | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null)
  const [dragOffsetX, setDragOffsetX] = useState(0)
  const dragIndexRef = useRef<number | null>(null)
  const pendingDragRef = useRef<{ index: number; startX: number; startY: number } | null>(null)
  const suppressClickRef = useRef(false)
  const tabRefs = useRef(new Map<string, HTMLDivElement | null>())
  const startDraggingRef = useRef<(() => Promise<void>) | null>(null)
  const t = useTranslation()

  useEffect(() => {
    if (!isTauri) return
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => {
        const win = getCurrentWindow()
        startDraggingRef.current = () => win.startDragging()
      })
      .catch(() => {})
  }, [])

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    updateScrollState()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', updateScrollState)
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', updateScrollState)
      ro.disconnect()
    }
  }, [updateScrollState, tabs.length])

  useEffect(() => {
    if (!activeTabId) return
    const activeTabEl = tabRefs.current.get(activeTabId)
    if (!activeTabEl) return

    activeTabEl.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    })

    const frame = window.requestAnimationFrame(updateScrollState)
    return () => window.cancelAnimationFrame(frame)
  }, [activeTabId, tabs.length, updateScrollState])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => {
      setContextMenu(null)
      setRightClickedTabId(null)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [contextMenu])

  const scroll = (direction: 'left' | 'right') => {
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ left: direction === 'left' ? -TAB_WIDTH : TAB_WIDTH, behavior: 'smooth' })
  }

  const closeTabWithCleanup = useCallback((tab: Tab) => {
    if (isSessionTab(tab)) {
      useWorkspacePanelStore.getState().clearSession(tab.sessionId)
      useTerminalPanelStore.getState().clearSession(tab.sessionId)
    }
    closeTab(tab.sessionId)
  }, [closeTab])

  const handleClose = (sessionId: string) => {
    // Special tabs can always be closed directly
    const tab = tabs.find((t) => t.sessionId === sessionId)
    if (!tab) return
    if (!isSessionTab(tab)) {
      closeTabWithCleanup(tab)
      return
    }

    const sessionState = useChatStore.getState().sessions[sessionId]
    const isRunning = sessionState && sessionState.chatState !== 'idle'

    if (isRunning) {
      setClosingTabId(sessionId)
      return
    }

    disconnectSession(sessionId)
    closeTabWithCleanup(tab)
  }

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    setContextMenu({ sessionId, x: e.clientX, y: e.clientY })
    setRightClickedTabId(sessionId)
  }

  const handleCloseOthers = (sessionId: string) => {
    setContextMenu(null)
    setRightClickedTabId(null)
    const otherTabs = tabs.filter((t) => t.sessionId !== sessionId)
    for (const tab of otherTabs) {
      if (isSessionTab(tab)) disconnectSession(tab.sessionId)
      closeTabWithCleanup(tab)
    }
  }

  const handleCloseLeft = (sessionId: string) => {
    setContextMenu(null)
    setRightClickedTabId(null)
    const idx = tabs.findIndex((t) => t.sessionId === sessionId)
    const leftTabs = tabs.slice(0, idx)
    for (const tab of leftTabs) {
      if (isSessionTab(tab)) disconnectSession(tab.sessionId)
      closeTabWithCleanup(tab)
    }
  }

  const handleCloseRight = (sessionId: string) => {
    setContextMenu(null)
    setRightClickedTabId(null)
    const idx = tabs.findIndex((t) => t.sessionId === sessionId)
    const rightTabs = tabs.slice(idx + 1)
    for (const tab of rightTabs) {
      if (isSessionTab(tab)) disconnectSession(tab.sessionId)
      closeTabWithCleanup(tab)
    }
  }

  const handleCloseAll = () => {
    setContextMenu(null)
    setRightClickedTabId(null)
    for (const tab of tabs) {
      if (isSessionTab(tab)) disconnectSession(tab.sessionId)
      closeTabWithCleanup(tab)
    }
  }

  const getTargetIndexFromClientX = useCallback((clientX: number) => {
    for (let index = 0; index < tabs.length; index++) {
      const tab = tabs[index]
      if (!tab) continue
      const el = tabRefs.current.get(tab.sessionId)
      if (!el) continue
      const rect = el.getBoundingClientRect()
      if (clientX < rect.left + rect.width / 2) return index
    }

    return tabs.length > 0 ? tabs.length - 1 : null
  }, [tabs])

  const finalizeDrag = useCallback((targetIndex: number | null) => {
    if (dragIndexRef.current !== null && targetIndex !== null && dragIndexRef.current !== targetIndex) {
      moveTab(dragIndexRef.current, targetIndex)
    }
    dragIndexRef.current = null
    pendingDragRef.current = null
    setDraggingSessionId(null)
    setDragOffsetX(0)
    setDragOverIndex(null)
  }, [moveTab])

  const handlePointerMove = useCallback((event: MouseEvent) => {
    const pending = pendingDragRef.current
    if (!pending) return

    const deltaX = Math.abs(event.clientX - pending.startX)
    const deltaY = Math.abs(event.clientY - pending.startY)

    if (dragIndexRef.current === null) {
      if (Math.max(deltaX, deltaY) < DRAG_START_THRESHOLD) return
      dragIndexRef.current = pending.index
      suppressClickRef.current = true
      setDraggingSessionId(tabs[pending.index]?.sessionId ?? null)
    }

    setDragOffsetX(event.clientX - pending.startX)

    const targetIndex = getTargetIndexFromClientX(event.clientX)
    if (targetIndex === null || targetIndex === dragIndexRef.current) {
      setDragOverIndex(null)
      return
    }

    setDragOverIndex(targetIndex)
  }, [getTargetIndexFromClientX])

  const handlePointerUp = useCallback(() => {
    finalizeDrag(dragOverIndex)
  }, [dragOverIndex, finalizeDrag])

  useEffect(() => {
    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', handlePointerUp)
    return () => {
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('mouseup', handlePointerUp)
    }
  }, [handlePointerMove, handlePointerUp])

  useEffect(() => {
    if (!draggingSessionId) return
    const previousCursor = document.body.style.cursor
    document.body.style.cursor = 'grabbing'
    return () => {
      document.body.style.cursor = previousCursor
    }
  }, [draggingSessionId])

  const handleTabMouseDown = (event: React.MouseEvent, index: number) => {
    if (event.button !== 0) return
    pendingDragRef.current = { index, startX: event.clientX, startY: event.clientY }
  }

  const handleTabClick = (sessionId: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    setActiveTab(sessionId)
  }

  const handleScrollRegionMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== scrollRef.current) return
    const startDragging = startDraggingRef.current
    if (!startDragging) return
    void startDragging().catch(() => {})
  }, [])

  return (
    <div
      data-testid="tab-bar"
      className="flex items-stretch bg-[var(--color-surface-container)] min-h-[37px] select-none border-b border-[var(--color-border)]"
    >

      {canScrollLeft && (
        <button onClick={() => scroll('left')} className="flex-shrink-0 w-7 h-[37px] flex items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
          <span className="material-symbols-outlined text-[16px]">chevron_left</span>
        </button>
      )}

      <div
        ref={scrollRef}
        className="tab-bar-hit-area flex-1 flex items-stretch overflow-x-hidden"
        onDragOver={(e) => e.preventDefault()}
        onMouseDown={handleScrollRegionMouseDown}
      >
        {tabs.map((tab, index) => (
          <TabItem
            key={tab.sessionId}
            ref={(node) => { tabRefs.current.set(tab.sessionId, node) }}
            tab={tab}
            isActive={tab.sessionId === activeTabId}
            isContextMenuTarget={tab.sessionId === rightClickedTabId}
            isDragOver={dragOverIndex === index}
            isDragging={tab.sessionId === draggingSessionId}
            dragOffsetX={tab.sessionId === draggingSessionId ? dragOffsetX : 0}
            onClick={() => handleTabClick(tab.sessionId)}
            onClose={() => handleClose(tab.sessionId)}
            onContextMenu={(e) => handleContextMenu(e, tab.sessionId)}
            onMouseDown={(event) => handleTabMouseDown(event, index)}
          />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-l border-[var(--color-border)]/70 px-2">
        <ToolbarIconButton
          icon={<SquareTerminal size={17} strokeWidth={1.9} />}
          label={t('tabs.openTerminal')}
          onClick={() => {
            if (activeTabId && isActiveSessionTab) {
              useTerminalPanelStore.getState().togglePanel(activeTabId)
              return
            }
            useTabStore.getState().openTerminalTab()
          }}
          active={isTerminalPanelOpen}
        />
        {isActiveSessionTab && activeTabId && (
          <ToolbarIconButton
            icon={isWorkspacePanelOpen ? <FolderOpen size={18} strokeWidth={1.9} /> : <Folder size={18} strokeWidth={1.9} />}
            label={t(isWorkspacePanelOpen ? 'tabs.hideWorkspace' : 'tabs.showWorkspace')}
            onClick={() => useWorkspacePanelStore.getState().togglePanel(activeTabId)}
            active={isWorkspacePanelOpen}
          />
        )}
      </div>

      {isTauri && (
        <div
          data-testid="tab-bar-drag-gutter"
          data-tauri-drag-region
          aria-hidden="true"
          className={`flex-shrink-0 min-h-[37px] ${showWindowControls ? 'w-3' : 'w-4'}`}
        />
      )}

      {canScrollRight && (
        <button onClick={() => scroll('right')} className="flex-shrink-0 w-7 h-[37px] flex items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
          <span className="material-symbols-outlined text-[16px]">chevron_right</span>
        </button>
      )}

      <WindowControls />

      {contextMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="fixed z-50 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-md)] py-1 min-w-[160px]"
          style={{ left: contextMenu.x / uiZoom, top: contextMenu.y / uiZoom, boxShadow: 'var(--shadow-dropdown)' }}
        >
          <button
            onClick={() => { handleClose(contextMenu.sessionId); setContextMenu(null) }}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.close')}
          </button>
          <button
            onClick={() => handleCloseOthers(contextMenu.sessionId)}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeOthers')}
          </button>
          <button
            onClick={() => handleCloseLeft(contextMenu.sessionId)}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeLeft')}
          </button>
          <button
            onClick={() => handleCloseRight(contextMenu.sessionId)}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeRight')}
          </button>
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button
            onClick={handleCloseAll}
            className="w-full px-3 py-1.5 text-xs text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeAll')}
          </button>
        </div>
      )}

      {closingTabId && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30">
          <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-6 max-w-sm w-full mx-4" style={{ boxShadow: 'var(--shadow-dropdown)' }}>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)] mb-2">{t('tabs.closeConfirmTitle')}</h3>
            <p className="text-xs text-[var(--color-text-secondary)] mb-4">{t('tabs.closeConfirmMessage')}</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setClosingTabId(null)} className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  const tab = tabs.find((item) => item.sessionId === closingTabId)
                  if (tab) closeTabWithCleanup(tab)
                  setClosingTabId(null)
                }}
                className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
              >
                {t('tabs.closeConfirmKeep')}
              </button>
              <button
                onClick={() => {
                  useChatStore.getState().stopGeneration(closingTabId)
                  disconnectSession(closingTabId)
                  const tab = tabs.find((item) => item.sessionId === closingTabId)
                  if (tab) closeTabWithCleanup(tab)
                  setClosingTabId(null)
                }}
                className="px-3 py-1.5 text-xs rounded-lg bg-[var(--color-brand)] text-white hover:opacity-90"
              >
                {t('tabs.closeConfirmStop')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const TabItem = forwardRef<HTMLDivElement, {
  tab: Tab
  isActive: boolean
  isContextMenuTarget: boolean
  isDragOver: boolean
  isDragging: boolean
  dragOffsetX: number
  onClick: () => void
  onClose: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onMouseDown: (event: React.MouseEvent) => void
}>(({ tab, isActive, isContextMenuTarget, isDragOver, isDragging, dragOffsetX, onClick, onClose, onContextMenu, onMouseDown }, ref) => {
  return (
    <div
      ref={ref}
      data-dragging={isDragging ? 'true' : 'false'}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      className={`
        tab-bar-hit-area group flex-shrink-0 flex items-center gap-1.5 px-3 min-h-[37px] relative
        ${isDragging ? 'z-20 cursor-grabbing' : 'cursor-grab'}
        transition-[background-color,box-shadow,opacity,transform] duration-150 ease-out
        ${isActive
          ? 'bg-[var(--color-surface)] shadow-[inset_0_-2px_0_var(--color-brand)]'
          : 'bg-transparent hover:bg-[var(--color-surface-hover)]'
        }
        ${isContextMenuTarget ? 'ring-2 ring-[var(--color-brand)] ring-offset-1 ring-offset-[var(--color-surface)]' : ''}
        ${isDragging ? 'opacity-95 shadow-[0_10px_24px_rgba(0,0,0,0.18)] ring-1 ring-[var(--color-border)]' : ''}
        ${isDragOver ? 'before:absolute before:left-0 before:top-[4px] before:bottom-[4px] before:w-[3px] before:bg-[var(--color-brand)] before:rounded-full before:shadow-[0_0_0_1px_rgba(255,255,255,0.25)]' : ''}
      `}
      style={{
        width: TAB_WIDTH,
        maxWidth: TAB_WIDTH,
        transform: isDragging ? `translateX(${dragOffsetX}px) scale(1.02)` : undefined,
      }}
    >
      {tab.type === 'session' && tab.status === 'running' && (
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse flex-shrink-0" />
      )}
      {tab.type === 'session' && tab.status === 'error' && (
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-error)] flex-shrink-0" />
      )}
      {tab.type === 'settings' && (
        <span className="material-symbols-outlined text-[14px] flex-shrink-0 text-[var(--color-text-tertiary)]">settings</span>
      )}
      {tab.type === 'scheduled' && (
        <span className="material-symbols-outlined text-[14px] flex-shrink-0 text-[var(--color-text-tertiary)]">schedule</span>
      )}
      {tab.type === 'terminal' && (
        <span className="material-symbols-outlined text-[14px] flex-shrink-0 text-[var(--color-text-tertiary)]">terminal</span>
      )}

      <span className={`flex-1 truncate text-xs ${isActive ? 'text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-secondary)]'}`}>
        {tab.title || 'Untitled'}
      </span>

      <button
        type="button"
        aria-label={`Close ${tab.title || 'Untitled'}`}
        onMouseDown={(e) => { e.stopPropagation() }}
        onClick={(e) => { e.stopPropagation(); onClose() }}
        className="flex-shrink-0 -mr-0.5 inline-flex h-3 w-3 items-center justify-center bg-transparent p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-[opacity,color] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] focus-visible:outline-none"
      >
        <span className="material-symbols-outlined text-[11px] leading-none">close</span>
      </button>
    </div>
  )
})
TabItem.displayName = 'TabItem'

function ToolbarIconButton({
  icon,
  label,
  onClick,
  active = false,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-active={active ? 'true' : 'false'}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
        active
          ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)]'
          : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      {icon}
    </button>
  )
}
