// Provider presets inspired by cc-switch (https://github.com/farion1231/cc-switch)
// Original work by Jason Young, MIT License

import type { ApiFormat } from '../types/provider'

export type ModelMapping = {
  main: string
  haiku: string
  sonnet: string
  opus: string
}

export type ProviderPreset = {
  id: string
  name: string
  baseUrl: string
  apiFormat: ApiFormat
  defaultModels: ModelMapping
  needsApiKey: boolean
  websiteUrl: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'official',
    name: 'Claude Official',
    baseUrl: '',
    apiFormat: 'anthropic',
    defaultModels: { main: '', haiku: '', sonnet: '', opus: '' },
    needsApiKey: false,
    websiteUrl: 'https://www.anthropic.com/claude-code',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    apiFormat: 'anthropic',
    defaultModels: { main: 'DeepSeek-V3.2', haiku: 'DeepSeek-V3.2', sonnet: 'DeepSeek-V3.2', opus: 'DeepSeek-V3.2' },
    needsApiKey: true,
    websiteUrl: 'https://platform.deepseek.com',
  },
  {
    id: 'zhipuglm',
    name: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    apiFormat: 'anthropic',
    defaultModels: { main: 'glm-5', haiku: 'glm-5', sonnet: 'glm-5', opus: 'glm-5' },
    needsApiKey: true,
    websiteUrl: 'https://open.bigmodel.cn',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    apiFormat: 'anthropic',
    defaultModels: { main: 'kimi-k2.5', haiku: 'kimi-k2.5', sonnet: 'kimi-k2.5', opus: 'kimi-k2.5' },
    needsApiKey: true,
    websiteUrl: 'https://platform.moonshot.cn',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    apiFormat: 'anthropic',
    defaultModels: { main: 'MiniMax-M2.7', haiku: 'MiniMax-M2.7', sonnet: 'MiniMax-M2.7', opus: 'MiniMax-M2.7' },
    needsApiKey: true,
    websiteUrl: 'https://platform.minimaxi.com',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    baseUrl: 'http://localhost:1234',
    apiFormat: 'openai_chat',
    defaultModels: { main: '', haiku: '', sonnet: '', opus: '' },
    needsApiKey: true,
    websiteUrl: 'https://lmstudio.ai',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434',
    apiFormat: 'openai_chat',
    defaultModels: { main: '', haiku: '', sonnet: '', opus: '' },
    needsApiKey: true,
    websiteUrl: 'https://ollama.ai',
  },
  {
    id: 'custom',
    name: 'Custom',
    baseUrl: '',
    apiFormat: 'anthropic',
    defaultModels: { main: '', haiku: '', sonnet: '', opus: '' },
    needsApiKey: true,
    websiteUrl: '',
  },
]
