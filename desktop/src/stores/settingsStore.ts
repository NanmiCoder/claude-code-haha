import { create } from 'zustand'
import { ApiError } from '../api/client'
import { settingsApi } from '../api/settings'
import { modelsApi } from '../api/models'
import { h5AccessApi } from '../api/h5Access'
import {
  isThemeMode,
  type AppMode,
  type AppModeConfig,
  type ChatSendBehavior,
  type DesktopTerminalSettings,
  type DesktopTerminalStartupShell,
  type H5AccessDiagnostics,
  type H5AccessSettings,
  type NetworkSettings,
  type PermissionMode,
  type EffortLevel,
  type ModelInfo,
  type ThemeMode,
  type UpdateProxyMode,
  type UpdateProxySettings,
  type WebSearchSettings,
} from '../types/settings'
import { isTauriRuntime } from '../lib/desktopRuntime'
import type { Locale } from '../i18n'
import {
  APP_ZOOM_CONTROL_STEP,
  DEFAULT_APP_ZOOM,
  MAX_APP_ZOOM,
  MIN_APP_ZOOM,
  applyAppZoomLevel,
  normalizeAppZoomLevel,
  readStoredAppZoomLevel,
} from '../lib/appZoom'
import { useUIStore } from './uiStore'

const LOCALE_STORAGE_KEY = 'cc-haha-locale'
export const UI_ZOOM_MIN = MIN_APP_ZOOM
export const UI_ZOOM_MAX = MAX_APP_ZOOM
export const UI_ZOOM_STEP = APP_ZOOM_CONTROL_STEP
export const UI_ZOOM_DEFAULT = DEFAULT_APP_ZOOM
let desktopNotificationsSaveQueue: Promise<void> = Promise.resolve()

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored === 'en' || stored === 'zh') return stored
  } catch { /* localStorage unavailable */ }
  return 'zh'
}

type SettingsStore = {
  permissionMode: PermissionMode
  currentModel: ModelInfo | null
  effortLevel: EffortLevel
  thinkingEnabled: boolean
  availableModels: ModelInfo[]
  activeProviderName: string | null
  locale: Locale
  theme: ThemeMode
  chatSendBehavior: ChatSendBehavior
  skipWebFetchPreflight: boolean
  desktopNotificationsEnabled: boolean
  desktopTerminal: DesktopTerminalSettings
  webSearch: WebSearchSettings
  updateProxy: UpdateProxySettings
  network: NetworkSettings
  h5Access: H5AccessSettings
  h5AccessDiagnostics: H5AccessDiagnostics | null
  h5AccessError: string | null
  responseLanguage: string
  plantumlJarPath: string
  uiZoom: number
  isLoading: boolean
  error: string | null

  appMode: AppModeConfig
  appModeRequiresRestart: boolean

  fetchAll: () => Promise<void>
  fetchH5Access: () => Promise<void>
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  setModel: (modelId: string) => Promise<void>
  setEffort: (level: EffortLevel) => Promise<void>
  setThinkingEnabled: (enabled: boolean) => Promise<void>
  setLocale: (locale: Locale) => void
  setTheme: (theme: ThemeMode) => Promise<void>
  setChatSendBehavior: (behavior: ChatSendBehavior) => Promise<void>
  setSkipWebFetchPreflight: (enabled: boolean) => Promise<void>
  setDesktopNotificationsEnabled: (enabled: boolean) => Promise<void>
  setDesktopTerminal: (settings: DesktopTerminalSettings) => Promise<void>
  setWebSearch: (settings: WebSearchSettings) => Promise<void>
  setUpdateProxy: (settings: UpdateProxySettings) => Promise<void>
  setNetwork: (settings: NetworkSettings) => Promise<void>
  enableH5Access: () => Promise<string>
  disableH5Access: () => Promise<void>
  regenerateH5AccessToken: () => Promise<string>
  updateH5AccessSettings: (input: {
    allowedOrigins?: string[]
    publicBaseUrl?: string | null
  }) => Promise<void>
  setResponseLanguage: (language: string) => Promise<void>
  fetchAppMode: () => Promise<void>
  setAppMode: (mode: AppMode, portableDir?: string | null) => Promise<void>
  setPlantumlJarPath: (path: string) => Promise<void>
  setUiZoom: (zoom: number) => void
}

type NetworkSettingsInput = Partial<Omit<NetworkSettings, 'proxy'>> & {
  proxy?: Partial<NetworkSettings['proxy']>
}

const DEFAULT_H5_ACCESS_SETTINGS: H5AccessSettings = {
  enabled: false,
  tokenPreview: null,
  allowedOrigins: [],
  publicBaseUrl: null,
}

const DEFAULT_DESKTOP_TERMINAL_SETTINGS: DesktopTerminalSettings = {
  startupShell: 'system',
  customShellPath: '',
}

const DEFAULT_UPDATE_PROXY_SETTINGS: UpdateProxySettings = {
  mode: 'system',
  url: '',
}

const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  aiRequestTimeoutMs: 120_000,
  proxy: {
    mode: 'system',
    url: '',
  },
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  permissionMode: 'default',
  currentModel: null,
  effortLevel: 'max',
  thinkingEnabled: true,
  availableModels: [],
  activeProviderName: null,
  locale: getStoredLocale(),
  theme: useUIStore.getState().theme,
  chatSendBehavior: 'enter',
  skipWebFetchPreflight: true,
  desktopNotificationsEnabled: false,
  desktopTerminal: DEFAULT_DESKTOP_TERMINAL_SETTINGS,
  webSearch: { mode: 'auto', tavilyApiKey: '', braveApiKey: '' },
  updateProxy: DEFAULT_UPDATE_PROXY_SETTINGS,
  network: DEFAULT_NETWORK_SETTINGS,
  h5Access: DEFAULT_H5_ACCESS_SETTINGS,
  h5AccessDiagnostics: null,
  h5AccessError: null,
  responseLanguage: '',
  uiZoom: readStoredAppZoomLevel(),
  plantumlJarPath: '',
  isLoading: false,
  error: null,

  appMode: {
    mode: 'default',
    portableDir: null,
    defaultPortableDir: null,
    activeConfigDir: null,
    configDirSource: 'system',
  },
  appModeRequiresRestart: false,
  setUiZoom: (zoom: number) => {
    const level = normalizeAppZoomLevel(zoom)
    set({ uiZoom: level })
    void applyAppZoomLevel(level)
  },

  fetchAll: async () => {
    set({ isLoading: true, error: null })
    try {
      const previousH5Access = get().h5Access
      const [{ mode }, modelsRes, { model }, { level }, userSettings, h5AccessResult] = await Promise.all([
        settingsApi.getPermissionMode(),
        modelsApi.list(),
        modelsApi.getCurrent(),
        modelsApi.getEffort(),
        settingsApi.getUser(),
        loadH5AccessSettings(previousH5Access),
      ])
      const theme = isThemeMode(userSettings.theme) ? userSettings.theme : 'white'
      useUIStore.getState().setTheme(theme)
      set({
        permissionMode: mode,
        availableModels: modelsRes.models,
        activeProviderName: modelsRes.provider?.name ?? null,
        currentModel: model,
        effortLevel: level,
        thinkingEnabled: userSettings.alwaysThinkingEnabled !== false,
        theme,
        chatSendBehavior: normalizeChatSendBehavior(userSettings.chatSendBehavior),
        skipWebFetchPreflight: userSettings.skipWebFetchPreflight !== false,
        desktopNotificationsEnabled: userSettings.desktopNotificationsEnabled === true,
        desktopTerminal: normalizeDesktopTerminalSettings(userSettings.desktopTerminal),
        webSearch: normalizeWebSearchSettings(userSettings.webSearch),
        updateProxy: normalizeUpdateProxySettings(userSettings.updateProxy),
        network: normalizeNetworkSettings(userSettings.network),
        h5Access: h5AccessResult.settings,
        h5AccessDiagnostics: h5AccessResult.diagnostics,
        h5AccessError: h5AccessResult.error,
        responseLanguage: typeof userSettings.language === 'string' ? userSettings.language : '',
        plantumlJarPath: typeof userSettings.plantumlJarPath === 'string' ? userSettings.plantumlJarPath : '',
        isLoading: false,
        error: null,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load desktop settings'
      set({ isLoading: false, error: message })
      throw error
    }
  },

  fetchH5Access: async () => {
    const result = await loadH5AccessSettings(get().h5Access)
    set({
      h5Access: result.settings,
      h5AccessDiagnostics: result.diagnostics,
      h5AccessError: result.error,
    })
  },

  setPermissionMode: async (mode) => {
    const prev = get().permissionMode
    set({ permissionMode: mode })
    try {
      await settingsApi.setPermissionMode(mode)
    } catch {
      set({ permissionMode: prev })
    }
  },

  setModel: async (modelId) => {
    await modelsApi.setCurrent(modelId)
    const { model } = await modelsApi.getCurrent()
    set({ currentModel: model })
  },

  setEffort: async (level) => {
    const prev = get().effortLevel
    set({ effortLevel: level })
    try {
      await modelsApi.setEffort(level)
    } catch {
      set({ effortLevel: prev })
    }
  },

  setThinkingEnabled: async (enabled) => {
    const prev = get().thinkingEnabled
    set({ thinkingEnabled: enabled })
    try {
      await settingsApi.updateUser({ alwaysThinkingEnabled: enabled })
    } catch {
      set({ thinkingEnabled: prev })
    }
  },

  setLocale: (locale) => {
    set({ locale })
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* noop */ }
  },

  setTheme: async (theme) => {
    const prev = get().theme
    set({ theme })
    useUIStore.getState().setTheme(theme)
    try {
      await settingsApi.updateUser({ theme })
    } catch {
      set({ theme: prev })
      useUIStore.getState().setTheme(prev)
    }
  },

  setChatSendBehavior: async (behavior) => {
    const prev = get().chatSendBehavior
    const next = normalizeChatSendBehavior(behavior)
    set({ chatSendBehavior: next })
    try {
      await settingsApi.updateUser({ chatSendBehavior: next })
    } catch (error) {
      set({ chatSendBehavior: prev })
      throw error
    }
  },

  setSkipWebFetchPreflight: async (enabled) => {
    const prev = get().skipWebFetchPreflight
    set({ skipWebFetchPreflight: enabled })
    try {
      await settingsApi.updateUser({ skipWebFetchPreflight: enabled })
    } catch {
      set({ skipWebFetchPreflight: prev })
    }
  },

  setDesktopNotificationsEnabled: async (enabled) => {
    const prev = get().desktopNotificationsEnabled
    set({ desktopNotificationsEnabled: enabled })
    const save = desktopNotificationsSaveQueue
      .catch(() => undefined)
      .then(async () => {
        if (get().desktopNotificationsEnabled !== enabled) return
        await settingsApi.updateUser({ desktopNotificationsEnabled: enabled })
      })

    desktopNotificationsSaveQueue = save

    try {
      await save
    } catch {
      if (get().desktopNotificationsEnabled === enabled) {
        set({ desktopNotificationsEnabled: prev })
      }
    }
  },

  setDesktopTerminal: async (settings) => {
    const prev = get().desktopTerminal
    const next = normalizeDesktopTerminalSettings(settings)
    set({ desktopTerminal: next })
    try {
      await settingsApi.updateUser({ desktopTerminal: next })
    } catch (error) {
      set({ desktopTerminal: prev })
      throw error
    }
  },

  setWebSearch: async (webSearch) => {
    const prev = get().webSearch
    const next = normalizeWebSearchSettings(webSearch)
    set({ webSearch: next })
    try {
      await settingsApi.updateUser({ webSearch: next })
    } catch {
      set({ webSearch: prev })
    }
  },

  setUpdateProxy: async (settings) => {
    const prev = get().updateProxy
    const next = normalizeUpdateProxySettings(settings)
    set({ updateProxy: next })
    try {
      await settingsApi.updateUser({ updateProxy: next })
    } catch (error) {
      set({ updateProxy: prev })
      throw error
    }
  },

  setNetwork: async (settings) => {
    const prev = get().network
    const next = normalizeNetworkSettings(settings)
    set({ network: next })
    try {
      await settingsApi.updateUser({ network: next })
    } catch (error) {
      set({ network: prev })
      throw error
    }
  },

  enableH5Access: async () => {
    set({ h5AccessError: null })
    try {
      const { settings, token } = await h5AccessApi.enable()
      set({
        h5Access: normalizeH5AccessSettings(settings),
        h5AccessError: null,
      })
      await refreshH5DiagnosticsSilent(set)
      return token
    } catch (error) {
      set({ h5AccessError: getErrorMessage(error, 'Failed to enable H5 access.') })
      throw error
    }
  },

  disableH5Access: async () => {
    set({ h5AccessError: null })
    try {
      const { settings } = await h5AccessApi.disable()
      set({
        h5Access: normalizeH5AccessSettings(settings),
        h5AccessError: null,
      })
      await refreshH5DiagnosticsSilent(set)
    } catch (error) {
      set({ h5AccessError: getErrorMessage(error, 'Failed to disable H5 access.') })
      throw error
    }
  },

  regenerateH5AccessToken: async () => {
    set({ h5AccessError: null })
    try {
      const { settings, token } = await h5AccessApi.regenerate()
      set({
        h5Access: normalizeH5AccessSettings(settings),
        h5AccessError: null,
      })
      await refreshH5DiagnosticsSilent(set)
      return token
    } catch (error) {
      set({ h5AccessError: getErrorMessage(error, 'Failed to regenerate the H5 token.') })
      throw error
    }
  },

  updateH5AccessSettings: async (input) => {
    set({ h5AccessError: null })
    try {
      const { settings } = await h5AccessApi.update(input)
      set({
        h5Access: normalizeH5AccessSettings(settings),
        h5AccessError: null,
      })
      await refreshH5DiagnosticsSilent(set)
    } catch (error) {
      set({ h5AccessError: getErrorMessage(error, 'Failed to update H5 access settings.') })
      throw error
    }
  },

  setResponseLanguage: async (language) => {
    const prev = get().responseLanguage
    set({ responseLanguage: language })
    try {
      await settingsApi.updateUser({ language: language || undefined })
    } catch {
      set({ responseLanguage: prev })
    }
  },

  fetchAppMode: async () => {
    if (!isTauriRuntime()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result: AppModeConfig = await invoke('get_app_mode')
      set({ appMode: result })
    } catch { /* silently ignore - not in Tauri or command unavailable */ }
  },

  setAppMode: async (mode, portableDir) => {
    if (!isTauriRuntime()) return
    const prev = get().appMode
    const newMode: AppModeConfig = {
      ...prev,
      mode,
      portableDir: mode === 'portable'
        ? portableDir ?? prev.defaultPortableDir ?? prev.portableDir
        : null,
      activeConfigDir: mode === 'portable'
        ? portableDir ?? prev.defaultPortableDir ?? prev.portableDir
        : null,
      configDirSource: mode === 'portable' ? 'portable' : 'system',
    }
    set({ appMode: newMode, appModeRequiresRestart: true })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('set_app_mode', {
        mode,
        portableDir: newMode.portableDir || null,
      })
    } catch {
      set({ appMode: prev, appModeRequiresRestart: false })
    }
  },

  setPlantumlJarPath: async (path) => {
    const prev = get().plantumlJarPath
    set({ plantumlJarPath: path })
    try {
      await settingsApi.updateUser({ plantumlJarPath: path || undefined })
    } catch {
      set({ plantumlJarPath: prev })
    }
  },


}))

function normalizeWebSearchSettings(settings: WebSearchSettings | undefined): WebSearchSettings {
  return {
    mode: settings?.mode ?? 'auto',
    tavilyApiKey: settings?.tavilyApiKey ?? '',
    braveApiKey: settings?.braveApiKey ?? '',
  }
}

function normalizeChatSendBehavior(value: unknown): ChatSendBehavior {
  return value === 'modifierEnter' ? 'modifierEnter' : 'enter'
}

function isUpdateProxyMode(value: unknown): value is UpdateProxyMode {
  return value === 'system' || value === 'manual'
}

function normalizeUpdateProxySettings(
  settings: Partial<UpdateProxySettings> | undefined,
): UpdateProxySettings {
  const mode = isUpdateProxyMode(settings?.mode)
    ? settings.mode
    : DEFAULT_UPDATE_PROXY_SETTINGS.mode
  return {
    mode,
    url: typeof settings?.url === 'string' ? settings.url.trim() : '',
  }
}

function normalizeNetworkSettings(
  settings: NetworkSettingsInput | undefined,
): NetworkSettings {
  const timeout = typeof settings?.aiRequestTimeoutMs === 'number' && Number.isFinite(settings.aiRequestTimeoutMs)
    ? Math.min(Math.max(Math.round(settings.aiRequestTimeoutMs), 5_000), 600_000)
    : DEFAULT_NETWORK_SETTINGS.aiRequestTimeoutMs
  const proxyMode = settings?.proxy?.mode === 'manual' ? 'manual' : 'system'

  return {
    aiRequestTimeoutMs: timeout,
    proxy: {
      mode: proxyMode,
      url: typeof settings?.proxy?.url === 'string' ? settings.proxy.url.trim() : '',
    },
  }
}

function normalizeDesktopTerminalSettings(
  settings: Partial<DesktopTerminalSettings> | undefined,
): DesktopTerminalSettings {
  const startupShell = isDesktopTerminalStartupShell(settings?.startupShell)
    ? settings.startupShell
    : DEFAULT_DESKTOP_TERMINAL_SETTINGS.startupShell

  return {
    startupShell,
    customShellPath: typeof settings?.customShellPath === 'string'
      ? settings.customShellPath
      : DEFAULT_DESKTOP_TERMINAL_SETTINGS.customShellPath,
  }
}

function normalizeH5AccessSettings(settings: H5AccessSettings | undefined): H5AccessSettings {
  return {
    enabled: settings?.enabled === true,
    tokenPreview: settings?.tokenPreview ?? null,
    allowedOrigins: Array.isArray(settings?.allowedOrigins) ? settings.allowedOrigins : [],
    publicBaseUrl: settings?.publicBaseUrl ?? null,
  }
}

async function refreshH5DiagnosticsSilent(
  set: (partial: Partial<SettingsStore>) => void,
): Promise<void> {
  // Best-effort diagnostics refresh. Failure here must not surface as an
  // error on the main H5 action (enable/disable/regenerate/update), because
  // the main action has already succeeded by the time we reach this point.
  try {
    const response = await h5AccessApi.get()
    const diagnostics = response?.diagnostics ?? null
    set({ h5AccessDiagnostics: diagnostics })
  } catch {
    // silent: keep previous diagnostics value
  }
}

async function loadH5AccessSettings(previousH5Access: H5AccessSettings): Promise<{
  settings: H5AccessSettings
  diagnostics: H5AccessDiagnostics | null
  error: string | null
}> {
  try {
    const { settings, diagnostics } = await h5AccessApi.get()
    return {
      settings: normalizeH5AccessSettings(settings),
      diagnostics: diagnostics ?? null,
      error: null,
    }
  } catch (error) {
    if (isLegacyH5EndpointError(error)) {
      return {
        settings: DEFAULT_H5_ACCESS_SETTINGS,
        diagnostics: null,
        error: null,
      }
    }

    return {
      settings: previousH5Access,
      diagnostics: null,
      error: getErrorMessage(error, 'Failed to load H5 access settings.'),
    }
  }
}

function isLegacyH5EndpointError(error: unknown) {
  const status = error instanceof ApiError
    ? error.status
    : typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
      ? error.status
      : null
  return status === 404 || status === 405
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

function isDesktopTerminalStartupShell(value: unknown): value is DesktopTerminalStartupShell {
  return value === 'system'
    || value === 'pwsh'
    || value === 'powershell'
    || value === 'cmd'
    || value === 'custom'
}
