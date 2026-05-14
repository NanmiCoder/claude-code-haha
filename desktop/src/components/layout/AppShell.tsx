import { useEffect, useRef, useState, type HTMLAttributes } from 'react'
import { Sidebar } from './Sidebar'
import { ContentRouter } from './ContentRouter'
import { ToastContainer } from '../shared/Toast'
import { UpdateChecker } from '../shared/UpdateChecker'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore, type SettingsTab } from '../../stores/uiStore'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import {
  H5ConnectionRequiredError,
  initializeDesktopServerUrl,
  isH5ConnectionRequiredError,
  isTauriRuntime,
} from '../../lib/desktopRuntime'
import { TabBar } from './TabBar'
import { StartupErrorView } from './StartupErrorView'
import { useTabStore, SETTINGS_TAB_ID } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTranslation } from '../../i18n'
import { H5ConnectionView } from './H5ConnectionView'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import type { Tab } from '../../stores/tabStore'

function isChatTab(tab: Tab | undefined) {
  return tab?.type === 'session'
}

export function AppShell() {
  const fetchSettings = useSettingsStore((s) => s.fetchAll)
  const uiZoom = useSettingsStore((s) => s.uiZoom)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen)
  const [ready, setReady] = useState(false)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [h5StartupError, setH5StartupError] = useState<H5ConnectionRequiredError | null>(null)
  const [bootstrapNonce, setBootstrapNonce] = useState(0)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const t = useTranslation()
  const tauriRuntime = isTauriRuntime()
  const isMobileShell = useMobileViewport() && !tauriRuntime
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const setActiveTab = useTabStore((s) => s.setActiveTab)
  const activeSession = useSessionStore((s) =>
    activeTabId ? s.sessions.find((session) => session.id === activeTabId) ?? null : null,
  )
  const wasMobileShellRef = useRef(false)
  const effectiveSidebarOpen = isMobileShell ? mobileSidebarOpen : sidebarOpen
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId)
  const isActiveChatTab = isChatTab(activeTab)
  const mobileSessionTitle = activeSession?.title || activeTab?.title || t('session.untitled')
  const mobileSessionUpdated = (() => {
    if (!activeSession?.modifiedAt) return ''
    const diff = Date.now() - new Date(activeSession.modifiedAt).getTime()
    if (diff < 60000) return t('session.timeJustNow')
    if (diff < 3600000) return t('session.timeMinutes', { n: Math.floor(diff / 60000) })
    if (diff < 86400000) return t('session.timeHours', { n: Math.floor(diff / 3600000) })
    return t('session.timeDays', { n: Math.floor(diff / 86400000) })
  })()
  const sidebarHiddenProps: HTMLAttributes<HTMLDivElement> & { inert?: '' } =
    isMobileShell && !effectiveSidebarOpen
      ? { 'aria-hidden': true, inert: '' }
      : {}

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      if (!cancelled) {
        setReady(false)
        setStartupError(null)
        setH5StartupError(null)
      }

      try {
        await initializeDesktopServerUrl()
        await fetchSettings()

        if (!cancelled) {
          setReady(true)
        }

        void (async () => {
          await useTabStore.getState().restoreTabs()
          if (cancelled) return
          const { activeTabId: activeId, tabs } = useTabStore.getState()
          const activeTab = tabs.find((tab) => tab.sessionId === activeId)
          if (activeId && activeTab?.type === 'session') {
            useChatStore.getState().connectToSession(activeId)
          }
        })().catch(() => {})
      } catch (error) {
        if (!cancelled) {
          if (!tauriRuntime && isH5ConnectionRequiredError(error)) {
            setH5StartupError(error)
            setStartupError(null)
          } else {
            setStartupError(error instanceof Error ? error.message : String(error))
            setH5StartupError(null)
          }
          setReady(false)
        }
      }
    }

    void bootstrap()

    return () => {
      cancelled = true
    }
  }, [bootstrapNonce, fetchSettings, tauriRuntime])

  // Listen for macOS native menu navigation events (About / Settings)
  useEffect(() => {
    if (!tauriRuntime) return
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<string>('native-menu-navigate', (event) => {
          const target = event.payload as SettingsTab | 'settings'
          if (target === 'about') {
            useUIStore.getState().setPendingSettingsTab('about')
          }
          useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
        }),
      )
      .then((fn) => { unlisten = fn })
      .catch(() => {})
    return () => { unlisten?.() }
  }, [])

  useKeyboardShortcuts()

  useEffect(() => {
    if (isMobileShell && !wasMobileShellRef.current) {
      setMobileSidebarOpen(false)
      setSidebarOpen(false)
    }
    if (!isMobileShell && wasMobileShellRef.current) {
      setMobileSidebarOpen(false)
    }
    wasMobileShellRef.current = isMobileShell
  }, [isMobileShell, setSidebarOpen])

  useEffect(() => {
    if (!ready || !isMobileShell) return
    if (isChatTab(activeTab) || (!activeTab && !activeTabId)) return
    const nextChatTab = tabs.find(isChatTab)
    if (nextChatTab) {
      setActiveTab(nextChatTab.sessionId)
      return
    }
    useTabStore.setState({ activeTabId: null })
  }, [activeTab, activeTabId, isMobileShell, ready, setActiveTab, tabs])

  const setEffectiveSidebarOpen = (open: boolean) => {
    if (isMobileShell) {
      setMobileSidebarOpen(open)
      setSidebarOpen(open)
      return
    }
    setSidebarOpen(open)
  }

  const toggleEffectiveSidebar = () => {
    if (isMobileShell) {
      setEffectiveSidebarOpen(!mobileSidebarOpen)
      return
    }
    toggleSidebar()
  }

  if (!tauriRuntime && h5StartupError) {
    return (
      <H5ConnectionView
        initialServerUrl={h5StartupError.serverUrl}
        error={h5StartupError.message}
        onConnected={() => setBootstrapNonce((value) => value + 1)}
      />
    )
  }

  if (startupError) {
    return <StartupErrorView error={startupError} />
  }

  if (!ready) {
    return (
      <div className="app-shell-viewport flex items-center justify-center bg-[var(--color-surface)] text-[var(--color-text-secondary)]">
        {t('app.launching')}
      </div>
    )
  }

  return (
    <div className={`app-shell app-shell-viewport flex overflow-hidden bg-[var(--color-surface)]${isMobileShell ? ' app-shell--mobile' : ''}`} style={{ zoom: uiZoom }}>
      {isMobileShell && effectiveSidebarOpen ? (
        <button
          type="button"
          data-testid="sidebar-backdrop"
          className="app-shell-backdrop fixed inset-0 z-40 border-0 p-0"
          aria-label={t('sidebar.collapse')}
          onClick={() => setEffectiveSidebarOpen(false)}
        />
      ) : null}
      <div
        id="sidebar-shell"
        data-testid="sidebar-shell"
        data-state={effectiveSidebarOpen ? 'open' : 'closed'}
        data-mobile={isMobileShell ? 'true' : 'false'}
        className={`sidebar-shell${isMobileShell ? ' sidebar-shell--mobile' : ''}`}
        {...sidebarHiddenProps}
      >
        {!isMobileShell || effectiveSidebarOpen ? (
          <Sidebar isMobile={isMobileShell} onRequestClose={() => setEffectiveSidebarOpen(false)} />
        ) : null}
      </div>
      <main
        id="content-area"
        data-sidebar-state={effectiveSidebarOpen ? 'open' : 'closed'}
        className={`min-w-0 flex-1 flex flex-col overflow-hidden${isMobileShell ? ' app-shell-main--mobile' : ''}`}
      >
        {isMobileShell ? (
          <div
            data-testid="mobile-session-header"
            className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
          >
            <button
              type="button"
              data-testid="mobile-sidebar-toggle"
              aria-controls="sidebar-shell"
              aria-expanded={effectiveSidebarOpen}
              aria-label={effectiveSidebarOpen ? t('sidebar.collapse') : t('sidebar.expand')}
              onClick={toggleEffectiveSidebar}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            >
              <span className="material-symbols-outlined text-[20px]">
                {effectiveSidebarOpen ? 'close' : 'menu'}
              </span>
            </button>
            {isActiveChatTab ? (
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-[15px] font-bold leading-tight text-[var(--color-text-primary)]">
                  {mobileSessionTitle}
                </h1>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10px] font-medium text-[var(--color-text-tertiary)]">
                  {activeTab?.status === 'running' ? (
                    <span className="flex shrink-0 items-center gap-1 text-[var(--color-text-secondary)]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)] animate-pulse-dot" />
                      {t('session.active')}
                    </span>
                  ) : null}
                  {activeSession?.messageCount !== undefined && activeSession.messageCount > 0 ? (
                    <>
                      {activeTab?.status === 'running' ? <span aria-hidden="true">·</span> : null}
                      <span>{t('session.messages', { count: activeSession.messageCount })}</span>
                    </>
                  ) : null}
                  {mobileSessionUpdated ? (
                    <>
                      {(activeTab?.status === 'running') || ((activeSession?.messageCount ?? 0) > 0) ? <span aria-hidden="true">·</span> : null}
                      <span className="truncate">{t('session.lastUpdated', { time: mobileSessionUpdated })}</span>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {!isMobileShell ? <TabBar /> : null}
        <ContentRouter />
      </main>
      <ToastContainer />
      <UpdateChecker />
      <div id="app-overlay-root" />
    </div>
  )
}
