import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import type { Input, Output, SearchResult } from './WebSearchTool.js'

export type WebSearchMode =
  | 'auto'
  | 'anthropic'
  | 'tavily'
  | 'brave'
  | 'disabled'

export type WebSearchProvider = 'anthropic' | 'tavily' | 'brave' | 'disabled'

export type WebSearchSettings = {
  mode?: WebSearchMode
  tavilyApiKey?: string
  braveApiKey?: string
}

export type ResolvedWebSearch = {
  provider: WebSearchProvider
  settings: WebSearchSettings
}

type ExternalSearchHit = {
  title: string
  url: string
}

const WEB_SEARCH_MODES = new Set<WebSearchMode>([
  'auto',
  'anthropic',
  'tavily',
  'brave',
  'disabled',
])

const unsupportedNativeModels = new Set<string>()

// Third-party Anthropic-compatible providers whose model IDs don't contain
// "claude" but do support the web_search_20250305 server tool (e.g. DeepSeek,
// Kimi, Zhipu GLM). Add model patterns here to enable native web search.
const thirdPartyNativeSearchModelPatterns = [/^deepseek-/]

export function isLikelyClaudeModel(model: string | undefined): boolean {
  if (!model) {
    return false
  }

  return /(^|[/:._-])claude([/:._-]|$)/.test(model.toLowerCase())
}

export function getConfiguredWebSearchSettings(
  settings: Pick<SettingsJson, 'webSearch'> = getSettings_DEPRECATED(),
): WebSearchSettings {
  const raw = settings.webSearch
  if (!raw || typeof raw !== 'object') {
    return {}
  }

  const modeCandidate = raw.mode ?? 'auto'

  return {
    mode: WEB_SEARCH_MODES.has(modeCandidate) ? modeCandidate : 'auto',
    tavilyApiKey: normalizeApiKey(raw.tavilyApiKey),
    braveApiKey: normalizeApiKey(raw.braveApiKey),
  }
}

export function resolveWebSearchProvider(
  model: string | undefined,
  settings: WebSearchSettings = getConfiguredWebSearchSettings(),
): ResolvedWebSearch {
  const mode = settings.mode ?? 'auto'

  if (mode === 'disabled') {
    return { provider: 'disabled', settings }
  }

  if (mode === 'tavily') {
    return { provider: settings.tavilyApiKey ? 'tavily' : 'disabled', settings }
  }

  if (mode === 'brave') {
    return { provider: settings.braveApiKey ? 'brave' : 'disabled', settings }
  }

  if (mode === 'anthropic') {
    return {
      provider: canUseAnthropicNativeWebSearch(model) ? 'anthropic' : 'disabled',
      settings,
    }
  }

  if (canUseAnthropicNativeWebSearch(model)) {
    return { provider: 'anthropic', settings }
  }

  if (settings.tavilyApiKey) {
    return { provider: 'tavily', settings }
  }

  if (settings.braveApiKey) {
    return { provider: 'brave', settings }
  }

  return { provider: 'disabled', settings }
}

export function isWebSearchEnabledForModel(
  model: string | undefined,
  settings: WebSearchSettings = getConfiguredWebSearchSettings(),
): boolean {
  return resolveWebSearchProvider(model, settings).provider !== 'disabled'
}

export function shouldFallbackFromNativeError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error)
  return (
    /\b(400|422)\b/.test(message) ||
    /web_search|server tool|tool schema|input_schema|extra input|unsupported/i.test(
      message,
    )
  )
}

export function markAnthropicNativeUnsupported(model: string | undefined): void {
  const key = normalizeModelKey(model)
  if (key) {
    unsupportedNativeModels.add(key)
  }
}

export async function searchWithExternalProvider(
  provider: Exclude<WebSearchProvider, 'anthropic' | 'disabled'>,
  input: Input,
  apiKey: string,
  signal: AbortSignal,
): Promise<Output> {
  const startTime = performance.now()
  const hits =
    provider === 'tavily'
      ? await searchWithTavily(input, apiKey, signal)
      : await searchWithBrave(input, apiKey, signal)
  const durationSeconds = (performance.now() - startTime) / 1000

  return makeExternalSearchOutput(provider, input.query, hits, durationSeconds)
}

export function getFallbackProvider(
  settings: WebSearchSettings,
): Exclude<WebSearchProvider, 'anthropic' | 'disabled'> | null {
  if (settings.tavilyApiKey) {
    return 'tavily'
  }
  if (settings.braveApiKey) {
    return 'brave'
  }
  return null
}

export function getApiKeyForProvider(
  provider: Exclude<WebSearchProvider, 'anthropic' | 'disabled'>,
  settings: WebSearchSettings,
): string | null {
  return provider === 'tavily'
    ? settings.tavilyApiKey ?? null
    : settings.braveApiKey ?? null
}

export function makeWebSearchUnavailableOutput(
  query: string,
  durationSeconds: number,
  reason: string,
): Output {
  return {
    query,
    results: [reason],
    durationSeconds,
  }
}

function canUseAnthropicNativeWebSearch(model: string | undefined): boolean {
  const key = normalizeModelKey(model)
  if (!key || unsupportedNativeModels.has(key)) {
    return false
  }
  return isLikelyClaudeModel(model) || thirdPartyNativeSearchModelPatterns.some(p => p.test(key))
}

function normalizeModelKey(model: string | undefined): string | null {
  const trimmed = model?.trim().toLowerCase()
  return trimmed || null
}

function normalizeApiKey(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

async function searchWithTavily(
  input: Input,
  apiKey: string,
  signal: AbortSignal,
): Promise<ExternalSearchHit[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: input.query,
      max_results: 8,
      search_depth: 'basic',
      include_answer: false,
      include_domains: input.allowed_domains,
      exclude_domains: input.blocked_domains,
    }),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status} ${await readErrorBody(response)}`)
  }

  const body = (await response.json()) as {
    results?: Array<{ title?: unknown; url?: unknown }>
  }

  return (body.results ?? [])
    .map(hit => normalizeHit(hit.title, hit.url))
    .filter((hit): hit is ExternalSearchHit => hit != null)
}

async function searchWithBrave(
  input: Input,
  apiKey: string,
  signal: AbortSignal,
): Promise<ExternalSearchHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', applyDomainFiltersToQuery(input))
  url.searchParams.set('count', '8')

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal,
  })

  if (!response.ok) {
    throw new Error(`Brave search failed: ${response.status} ${await readErrorBody(response)}`)
  }

  const body = (await response.json()) as {
    web?: { results?: Array<{ title?: unknown; url?: unknown }> }
  }

  return (body.web?.results ?? [])
    .map(hit => normalizeHit(hit.title, hit.url))
    .filter((hit): hit is ExternalSearchHit => hit != null)
}

function applyDomainFiltersToQuery(input: Input): string {
  const allowed = input.allowed_domains?.filter(Boolean) ?? []
  const blocked = input.blocked_domains?.filter(Boolean) ?? []
  const allowedClause = allowed.length
    ? `(${allowed.map(domain => `site:${domain}`).join(' OR ')}) `
    : ''
  const blockedClause = blocked.length
    ? `${blocked.map(domain => `-site:${domain}`).join(' ')} `
    : ''

  return `${allowedClause}${blockedClause}${input.query}`.trim()
}

function normalizeHit(title: unknown, url: unknown): ExternalSearchHit | null {
  if (typeof title !== 'string' || typeof url !== 'string') {
    return null
  }

  return { title, url }
}

function makeExternalSearchOutput(
  provider: Exclude<WebSearchProvider, 'anthropic' | 'disabled'>,
  query: string,
  hits: ExternalSearchHit[],
  durationSeconds: number,
): Output {
  const result: SearchResult = {
    tool_use_id: `${provider}-web-search`,
    content: hits,
  }

  return {
    query,
    results: [`Search provider: ${provider}`, result],
    durationSeconds,
  }
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  return text.slice(0, 500)
}
