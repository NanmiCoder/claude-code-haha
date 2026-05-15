import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { computerUseApi, type ComputerUseStatus, type SetupResult, type InstalledApp, type AuthorizedApp } from '../api/computerUse'
import { useTranslation } from '../i18n'
import { isWebRuntime } from '../lib/desktopRuntime'

type CheckState = 'loading' | 'ready' | 'error'
const PYTHON_DOWNLOAD_URLS: Record<string, string> = {
  darwin: 'https://www.python.org/downloads/macos/',
  win32: 'https://www.python.org/downloads/windows/',
}

function StatusIcon({ ok }: { ok: boolean | null }) {
  if (ok === null) {
    return <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">help</span>
  }
  return ok ? (
    <span className="material-symbols-outlined text-[18px] text-green-500" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
  ) : (
    <span className="material-symbols-outlined text-[18px] text-red-400" style={{ fontVariationSettings: "'FILL' 1" }}>cancel</span>
  )
}

function StatusRow({ label, ok, detail }: { label: string; ok: boolean | null; detail: string }) {
  return (
    <div className="flex items-center gap-3 py-2.5 px-4 rounded-lg bg-[var(--color-surface-container-low)]">
      <StatusIcon ok={ok} />
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-[var(--color-text-primary)]">{label}</span>
        <span className="ml-2 text-xs text-[var(--color-text-tertiary)]">{detail}</span>
      </div>
    </div>
  )
}

async function openSystemSettings(pane: 'Privacy_ScreenCapture' | 'Privacy_Accessibility') {
  await computerUseApi.openSettings(pane)
}

async function openExternalUrl(url: string) {
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

export function ComputerUseSettings() {
  if (isWebRuntime()) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Computer Use is disabled in web mode.
      </div>
    )
  }

  const t = useTranslation()
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [checkState, setCheckState] = useState<CheckState>('loading')
  const [setupRunning, setSetupRunning] = useState(false)
  const [setupResult, setSetupResult] = useState<SetupResult | null>(null)

  // App authorization state
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([])
  const [authorizedBundleIds, setAuthorizedBundleIds] = useState<Set<string>>(new Set())
  const [authorizedApps, setAuthorizedApps] = useState<AuthorizedApp[]>([])
  const [appsLoading, setAppsLoading] = useState(false)
  const [appsSaved, setAppsSaved] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [computerUseEnabled, setComputerUseEnabled] = useState(true)
  const [clipboardAccess, setClipboardAccess] = useState(true)
  const [systemKeys, setSystemKeys] = useState(true)
  const [pythonPathDraft, setPythonPathDraft] = useState('')
  const [pythonPathSaved, setPythonPathSaved] = useState('')
  const [pythonPathSaving, setPythonPathSaving] = useState(false)
  const [pythonPathMessage, setPythonPathMessage] = useState<string | null>(null)
  const configMutationSeqRef = useRef(0)

  const fetchStatus = useCallback(async () => {
    setCheckState('loading')
    try {
      const s = await computerUseApi.getStatus()
      setStatus(s)
      setCheckState('ready')
    } catch {
      setCheckState('error')
    }
  }, [])

  const applyConfig = useCallback((
    configResult: Awaited<ReturnType<typeof computerUseApi.getAuthorizedApps>>,
    requestSeq = configMutationSeqRef.current,
  ) => {
    if (requestSeq !== configMutationSeqRef.current) return
    setComputerUseEnabled(configResult.enabled)
    setAuthorizedApps(configResult.authorizedApps)
    setAuthorizedBundleIds(new Set(configResult.authorizedApps.map(a => a.bundleId)))
    setClipboardAccess(configResult.grantFlags.clipboardRead)
    setSystemKeys(configResult.grantFlags.systemKeyCombos)
    setPythonPathDraft(configResult.pythonPath ?? '')
    setPythonPathSaved(configResult.pythonPath ?? '')
  }, [])

  const fetchConfig = useCallback(async () => {
    const requestSeq = configMutationSeqRef.current
    try {
      applyConfig(await computerUseApi.getAuthorizedApps(), requestSeq)
    } catch {
      // API not ready
    }
  }, [applyConfig])

  const fetchApps = useCallback(async () => {
    const requestSeq = configMutationSeqRef.current
    setAppsLoading(true)
    try {
      const [appsResult, configResult] = await Promise.all([
        computerUseApi.getInstalledApps(),
        computerUseApi.getAuthorizedApps(),
      ])
      setInstalledApps(appsResult.apps)
      applyConfig(configResult, requestSeq)
    } catch {
      // API not ready
    } finally {
      setAppsLoading(false)
    }
  }, [applyConfig])

  useEffect(() => {
    fetchStatus()
    fetchConfig()
  }, [fetchStatus, fetchConfig])

  // Load apps when environment is ready
  const envReady = status?.venv.created && status?.dependencies.installed
  useEffect(() => {
    if (envReady) fetchApps()
  }, [envReady, fetchApps])

  const handleSetup = async () => {
    setSetupRunning(true)
    setSetupResult(null)
    try {
      const result = await computerUseApi.runSetup()
      setSetupResult(result)
      await fetchStatus()
      if (result.success) await fetchApps()
    } catch {
      setSetupResult({ success: false, steps: [{ name: 'error', ok: false, message: 'Request failed' }] })
    } finally {
      setSetupRunning(false)
    }
  }

  const toggleApp = (app: InstalledApp) => {
    configMutationSeqRef.current += 1
    const newSet = new Set(authorizedBundleIds)
    let newAuthorized = [...authorizedApps]
    if (newSet.has(app.bundleId)) {
      newSet.delete(app.bundleId)
      newAuthorized = newAuthorized.filter(a => a.bundleId !== app.bundleId)
    } else {
      newSet.add(app.bundleId)
      newAuthorized.push({
        bundleId: app.bundleId,
        displayName: app.displayName,
        authorizedAt: new Date().toISOString(),
      })
    }
    setAuthorizedBundleIds(newSet)
    setAuthorizedApps(newAuthorized)

    // Auto-save
    computerUseApi.setAuthorizedApps({
      authorizedApps: newAuthorized,
      grantFlags: { clipboardRead: clipboardAccess, clipboardWrite: clipboardAccess, systemKeyCombos: systemKeys },
    }).then(() => {
      setAppsSaved(true)
      setTimeout(() => setAppsSaved(false), 1500)
    })
  }

  const toggleFlag = (flag: 'clipboard' | 'systemKeys', value: boolean) => {
    configMutationSeqRef.current += 1
    if (flag === 'clipboard') setClipboardAccess(value)
    else setSystemKeys(value)

    computerUseApi.setAuthorizedApps({
      authorizedApps,
      grantFlags: {
        clipboardRead: flag === 'clipboard' ? value : clipboardAccess,
        clipboardWrite: flag === 'clipboard' ? value : clipboardAccess,
        systemKeyCombos: flag === 'systemKeys' ? value : systemKeys,
      },
    })
  }

  const toggleComputerUseEnabled = (value: boolean) => {
    configMutationSeqRef.current += 1
    setComputerUseEnabled(value)
    computerUseApi.setAuthorizedApps({ enabled: value }).then(() => {
      setAppsSaved(true)
      setTimeout(() => setAppsSaved(false), 1500)
    })
  }

  const savePythonPath = async (value = pythonPathDraft) => {
    configMutationSeqRef.current += 1
    const normalized = value.trim()
    setPythonPathSaving(true)
    setPythonPathMessage(null)
    try {
      await computerUseApi.setAuthorizedApps({ pythonPath: normalized || null })
      setPythonPathDraft(normalized)
      setPythonPathSaved(normalized)
      setPythonPathMessage(t('settings.computerUse.pythonPathSaved'))
      await fetchStatus()
    } catch {
      setPythonPathMessage(t('settings.computerUse.pythonPathSaveFailed'))
    } finally {
      setPythonPathSaving(false)
    }
  }

  const choosePythonPath = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        directory: false,
        title: t('settings.computerUse.pythonPathDialogTitle'),
      })
      const selectedPath = Array.isArray(selected) ? selected[0] : selected
      if (typeof selectedPath === 'string' && selectedPath.trim()) {
        setPythonPathDraft(selectedPath)
        await savePythonPath(selectedPath)
      }
    } catch {
      setPythonPathMessage(t('settings.computerUse.pythonPathDialogFailed'))
    }
  }

  const allReady =
    status?.supported &&
    status.python.installed &&
    status.venv.created &&
    status.dependencies.installed

  const accessibilityNeedsAttention = status?.permissions.accessibility === false
  const screenRecordingNeedsAttention = status?.permissions.screenRecording === false
  const screenRecordingReady = status ? status.permissions.screenRecording !== false : null
  const pythonDownloadUrl = status
    ? PYTHON_DOWNLOAD_URLS[status.platform] ?? 'https://www.python.org/downloads/'
    : 'https://www.python.org/downloads/'
  const pythonPathDirty = pythonPathDraft.trim() !== pythonPathSaved
  const pythonDetail = status?.python.installed
    ? `${t('settings.computerUse.pythonFound')} — ${status.python.version} (${status.python.path})`
    : status?.python.source === 'custom'
      ? `${t('settings.computerUse.pythonCustomInvalid')} — ${status.python.path}${status.python.error ? `: ${status.python.error}` : ''}`
      : t('settings.computerUse.pythonNotFound')

  // Filter apps by search query
  const filteredApps = useMemo(() => {
    if (!searchQuery) return installedApps
    const q = searchQuery.toLowerCase()
    return installedApps.filter(
      a => a.displayName.toLowerCase().includes(q) || a.bundleId.toLowerCase().includes(q)
    )
  }, [installedApps, searchQuery])

  // Sort: authorized apps first, then alphabetical
  const sortedApps = useMemo(() => {
    return [...filteredApps].sort((a, b) => {
      const aAuth = authorizedBundleIds.has(a.bundleId) ? 0 : 1
      const bAuth = authorizedBundleIds.has(b.bundleId) ? 0 : 1
      if (aAuth !== bAuth) return aAuth - bAuth
      return a.displayName.localeCompare(b.displayName)
    })
  }, [filteredApps, authorizedBundleIds])

  return (
    <div className="max-w-2xl space-y-6">
      {/* Title */}
      <div>
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
            {t('settings.computerUse.title')}
          </h2>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={computerUseEnabled}
              onChange={e => toggleComputerUseEnabled(e.target.checked)}
              className="rounded border-[var(--color-border)] accent-[var(--color-brand)]"
            />
            {t('settings.computerUse.enabledToggle')}
          </label>
        </div>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          {t('settings.computerUse.description')}
        </p>
      </div>

      {!computerUseEnabled && (
        <div className="px-4 py-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-sm text-yellow-700">
          {t('settings.computerUse.disabledHint')}
        </div>
      )}

      {checkState === 'loading' ? (
        <div className="py-8 text-center text-sm text-[var(--color-text-tertiary)]">
          {t('common.loading')}
        </div>
      ) : checkState === 'error' ? (
        <div className="py-8 text-center text-sm text-red-400">
          Failed to check status.
          <button onClick={fetchStatus} className="ml-2 underline">{t('common.retry')}</button>
        </div>
      ) : status ? (
        <>
          {!status.supported && (
            <div className="px-4 py-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-sm text-yellow-600">
              {t('settings.computerUse.notSupported')}
            </div>
          )}

          {/* Status checks */}
          <div className="space-y-2">
            <StatusRow
              label={t('settings.computerUse.python')}
              ok={status.python.installed}
              detail={pythonDetail}
            />
            <StatusRow
              label={t('settings.computerUse.venv')}
              ok={status.venv.created}
              detail={status.venv.created ? `${t('settings.computerUse.venvReady')} — ${status.venv.path}` : t('settings.computerUse.venvNotReady')}
            />
            <StatusRow
              label={t('settings.computerUse.deps')}
              ok={status.dependencies.installed}
              detail={status.dependencies.installed ? t('settings.computerUse.depsReady') : t('settings.computerUse.depsNotReady')}
            />
          </div>

          <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
            <label htmlFor="computer-use-python-path" className="block text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.computerUse.pythonPathLabel')}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id="computer-use-python-path"
                type="text"
                value={pythonPathDraft}
                onChange={e => {
                  setPythonPathDraft(e.target.value)
                  setPythonPathMessage(null)
                }}
                placeholder={t('settings.computerUse.pythonPathPlaceholder')}
                className="min-w-[220px] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container)] px-3 py-2 font-mono text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-brand)] focus:outline-none"
              />
              <button
                onClick={choosePythonPath}
                disabled={pythonPathSaving}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">folder_open</span>
                {t('settings.computerUse.pythonPathBrowse')}
              </button>
              <button
                onClick={() => savePythonPath()}
                disabled={pythonPathSaving || !pythonPathDirty}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--color-brand)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[16px]">{pythonPathSaving ? 'hourglass_empty' : 'save'}</span>
                {t('settings.computerUse.pythonPathSave')}
              </button>
              {pythonPathSaved && (
                <button
                  onClick={() => savePythonPath('')}
                  disabled={pythonPathSaving}
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[16px]">restart_alt</span>
                  {t('settings.computerUse.pythonPathAuto')}
                </button>
              )}
            </div>
            <p className="text-xs text-[var(--color-text-tertiary)]">
              {pythonPathMessage ?? t('settings.computerUse.pythonPathHint')}
            </p>
          </div>

          {/* macOS Permissions — only shown on macOS (darwin) */}
          {envReady && status.platform === 'darwin' && (
            <>
              <StatusRow
                label={t('settings.computerUse.accessibility')}
                ok={status.permissions.accessibility}
                detail={
                  status.permissions.accessibility === null ? t('settings.computerUse.permUnknown')
                    : status.permissions.accessibility ? t('settings.computerUse.permGranted')
                      : t('settings.computerUse.permDenied')
                }
              />
              <StatusRow
                label={t('settings.computerUse.screenRecording')}
                ok={screenRecordingReady}
                detail={
                  status.permissions.screenRecording === true ? t('settings.computerUse.permGranted')
                    : status.permissions.screenRecording === false ? t('settings.computerUse.permDenied')
                      : t('settings.computerUse.permScreenRecordingUnknownSoft')
                }
              />
              {(accessibilityNeedsAttention || screenRecordingNeedsAttention) && (
                <div className="flex flex-col gap-2 px-4 py-3 rounded-lg bg-yellow-500/5 border border-yellow-500/20">
                  <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.computerUse.permRestartHint')}</p>
                  <div className="flex gap-2">
                    {accessibilityNeedsAttention && (
                      <button
                        onClick={() => openSystemSettings('Privacy_Accessibility')}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--color-text-accent)] border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-surface-hover)]"
                      >
                        <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                        {t('settings.computerUse.openAccessibility')}
                      </button>
                    )}
                    {screenRecordingNeedsAttention && (
                      <button
                        onClick={() => openSystemSettings('Privacy_ScreenCapture')}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[var(--color-text-accent)] border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-surface-hover)]"
                      >
                        <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                        {t('settings.computerUse.openScreenRecording')}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {allReady && (status.platform !== 'darwin' || (status.permissions.accessibility && screenRecordingReady)) && (
            <div className="px-4 py-3 rounded-lg bg-green-500/10 border border-green-500/30 text-sm text-green-600 flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 1" }}>verified</span>
              {t('settings.computerUse.allReady')}
            </div>
          )}

          {setupResult && (
            <div className={`rounded-lg border p-4 space-y-2 ${setupResult.success ? 'bg-green-500/5 border-green-500/30' : 'bg-red-500/5 border-red-500/30'}`}>
              <div className={`text-sm font-medium ${setupResult.success ? 'text-green-600' : 'text-red-400'}`}>
                {setupResult.success ? t('settings.computerUse.setupSuccess') : t('settings.computerUse.setupFail')}
              </div>
              {setupResult.steps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                  <StatusIcon ok={step.ok} />
                  <span>{step.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3">
            {!status.python.installed && (
              <button
                onClick={() => openExternalUrl(pythonDownloadUrl)}
                className="flex items-center gap-2 px-5 py-2.5 bg-[var(--color-brand)] text-white text-sm font-semibold rounded-lg hover:opacity-90 transition-opacity"
              >
                <span className="material-symbols-outlined text-[18px]">open_in_new</span>
                {t('settings.computerUse.downloadPython')}
              </button>
            )}
            {!envReady && status.python.installed && (
              <button
                onClick={handleSetup}
                disabled={setupRunning}
                className="flex items-center gap-2 px-5 py-2.5 bg-[var(--color-brand)] text-white text-sm font-semibold rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                <span className="material-symbols-outlined text-[18px]">{setupRunning ? 'hourglass_empty' : 'download'}</span>
                {setupRunning ? t('settings.computerUse.setupRunning') : t('settings.computerUse.setupBtn')}
              </button>
            )}
            <button
              onClick={fetchStatus}
              className="flex items-center gap-2 px-4 py-2.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-surface-hover)] transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]">refresh</span>
              {t('settings.computerUse.recheckBtn')}
            </button>
          </div>

          {/* ─── App Authorization Section ─── */}
          {envReady && (
            <div className="space-y-4 pt-4 border-t border-[var(--color-border)]">
              <div>
                <h3 className="text-base font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
                  {t('settings.computerUse.appsTitle')}
                  {appsSaved && (
                    <span className="text-xs font-normal text-green-500 flex items-center gap-1">
                      <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
                      {t('settings.computerUse.appsSaved')}
                    </span>
                  )}
                </h3>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                  {t('settings.computerUse.appsDescription')}
                </p>
              </div>

              {/* Grant flags */}
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={clipboardAccess}
                    onChange={e => toggleFlag('clipboard', e.target.checked)}
                    className="rounded border-[var(--color-border)] accent-[var(--color-brand)]"
                  />
                  {t('settings.computerUse.flagClipboard')}
                </label>
                <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={systemKeys}
                    onChange={e => toggleFlag('systemKeys', e.target.checked)}
                    className="rounded border-[var(--color-border)] accent-[var(--color-brand)]"
                  />
                  {t('settings.computerUse.flagSystemKeys')}
                </label>
              </div>

              {/* Search */}
              <div className="relative">
                <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)] absolute left-3 top-1/2 -translate-y-1/2">search</span>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={t('settings.computerUse.appsSearch')}
                  className="w-full pl-9 pr-4 py-2 text-sm bg-[var(--color-surface-container-low)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-brand)]"
                />
              </div>

              {/* App list */}
              {appsLoading ? (
                <div className="py-6 text-center text-sm text-[var(--color-text-tertiary)]">
                  {t('settings.computerUse.appsLoading')}
                </div>
              ) : installedApps.length === 0 ? (
                <div className="py-6 text-center text-sm text-[var(--color-text-tertiary)]">
                  {t('settings.computerUse.appsEmpty')}
                </div>
              ) : (
                <div className="max-h-[400px] overflow-y-auto rounded-lg border border-[var(--color-border)]">
                  {sortedApps.map(app => {
                    const isAuthorized = authorizedBundleIds.has(app.bundleId)
                    return (
                      <button
                        key={app.bundleId}
                        onClick={() => toggleApp(app)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)] border-b border-[var(--color-border)] last:border-b-0 ${
                          isAuthorized ? 'bg-[var(--color-brand)]/5' : ''
                        }`}
                      >
                        <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 border ${
                          isAuthorized
                            ? 'bg-[var(--color-brand)] border-[var(--color-brand)]'
                            : 'border-[var(--color-border)]'
                        }`}>
                          {isAuthorized && (
                            <span className="material-symbols-outlined text-[14px] text-white" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-[var(--color-text-primary)] truncate">
                            {app.displayName}
                          </div>
                          <div className="text-[11px] text-[var(--color-text-tertiary)] truncate font-mono">
                            {app.bundleId}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
