import { api } from './client'
import type { AdapterFileConfig } from '../types/adapter'

export type DingtalkRegistrationBegin = {
  deviceCode: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete: string
  expiresInSeconds: number
  intervalSeconds: number
  qrDataUrl?: string
}

export type DingtalkRegistrationPoll = {
  status: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED' | 'UNKNOWN'
  failReason?: string
  config?: AdapterFileConfig
}

export type FeishuSetupBegin = {
  deviceCode: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete: string
  expiresInSeconds: number
  intervalSeconds: number
  qrDataUrl?: string
}

export type FeishuSetupPoll = {
  status: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED' | 'UNKNOWN'
  domain?: string
  openId?: string
  failReason?: string
  config?: AdapterFileConfig
}

export const adaptersApi = {
  getConfig() {
    return api.get<AdapterFileConfig>('/api/adapters')
  },

  updateConfig(patch: Partial<AdapterFileConfig>) {
    return api.put<AdapterFileConfig>('/api/adapters', patch)
  },

  startWechatLogin() {
    return api.post<{ qrcodeUrl?: string; message: string; sessionKey: string }>('/api/adapters/wechat/login/start', {})
  },

  pollWechatLogin(sessionKey: string) {
    return api.post<
      | AdapterFileConfig
      | { connected: false; status: string; message: string }
    >('/api/adapters/wechat/login/poll', { sessionKey }, { timeout: 45_000 })
  },

  unbindWechat() {
    return api.post<AdapterFileConfig>('/api/adapters/wechat/unbind', {})
  },

  unbindDingtalk() {
    return api.post<AdapterFileConfig>('/api/adapters/dingtalk/unbind', {})
  },

  beginDingtalkRegistration() {
    return api.post<DingtalkRegistrationBegin>('/api/adapters/dingtalk/registration/begin', {})
  },

  pollDingtalkRegistration(deviceCode: string) {
    return api.post<DingtalkRegistrationPoll>('/api/adapters/dingtalk/registration/poll', { deviceCode })
  },

  beginFeishuSetup(domain = 'feishu') {
    return api.post<FeishuSetupBegin>('/api/adapters/feishu/setup/begin', { domain })
  },

  pollFeishuSetup(deviceCode: string, domain = 'feishu') {
    return api.post<FeishuSetupPoll>('/api/adapters/feishu/setup/poll', { deviceCode, domain })
  },

  unbindFeishu() {
    return api.post<AdapterFileConfig>('/api/adapters/feishu/unbind', {})
  },
}
