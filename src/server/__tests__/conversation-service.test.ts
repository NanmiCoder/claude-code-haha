import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConversationService } from '../services/conversationService.js'
import { ProviderService } from '../services/providerService.js'

describe('ConversationService', () => {
  let tmpDir: string
  let originalConfigDir: string | undefined
  let originalApiKey: string | undefined
  let originalAuthToken: string | undefined
  let originalBaseUrl: string | undefined
  let originalModel: string | undefined
  let originalEntrypoint: string | undefined
  let originalOAuthToken: string | undefined
  let originalProviderManagedByHost: string | undefined
  let originalDiagnosticsFile: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-conversation-service-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalApiKey = process.env.ANTHROPIC_API_KEY
    originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
    originalBaseUrl = process.env.ANTHROPIC_BASE_URL
    originalModel = process.env.ANTHROPIC_MODEL
    originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
    originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    originalProviderManagedByHost = process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    originalDiagnosticsFile = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE

    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.ANTHROPIC_API_KEY = 'stale-parent-api-key'
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token'
    process.env.ANTHROPIC_BASE_URL = 'https://example.invalid/anthropic'
    process.env.ANTHROPIC_MODEL = 'test-model'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited-parent-oauth-token'
    // Clear inherited CLAUDE_CODE_ENTRYPOINT so tests can assert whether
    // buildChildEnv injects it or not without interference from the shell env.
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir

    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalApiKey

    if (originalAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken

    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl

    if (originalModel === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = originalModel

    if (originalEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT
    else process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint

    if (originalOAuthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken

    if (originalProviderManagedByHost === undefined) delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    else process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = originalProviderManagedByHost

    if (originalDiagnosticsFile === undefined) delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
    else process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = originalDiagnosticsFile

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('keeps inherited provider env when no desktop provider config exists', async () => {
    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('D:\\workspace\\code\\myself_code\\cc-haha')) as Record<string, string>

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('test-token')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.invalid/anthropic')
    expect(env.ANTHROPIC_MODEL).toBe('test-model')
    expect(env.CLAUDE_CODE_DIAGNOSTICS_FILE).toBe(path.join(tmpDir, 'cc-haha', 'diagnostics', 'cli-diagnostics.jsonl'))
    expect(env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE).toBe(
      `${path.join(tmpDir, 'projects', 'D--workspace-code-myself-code-cc-haha', 'memory')}${path.sep}`,
    )
    await expect(fs.stat(path.dirname(env.CLAUDE_CODE_DIAGNOSTICS_FILE))).resolves.toBeTruthy()
  })

  test('buildChildEnv pins desktop memory to the current sanitized project directory', async () => {
    const service = new ConversationService() as any
    const workDir = path.join(tmpDir, 'workspace', 'myself_code', 'claude-code-haha')
    await fs.mkdir(workDir, { recursive: true })

    const env = (await service.buildChildEnv(workDir)) as Record<string, string>

    expect(env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE).toBe(
      `${path.join(tmpDir, 'projects', sanitizeMemoryPath(workDir), 'memory')}${path.sep}`,
    )
    expect(env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE).toContain('myself-code')
    expect(env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE).not.toContain('myself_code')
  })

  test('strips inherited provider env when desktop provider config exists', async () => {
    const ccHahaDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'providers.json'),
      JSON.stringify({ activeId: null, providers: [] }),
      'utf-8',
    )

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('D:\\workspace\\code\\myself_code\\cc-haha')) as Record<string, string>

    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
  })

  test('buildChildEnv injects CLAUDE_CODE_OAUTH_TOKEN when official mode + haha oauth token exists', async () => {
    const ccHahaDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'settings.json'),
      JSON.stringify({ env: {} }),
      'utf-8',
    )

    const { hahaOAuthService } = await import('../services/hahaOAuthService.js')
    await hahaOAuthService.saveTokens({
      accessToken: 'haha-fresh-token',
      refreshToken: 'haha-refresh-xxx',
      expiresAt: Date.now() + 30 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp')) as Record<string, string>

    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-desktop')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('haha-fresh-token')
  })

  test('buildChildEnv does NOT inject CLAUDE_CODE_OAUTH_TOKEN when not official mode', async () => {
    const ccHahaDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'custom-provider-token' } }),
      'utf-8',
    )

    const { hahaOAuthService } = await import('../services/hahaOAuthService.js')
    await hahaOAuthService.saveTokens({
      accessToken: 'haha-token-should-not-be-used',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
      subscriptionType: null,
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp')) as Record<string, string>

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
  })

  test('buildChildEnv injects explicit provider runtime env for session-scoped providers', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'custom',
      name: 'Packy',
      apiKey: 'provider-key',
      baseUrl: 'https://api.packy.example',
      apiFormat: 'openai_chat',
      models: {
        main: 'kimi-k2.6',
        haiku: '',
        sonnet: '',
        opus: '',
      },
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp', undefined, {
      providerId: provider.id,
    })) as Record<string, string>

    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:3456/proxy/providers/${provider.id}`)
    expect(env.ANTHROPIC_API_KEY).toBe('proxy-managed')
    expect(env.ANTHROPIC_MODEL).toBe('kimi-k2.6')
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1')
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
  })

  test('buildChildEnv uses the session-selected model for session-scoped providers', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'custom',
      name: 'Switchable',
      apiKey: 'provider-key',
      baseUrl: 'https://api.switchable.example',
      apiFormat: 'openai_chat',
      models: {
        main: 'old-provider-main',
        haiku: 'new-provider-haiku',
        sonnet: 'new-provider-sonnet',
        opus: 'new-provider-opus',
      },
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp', undefined, {
      providerId: provider.id,
      model: 'new-provider-sonnet',
    })) as Record<string, string>

    expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:3456/proxy/providers/${provider.id}`)
    expect(env.ANTHROPIC_MODEL).toBe('new-provider-sonnet')
  })

  test('buildChildEnv clears stale api key for bearer-token providers', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'jiekouai',
      name: 'Jiekou',
      apiKey: 'provider-key',
      baseUrl: 'https://api.jiekou.ai/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'claude-sonnet-4-6',
        haiku: 'claude-haiku-4-5-20251001',
        sonnet: 'claude-sonnet-4-6',
        opus: 'claude-opus-4-7',
      },
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp', undefined, {
      providerId: provider.id,
      model: 'claude-sonnet-4-6',
    })) as Record<string, string>

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.jiekou.ai/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('provider-key')
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES).toBe('none')
  })

  test('buildChildEnv can force official auth even when a custom default provider exists', async () => {
    const ccHahaDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'custom-provider-token' } }),
      'utf-8',
    )

    const { hahaOAuthService } = await import('../services/hahaOAuthService.js')
    await hahaOAuthService.saveTokens({
      accessToken: 'forced-official-token',
      refreshToken: 'forced-official-refresh',
      expiresAt: Date.now() + 30 * 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    })

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp', undefined, {
      providerId: null,
    })) as Record<string, string>

    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-desktop')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('forced-official-token')
  })

  test('buildChildEnv does not leak inherited CLAUDE_CODE_OAUTH_TOKEN when official token is unavailable', async () => {
    const ccHahaDir = path.join(tmpDir, 'cc-haha')
    await fs.mkdir(ccHahaDir, { recursive: true })
    await fs.writeFile(
      path.join(ccHahaDir, 'settings.json'),
      JSON.stringify({ env: {} }),
      'utf-8',
    )

    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp')) as Record<string, string>

    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-desktop')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test('buildChildEnv injects desktop Computer Use host bundle id for sdk sessions', async () => {
    const service = new ConversationService() as any
    const env = (await service.buildChildEnv(
      '/tmp',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
    )) as Record<string, string>

    expect(env.CC_HAHA_COMPUTER_USE_HOST_BUNDLE_ID).toBe(
      'com.claude-code-haha.desktop',
    )
    expect(env.CC_HAHA_DESKTOP_SERVER_URL).toBe('http://127.0.0.1:3456')
    expect(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('1')
    expect(env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBe('1')
  })

  test('buildChildEnv does not force interrupted-turn resume for non-SDK sessions', async () => {
    const service = new ConversationService() as any
    const env = (await service.buildChildEnv('/tmp')) as Record<string, string>

    expect(env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN).toBeUndefined()
  })

  test('uses bun entrypoint fallback on Windows dev mode', () => {
    const service = new ConversationService() as any
    const args = service.resolveCliArgs(['--print'])

    if (process.platform === 'win32') {
      expect(args[0]).toBe(process.execPath)
      expect(args[1]).toBe('--preload')
      expect(args[2]).toContain('preload.ts')
      expect(args[3]).toContain(path.join('src', 'entrypoints', 'cli.tsx'))
    } else {
      expect(args[0]).toContain(path.join('bin', 'claude-haha'))
    }
  })

  test('buildSessionCliArgs enables partial assistant messages for desktop streaming', () => {
    const service = new ConversationService() as any
    const args = service.buildSessionCliArgs(
      '123e4567-e89b-12d3-a456-426614174000',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
      false,
      { permissionMode: 'bypassPermissions' },
    ) as string[]

    expect(args).toContain('--include-partial-messages')
    expect(args).toContain('--sdk-url')
    expect(args).toContain('--replay-user-messages')
  })

  test('buildChildEnv asks desktop SDK sessions to wait briefly for MCP tools', async () => {
    const service = new ConversationService() as any
    const env = (await service.buildChildEnv(
      '/tmp',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
    )) as Record<string, string>

    expect(env.CC_HAHA_DESKTOP_AWAIT_MCP).toBe('1')
    expect(env.CC_HAHA_DESKTOP_AWAIT_MCP_TIMEOUT_MS).toBe('5000')
  })

  test('buildSessionCliArgs forwards the selected runtime model and effort to the CLI process', () => {
    const service = new ConversationService() as any
    const args = service.buildSessionCliArgs(
      '123e4567-e89b-12d3-a456-426614174000',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
      false,
      {
        model: 'model-b-opus',
        effort: 'max',
      },
    ) as string[]

    expect(args).toContain('--model')
    expect(args).toContain('model-b-opus')
    expect(args).toContain('--effort')
    expect(args).toContain('max')
  })

  test('buildSessionCliArgs starts pending desktop worktrees through the native CLI flag', () => {
    const service = new ConversationService() as any
    const args = service.buildSessionCliArgs(
      '123e4567-e89b-12d3-a456-426614174000',
      'ws://127.0.0.1:3456/sdk/test-session?token=test-token',
      false,
      undefined,
      {
        requestedWorkDir: '/tmp/source-repo',
        repoRoot: '/tmp/source-repo',
        branch: 'feature/rail',
        worktree: true,
        baseRef: 'feature/rail',
        worktreeSlug: 'desktop-feature-rail-123e4567',
      },
    ) as string[]

    expect(args).toContain('--worktree')
    expect(args).toContain('desktop-feature-rail-123e4567')
    expect(args).toContain('--worktree-base-ref')
    expect(args).toContain('feature/rail')
  })
})

function sanitizeMemoryPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '-')
}
