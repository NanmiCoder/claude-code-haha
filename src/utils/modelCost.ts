import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { setHasUnknownModelCost } from '../bootstrap/state.js'
import { isFastModeEnabled } from './fastMode.js'
import {
  CLAUDE_3_5_HAIKU_CONFIG,
  CLAUDE_3_5_V2_SONNET_CONFIG,
  CLAUDE_3_7_SONNET_CONFIG,
  CLAUDE_HAIKU_4_5_CONFIG,
  CLAUDE_OPUS_4_1_CONFIG,
  CLAUDE_OPUS_4_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_OPUS_4_CONFIG,
  CLAUDE_SONNET_4_5_CONFIG,
  CLAUDE_SONNET_4_6_CONFIG,
  CLAUDE_SONNET_4_CONFIG,
} from './model/configs.js'
import {
  firstPartyNameToCanonical,
  getCanonicalName,
  getDefaultMainLoopModelSetting,
  type ModelShortName,
} from './model/model.js'

// @see https://platform.claude.com/docs/en/about-claude/pricing
export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
  currency: 'USD' | 'CNY'
}

// Standard pricing tier for Sonnet models: $3 input / $15 output per Mtok
export const COST_TIER_3_15 = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
  currency: 'USD',
} as const satisfies ModelCosts

// Pricing tier for Opus 4/4.1: $15 input / $75 output per Mtok
export const COST_TIER_15_75 = {
  inputTokens: 15,
  outputTokens: 75,
  promptCacheWriteTokens: 18.75,
  promptCacheReadTokens: 1.5,
  webSearchRequests: 0.01,
  currency: 'USD',
} as const satisfies ModelCosts

// Pricing tier for Opus 4.5: $5 input / $25 output per Mtok
export const COST_TIER_5_25 = {
  inputTokens: 5,
  outputTokens: 25,
  promptCacheWriteTokens: 6.25,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0.01,
  currency: 'USD',
} as const satisfies ModelCosts

// Fast mode pricing for Opus 4.7: $30 input / $150 output per Mtok
export const COST_TIER_30_150 = {
  inputTokens: 30,
  outputTokens: 150,
  promptCacheWriteTokens: 37.5,
  promptCacheReadTokens: 3,
  webSearchRequests: 0.01,
  currency: 'USD',
} as const satisfies ModelCosts

// Pricing for Haiku 3.5: $0.80 input / $4 output per Mtok
export const COST_HAIKU_35 = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0.01,
  currency: 'USD',
} as const satisfies ModelCosts

// Pricing for Haiku 4.5: $1 input / $5 output per Mtok
export const COST_HAIKU_45 = {
  inputTokens: 1,
  outputTokens: 5,
  promptCacheWriteTokens: 1.25,
  promptCacheReadTokens: 0.1,
  webSearchRequests: 0.01,
  currency: 'USD',
} as const satisfies ModelCosts

const DEFAULT_UNKNOWN_MODEL_COST = { ...COST_TIER_5_25, currency: 'USD' as const }

// ── 中国大模型定价（每百万 tokens 人民币）──
// 数据来源：各厂商官方定价页，截至 2026-04
// 仅包含有明确文档确认的缓存价格，未确认的不纳入计算

// DeepSeek V4-Pro (2026.4.26 永久降价后)
const DEEPSEEK_V4_PRO: ModelCosts = {
  inputTokens: 3,
  outputTokens: 6,
  promptCacheWriteTokens: 0,   // 未公开
  promptCacheReadTokens: 0.1,  // 永久价 0.1，限时 0.025 截至 2026-05-31
  webSearchRequests: 0,
  currency: 'CNY',
}

// DeepSeek V4-Flash
const DEEPSEEK_V4_FLASH: ModelCosts = {
  inputTokens: 1,
  outputTokens: 2,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0.02,
  webSearchRequests: 0,
  currency: 'CNY',
}

// DeepSeek V3（无缓存定价）
const DEEPSEEK_V3: ModelCosts = {
  inputTokens: 2,
  outputTokens: 8,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0,
  webSearchRequests: 0,
  currency: 'CNY',
}

// DeepSeek R1（无缓存定价，含思维链输出）
const DEEPSEEK_R1: ModelCosts = {
  inputTokens: 4,
  outputTokens: 16,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0,
  webSearchRequests: 0,
  currency: 'CNY',
}

// MiniMax M2.7（无缓存定价）
const MINIMAX_M27: ModelCosts = {
  inputTokens: 7.20,
  outputTokens: 36,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0,
  webSearchRequests: 0,
  currency: 'CNY',
}

// MiniMax M2.5（无缓存定价）
const MINIMAX_M25: ModelCosts = {
  inputTokens: 2.16,
  outputTokens: 17.28,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0,
  webSearchRequests: 0,
  currency: 'CNY',
}

// MiniMax abab6.5t（无缓存定价）
const MINIMAX_ABAB65T: ModelCosts = {
  inputTokens: 0.70,
  outputTokens: 2.10,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0,
  webSearchRequests: 0,
  currency: 'CNY',
}

// Qwen3.5-Plus ≤128K
const QWEN35_PLUS: ModelCosts = {
  inputTokens: 0.8,
  outputTokens: 4.8,
  promptCacheWriteTokens: 1.0,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0,
  currency: 'CNY',
}

// Qwen3-Max ≤32K
const QWEN3_MAX: ModelCosts = {
  inputTokens: 2.5,
  outputTokens: 10,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0.25,
  webSearchRequests: 0,
  currency: 'CNY',
}

// GLM-5.1 (via OpenRouter, USD pricing)
// NOTE: 此定价基于 OpenRouter，通过智谱官方 API 使用时价格和币种可能不同
const GLM51: ModelCosts = {
  inputTokens: 1.26,
  outputTokens: 3.96,
  promptCacheWriteTokens: 0.26,
  promptCacheReadTokens: 0.475,
  webSearchRequests: 0,
  currency: 'USD',
}

// 豆包 Seed 1.8 ≤32K
const DOUBAO_SEED18: ModelCosts = {
  inputTokens: 0.8,
  outputTokens: 2,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0.16,
  webSearchRequests: 0,
  currency: 'CNY',
}

// 豆包 Seed 2.0 Pro
const DOUBAO_SEED20_PRO: ModelCosts = {
  inputTokens: 3.2,
  outputTokens: 16,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0.64,
  webSearchRequests: 0,
  currency: 'CNY',
}

// 豆包 Seed 2.0 Lite
const DOUBAO_SEED20_LITE: ModelCosts = {
  inputTokens: 0.6,
  outputTokens: 3.6,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0.12,
  webSearchRequests: 0,
  currency: 'CNY',
}

// Kimi K2.5
const KIMI_K25: ModelCosts = {
  inputTokens: 4.0,
  outputTokens: 21,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 0.7,
  webSearchRequests: 0,
  currency: 'CNY',
}

// Kimi K2.6
const KIMI_K26: ModelCosts = {
  inputTokens: 6.5,
  outputTokens: 27,
  promptCacheWriteTokens: 0,
  promptCacheReadTokens: 1.1,
  webSearchRequests: 0,
  currency: 'CNY',
}

/**
 * 模型名称关键词 → 定价映射（模糊匹配用）
 * 按优先级排序：越具体的匹配越靠前
 */
const MODEL_PRICING_KEYWORDS: [RegExp, ModelCosts][] = [
  [/deepseek.*v4.*pro/i, DEEPSEEK_V4_PRO],
  [/deepseek.*v4.*flash/i, DEEPSEEK_V4_FLASH],
  [/deepseek.*v4/i, DEEPSEEK_V4_PRO],  // "deepseek-v4" 默认匹配 Pro
  [/deepseek.*r1/i, DEEPSEEK_R1],
  [/deepseek.*v3/i, DEEPSEEK_V3],
  [/deepseek/i, DEEPSEEK_V3],           // 通用 DeepSeek 回退到 V3
  [/minimax.*m2\.7/i, MINIMAX_M27],
  [/minimax.*m2\.5/i, MINIMAX_M25],
  [/minimax.*abab.*6\.?5t/i, MINIMAX_ABAB65T],
  [/minimax.*abab/i, MINIMAX_ABAB65T],
  [/minimax.*m2/i, MINIMAX_M25],
  [/minimax/i, MINIMAX_M25],
  [/qwen3\.5.*plus/i, QWEN35_PLUS],
  [/qwen3.*max/i, QWEN3_MAX],
  [/qwen/i, QWEN3_MAX],
  [/glm.*5\.1/i, GLM51],
  [/glm.*5/i, GLM51],
  [/glm/i, GLM51],
  [/doubao.*seed.*2.*pro/i, DOUBAO_SEED20_PRO],
  [/doubao.*seed.*2.*lite/i, DOUBAO_SEED20_LITE],
  [/doubao.*seed.*1/i, DOUBAO_SEED18],
  [/doubao.*seed/i, DOUBAO_SEED20_PRO],
  [/doubao/i, DOUBAO_SEED18],
  [/kimi.*k2\.6/i, KIMI_K26],
  [/kimi.*k2/i, KIMI_K25],
  [/kimi/i, KIMI_K25],
  [/moonshot/i, KIMI_K25],
]

/**
 * Get the cost tier for Opus 4.7 based on fast mode.
 */
export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  if (isFastModeEnabled() && fastMode) {
    return COST_TIER_30_150
  }
  return COST_TIER_5_25
}

// @[MODEL LAUNCH]: Add a pricing entry for the new model below.
// Costs from https://platform.claude.com/docs/en/about-claude/pricing
// Web search cost: $10 per 1000 requests = $0.01 per request
export const MODEL_COSTS: Record<ModelShortName, ModelCosts> = {
  [firstPartyNameToCanonical(CLAUDE_3_5_HAIKU_CONFIG.firstParty)]:
    COST_HAIKU_35,
  [firstPartyNameToCanonical(CLAUDE_HAIKU_4_5_CONFIG.firstParty)]:
    COST_HAIKU_45,
  [firstPartyNameToCanonical(CLAUDE_3_5_V2_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_3_7_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_5_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_6_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_CONFIG.firstParty)]: COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_1_CONFIG.firstParty)]:
    COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_5_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)]:
    COST_TIER_5_25,
}

/**
 * Calculates the USD cost based on token usage and model cost configuration
 */
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

// 缓存 settings.json 中的 modelPricing，避免每次 API 调用都 require 读取
type CustomPricingCache = {
  exact: Record<string, ModelCosts>
  patterns: [RegExp, ModelCosts][]
} | null

let _cachedCustomPricing: CustomPricingCache = undefined as unknown as CustomPricingCache

function getCustomPricingCache(): CustomPricingCache {
  if (_cachedCustomPricing !== (undefined as unknown as CustomPricingCache)) {
    return _cachedCustomPricing
  }

  _cachedCustomPricing = null
  try {
    const { getInitialSettings } = require('./settings/settings.js') as typeof import('./settings/settings.js')
    const settings = getInitialSettings()
    const customPricing = (settings as Record<string, unknown>)?.modelPricing as
      | Record<string, { inputPrice: number; outputPrice: number; cacheReadPrice?: number; cacheWritePrice?: number; currency?: 'USD' | 'CNY' }>
      | undefined
    if (customPricing) {
      const exact: Record<string, ModelCosts> = {}
      const patterns: [RegExp, ModelCosts][] = []
      for (const [key, p] of Object.entries(customPricing)) {
        const costs: ModelCosts = {
          inputTokens: p.inputPrice,
          outputTokens: p.outputPrice,
          promptCacheWriteTokens: p.cacheWritePrice ?? 0,
          promptCacheReadTokens: p.cacheReadPrice ?? 0,
          webSearchRequests: 0,
          currency: p.currency ?? 'CNY',
        }
        try {
          patterns.push([new RegExp(key, 'i'), costs])
        } catch {
          // key 不是合法正则，作为精确匹配
          exact[key] = costs
        }
      }
      _cachedCustomPricing = { exact, patterns }
    }
  } catch {
    // settings 读取失败，缓存为空
  }

  return _cachedCustomPricing
}

export function getModelCosts(model: string, usage: Usage): ModelCosts {
  const shortName = getCanonicalName(model)

  // Check if this is an Opus 4.7 model with fast mode active.
  if (
    shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)
  ) {
    const isFastMode = usage.speed === 'fast'
    return getOpus46CostTier(isFastMode)
  }

  // 1. 精确匹配内置 MODEL_COSTS（Anthropic 第一方模型）
  const costs = MODEL_COSTS[shortName]
  if (costs) return costs

  // 2. settings.json modelPricing（精确匹配 + 关键词匹配，缓存避免重复 I/O）
  const cachedPricing = getCustomPricingCache()
  if (cachedPricing) {
    // 精确匹配
    if (cachedPricing.exact[model]) {
      return cachedPricing.exact[model]
    }
    // 关键词匹配（正则已预编译）
    for (const [regex, pricing] of cachedPricing.patterns) {
      if (regex.test(model)) {
        return pricing
      }
    }
  }

  // 3. 关键词模糊匹配（中国大模型等第三方模型内置定价）
  for (const [regex, pricing] of MODEL_PRICING_KEYWORDS) {
    if (regex.test(model)) {
      return pricing
    }
  }

  // 4. 回退：未知模型
  trackUnknownModelCost(model, shortName)
  return (
    MODEL_COSTS[getCanonicalName(getDefaultMainLoopModelSetting())] ??
    DEFAULT_UNKNOWN_MODEL_COST
  )
}

function trackUnknownModelCost(model: string, shortName: ModelShortName): void {
  logEvent('tengu_unknown_model_cost', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    shortName:
      shortName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  setHasUnknownModelCost()
}

/**
 * Calculate the cost of a query in the model's native currency.
 * - USD for Anthropic first-party models
 * - CNY for Chinese models (DeepSeek, Qwen, etc.)
 * Caller should use toCNY() to normalize to display currency.
 * If the model's costs are not found, use the default model's costs.
 */
export function calculateModelCost(resolvedModel: string, usage: Usage): number {
  const modelCosts = getModelCosts(resolvedModel, usage)
  return tokensToUSDCost(modelCosts, usage)
}

/**
 * Calculate cost from raw token counts without requiring a full BetaUsage object.
 * Useful for side queries (e.g. classifier) that track token counts independently.
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateModelCost(model, usage)
}

/** 默认 USD → CNY 汇率，可通过 settings.json 的 exchangeRate 覆盖 */
const DEFAULT_EXCHANGE_RATE = 7.25

let _cachedExchangeRate: number | null = null

/**
 * 获取当前汇率。优先读取 settings.json 的 exchangeRate，缓存结果
 */
export function getExchangeRate(): number {
  if (_cachedExchangeRate !== null) return _cachedExchangeRate
  try {
    const { getInitialSettings } = require('./settings/settings.js') as typeof import('./settings/settings.js')
    const settings = getInitialSettings()
    _cachedExchangeRate =
      (settings as Record<string, unknown>)?.exchangeRate as number ?? DEFAULT_EXCHANGE_RATE
  } catch {
    _cachedExchangeRate = DEFAULT_EXCHANGE_RATE
  }
  return _cachedExchangeRate
}

/**
 * 将模型原生货币成本转换为人民币
 */
export function toCNY(cost: number, currency: 'USD' | 'CNY'): number {
  if (currency === 'USD') {
    return cost * getExchangeRate()
  }
  return cost
}

function formatPrice(price: number): string {
  if (Number.isInteger(price)) {
    return `¥${price}`
  }
  return `¥${price.toFixed(2)}`
}

/**
 * Format model costs as a pricing string for display
 * e.g., "$3/$15 per Mtok" or "¥3/¥6 per Mtok"
 */
export function formatModelPricing(costs: ModelCosts): string {
  const symbol = costs.currency === 'CNY' ? '¥' : '$'
  const fmt = (p: number) =>
    Number.isInteger(p) ? `${symbol}${p}` : `${symbol}${p.toFixed(2)}`
  return `${fmt(costs.inputTokens)}/${fmt(costs.outputTokens)} per Mtok`
}

/**
 * Get formatted pricing string for a model
 * Accepts either a short name or full model name
 * Returns undefined if model is not found
 */
export function getModelPricingString(model: string): string | undefined {
  const shortName = getCanonicalName(model)
  const costs = MODEL_COSTS[shortName]
  if (!costs) return undefined
  return formatModelPricing(costs)
}
