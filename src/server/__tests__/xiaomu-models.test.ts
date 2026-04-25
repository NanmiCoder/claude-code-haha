import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleModelsApi } from '../api/models.js'
import { ProviderService } from '../services/providerService.js'
import { resetXiaomuModelCatalogCache } from '../services/xiaomuModelService.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalFetch: typeof globalThis.fetch

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

function installAiapiMock(statusOverrides: Record<string, unknown> = {}): void {
  const statusPayload = {
    success: true,
    data: {
      system_name: '远程模型中心',
      desktop_models_config: JSON.stringify({
        defaultModel: 'gemini-3.1-pro-preview',
        models: [
          {
            id: 'gemini-3.1-pro-preview',
            name: 'Gemini Pro+',
            description: '远程主模型',
            context: '1m',
            routing: {
              haiku: 'gpt-5.4',
              sonnet: 'gemini-3.1-pro-preview',
              opus: 'gemini-3.1-pro-preview',
              smallFast: 'gpt-5.4',
            },
          },
          {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            description: '远程备用模型',
            context: '200k',
          },
        ],
      }),
      ...statusOverrides,
    },
  }

  const pricingPayload = {
    success: true,
    data: [
      {
        model_name: 'gpt-5.4',
        display_name: '灵感引擎Pro',
        quota_type: 0,
        model_ratio: 0.8,
        completion_ratio: 8,
      },
      {
        model_name: 'gpt-5.5',
        display_name: 'GPT-5.5',
        quota_type: 0,
        model_ratio: 0.8,
        completion_ratio: 8,
      },
      {
        model_name: 'gemini-3.1-pro-preview',
        display_name: '智写Pro+',
        quota_type: 0,
        model_ratio: 1.8,
        completion_ratio: 5.5,
      },
      {
        model_name: 'claude-sonnet-4-6',
        display_name: '创作大师',
        quota_type: 0,
        model_ratio: 4.14,
        completion_ratio: 5,
      },
    ],
  }

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

    if (url.includes('/api/status')) {
      return Response.json(statusPayload)
    }
    if (url.includes('/api/pricing')) {
      return Response.json(pricingPayload)
    }

    throw new Error(`Unexpected fetch URL: ${url}`)
  }) as typeof globalThis.fetch
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

describe('xiaomu remote model management', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaomu-models-test-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    originalFetch = globalThis.fetch
    resetXiaomuModelCatalogCache()
    installAiapiMock()
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    resetXiaomuModelCatalogCache()

    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('GET /api/models honors remote ordering and provider metadata', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/models')
    const res = await handleModelsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.provider.name).toBe('远程模型中心')
    expect(body.meta.remoteManaged).toBe(true)
    expect(body.models.map((model: { id: string }) => model.id)).toEqual([
      'gemini-3.1-pro-preview',
      'gpt-5.4',
    ])
  })

  test('GET /api/models keeps gpt-5.5 visible when remote whitelist omits it', async () => {
    resetXiaomuModelCatalogCache()
    installAiapiMock({
      desktop_models_config: '',
      desktop_visible_models: 'gpt-5.4,gemini-3.1-pro-preview',
    })

    const { req, url, segments } = makeRequest('GET', '/api/models')
    const res = await handleModelsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.models.map((model: { id: string }) => model.id)).toContain('gpt-5.5')
  })

  test('GET /api/models/current falls back to remote default and syncs routing env', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ model: 'claude-sonnet-4-6' }),
      'utf-8',
    )

    const { req, url, segments } = makeRequest('GET', '/api/models/current')
    const res = await handleModelsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.model.id).toBe('gemini-3.1-pro-preview')

    const topSettings = await readJson(path.join(tmpDir, 'settings.json'))
    const ccHahaSettings = await readJson(path.join(tmpDir, 'cc-haha', 'settings.json'))
    const topEnv = topSettings.env as Record<string, string>
    const ccEnv = ccHahaSettings.env as Record<string, string>

    expect(topSettings.model).toBeUndefined()
    expect(topEnv.ANTHROPIC_MODEL).toBe('gemini-3.1-pro-preview')
    expect(topEnv.ANTHROPIC_SMALL_FAST_MODEL).toBe('gpt-5.4')
    expect(topEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.4')
    expect(ccEnv.ANTHROPIC_MODEL).toBe('gemini-3.1-pro-preview')
    expect(ccEnv.ANTHROPIC_SMALL_FAST_MODEL).toBe('gpt-5.4')
  })

  test('PUT /api/models/current persists the selected model and routing env', async () => {
    const { req, url, segments } = makeRequest('PUT', '/api/models/current', {
      modelId: 'gpt-5.4',
    })
    const res = await handleModelsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.model).toBe('gpt-5.4')

    const topSettings = await readJson(path.join(tmpDir, 'settings.json'))
    const ccHahaSettings = await readJson(path.join(tmpDir, 'cc-haha', 'settings.json'))
    const topEnv = topSettings.env as Record<string, string>
    const ccEnv = ccHahaSettings.env as Record<string, string>

    expect(topSettings.model).toBe('gpt-5.4')
    expect(topEnv.ANTHROPIC_MODEL).toBe('gpt-5.4')
    expect(topEnv.ANTHROPIC_SMALL_FAST_MODEL).toBe('gpt-5.4')
    expect(ccEnv.ANTHROPIC_MODEL).toBe('gpt-5.4')
    expect(ccEnv.ANTHROPIC_SMALL_FAST_MODEL).toBe('gpt-5.4')
  })
})

describe('provider model routing sync', () => {
  let providerTmpDir: string
  let providerOriginalConfigDir: string | undefined

  beforeEach(async () => {
    providerTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-routing-test-'))
    providerOriginalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = providerTmpDir
  })

  afterEach(async () => {
    if (providerOriginalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = providerOriginalConfigDir

    await fs.rm(providerTmpDir, { recursive: true, force: true })
  })

  test('active providers persist small-fast routing alongside the selected models', async () => {
    const service = new ProviderService()
    const provider = await service.addProvider({
      presetId: 'custom',
      name: '自定义供应商',
      apiKey: 'sk-provider-test',
      baseUrl: 'https://api.example.com',
      apiFormat: 'anthropic',
      models: {
        main: 'gpt-5.4',
        haiku: 'gpt-5.4-mini',
        sonnet: 'gpt-5.4',
        opus: 'gpt-5.5',
      },
    })

    await service.activateProvider(provider.id)

    const settings = await readJson(path.join(providerTmpDir, 'cc-haha', 'settings.json'))
    const env = settings.env as Record<string, string>

    expect(env.ANTHROPIC_MODEL).toBe('gpt-5.4')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.4-mini')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.4')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-5.5')
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('gpt-5.4-mini')
  })
})
