import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BaselineTarget } from './types'

type ProviderModels = {
  main?: string
  haiku?: string
  sonnet?: string
  opus?: string
}

type SavedProviderIndexEntry = {
  id: string
  name: string
  presetId?: string
  models?: ProviderModels
}

export type ProviderIndex = {
  activeId: string | null
  providers: SavedProviderIndexEntry[]
}

const DEFAULT_INDEX: ProviderIndex = { activeId: null, providers: [] }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function getProviderIndexPath(configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) {
  return join(configDir, 'cc-haha', 'providers.json')
}

export function slugifyProviderName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function slugifyLabel(value: string) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function providerAliases(provider: SavedProviderIndexEntry) {
  return new Set([
    provider.id,
    provider.name,
    provider.name.toLowerCase(),
    slugifyProviderName(provider.name),
  ].filter(Boolean))
}

function modelEntries(provider: SavedProviderIndexEntry) {
  const roles = [
    ['main', provider.models?.main],
    ['haiku', provider.models?.haiku],
    ['sonnet', provider.models?.sonnet],
    ['opus', provider.models?.opus],
  ] as const
  const seen = new Set<string>()

  return roles
    .filter((entry): entry is [typeof entry[0], string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .filter(([, modelId]) => {
      if (seen.has(modelId)) return false
      seen.add(modelId)
      return true
    })
}

function splitProviderTarget(value: string) {
  const separator = value.indexOf(':')
  if (separator === -1) {
    return null
  }

  return {
    providerRef: value.slice(0, separator),
    modelAndLabel: value.slice(separator + 1),
  }
}

function splitModelAndLabel(value: string) {
  const separator = value.lastIndexOf(':')
  if (separator === -1) {
    return { modelId: value, label: undefined }
  }

  return {
    modelId: value.slice(0, separator),
    label: value.slice(separator + 1) || undefined,
  }
}

function resolveProviderModel(provider: SavedProviderIndexEntry, modelAndLabel: string) {
  const roleEntries = [
    ['main', provider.models?.main],
    ['haiku', provider.models?.haiku],
    ['sonnet', provider.models?.sonnet],
    ['opus', provider.models?.opus],
  ] as const

  for (const [role, modelId] of roleEntries) {
    if (!modelId) continue
    if (modelAndLabel === role) {
      return { modelId, label: undefined }
    }
    if (modelAndLabel.startsWith(`${role}:`)) {
      return { modelId, label: modelAndLabel.slice(role.length + 1) || undefined }
    }
  }

  const knownModels = [...new Set(roleEntries.map(([, modelId]) => modelId).filter((modelId): modelId is string => Boolean(modelId)))]
    .sort((left, right) => right.length - left.length)
  for (const modelId of knownModels) {
    if (modelAndLabel === modelId) {
      return { modelId, label: undefined }
    }
    if (modelAndLabel.startsWith(`${modelId}:`)) {
      return { modelId, label: modelAndLabel.slice(modelId.length + 1) || undefined }
    }
  }

  return splitModelAndLabel(modelAndLabel)
}

export function loadProviderIndex(configDir?: string): ProviderIndex {
  const filePath = getProviderIndexPath(configDir)
  if (!existsSync(filePath)) {
    return { ...DEFAULT_INDEX, providers: [] }
  }

  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ProviderIndex>
  return {
    activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
    providers: Array.isArray(parsed.providers)
      ? parsed.providers.filter((provider): provider is SavedProviderIndexEntry => (
        provider &&
        typeof provider.id === 'string' &&
        typeof provider.name === 'string'
      ))
      : [],
  }
}

function resolveProviderReference(reference: string, index: ProviderIndex) {
  if (reference === 'current' || reference === 'official') {
    return null
  }

  const normalized = reference.toLowerCase()
  const slug = slugifyProviderName(reference)
  const matches = index.providers.filter((provider) => {
    const aliases = providerAliases(provider)
    return aliases.has(reference) || aliases.has(normalized) || aliases.has(slug)
  })

  if (matches.length === 1) {
    return matches[0]
  }

  if (matches.length > 1) {
    throw new Error(`Ambiguous provider reference "${reference}". Use one of these IDs: ${matches.map((provider) => provider.id).join(', ')}`)
  }

  if (UUID_PATTERN.test(reference)) {
    return { id: reference, name: reference }
  }

  throw new Error(`Unknown provider "${reference}". Run "bun run quality:providers" to list available --provider-model values.`)
}

export function parseBaselineTargetValues(values: string[], index: ProviderIndex = loadProviderIndex()): BaselineTarget[] {
  return values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const target = splitProviderTarget(value)
      if (!target?.providerRef || !target.modelAndLabel) {
        throw new Error(`Invalid --provider-model value "${value}". Expected provider:model[:label]. Run "bun run quality:providers" for copyable values.`)
      }

      const { providerRef, modelAndLabel } = target
      const provider = resolveProviderReference(providerRef, index)
      if (!provider) {
        const { modelId, label } = splitModelAndLabel(modelAndLabel)
        return {
          providerId: null,
          modelId,
          label: label || (providerRef === 'current' && modelId === 'current' ? 'current-runtime' : `${providerRef}-${modelId}`),
        }
      }

      const { modelId, label } = resolveProviderModel(provider, modelAndLabel)
      const providerSlug = slugifyProviderName(provider.name) || provider.id.slice(0, 8)
      return {
        providerId: provider.id,
        modelId,
        label: label || slugifyLabel(`${providerSlug}-${modelId}`),
      }
    })
}

function providerSelector(provider: SavedProviderIndexEntry, index: ProviderIndex) {
  const slug = slugifyProviderName(provider.name)
  if (!slug) {
    return provider.id
  }

  const matchingSlugCount = index.providers.filter((candidate) => slugifyProviderName(candidate.name) === slug).length
  return matchingSlugCount === 1 ? slug : provider.id
}

export function formatProviderTargets(index: ProviderIndex = loadProviderIndex(), configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) {
  const lines = [
    'Quality gate provider targets',
    `Config: ${getProviderIndexPath(configDir)}`,
    '',
    'Current/default runtime:',
    '  --provider-model current:current:current-runtime',
    '',
  ]

  if (index.providers.length === 0) {
    lines.push('Saved providers: none')
    lines.push('')
    lines.push('Add a provider to your local configuration, then run this command again.')
    return lines.join('\n')
  }

  lines.push('Saved providers:')
  for (const provider of index.providers) {
    const providerSlug = providerSelector(provider, index)
    const active = index.activeId === provider.id ? ' (active)' : ''
    lines.push(`  ${provider.name}${active}`)
    lines.push(`    id: ${provider.id}`)
    lines.push(`    selector: ${providerSlug}`)

    const models = modelEntries(provider)
    if (models.length === 0) {
      lines.push('    models: none configured')
      continue
    }

    for (const [role, modelId] of models) {
      const label = slugifyLabel(`${providerSlug}-${role}`)
      lines.push(`    ${role}: ${modelId}`)
      lines.push(`      --provider-model ${providerSlug}:${role}:${label}`)
    }
  }

  return lines.join('\n')
}
