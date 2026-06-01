export const MODEL_CONTEXT_WINDOWS_ENV_KEY = 'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS'
export const MODEL_CONTEXT_WINDOW_MIN = 16_000
export const MODEL_CONTEXT_WINDOW_MAX = 10_000_000

const DIRECT_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-7': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'deepseek-chat': 1_000_000,
  'deepseek-reasoner': 1_000_000,
  'kimi-k2.6': 262_144,
  'kimi-k2.5': 262_144,
  'kimi-k2-0905-preview': 262_144,
  'kimi-k2-turbo-preview': 262_144,
  'kimi-k2-thinking': 262_144,
  'kimi-k2-thinking-turbo': 262_144,
  'minimax-m3': 204_800,
  'minimax-m2.7': 204_800,
  'minimax-m2.7-highspeed': 204_800,
  'glm-5.1': 200_000,
  'glm-5': 200_000,
  'glm-5-turbo': 200_000,
  'glm-4.7': 200_000,
  'glm-4.6': 200_000,
  'glm-4.5': 128_000,
  'glm-4.5-air': 128_000,
}

const PATTERN_MODEL_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/^anthropic\/claude-opus-4\.7\b/i, 1_000_000],
  [/^anthropic\/claude-sonnet-4\.6\b/i, 200_000],
  [/^anthropic\/claude-haiku-4\.5\b/i, 200_000],
  [/^openai\/gpt-4\.1\b/i, 1_047_576],
  [/^openai\/gpt-5(?:[.-]\d+)?\b/i, 400_000],
  [/^google\/gemini-(?:2\.0|2\.5|3)/i, 1_048_576],
  [/^gemini-(?:2\.0|2\.5|3)/i, 1_048_576],
  [/^qwen\/qwen3\.5-(?:plus|flash)\b/i, 1_000_000],
  [/^qwen3\.5-(?:plus|flash)\b/i, 1_000_000],
  [/^qwen\/qwen3-max\b/i, 262_144],
  [/^qwen3-max\b/i, 262_144],
  [/qwen-long/i, 10_000_000],
]

export function normalizeModelContextKey(model: string): string {
  return model
    .trim()
    .replace(/\[1m\]$/i, '')
    .replace(/:1m$/i, '')
    .toLowerCase()
}

function normalizeWindow(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return undefined
  }
  if (value < MODEL_CONTEXT_WINDOW_MIN || value > MODEL_CONTEXT_WINDOW_MAX) {
    return undefined
  }
  return value
}

function parseConfiguredContextWindows(): Record<string, number> {
  const raw = process.env[MODEL_CONTEXT_WINDOWS_ENV_KEY]
  if (!raw?.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    const windows: Record<string, number> = {}
    for (const [model, value] of Object.entries(parsed)) {
      const normalized = normalizeWindow(value)
      if (normalized !== undefined) {
        windows[normalizeModelContextKey(model)] = normalized
      }
    }
    return windows
  } catch {
    return {}
  }
}

function getConfiguredModelContextWindow(model: string): number | undefined {
  const configured = parseConfiguredContextWindows()
  const normalizedModel = normalizeModelContextKey(model)
  const exact = configured[normalizedModel]
  if (exact !== undefined) {
    return exact
  }

  for (const [configuredModel, window] of Object.entries(configured)) {
    if (
      normalizedModel.endsWith(`/${configuredModel}`) ||
      normalizedModel.endsWith(`:${configuredModel}`)
    ) {
      return window
    }
  }
  return undefined
}

function getBuiltInModelContextWindow(model: string): number | undefined {
  const normalizedModel = normalizeModelContextKey(model)
  const exact = DIRECT_MODEL_CONTEXT_WINDOWS[normalizedModel]
  if (exact !== undefined) {
    return exact
  }

  for (const [pattern, window] of PATTERN_MODEL_CONTEXT_WINDOWS) {
    if (pattern.test(normalizedModel)) {
      return window
    }
  }
  return undefined
}

export function getConfiguredOrBuiltInModelContextWindow(
  model: string,
): number | undefined {
  return (
    getConfiguredModelContextWindow(model) ??
    getBuiltInModelContextWindow(model)
  )
}
