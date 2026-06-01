import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { handleProvidersApi } from '../api/providers.js'
import { PROVIDER_PRESETS } from '../config/providerPresets.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-presets-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

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

describe('provider presets API', () => {
  test('GET /api/providers/presets returns the configured presets', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/providers/presets')
    const response = await handleProvidersApi(req, url, segments)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ presets: PROVIDER_PRESETS })
  })

  test('configured presets include built-in official and custom entries', () => {
    expect(PROVIDER_PRESETS.some((preset) => preset.id === 'official')).toBe(true)
    expect(PROVIDER_PRESETS.some((preset) => preset.id === 'custom')).toBe(true)
  })

  test('local Anthropic-compatible presets appear immediately before custom', () => {
    expect(PROVIDER_PRESETS.at(-3)?.id).toBe('lmstudio')
    expect(PROVIDER_PRESETS.at(-2)?.id).toBe('ollama')
    expect(PROVIDER_PRESETS.at(-1)?.id).toBe('custom')
  })

  test('configured presets keep current default model ids aligned with official provider docs', () => {
    const lmstudio = PROVIDER_PRESETS.find((preset) => preset.id === 'lmstudio')
    const ollama = PROVIDER_PRESETS.find((preset) => preset.id === 'ollama')
    const deepseek = PROVIDER_PRESETS.find((preset) => preset.id === 'deepseek')
    const zhipu = PROVIDER_PRESETS.find((preset) => preset.id === 'zhipuglm')
    const kimi = PROVIDER_PRESETS.find((preset) => preset.id === 'kimi')
    const minimax = PROVIDER_PRESETS.find((preset) => preset.id === 'minimax')
    const jiekouai = PROVIDER_PRESETS.find((preset) => preset.id === 'jiekouai')
    const shengsuanyun = PROVIDER_PRESETS.find((preset) => preset.id === 'shengsuanyun')

    expect(lmstudio?.baseUrl).toBe('http://localhost:1234')
    expect(lmstudio?.apiFormat).toBe('anthropic')
    expect(lmstudio?.authStrategy).toBe('auth_token_empty_api_key')
    expect(lmstudio?.defaultModels.main).toBe('qwen/qwen3.6-27b')
    expect(ollama?.baseUrl).toBe('http://localhost:11434')
    expect(ollama?.apiFormat).toBe('anthropic')
    expect(ollama?.authStrategy).toBe('auth_token_empty_api_key')
    expect(ollama?.defaultModels.main).toBe('qwen3.6:27b')
    expect(deepseek?.authStrategy).toBe('auth_token')
    expect(deepseek?.defaultModels.main).toBe('deepseek-v4-pro')
    expect(deepseek?.defaultModels.haiku).toBe('deepseek-v4-flash')
    expect(deepseek?.defaultModels.sonnet).toBe('deepseek-v4-pro')
    expect(deepseek?.defaultModels.opus).toBe('deepseek-v4-pro')
    expect(deepseek?.defaultEnv?.CC_HAHA_SEND_DISABLED_THINKING).toBeUndefined()
    expect(deepseek?.defaultEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe(
      'thinking,effort,adaptive_thinking,max_effort',
    )
    expect(zhipu?.authStrategy).toBe('auth_token')
    expect(zhipu?.defaultModels.main).toBe('glm-5.1')
    expect(zhipu?.defaultModels.haiku).toBe('glm-4.5-air')
    expect(zhipu?.defaultModels.sonnet).toBe('glm-5-turbo')
    expect(zhipu?.defaultModels.opus).toBe('glm-5.1')
    expect(kimi?.baseUrl).toBe('https://api.kimi.com/coding')
    expect(kimi?.authStrategy).toBe('auth_token')
    expect(kimi?.defaultModels.main).toBe('kimi-k2.6')
    expect(kimi?.defaultEnv?.CC_HAHA_SEND_DISABLED_THINKING).toBe('1')
    expect(minimax?.authStrategy).toBe('auth_token')
    expect(minimax?.defaultModels.main).toBe('MiniMax-M3')
    expect(minimax?.modelContextWindows?.['MiniMax-M3']).toBe(204800)
    expect(jiekouai?.baseUrl).toBe('https://api.jiekou.ai/anthropic')
    expect(jiekouai?.authStrategy).toBe('auth_token')
    expect(jiekouai?.defaultModels.main).toBe('claude-sonnet-4-6')
    expect(jiekouai?.defaultModels.opus).toBe('claude-opus-4-7')
    expect(jiekouai?.defaultEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe('none')
    expect(jiekouai?.modelContextWindows?.['claude-sonnet-4-6']).toBe(1000000)
    expect(shengsuanyun?.baseUrl).toBe('https://router.shengsuanyun.com/api')
    expect(shengsuanyun?.authStrategy).toBe('auth_token')
    expect(shengsuanyun?.defaultModels.main).toBe('anthropic/claude-sonnet-4.6')
    expect(shengsuanyun?.defaultModels.haiku).toBe('anthropic/claude-haiku-4.5:thinking')
    expect(shengsuanyun?.modelContextWindows?.['anthropic/claude-sonnet-4.6']).toBe(1000000)
  })

  test('configured presets can expose optional API key and promo metadata', () => {
    const lmstudio = PROVIDER_PRESETS.find((preset) => preset.id === 'lmstudio')
    const ollama = PROVIDER_PRESETS.find((preset) => preset.id === 'ollama')
    const deepseek = PROVIDER_PRESETS.find((preset) => preset.id === 'deepseek')
    const zhipu = PROVIDER_PRESETS.find((preset) => preset.id === 'zhipuglm')
    const kimi = PROVIDER_PRESETS.find((preset) => preset.id === 'kimi')
    const minimax = PROVIDER_PRESETS.find((preset) => preset.id === 'minimax')
    const jiekouai = PROVIDER_PRESETS.find((preset) => preset.id === 'jiekouai')
    const shengsuanyun = PROVIDER_PRESETS.find((preset) => preset.id === 'shengsuanyun')
    const custom = PROVIDER_PRESETS.find((preset) => preset.id === 'custom')

    expect(lmstudio?.needsApiKey).toBe(false)
    expect(lmstudio?.promoText).toContain('http://localhost:1234')
    expect(lmstudio?.promoText).toContain('200K')
    expect(lmstudio?.defaultEnv).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'lmstudio',
    })
    expect(ollama?.needsApiKey).toBe(false)
    expect(ollama?.promoText).toContain('http://localhost:11434')
    expect(ollama?.promoText).toContain('200K')
    expect(ollama?.defaultEnv).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'ollama',
    })
    expect(deepseek?.apiKeyUrl).toBe('https://platform.deepseek.com/api_keys')
    expect(deepseek?.modelContextWindows?.['deepseek-v4-pro']).toBe(1000000)
    expect(deepseek?.modelContextWindows?.['deepseek-v4-flash']).toBe(1000000)
    expect(zhipu?.apiKeyUrl).toBe('https://www.bigmodel.cn/invite?icode=d41B2qi8Z5xNwTGLNPPF3OZLO2QH3C0EBTSr%2BArzMw4%3D')
    expect(zhipu?.promoText).toContain('cc-haha')
    expect(zhipu?.defaultEnv?.CC_HAHA_SEND_DISABLED_THINKING).toBe('1')
    expect(zhipu?.modelContextWindows?.['glm-5.1']).toBe(200000)
    expect(zhipu?.modelContextWindows?.['glm-4.5-air']).toBe(128000)
    expect(kimi?.apiKeyUrl).toBe('https://platform.kimi.com/console/api-keys')
    expect(kimi?.modelContextWindows?.['kimi-k2.6']).toBe(262144)
    expect(minimax?.apiKeyUrl).toBe('https://platform.minimaxi.com/subscribe/token-plan?code=1TG2Cseab2&source=link')
    expect(jiekouai?.apiKeyUrl).toBe('https://jiekou.ai/referral?invited_code=OBNU3K')
    expect(jiekouai?.promoText).toContain('官方 8 折')
    expect(jiekouai?.featured).toBe(true)
    expect(shengsuanyun?.apiKeyUrl).toBe('https://www.shengsuanyun.com/?from=CH_LEJ88KWR')
    expect(shengsuanyun?.promoText).toContain('首充 10%')
    expect(shengsuanyun?.featured).toBe(true)
    expect(shengsuanyun?.defaultEnv).toEqual({
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: 'none',
    })
    expect(shengsuanyun?.modelContextWindows?.['anthropic/claude-opus-4.7']).toBe(1000000)
    expect(custom?.promoText).toBeUndefined()
    expect(custom?.authStrategy).toBe('auth_token')
    expect(custom?.defaultEnv).toBeUndefined()
  })

  test('GET and PUT /api/providers/settings read and write cc-haha settings.json', async () => {
    const initial = {
      env: {
        ANTHROPIC_MODEL: 'glm-5.1',
      },
      model: 'glm-5.1',
    }
    await fs.mkdir(path.join(tmpDir, 'cc-haha'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'cc-haha', 'settings.json'),
      JSON.stringify(initial, null, 2),
      'utf-8',
    )

    const getReq = makeRequest('GET', '/api/providers/settings')
    const getRes = await handleProvidersApi(getReq.req, getReq.url, getReq.segments)
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual(initial)

    const updateBody = {
      model: 'kimi-k2.6',
      env: {
        ANTHROPIC_MODEL: 'kimi-k2.6',
      },
    }
    const putReq = makeRequest('PUT', '/api/providers/settings', updateBody)
    const putRes = await handleProvidersApi(putReq.req, putReq.url, putReq.segments)
    expect(putRes.status).toBe(200)

    const updatedRaw = await fs.readFile(path.join(tmpDir, 'cc-haha', 'settings.json'), 'utf-8')
    expect(JSON.parse(updatedRaw)).toEqual(updateBody)
  })

  test('provider presets carry docs-backed context windows for current coding models', () => {
    const byId = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]))

    for (const id of ['deepseek', 'zhipuglm', 'kimi', 'minimax']) {
      const preset = byId.get(id)!
      expect(preset.modelContextWindows?.[preset.defaultModels.main]).toBeGreaterThan(0)
    }
  })
})
