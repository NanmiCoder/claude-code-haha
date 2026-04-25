import { normalizeModelRouting, type ModelRouting } from './modelRoutingService.js'

export type XiaomuModel = {
  id: string
  name: string
  description: string
  context: string
}

export type XiaomuModelCatalog = {
  models: XiaomuModel[]
  defaultModelId: string
  providerName: string
  routingById: Record<string, ModelRouting>
  remoteManaged: boolean
}

const AIAPI_STATUS_URL = 'https://aiapi.space/api/status'
const AIAPI_PRICING_URL = 'https://aiapi.space/api/pricing'
const XIAOMU_CACHE_TTL_MS = 15 * 1000

const DEFAULT_MODELS: XiaomuModel[] = [
  { id: 'gpt-5.4', name: 'GPT-5.4', description: '默认推荐，稳定好用', context: '200k' },
  { id: 'gpt-5.5', name: 'GPT-5.5', description: 'OpenAI GPT new model', context: '200k' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', description: '长文本和写作表现强', context: '1m' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: '综合均衡，速度快', context: '200k' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', description: '创作和理解能力强', context: '200k' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', description: '最新旗舰模型', context: '1m' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: '响应速度快', context: '200k' },
  { id: 'gpt-4.5', name: 'GPT-4.5', description: 'OpenAI 上一代强模型', context: '128k' },
  { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', description: '国产通用强模型', context: '128k' },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', description: 'Moonshot 长上下文', context: '200k' },
  { id: 'glm-5', name: 'GLM-5', description: '智谱通用模型', context: '128k' },
  { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', description: 'MiniMax 通用模型', context: '1m' },
]

export const DEFAULT_XIAOMU_MODEL_ID = DEFAULT_MODELS[0]!.id

const DEFAULT_MODEL_INDEX = new Map(DEFAULT_MODELS.map((model, index) => [model.id, index]))
const DEFAULT_MODEL_MAP = new Map(DEFAULT_MODELS.map((model) => [model.id, model]))
const REMOTE_MODEL_CONFIG_KEYS = [
  'desktop_models_config',
  'desktop_model_config',
  'desktop_models_json',
  'desktop_models',
]
const REMOTE_VISIBLE_MODEL_KEYS = ['desktop_visible_models', 'desktop_model_whitelist']
const REMOTE_ORDER_KEYS = ['desktop_model_order', 'desktop_models_order']
const REMOTE_DEFAULT_MODEL_KEYS = ['desktop_default_model', 'desktop_default_model_id']
const REMOTE_ROUTING_KEYS = ['desktop_model_routing', 'desktop_models_routing']
const PINNED_VISIBLE_MODEL_IDS = ['gpt-5.5']

let modelCatalogCache: { at: number; catalog: XiaomuModelCatalog } | null = null

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return value

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }

  return value
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstString(
  source: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = readString(source[key])
    if (value) return value
  }
  return undefined
}

function toStringArray(value: unknown): string[] {
  const parsed = parseMaybeJson(value)

  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
  }

  if (typeof parsed === 'string') {
    return parsed
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  return []
}

function firstStringArray(
  source: Record<string, unknown>,
  keys: string[],
): string[] {
  for (const key of keys) {
    const values = toStringArray(source[key])
    if (values.length > 0) return values
  }
  return []
}

function prettyModelName(id: string): string {
  return id
    .replace(/^claude-/, 'Claude ')
    .replace(/^gpt-/, 'GPT-')
    .replace(/^gemini-/, 'Gemini ')
    .replace(/^deepseek-/, 'DeepSeek ')
    .replace(/^kimi-/, 'Kimi ')
    .replace(/^glm-/, 'GLM-')
    .replace(/-preview$/, ' Preview')
}

function formatPricingDescription(model: Record<string, unknown>): string {
  const type = model.quota_type === 0 ? '按量' : '按次'
  const ratio = model.model_ratio ?? model.ratio ?? 1
  const completionRatio = model.completion_ratio ?? 1
  const displayName = readString(model.display_name)

  const parts = [
    displayName,
    type,
    `倍率 ${ratio}${completionRatio !== 1 ? ` / ${completionRatio}` : ''}`,
  ].filter(Boolean)

  return parts.join(' · ')
}

function buildFallbackModel(id: string): XiaomuModel {
  const fallback = DEFAULT_MODEL_MAP.get(id)
  if (fallback) return fallback

  return {
    id,
    name: prettyModelName(id),
    description: '',
    context: '',
  }
}

function dedupeModels(models: XiaomuModel[]): XiaomuModel[] {
  const seen = new Set<string>()
  const deduped: XiaomuModel[] = []

  for (const model of models) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    deduped.push(model)
  }

  return deduped
}

function sortModels(models: XiaomuModel[]): XiaomuModel[] {
  return [...models].sort((a, b) => {
    const aIndex = DEFAULT_MODEL_INDEX.get(a.id)
    const bIndex = DEFAULT_MODEL_INDEX.get(b.id)

    if (aIndex != null && bIndex != null) return aIndex - bIndex
    if (aIndex != null) return -1
    if (bIndex != null) return 1

    return a.id.localeCompare(b.id)
  })
}

function materializeModelsById(
  ids: string[],
  knownModels: Map<string, XiaomuModel>,
): XiaomuModel[] {
  return ids.map((id) => knownModels.get(id) ?? buildFallbackModel(id))
}

function readRemoteConfigObject(statusData: Record<string, unknown>): unknown {
  for (const key of REMOTE_MODEL_CONFIG_KEYS) {
    const parsed = parseMaybeJson(statusData[key])
    if (Array.isArray(parsed) || isObject(parsed)) {
      return parsed
    }
  }
  return null
}

function normalizeRemoteModelEntry(
  entry: unknown,
  pricingById: Map<string, XiaomuModel>,
): { model: XiaomuModel; routing: ModelRouting } | null {
  if (typeof entry === 'string') {
    const id = entry.trim()
    if (!id) return null
    return {
      model: pricingById.get(id) ?? buildFallbackModel(id),
      routing: normalizeModelRouting(undefined, id),
    }
  }

  if (!isObject(entry)) return null
  if (entry.enabled === false || entry.visible === false || entry.disabled === true) {
    return null
  }

  const id = firstString(entry, ['id', 'modelId', 'model', 'model_name'])
  if (!id) return null

  const pricingModel = pricingById.get(id)
  const nestedRouting = parseMaybeJson(entry.routing)
  const routing = normalizeModelRouting(
    isObject(nestedRouting) ? { ...nestedRouting, ...entry } : entry,
    id,
  )

  return {
    model: {
      id,
      name:
        firstString(entry, ['name', 'displayName', 'display_name', 'label'])
        || pricingModel?.name
        || prettyModelName(id),
      description:
        firstString(entry, ['description', 'desc', 'subtitle'])
        || pricingModel?.description
        || '',
      context:
        firstString(entry, ['context', 'contextWindow', 'context_window'])
        || pricingModel?.context
        || '',
    },
    routing,
  }
}

function parseRoutingMap(value: unknown): Record<string, ModelRouting> {
  const parsed = parseMaybeJson(value)
  if (!isObject(parsed)) return {}

  const routingById: Record<string, ModelRouting> = {}
  for (const [modelId, routing] of Object.entries(parsed)) {
    if (!modelId.trim()) continue
    routingById[modelId] = normalizeModelRouting(routing, modelId)
  }
  return routingById
}

function buildCatalogFromRemoteConfig(
  remoteConfig: unknown,
  pricingById: Map<string, XiaomuModel>,
): {
  models?: XiaomuModel[]
  defaultModelId?: string
  providerName?: string
  routingById: Record<string, ModelRouting>
  hasRemoteControl: boolean
} {
  if (Array.isArray(remoteConfig)) {
    const entries = remoteConfig
      .map((entry) => normalizeRemoteModelEntry(entry, pricingById))
      .filter((entry): entry is { model: XiaomuModel; routing: ModelRouting } => entry != null)

    return {
      models: entries.map((entry) => entry.model),
      routingById: Object.fromEntries(entries.map((entry) => [entry.model.id, entry.routing])),
      hasRemoteControl: entries.length > 0,
    }
  }

  if (!isObject(remoteConfig)) {
    return { routingById: {}, hasRemoteControl: false }
  }

  const rawModels = ['models', 'visibleModels', 'items', 'list']
    .map((key) => parseMaybeJson(remoteConfig[key]))
    .find((value) => Array.isArray(value))
  const visibleIds = firstStringArray(remoteConfig, ['visibleModelIds', 'modelIds'])
  const orderIds = firstStringArray(remoteConfig, ['order', 'modelOrder'])
  const externalRouting = parseRoutingMap(
    remoteConfig.routing ?? remoteConfig.modelRouting,
  )

  let models: XiaomuModel[] | undefined
  const routingById: Record<string, ModelRouting> = { ...externalRouting }

  if (Array.isArray(rawModels)) {
    const entries = rawModels
      .map((entry) => normalizeRemoteModelEntry(entry, pricingById))
      .filter((entry): entry is { model: XiaomuModel; routing: ModelRouting } => entry != null)

    models = entries.map((entry) => entry.model)
    for (const entry of entries) {
      routingById[entry.model.id] = entry.routing
    }
  } else if (visibleIds.length > 0) {
    models = materializeModelsById(visibleIds, pricingById)
  }

  if (models && orderIds.length > 0) {
    const modelMap = new Map(models.map((model) => [model.id, model]))
    const ordered = materializeModelsById(orderIds, modelMap)
    const rest = models.filter((model) => !orderIds.includes(model.id))
    models = dedupeModels([...ordered, ...rest])
  }

  return {
    models,
    defaultModelId: firstString(remoteConfig, ['defaultModel', 'defaultModelId']),
    providerName: firstString(remoteConfig, ['providerName', 'systemName']),
    routingById,
    hasRemoteControl:
      !!models
      || visibleIds.length > 0
      || orderIds.length > 0
      || !!firstString(remoteConfig, ['defaultModel', 'defaultModelId'])
      || Object.keys(externalRouting).length > 0,
  }
}

async function fetchStatusData(): Promise<Record<string, unknown>> {
  const response = await fetch(AIAPI_STATUS_URL, {
    cache: 'no-store',
    signal: AbortSignal.timeout(4000),
    headers: { 'User-Agent': 'xiaomu-desktop/8.0' },
  })
  if (!response.ok) throw new Error(`status HTTP ${response.status}`)
  const payload = (await response.json()) as { data?: Record<string, unknown> }
  return isObject(payload.data) ? payload.data : {}
}

async function fetchPricingModels(): Promise<XiaomuModel[]> {
  const response = await fetch(AIAPI_PRICING_URL, {
    cache: 'no-store',
    signal: AbortSignal.timeout(6000),
    headers: { 'User-Agent': 'xiaomu-desktop/8.0' },
  })
  if (!response.ok) throw new Error(`pricing HTTP ${response.status}`)

  const payload = (await response.json()) as { success?: boolean; data?: unknown[] }
  if (!payload.success || !Array.isArray(payload.data)) {
    throw new Error('invalid pricing response')
  }

  return dedupeModels(
    payload.data
      .filter((item): item is Record<string, unknown> => isObject(item))
      .map((item) => {
        const id = readString(item.model_name)
        if (!id) return null
        const fallback = DEFAULT_MODEL_MAP.get(id)
        return {
          id,
          name: fallback?.name ?? prettyModelName(id),
          description: formatPricingDescription(item),
          context: fallback?.context ?? '',
        }
      })
      .filter((item): item is XiaomuModel => item != null),
  )
}

export async function getXiaomuModelCatalog(): Promise<XiaomuModelCatalog> {
  if (modelCatalogCache && Date.now() - modelCatalogCache.at < XIAOMU_CACHE_TTL_MS) {
    return modelCatalogCache.catalog
  }

  try {
    const [pricingResult, statusResult] = await Promise.allSettled([
      fetchPricingModels(),
      fetchStatusData(),
    ])

    const pricingModels =
      pricingResult.status === 'fulfilled' && pricingResult.value.length > 0
        ? pricingResult.value
        : DEFAULT_MODELS
    const pricingById = new Map(pricingModels.map((model) => [model.id, model]))
    const statusData = statusResult.status === 'fulfilled' ? statusResult.value : {}

    let models = sortModels(pricingModels)
    let remoteManaged = false

    const remoteConfig = readRemoteConfigObject(statusData)
    const remoteConfigResult = buildCatalogFromRemoteConfig(remoteConfig, pricingById)
    if (remoteConfigResult.hasRemoteControl) {
      remoteManaged = true
      if (remoteConfigResult.models && remoteConfigResult.models.length > 0) {
        models = dedupeModels(remoteConfigResult.models)
      }
    }

    const visibleIds = firstStringArray(statusData, REMOTE_VISIBLE_MODEL_KEYS)
    if (visibleIds.length > 0) {
      const pinnedVisibleIds = [...visibleIds]
      for (const id of PINNED_VISIBLE_MODEL_IDS) {
        if (!pinnedVisibleIds.includes(id)) pinnedVisibleIds.push(id)
      }
      models = materializeModelsById(
        pinnedVisibleIds,
        new Map(
          [...DEFAULT_MODELS, ...pricingModels, ...models].map((model) => [model.id, model]),
        ),
      )
      remoteManaged = true
    }

    const orderIds = firstStringArray(statusData, REMOTE_ORDER_KEYS)
    if (orderIds.length > 0) {
      const modelMap = new Map(models.map((model) => [model.id, model]))
      const ordered = materializeModelsById(orderIds, modelMap)
      const rest = models.filter((model) => !orderIds.includes(model.id))
      models = dedupeModels([...ordered, ...rest])
      remoteManaged = true
    }

    if (models.length === 0) {
      models = DEFAULT_MODELS
    }

    const routingById: Record<string, ModelRouting> = {}
    for (const model of models) {
      routingById[model.id] = normalizeModelRouting(undefined, model.id)
    }
    Object.assign(
      routingById,
      parseRoutingMap(
        REMOTE_ROUTING_KEYS
          .map((key) => statusData[key])
          .find((value) => value != null),
      ),
      remoteConfigResult.routingById,
    )

    const requestedDefault =
      remoteConfigResult.defaultModelId
      || firstString(statusData, REMOTE_DEFAULT_MODEL_KEYS)
      || DEFAULT_XIAOMU_MODEL_ID
    const defaultModelId = models.some((model) => model.id === requestedDefault)
      ? requestedDefault
      : (models[0]?.id ?? DEFAULT_XIAOMU_MODEL_ID)

    const catalog: XiaomuModelCatalog = {
      models,
      defaultModelId,
      providerName: remoteConfigResult.providerName || firstString(statusData, ['system_name']) || '丸美小沐',
      routingById,
      remoteManaged,
    }

    modelCatalogCache = {
      at: Date.now(),
      catalog,
    }

    return catalog
  } catch (error) {
    console.warn('[models] failed to load xiaomu model catalog, using fallback:', error)
    const catalog: XiaomuModelCatalog = {
      models: DEFAULT_MODELS,
      defaultModelId: DEFAULT_XIAOMU_MODEL_ID,
      providerName: '丸美小沐',
      routingById: Object.fromEntries(
        DEFAULT_MODELS.map((model) => [model.id, normalizeModelRouting(undefined, model.id)]),
      ),
      remoteManaged: false,
    }
    modelCatalogCache = {
      at: Date.now(),
      catalog,
    }
    return catalog
  }
}

export function resetXiaomuModelCatalogCache(): void {
  modelCatalogCache = null
}
