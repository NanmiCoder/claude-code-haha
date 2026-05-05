/**
 * Unit tests for Settings, Models, and Status APIs
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SettingsService } from '../services/settingsService.js'
import { handleSettingsApi } from '../api/settings.js'
import { handleModelsApi } from '../api/models.js'
import { handleStatusApi, resetUsage, addUsage } from '../api/status.js'
import { ProviderService } from '../services/providerService.js'
import {
  clearOpenAIOAuthTokenCache,
} from '../../services/openaiAuth/storage.js'
import { plainTextStorage } from '../../utils/secureStorage/plainTextStorage.js'
import {
  clearKeychainCache,
  primeKeychainCacheFromPrefetch,
} from '../../utils/secureStorage/macOsKeychainHelpers.js'
import type { OpenAIOAuthTokens } from '../../services/openaiAuth/types.js'
import { getModelOptions } from '../../utils/model/modelOptions.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string
let originalConfigDir: string | undefined
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalShell: string | undefined
let originalPath: string | undefined
let originalCliPath: string | undefined
let originalAnthropicApiKey: string | undefined
let originalAnthropicBaseUrl: string | undefined
let originalAnthropicModel: string | undefined
let originalAnthropicDefaultHaikuModel: string | undefined
let originalAnthropicDefaultSonnetModel: string | undefined
let originalAnthropicDefaultOpusModel: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  originalShell = process.env.SHELL
  originalPath = process.env.PATH
  originalCliPath = process.env.CLAUDE_CLI_PATH
  originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL
  originalAnthropicModel = process.env.ANTHROPIC_MODEL
  originalAnthropicDefaultHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  originalAnthropicDefaultSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  originalAnthropicDefaultOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.HOME = tmpDir
  process.env.USERPROFILE = tmpDir
  process.env.SHELL = '/bin/zsh'
  process.env.PATH = ''
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_MODEL
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  clearKeychainCache()
  primeKeychainCacheFromPrefetch(null)
  clearOpenAIOAuthTokenCache()
}

async function teardown() {
  plainTextStorage.delete()
  clearKeychainCache()
  clearOpenAIOAuthTokenCache()

  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }

  if (originalHome !== undefined) {
    process.env.HOME = originalHome
  } else {
    delete process.env.HOME
  }

  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile
  } else {
    delete process.env.USERPROFILE
  }

  if (originalShell !== undefined) {
    process.env.SHELL = originalShell
  } else {
    delete process.env.SHELL
  }

  if (originalPath !== undefined) {
    process.env.PATH = originalPath
  } else {
    delete process.env.PATH
  }

  if (originalCliPath !== undefined) {
    process.env.CLAUDE_CLI_PATH = originalCliPath
  } else {
    delete process.env.CLAUDE_CLI_PATH
  }

  if (originalAnthropicApiKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  } else {
    delete process.env.ANTHROPIC_API_KEY
  }

  if (originalAnthropicBaseUrl !== undefined) {
    process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl
  } else {
    delete process.env.ANTHROPIC_BASE_URL
  }

  if (originalAnthropicModel !== undefined) {
    process.env.ANTHROPIC_MODEL = originalAnthropicModel
  } else {
    delete process.env.ANTHROPIC_MODEL
  }

  if (originalAnthropicDefaultHaikuModel !== undefined) {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = originalAnthropicDefaultHaikuModel
  } else {
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }

  if (originalAnthropicDefaultSonnetModel !== undefined) {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = originalAnthropicDefaultSonnetModel
  } else {
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }

  if (originalAnthropicDefaultOpusModel !== undefined) {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = originalAnthropicDefaultOpusModel
  } else {
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }

  await fs.rm(tmpDir, { recursive: true, force: true })
}

function saveTestOpenAIOAuthTokens(tokens: OpenAIOAuthTokens) {
  plainTextStorage.update({ openaiCodexOauth: tokens })
  clearOpenAIOAuthTokenCache()
}

/** 创建一个模拟 Request */
function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

// =============================================================================
// SettingsService
// =============================================================================

describe('SettingsService', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('should return empty object when settings file does not exist', async () => {
    const svc = new SettingsService()
    const settings = await svc.getUserSettings()
    expect(settings).toEqual({})
  })

  it('should write and read user settings', async () => {
    const svc = new SettingsService()
    await svc.updateUserSettings({ theme: 'dark', model: 'claude-opus-4-7' })

    const settings = await svc.getUserSettings()
    expect(settings.theme).toBe('dark')
    expect(settings.model).toBe('claude-opus-4-7')
  })

  it('should merge settings on update (shallow merge)', async () => {
    const svc = new SettingsService()
    await svc.updateUserSettings({ theme: 'dark' })
    await svc.updateUserSettings({ model: 'claude-haiku-4-5' })

    const settings = await svc.getUserSettings()
    expect(settings.theme).toBe('dark')
    expect(settings.model).toBe('claude-haiku-4-5')
  })

  it('should read and write project settings', async () => {
    const projectRoot = path.join(tmpDir, 'myproject')
    await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true })

    const svc = new SettingsService(projectRoot)
    await svc.updateProjectSettings({ outputStyle: 'verbose' })

    const settings = await svc.getProjectSettings()
    expect(settings.outputStyle).toBe('verbose')
  })

  it('should merge user and project settings', async () => {
    const projectRoot = path.join(tmpDir, 'myproject')
    await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true })

    const svc = new SettingsService(projectRoot)
    await svc.updateUserSettings({ theme: 'dark', model: 'claude-opus-4-7' })
    await svc.updateProjectSettings({ theme: 'light' })

    const merged = await svc.getSettings()
    // project overrides user
    expect(merged.theme).toBe('light')
    // user value preserved when not overridden
    expect(merged.model).toBe('claude-opus-4-7')
  })

  it('should get default permission mode', async () => {
    const svc = new SettingsService()
    const mode = await svc.getPermissionMode()
    expect(mode).toBe('default')
  })

  it('should set and get permission mode', async () => {
    const svc = new SettingsService()
    await svc.setPermissionMode('plan')
    const mode = await svc.getPermissionMode()
    expect(mode).toBe('plan')
  })

  it('should reject invalid permission mode', async () => {
    const svc = new SettingsService()
    await expect(svc.setPermissionMode('invalid')).rejects.toThrow('Invalid permission mode')
  })

  it('should preserve other settings when updating permission mode', async () => {
    const svc = new SettingsService()
    await svc.updateUserSettings({ theme: 'dark' })
    await svc.setPermissionMode('acceptEdits')

    const settings = await svc.getUserSettings()
    expect(settings.theme).toBe('dark')
    expect(settings.defaultMode).toBe('acceptEdits')
  })

  it('should serialize concurrent user settings writes to the same file', async () => {
    const svc = new SettingsService()
    const originalNow = Date.now
    Date.now = () => 1776695497171

    try {
      await Promise.all([
        svc.updateUserSettings({ theme: 'dark' }),
        svc.setPermissionMode('bypassPermissions'),
      ])
    } finally {
      Date.now = originalNow
    }

    const settings = await svc.getUserSettings()
    expect(settings.theme).toBe('dark')
    expect(settings.defaultMode).toBe('bypassPermissions')
  })
})

// =============================================================================
// Settings API
// =============================================================================

describe('Settings API', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('GET /api/settings should return merged settings', async () => {
    // Seed some user settings
    const settingsPath = path.join(tmpDir, 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify({ theme: 'dark' }))

    const { req, url, segments } = makeRequest('GET', '/api/settings')
    const res = await handleSettingsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.theme).toBe('dark')
  })

  it('GET /api/settings/user should return user settings', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/settings/user')
    const res = await handleSettingsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({})
  })

  it('PUT /api/settings/user should update user settings', async () => {
    const { req, url, segments } = makeRequest('PUT', '/api/settings/user', {
      model: 'claude-opus-4-7',
    })
    const res = await handleSettingsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    // Verify persisted
    const { req: r2, url: u2, segments: s2 } = makeRequest('GET', '/api/settings/user')
    const res2 = await handleSettingsApi(r2, u2, s2)
    const body2 = await res2.json()
    expect(body2.model).toBe('claude-opus-4-7')
  })

  it('GET /api/permissions/mode should return default mode', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/permissions/mode')
    const res = await handleSettingsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('default')
  })

  it('PUT /api/permissions/mode should set mode', async () => {
    const { req, url, segments } = makeRequest('PUT', '/api/permissions/mode', {
      mode: 'bypassPermissions',
    })
    const res = await handleSettingsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.mode).toBe('bypassPermissions')
  })

  it('PUT /api/permissions/mode should reject invalid mode', async () => {
    const { req, url, segments } = makeRequest('PUT', '/api/permissions/mode', {
      mode: 'yolo',
    })
    const res = await handleSettingsApi(req, url, segments)

    expect(res.status).toBe(400)
  })

  it('should return 404 for unknown settings endpoint', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/settings/unknown')
    const res = await handleSettingsApi(req, url, segments)
    expect(res.status).toBe(404)
  })
})

// =============================================================================
// Models API
// =============================================================================

describe('Models API', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('GET /api/models should return available models', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/models')
    const res = await handleModelsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.models).toBeArray()
    expect(body.models.length).toBe(3)
    expect(body.models[0].id).toContain('claude')
  })

  it('GET /api/models should merge env-configured provider models with saved OpenAI OAuth models', async () => {
    process.env.ANTHROPIC_API_KEY = 'deepseek-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_MODEL = 'deepseek-v4-pro'
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'
    saveTestOpenAIOAuthTokens({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
    })

    const { req, url, segments } = makeRequest('GET', '/api/models')
    const res = await handleModelsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.models.map((model: { id: string }) => model.id)

    expect(ids).toContain('deepseek-v4-pro')
    expect(ids).toContain('deepseek-v4-flash')
    expect(ids).toContain('gpt-5.3-codex')
    expect(ids).toContain('gpt-5.4')
    expect(ids).toContain('gpt-5.4-mini')
    expect(ids.filter((id: string) => id === 'deepseek-v4-pro')).toHaveLength(1)
  })

  it('GET /api/models/current should return default model when not set', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/models/current')
    const res = await handleModelsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.model.id).toBe('claude-opus-4-7')
  })

  it('GET /api/models/current should respect env-configured default model when no provider is active', async () => {
    process.env.ANTHROPIC_MODEL = 'deepseek-v4-pro'

    const { req, url, segments } = makeRequest('GET', '/api/models/current')
    const res = await handleModelsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.model.id).toBe('deepseek-v4-pro')
  })

  it('PUT /api/models/current should switch model', async () => {
    const { req, url, segments } = makeRequest('PUT', '/api/models/current', {
      modelId: 'claude-opus-4-7',
    })
    const res = await handleModelsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.model).toBe('claude-opus-4-7')

    // Verify persisted
    const { req: r2, url: u2, segments: s2 } = makeRequest('GET', '/api/models/current')
    const res2 = await handleModelsApi(r2, u2, s2)
    const body2 = await res2.json()
    expect(body2.model.id).toBe('claude-opus-4-7')
  })

  it('PUT /api/models/current should reject missing modelId', async () => {
    const { req, url, segments } = makeRequest('PUT', '/api/models/current', {})
    const res = await handleModelsApi(req, url, segments)
    expect(res.status).toBe(400)
  })

  it('GET /api/models/current should prefer cc-haha managed model over global user model when provider is active', async () => {
    const settingsSvc = new SettingsService()
    await settingsSvc.updateUserSettings({ model: 'kimi-k2.6' })

    const providerSvc = new ProviderService()
    const provider = await providerSvc.addProvider({
      presetId: 'zhipuglm',
      name: 'Zhipu GLM',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'test-key',
      apiFormat: 'anthropic',
      models: {
        main: 'glm-5.1',
        haiku: 'glm-4.5-air',
        sonnet: 'glm-5-turbo',
        opus: 'glm-5.1',
      },
    })
    await providerSvc.activateProvider(provider.id)
    await providerSvc.updateManagedSettings({ model: 'glm-5-turbo' })

    const { req, url, segments } = makeRequest('GET', '/api/models/current')
    const res = await handleModelsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.model.id).toBe('glm-5-turbo')
  })

  it('PUT /api/models/current should persist to cc-haha managed settings when provider is active', async () => {
    const settingsSvc = new SettingsService()
    const providerSvc = new ProviderService()
    const provider = await providerSvc.addProvider({
      presetId: 'zhipuglm',
      name: 'Zhipu GLM',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'test-key',
      apiFormat: 'anthropic',
      models: {
        main: 'glm-5.1',
        haiku: 'glm-4.5-air',
        sonnet: 'glm-5-turbo',
        opus: 'glm-5.1',
      },
    })
    await providerSvc.activateProvider(provider.id)

    const putReq = makeRequest('PUT', '/api/models/current', {
      modelId: 'glm-5-turbo',
    })
    const putRes = await handleModelsApi(putReq.req, putReq.url, putReq.segments)
    expect(putRes.status).toBe(200)

    const managedSettings = await providerSvc.getManagedSettings()
    expect(managedSettings.model).toBe('glm-5-turbo')

    const globalSettings = await settingsSvc.getUserSettings()
    expect(globalSettings.model).toBeUndefined()
  })

  it('GET /api/effort should return default effort level', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/effort')
    const res = await handleModelsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.level).toBe('medium')
    expect(body.available).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('PUT /api/effort should set effort level', async () => {
    const { req, url, segments } = makeRequest('PUT', '/api/effort', { level: 'high' })
    const res = await handleModelsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.level).toBe('high')
  })

  it('PUT /api/effort should reject invalid level', async () => {
    const { req, url, segments } = makeRequest('PUT', '/api/effort', { level: 'turbo' })
    const res = await handleModelsApi(req, url, segments)
    expect(res.status).toBe(400)
  })

  it('should return 404 for unknown models endpoint', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/models/unknown')
    const res = await handleModelsApi(req, url, segments)
    expect(res.status).toBe(404)
  })
})

describe('Model Options', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('should keep OpenAI OAuth models visible alongside env-configured provider models', () => {
    process.env.ANTHROPIC_API_KEY = 'deepseek-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_MODEL = 'deepseek-v4-pro'
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'
    saveTestOpenAIOAuthTokens({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
    })

    const options = getModelOptions()
    const values = options
      .map(option => option.value)
      .filter((value): value is string => typeof value === 'string')
    const labels = options.map(option => option.label)

    expect(values).toContain('gpt-5.3-codex')
    expect(values).toContain('gpt-5.4')
    expect(values).toContain('gpt-5.4-mini')
    expect(labels).toContain('deepseek-v4-pro')
    expect(labels).toContain('deepseek-v4-flash')
  })
})

// =============================================================================
// Status API
// =============================================================================

describe('Status API', () => {
  beforeEach(async () => {
    await setup()
    resetUsage()
  })
  afterEach(teardown)

  it('GET /api/status should return health check', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/status')
    const res = await handleStatusApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.version).toBeDefined()
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })

  it('GET /api/status/diagnostics should return system info', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/status/diagnostics')
    const res = await handleStatusApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.platform).toBeDefined()
    expect(body.arch).toBeDefined()
    expect(body.configDir).toBeDefined()
  })

  it('GET /api/status/usage should return token usage', async () => {
    addUsage(100, 50, 0.005)
    addUsage(200, 100, 0.01)

    const { req, url, segments } = makeRequest('GET', '/api/status/usage')
    const res = await handleStatusApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalInputTokens).toBe(300)
    expect(body.totalOutputTokens).toBe(150)
    expect(body.totalCost).toBeCloseTo(0.015)
  })

  it('GET /api/status/user should return user info', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/status/user')
    const res = await handleStatusApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configDir).toBe(tmpDir)
    expect(body.projects).toBeArray()
  })

  it('should reject non-GET methods', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/status')
    const res = await handleStatusApi(req, url, segments)
    expect(res.status).toBe(405)
  })

  it('should return 404 for unknown status endpoint', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/status/nonexistent')
    const res = await handleStatusApi(req, url, segments)
    expect(res.status).toBe(404)
  })
})
