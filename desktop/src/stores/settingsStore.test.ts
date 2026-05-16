import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'

describe('settingsStore locale defaults', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
  })

  it('defaults to Chinese when no locale is stored', async () => {
    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().locale).toBe('zh')
  })

  it('keeps a stored locale override', async () => {
    window.localStorage.setItem('cc-haha-locale', 'en')

    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().locale).toBe('en')
  })
})

describe('settingsStore UI zoom', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-app-zoom-percent')
    document.documentElement.style.removeProperty('--app-zoom')
    document.body.style.removeProperty('zoom')
  })

  it('hydrates from the app zoom storage key', async () => {
    window.localStorage.setItem('cc-haha-app-zoom', '1.25')

    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().uiZoom).toBe(1.25)
  })

  it('applies and persists UI zoom changes through the shared app zoom controller', async () => {
    const { useSettingsStore } = await import('./settingsStore')

    useSettingsStore.getState().setUiZoom(1.25)

    await vi.waitFor(() => {
      expect(window.localStorage.getItem('cc-haha-app-zoom')).toBe('1.25')
    })
    expect(useSettingsStore.getState().uiZoom).toBe(1.25)
    expect(document.documentElement.getAttribute('data-app-zoom-percent')).toBe('125')
  })

  it('clamps UI zoom changes to the supported range', async () => {
    const { useSettingsStore } = await import('./settingsStore')

    useSettingsStore.getState().setUiZoom(9)

    await vi.waitFor(() => {
      expect(window.localStorage.getItem('cc-haha-app-zoom')).toBe('2')
    })
    expect(useSettingsStore.getState().uiZoom).toBe(2)
  })
})

describe('settingsStore desktop notification persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('defaults desktop notifications to explicit opt-in', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().desktopNotificationsEnabled).toBe(false)
  })

  it('keeps desktop notifications disabled when user settings do not opt in', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().desktopNotificationsEnabled).toBe(false)
  })

  it('persists the latest desktop notification toggle when saves overlap', async () => {
    const pendingSaves: Array<() => void> = []
    const updateUser = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          pendingSaves.push(() => resolve({ ok: true }))
        }),
    )

    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser,
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    const firstSave = useSettingsStore.getState().setDesktopNotificationsEnabled(false)
    await vi.waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith({ desktopNotificationsEnabled: false })
    })

    const secondSave = useSettingsStore.getState().setDesktopNotificationsEnabled(true)
    expect(useSettingsStore.getState().desktopNotificationsEnabled).toBe(true)

    pendingSaves.shift()?.()
    await vi.waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith({ desktopNotificationsEnabled: true })
    })
    pendingSaves.shift()?.()
    await Promise.all([firstSave, secondSave])

    expect(updateUser).toHaveBeenLastCalledWith({ desktopNotificationsEnabled: true })
    expect(useSettingsStore.getState().desktopNotificationsEnabled).toBe(true)
  })
})

describe('settingsStore thinking persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('persists both enabled and disabled thinking states explicitly', async () => {
    const updateUser = vi.fn().mockResolvedValue({})

    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser,
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setThinkingEnabled(false)
    await useSettingsStore.getState().setThinkingEnabled(true)

    expect(updateUser).toHaveBeenNthCalledWith(1, { alwaysThinkingEnabled: false })
    expect(updateUser).toHaveBeenNthCalledWith(2, { alwaysThinkingEnabled: true })
    expect(useSettingsStore.getState().thinkingEnabled).toBe(true)
  })

  it('rolls back the thinking toggle when persistence fails', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser: vi.fn().mockRejectedValue(new Error('save failed')),
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setThinkingEnabled(false)

    expect(useSettingsStore.getState().thinkingEnabled).toBe(true)
  })
})

describe('settingsStore theme persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.colorScheme = ''
  })

  it('falls back to the pure white theme when user settings have no theme', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')
    const { useUIStore } = await import('./uiStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().theme).toBe('white')
    expect(useUIStore.getState().theme).toBe('white')
    expect(document.documentElement.getAttribute('data-theme')).toBe('white')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('hydrates the pure white theme from user settings', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({ theme: 'white' }),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')
    const { useUIStore } = await import('./uiStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().theme).toBe('white')
    expect(useUIStore.getState().theme).toBe('white')
    expect(document.documentElement.getAttribute('data-theme')).toBe('white')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })
})

describe('settingsStore H5 access behavior', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it.each([404, 405])('falls back to disabled defaults only for legacy H5 endpoint status %s', async (status) => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockRejectedValue(new ApiError(status, { message: 'legacy' })),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        tokenPreview: 'h5_prev',
        allowedOrigins: ['https://prev.example'],
        publicBaseUrl: 'https://prev.example/app',
      },
    })

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().h5Access).toEqual({
      enabled: false,
      tokenPreview: null,
      allowedOrigins: [],
      publicBaseUrl: null,
    })
    expect(useSettingsStore.getState().h5AccessError).toBeNull()
  })

  it('preserves the last known H5 state and surfaces an H5 error on non-legacy load failures', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockRejectedValue(new ApiError(500, { message: 'H5 unavailable' })),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      h5Access: {
        enabled: true,
        tokenPreview: 'h5_prev',
        allowedOrigins: ['https://prev.example'],
        publicBaseUrl: 'https://prev.example/app',
      },
    })

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().h5Access).toEqual({
      enabled: true,
      tokenPreview: 'h5_prev',
      allowedOrigins: ['https://prev.example'],
      publicBaseUrl: 'https://prev.example/app',
    })
    expect(useSettingsStore.getState().h5AccessError).toBe('H5 unavailable')
  })

  it('handles H5 enable, regenerate, and disable transitions without persisting a raw token in store state', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn(),
        enable: vi.fn().mockResolvedValue({
          settings: {
            enabled: true,
            tokenPreview: 'h5_first',
            allowedOrigins: [],
            publicBaseUrl: null,
          },
          token: 'raw-enable-token',
        }),
        disable: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        regenerate: vi.fn().mockResolvedValue({
          settings: {
            enabled: true,
            tokenPreview: 'h5_second',
            allowedOrigins: ['https://phone.example'],
            publicBaseUrl: 'https://phone.example/app',
          },
          token: 'raw-regenerated-token',
        }),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await expect(useSettingsStore.getState().enableH5Access()).resolves.toBe('raw-enable-token')
    expect(useSettingsStore.getState().h5Access).toEqual({
      enabled: true,
      tokenPreview: 'h5_first',
      allowedOrigins: [],
      publicBaseUrl: null,
    })

    await expect(useSettingsStore.getState().regenerateH5AccessToken()).resolves.toBe('raw-regenerated-token')
    expect(useSettingsStore.getState().h5Access).toEqual({
      enabled: true,
      tokenPreview: 'h5_second',
      allowedOrigins: ['https://phone.example'],
      publicBaseUrl: 'https://phone.example/app',
    })

    await expect(useSettingsStore.getState().disableH5Access()).resolves.toBeUndefined()
    expect(useSettingsStore.getState().h5Access).toEqual({
      enabled: false,
      tokenPreview: null,
      allowedOrigins: [],
      publicBaseUrl: null,
    })
    expect(useSettingsStore.getState().h5AccessError).toBeNull()
    expect('h5AccessGeneratedToken' in useSettingsStore.getState()).toBe(false)
  })
})

describe('settingsStore observer sessions hidden', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('defaults to false (observer sessions visible)', async () => {
    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().observerSessionsHidden).toBe(false)
  })

  it('hydrates claudeMemObserverSessionsHidden from user settings', async () => {
    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn().mockResolvedValue({ claudeMemObserverSessionsHidden: true }),
        updateUser: vi.fn(),
        getPermissionMode: vi.fn().mockResolvedValue({ mode: 'default' }),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn().mockResolvedValue({ models: [] }),
        getCurrent: vi.fn().mockResolvedValue({ model: null }),
        setCurrent: vi.fn(),
        getEffort: vi.fn().mockResolvedValue({ level: 'medium' }),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().observerSessionsHidden).toBe(true)
  })

  it('persists toggle state to user settings', async () => {
    const updateUser = vi.fn().mockResolvedValue({ ok: true })

    vi.doMock('../api/settings', () => ({
      settingsApi: {
        getUser: vi.fn(),
        updateUser,
        getPermissionMode: vi.fn(),
        setPermissionMode: vi.fn(),
        getCliLauncherStatus: vi.fn(),
      },
    }))
    vi.doMock('../api/models', () => ({
      modelsApi: {
        list: vi.fn(),
        getCurrent: vi.fn(),
        setCurrent: vi.fn(),
        getEffort: vi.fn(),
        setEffort: vi.fn(),
      },
    }))
    vi.doMock('../api/h5Access', () => ({
      h5AccessApi: {
        get: vi.fn().mockResolvedValue({
          settings: {
            enabled: false,
            tokenPreview: null,
            allowedOrigins: [],
            publicBaseUrl: null,
          },
        }),
        enable: vi.fn(),
        disable: vi.fn(),
        regenerate: vi.fn(),
        update: vi.fn(),
      },
    }))

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setObserverSessionsHidden(true)
    expect(useSettingsStore.getState().observerSessionsHidden).toBe(true)
    expect(updateUser).toHaveBeenCalledWith({ claudeMemObserverSessionsHidden: true })

    await useSettingsStore.getState().setObserverSessionsHidden(false)
    expect(useSettingsStore.getState().observerSessionsHidden).toBe(false)
    expect(updateUser).toHaveBeenCalledWith({ claudeMemObserverSessionsHidden: undefined })
  })
})
