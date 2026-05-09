/**
 * Adapter 配置加载
 *
 * 优先级：环境变量 > ~/.claude/adapters.json > 默认值
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type PairedUser = {
  userId: string | number
  displayName: string
  pairedAt: number
}

export type PairingState = {
  code: string | null
  expiresAt: number | null
  createdAt: number | null
}

export type TelegramConfig = {
  botToken: string
  allowedUsers: number[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
}

export type FeishuConfig = {
  appId: string
  appSecret: string
  domain: string
  encryptKey: string
  verificationToken: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  streamingCard: boolean
}

export type WechatConfig = {
  accountId: string
  botToken: string
  baseUrl: string
  userId: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
}

export type DingtalkConfig = {
  clientId: string
  clientSecret: string
  allowedUsers: string[]
  pairedUsers: PairedUser[]
  defaultWorkDir: string
  endpoint: string
  permissionCardTemplateId: string
}

export type AdapterConfig = {
  serverUrl: string
  defaultProjectDir: string
  pairing: PairingState
  telegram: TelegramConfig
  feishu: FeishuConfig
  wechat: WechatConfig
  dingtalk: DingtalkConfig
}

export type AdapterPlatformConfig =
  | TelegramConfig
  | FeishuConfig
  | WechatConfig
  | DingtalkConfig

function getConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'adapters.json')
}

function loadFile(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.warn(`[Config] Failed to parse ${getConfigPath()}, using defaults`)
    }
    return {}
  }
}

export function loadConfig(): AdapterConfig {
  const file = loadFile()
  const tg = file.telegram ?? {}
  const fs_ = file.feishu ?? {}
  const wc = file.wechat ?? {}
  const dt = file.dingtalk ?? {}
  const pairing = file.pairing ?? {}
  const fallbackWorkDir = resolveUserDefaultWorkDir()

  return {
    serverUrl: process.env.ADAPTER_SERVER_URL || file.serverUrl || 'ws://127.0.0.1:3456',
    defaultProjectDir: file.defaultProjectDir || '',
    pairing: {
      code: pairing.code ?? null,
      expiresAt: pairing.expiresAt ?? null,
      createdAt: pairing.createdAt ?? null,
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || tg.botToken || '',
      allowedUsers: tg.allowedUsers ?? [],
      pairedUsers: tg.pairedUsers ?? [],
      defaultWorkDir: tg.defaultWorkDir || fallbackWorkDir,
    },
    feishu: {
      appId: process.env.FEISHU_APP_ID || fs_.appId || '',
      appSecret: process.env.FEISHU_APP_SECRET || fs_.appSecret || '',
      domain: process.env.FEISHU_DOMAIN || fs_.domain || 'feishu',
      encryptKey: process.env.FEISHU_ENCRYPT_KEY || fs_.encryptKey || '',
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || fs_.verificationToken || '',
      allowedUsers: fs_.allowedUsers ?? [],
      pairedUsers: fs_.pairedUsers ?? [],
      defaultWorkDir: fs_.defaultWorkDir || fallbackWorkDir,
      streamingCard: fs_.streamingCard ?? false,
    },
    wechat: {
      accountId: process.env.WECHAT_ACCOUNT_ID || wc.accountId || '',
      botToken: process.env.WECHAT_BOT_TOKEN || wc.botToken || '',
      baseUrl: process.env.WECHAT_BASE_URL || wc.baseUrl || 'https://ilinkai.weixin.qq.com',
      userId: process.env.WECHAT_USER_ID || wc.userId || '',
      allowedUsers: wc.allowedUsers ?? [],
      pairedUsers: wc.pairedUsers ?? [],
      defaultWorkDir: wc.defaultWorkDir || fallbackWorkDir,
    },
    dingtalk: {
      clientId: process.env.DINGTALK_CLIENT_ID || dt.clientId || '',
      clientSecret: process.env.DINGTALK_CLIENT_SECRET || dt.clientSecret || '',
      allowedUsers: dt.allowedUsers ?? [],
      pairedUsers: dt.pairedUsers ?? [],
      defaultWorkDir: dt.defaultWorkDir || fallbackWorkDir,
      endpoint: process.env.DINGTALK_STREAM_ENDPOINT || dt.endpoint || 'https://api.dingtalk.com',
      permissionCardTemplateId: process.env.DINGTALK_PERMISSION_CARD_TEMPLATE_ID || dt.permissionCardTemplateId || '',
    },
  }
}

export function getConfiguredWorkDir(config: AdapterConfig, platformConfig: AdapterPlatformConfig): string {
  return config.defaultProjectDir || platformConfig.defaultWorkDir
}

function resolveUserDefaultWorkDir(): string {
  const candidates = [
    process.env.ADAPTER_DEFAULT_PROJECT_DIR,
    process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR,
    process.env.PWD,
    process.cwd(),
    os.homedir(),
  ]

  for (const candidate of candidates) {
    const resolved = resolveExistingDirectory(candidate)
    if (resolved) return resolved
  }

  return os.homedir()
}

function resolveExistingDirectory(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  const expanded = trimmed === '~'
    ? os.homedir()
    : trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed

  try {
    const realPath = fs.realpathSync(expanded)
    return fs.statSync(realPath).isDirectory() ? realPath : null
  } catch {
    return null
  }
}
