import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleAdaptersApi } from '../api/adapters.js'

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-adapters-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
}

function makeRequest(method: string, pathName: string, body?: Record<string, unknown>) {
  const url = new URL(pathName, 'http://localhost:3456')
  const req = new Request(url.toString(), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

describe('Adapters API', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('masks WeChat bot tokens in GET responses', async () => {
    const put = makeRequest('PUT', '/api/adapters', {
      wechat: {
        accountId: 'bot-1',
        botToken: 'wechat-secret-token',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        userId: 'wx-user',
        pairedUsers: [{ userId: 'wx-user', displayName: 'WeChat User', pairedAt: 1 }],
      },
    })
    expect((await handleAdaptersApi(put.req, put.url, put.segments)).status).toBe(200)

    const get = makeRequest('GET', '/api/adapters')
    const res = await handleAdaptersApi(get.req, get.url, get.segments)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.wechat.botToken).toBe('****oken')
    expect(json.wechat.accountId).toBe('bot-1')
  })

  it('writes adapter credentials with owner-only permissions', async () => {
    const put = makeRequest('PUT', '/api/adapters', {
      telegram: {
        botToken: 'telegram-secret-token',
      },
    })
    expect((await handleAdaptersApi(put.req, put.url, put.segments)).status).toBe(200)

    const configPath = path.join(tmpDir, 'adapters.json')
    const stat = await fs.stat(configPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('masks and preserves DingTalk client secrets', async () => {
    const put = makeRequest('PUT', '/api/adapters', {
      dingtalk: {
        clientId: 'ding-client-1',
        clientSecret: 'dingtalk-client-secret',
        permissionCardTemplateId: 'permission-template',
        pairedUsers: [{ userId: 'ding-user', displayName: 'DingTalk User', pairedAt: 1 }],
      },
    })
    expect((await handleAdaptersApi(put.req, put.url, put.segments)).status).toBe(200)

    const get = makeRequest('GET', '/api/adapters')
    const res = await handleAdaptersApi(get.req, get.url, get.segments)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.dingtalk.clientSecret).toBe('****cret')
    expect(json.dingtalk.clientId).toBe('ding-client-1')
    expect(json.dingtalk.permissionCardTemplateId).toBe('permission-template')

    const maskedPut = makeRequest('PUT', '/api/adapters', {
      dingtalk: {
        clientSecret: json.dingtalk.clientSecret,
        allowedUsers: ['ding-user'],
      },
    })
    expect((await handleAdaptersApi(maskedPut.req, maskedPut.url, maskedPut.segments)).status).toBe(200)

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'adapters.json'), 'utf-8')) as any
    expect(raw.dingtalk.clientSecret).toBe('dingtalk-client-secret')
    expect(raw.dingtalk.allowedUsers).toEqual(['ding-user'])
    expect(raw.dingtalk.permissionCardTemplateId).toBe('permission-template')
  })

  it('clears WeChat credentials on unbind', async () => {
    const put = makeRequest('PUT', '/api/adapters', {
      wechat: {
        accountId: 'bot-1',
        botToken: 'wechat-secret-token',
        userId: 'wx-user',
        allowedUsers: ['wx-allowed-user'],
        pairedUsers: [{ userId: 'wx-user', displayName: 'WeChat User', pairedAt: 1 }],
      },
    })
    await handleAdaptersApi(put.req, put.url, put.segments)

    const unbind = makeRequest('POST', '/api/adapters/wechat/unbind')
    const res = await handleAdaptersApi(unbind.req, unbind.url, unbind.segments)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.wechat.botToken).toBeUndefined()
    expect(json.wechat.accountId).toBeUndefined()
    expect(json.wechat.userId).toBeUndefined()
    expect(json.wechat.allowedUsers).toEqual([])
    expect(json.wechat.pairedUsers).toEqual([])
  })

  it('clears DingTalk credentials on unbind', async () => {
    const put = makeRequest('PUT', '/api/adapters', {
      dingtalk: {
        clientId: 'ding-client-1',
        clientSecret: 'dingtalk-client-secret',
        allowedUsers: ['ding-allowed-user'],
        permissionCardTemplateId: 'permission-template',
        pairedUsers: [{ userId: 'ding-user', displayName: 'DingTalk User', pairedAt: 1 }],
      },
    })
    await handleAdaptersApi(put.req, put.url, put.segments)

    const unbind = makeRequest('POST', '/api/adapters/dingtalk/unbind')
    const res = await handleAdaptersApi(unbind.req, unbind.url, unbind.segments)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.dingtalk.clientId).toBeUndefined()
    expect(json.dingtalk.clientSecret).toBeUndefined()
    expect(json.dingtalk.allowedUsers).toEqual([])
    expect(json.dingtalk.permissionCardTemplateId).toBeUndefined()
    expect(json.dingtalk.pairedUsers).toEqual([])
  })

  it('clears Feishu credentials on unbind', async () => {
    const put = makeRequest('PUT', '/api/adapters', {
      feishu: {
        appId: 'cli_test',
        appSecret: 'secret_test',
        domain: 'feishu',
        encryptKey: 'enc_test',
        verificationToken: 'tok_test',
        allowedUsers: ['ou_allowed'],
        streamingCard: true,
        pairedUsers: [{ userId: 'ou_user', displayName: 'Feishu User', pairedAt: 1 }],
      },
    })
    await handleAdaptersApi(put.req, put.url, put.segments)

    const unbind = makeRequest('POST', '/api/adapters/feishu/unbind')
    const res = await handleAdaptersApi(unbind.req, unbind.url, unbind.segments)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.feishu.appId).toBeUndefined()
    expect(json.feishu.appSecret).toBeUndefined()
    expect(json.feishu.domain).toBeUndefined()
    expect(json.feishu.encryptKey).toBeUndefined()
    expect(json.feishu.verificationToken).toBeUndefined()
    expect(json.feishu.allowedUsers).toEqual([])
    expect(json.feishu.pairedUsers).toEqual([])
    expect(json.feishu.streamingCard).toBe(false)
  })

  it('begins Feishu QR registration and returns QR payload', async () => {
    // Mock the Feishu accounts endpoint
    const mockInit = {
      nonce: 'test_nonce',
      supported_auth_methods: ['client_secret'],
    }
    const mockBegin = {
      device_code: 'dc_test_feishu',
      verification_uri_complete: 'https://accounts.feishu.cn/scan/dc_test',
      user_code: 'XYZ-123',
      interval: 3,
      expire_in: 600,
    }
    let callCount = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: any, init?: any) => {
      callCount++
      const url = typeof input === 'string' ? input : input?.url || ''
      if (url.includes('accounts.feishu.cn')) {
        const body = init?.body as string || ''
        if (body.includes('action=init')) {
          return new Response(JSON.stringify(mockInit), { status: 200 })
        }
        if (body.includes('action=begin')) {
          return new Response(JSON.stringify(mockBegin), { status: 200 })
        }
      }
      return originalFetch(input, init)
    }

    try {
      const begin = makeRequest('POST', '/api/adapters/feishu/setup/begin', { domain: 'feishu' })
      const res = await handleAdaptersApi(begin.req, begin.url, begin.segments)
      expect(res.status).toBe(200)
      const json = await res.json() as any
      expect(json.deviceCode).toBe('dc_test_feishu')
      expect(json.verificationUriComplete).toContain('accounts.feishu.cn')
      expect(json.expiresInSeconds).toBe(600)
      expect(callCount).toBe(2) // init + begin
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
