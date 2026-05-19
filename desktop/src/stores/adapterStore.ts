import { create } from 'zustand'
import { adaptersApi } from '../api/adapters'
import type { AdapterFileConfig } from '../types/adapter'
import type { DingtalkRegistrationBegin, DingtalkRegistrationPoll } from '../api/adapters'
import { tauriInvoke, TauriUnavailableError } from '../lib/tauriBridge'

/**
 * Tauri command 触发器：让主进程 kill + respawn adapter sidecar，
 * 让 ~/.claude/adapters.json 里的最新凭据被新进程读到，建立飞书 / Telegram / 微信 / 钉钉
 * 的 WebSocket 连接。
 *
 * 在非 Tauri 环境（web target / 单元测试）这会安静失败 —— 那种场景下
 * 本来也没有 sidecar 可重启。
 */
async function notifyTauriRestartAdapters(): Promise<void> {
  try {
    await tauriInvoke('restart_adapters_sidecar')
  } catch (err) {
    if (err instanceof TauriUnavailableError) return // expected in web target
    // 不阻塞保存流程 —— 配置文件已经写入，下次启动 App 也会生效
    if (typeof console !== 'undefined') {
      console.warn('[adapterStore] restart_adapters_sidecar failed:', err)
    }
  }
}

const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
const CODE_TTL_MS = 60 * 60 * 1000 // 60 minutes

function generateCode(): string {
  const maxValid = Math.floor(256 / SAFE_ALPHABET.length) * SAFE_ALPHABET.length
  let code = ''
  while (code.length < CODE_LENGTH) {
    const array = new Uint8Array(1)
    crypto.getRandomValues(array)
    if (array[0]! < maxValid) {
      code += SAFE_ALPHABET[array[0]! % SAFE_ALPHABET.length]
    }
  }
  return code
}

type AdapterStore = {
  config: AdapterFileConfig
  isLoading: boolean
  error: string | null

  fetchConfig: () => Promise<void>
  updateConfig: (patch: Partial<AdapterFileConfig>) => Promise<void>
  generatePairingCode: () => Promise<string>
  startWechatLogin: () => Promise<{ qrcodeUrl?: string; message: string; sessionKey: string }>
  pollWechatLogin: (sessionKey: string) => Promise<{ connected: boolean; status?: string; message?: string }>
  removePairedUser: (platform: 'telegram' | 'feishu' | 'wechat' | 'dingtalk', userId: string | number) => Promise<void>
  beginDingtalkRegistration: () => Promise<DingtalkRegistrationBegin>
  pollDingtalkRegistration: (deviceCode: string) => Promise<DingtalkRegistrationPoll>
  unbindWechatAccount: () => Promise<void>
  unbindDingtalkBot: () => Promise<void>
}

export const useAdapterStore = create<AdapterStore>((set, get) => ({
  config: {},
  isLoading: false,
  error: null,

  fetchConfig: async () => {
    set({ isLoading: true, error: null })
    try {
      const config = await adaptersApi.getConfig()
      set({ config, isLoading: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load config'
      set({ isLoading: false, error: message })
    }
  },

  updateConfig: async (patch) => {
    const config = await adaptersApi.updateConfig(patch)
    set({ config })
    // 配置文件已写入磁盘，让 Tauri 主进程 kill + respawn adapter sidecar，
    // 触发飞书 / Telegram WebSocket 用新凭据重连。pairing code / paired users
    // 这种轻量更新也会触发重启 —— 这是个有意为之的简化：保证"任何配置变更
    // 都立刻生效"，比起精细判断哪些字段值得重启更可靠。
    void notifyTauriRestartAdapters()
  },

  generatePairingCode: async () => {
    const code = generateCode()
    const now = Date.now()
    await get().updateConfig({
      pairing: {
        code,
        expiresAt: now + CODE_TTL_MS,
        createdAt: now,
      },
    })
    return code
  },

  startWechatLogin: async () => {
    return adaptersApi.startWechatLogin()
  },

  pollWechatLogin: async (sessionKey) => {
    const result = await adaptersApi.pollWechatLogin(sessionKey)
    if ('connected' in result && result.connected === false) {
      return { connected: false, status: result.status, message: result.message }
    }
    if ('wechat' in result || 'telegram' in result || 'feishu' in result || 'dingtalk' in result) {
      set({ config: result })
      void notifyTauriRestartAdapters()
      return { connected: true }
    }
    return { connected: false }
  },

  beginDingtalkRegistration: () => adaptersApi.beginDingtalkRegistration(),

  pollDingtalkRegistration: async (deviceCode) => {
    const result = await adaptersApi.pollDingtalkRegistration(deviceCode)
    if (result.config) {
      set({ config: result.config })
      void notifyTauriRestartAdapters()
    }
    return result
  },

  unbindWechatAccount: async () => {
    const config = await adaptersApi.unbindWechat()
    set({ config })
    void notifyTauriRestartAdapters()
  },

  unbindDingtalkBot: async () => {
    const config = await adaptersApi.unbindDingtalk()
    set({ config })
    void notifyTauriRestartAdapters()
  },

  removePairedUser: async (platform, userId) => {
    const { config } = get()
    const platformConfig = config[platform]
    if (!platformConfig) return

    const pairedUsers = (platformConfig.pairedUsers ?? []).filter(
      (u) => String(u.userId) !== String(userId),
    )

    await get().updateConfig({
      [platform]: { ...platformConfig, pairedUsers },
    })
  },
}))
