/**
 * Models REST API
 *
 * GET  /api/models          - Get available models
 * GET  /api/models/current  - Get the currently selected model
 * PUT  /api/models/current  - Switch the current model
 * GET  /api/effort          - Get current effort level
 * PUT  /api/effort          - Update effort level
 */

import { SettingsService } from '../services/settingsService.js'
import { ProviderService } from '../services/providerService.js'
import { conversationService } from '../services/conversationService.js'
import {
  modelEnvMatches,
  normalizeModelRouting,
  routingFromProviderModels,
  toModelEnv,
} from '../services/modelRoutingService.js'
import { patchSettingsEnv } from '../services/settingsSyncService.js'
import {
  DEFAULT_XIAOMU_MODEL_ID,
  getXiaomuModelCatalog,
  type XiaomuModel,
} from '../services/xiaomuModelService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const
const DEFAULT_EFFORT = 'max'
const XIAOMU_CONFIG_FALLBACK_DIR = '.xiaomu-ai'

const settingsService = new SettingsService()
const providerService = new ProviderService()

type ModelInfo = XiaomuModel

function buildProviderModelList(activeProvider: {
  models: { main: string; haiku: string; sonnet: string; opus: string }
}): ModelInfo[] {
  const candidates = [
    { id: activeProvider.models.main, name: activeProvider.models.main, description: 'Main model', context: '' },
    { id: activeProvider.models.haiku, name: activeProvider.models.haiku, description: 'Haiku model', context: '' },
    { id: activeProvider.models.sonnet, name: activeProvider.models.sonnet, description: 'Sonnet model', context: '' },
    { id: activeProvider.models.opus, name: activeProvider.models.opus, description: 'Opus model', context: '' },
  ]

  const seen = new Set<string>()
  return candidates.filter((model) => {
    if (!model.id || seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

async function syncSelectedModelRouting(
  modelId: string,
  options: {
    activeProvider?: {
      models: { main: string; haiku: string; sonnet: string; opus: string }
    } | null
    catalog?: Awaited<ReturnType<typeof getXiaomuModelCatalog>> | null
  },
): Promise<void> {
  const routing = options.activeProvider
    ? routingFromProviderModels({
        ...options.activeProvider.models,
        main: modelId,
      })
    : options.catalog?.routingById[modelId] || normalizeModelRouting(undefined, modelId)

  await patchSettingsEnv(toModelEnv(routing), {
    fallbackDirName: XIAOMU_CONFIG_FALLBACK_DIR,
    topLevel: !options.activeProvider,
    ccHaha: true,
  })
}

async function reconcileXiaomuCurrentModel(
  explicitModel: string,
  env: Record<string, string>,
): Promise<{
  availableModels: ModelInfo[]
  currentModelId: string
  currentModelName: string
  contextTier?: string
}> {
  const catalog = await getXiaomuModelCatalog()
  const availableModels = catalog.models
  const availableIds = new Set(availableModels.map((model) => model.id))

  let currentModelId = explicitModel || catalog.defaultModelId || DEFAULT_XIAOMU_MODEL_ID
  const explicitModelIsInvalid = !!explicitModel && !availableIds.has(explicitModel)

  if (!availableIds.has(currentModelId)) {
    currentModelId = catalog.defaultModelId || availableModels[0]?.id || DEFAULT_XIAOMU_MODEL_ID
  }

  if (explicitModelIsInvalid) {
    await settingsService.updateUserSettings({ model: undefined, modelContext: undefined })
  }

  const desiredRouting =
    catalog.routingById[currentModelId] || normalizeModelRouting(undefined, currentModelId)
  if (!modelEnvMatches(env, desiredRouting)) {
    await syncSelectedModelRouting(currentModelId, { catalog })
    conversationService.invalidateRuntimeOptions('xiaomu model routing reconciled')
  }

  return {
    availableModels,
    currentModelId,
    currentModelName: currentModelId,
  }
}

export async function handleModelsApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const resource = segments[1]
    const sub = segments[2]

    if (resource === 'effort') {
      return await handleEffort(req)
    }

    switch (sub) {
      case undefined:
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return await handleModelsList()

      case 'current':
        return await handleCurrentModel(req)

      default:
        throw ApiError.notFound(`Unknown models endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

async function handleModelsList(): Promise<Response> {
  const { providers, activeId } = await providerService.listProviders()
  const activeProvider = activeId ? providers.find((provider) => provider.id === activeId) : null

  if (activeProvider) {
    return Response.json({
      models: buildProviderModelList(activeProvider),
      provider: { id: activeProvider.id, name: activeProvider.name },
    })
  }

  const catalog = await getXiaomuModelCatalog()
  return Response.json({
    models: catalog.models,
    provider: { id: 'xiaomu', name: catalog.providerName },
    meta: {
      remoteManaged: catalog.remoteManaged,
      defaultModelId: catalog.defaultModelId,
    },
  })
}

async function handleCurrentModel(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const settings = await settingsService.getUserSettings()
    const explicitModel = (settings.model as string) || ''
    const contextTier = (settings.modelContext as string) || undefined
    const env = ((settings.env as Record<string, string>) || {})

    const { providers, activeId } = await providerService.listProviders()
    const activeProvider = activeId ? providers.find((provider) => provider.id === activeId) : null

    let availableModels: ModelInfo[]
    let currentModelId: string
    let currentModelName: string

    if (activeProvider) {
      availableModels = buildProviderModelList(activeProvider)
      const availableIds = new Set(availableModels.map((model) => model.id))
      const providerEnvModel = env.ANTHROPIC_MODEL
      currentModelId = explicitModel || providerEnvModel || activeProvider.models.main

      if (!availableIds.has(currentModelId)) {
        currentModelId = availableIds.has(providerEnvModel || '')
          ? (providerEnvModel as string)
          : activeProvider.models.main
      }

      currentModelName = currentModelId

      const desiredRouting = routingFromProviderModels({
        ...activeProvider.models,
        main: currentModelId,
      })
      if (!modelEnvMatches(env, desiredRouting)) {
        await syncSelectedModelRouting(currentModelId, { activeProvider })
        conversationService.invalidateRuntimeOptions('provider model routing reconciled')
      }
    } else {
      const reconciled = await reconcileXiaomuCurrentModel(explicitModel, env)
      availableModels = reconciled.availableModels
      currentModelId = reconciled.currentModelId
      currentModelName = reconciled.currentModelName
    }

    const lookupId = contextTier ? `${currentModelId}:${contextTier}` : currentModelId
    const modelEntry = availableModels.find((model) => model.id === lookupId)
      || availableModels.find((model) => model.id === currentModelId)
      || {
        id: currentModelId,
        name: currentModelName,
        description: 'Custom model',
        context: contextTier || 'unknown',
      }

    return Response.json({
      model: {
        ...modelEntry,
        context: contextTier || modelEntry.context,
      },
    })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const modelId = body.modelId
    if (typeof modelId !== 'string' || !modelId.trim()) {
      throw ApiError.badRequest('Missing or invalid "modelId" in request body')
    }

    const normalizedModelId = modelId.trim()
    const colonIndex = normalizedModelId.indexOf(':')
    const baseId = colonIndex !== -1 ? normalizedModelId.slice(0, colonIndex) : normalizedModelId
    const contextTier = colonIndex !== -1 ? normalizedModelId.slice(colonIndex + 1) : undefined

    const { providers, activeId } = await providerService.listProviders()
    const activeProvider = activeId ? providers.find((provider) => provider.id === activeId) : null
    const catalog = activeProvider ? null : await getXiaomuModelCatalog()
    const availableModels = activeProvider
      ? buildProviderModelList(activeProvider)
      : catalog!.models

    if (!availableModels.some((model) => model.id === baseId)) {
      throw ApiError.badRequest(`Model "${baseId}" is not available right now`)
    }

    await settingsService.updateUserSettings({
      model: baseId,
      modelContext: contextTier || undefined,
    })
    await syncSelectedModelRouting(baseId, { activeProvider, catalog })
    conversationService.invalidateRuntimeOptions('model changed')

    return Response.json({ ok: true, model: normalizedModelId })
  }

  throw methodNotAllowed(req.method)
}

async function handleEffort(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const settings = await settingsService.getUserSettings()
    const level = (settings.effort as string) || DEFAULT_EFFORT
    return Response.json({ level, available: EFFORT_LEVELS })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const level = body.level
    if (typeof level !== 'string') {
      throw ApiError.badRequest('Missing or invalid "level" in request body')
    }
    if (!EFFORT_LEVELS.includes(level as (typeof EFFORT_LEVELS)[number])) {
      throw ApiError.badRequest(
        `Invalid effort level: "${level}". Valid levels: ${EFFORT_LEVELS.join(', ')}`,
      )
    }
    await settingsService.updateUserSettings({ effort: level })
    conversationService.invalidateRuntimeOptions('effort changed')
    return Response.json({ ok: true, level })
  }

  throw methodNotAllowed(req.method)
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}
