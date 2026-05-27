import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

// Returns the context window size minus the max output tokens for the model
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = parsed
    }
  }

  return contextWindow - reservedTokensForSummary
}

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // Unique ID per turn
  turnId: string
  // Consecutive autocompact failures. Reset on success.
  // Used as a circuit breaker to stop retrying when the context is
  // irrecoverably over the limit (e.g., prompt_too_long).
  consecutiveFailures?: number
  // True when compaction has already run this turn (prevents double-fold).
  // Mirrors Reasonix's alreadyFoldedThisTurn — the post-response check
  // should not trigger a second fold if the pre-check already folded.
  alreadyFoldedThisTurn?: boolean
}

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

// ---------------------------------------------------------------------------
// Percentage-based multi-level compaction thresholds (supplement, not replace)
//
// The fixed-buffer threshold (effectiveWindow - 13_000) is the "final defense"
// at ~93-98% of the window. These percentage thresholds provide earlier,
// gentler interventions that work well across all context window sizes
// (200K through 1M+).
// ---------------------------------------------------------------------------

/** Normal fold: compact older messages, keep 20% of context window as tail budget */
export const COMPACT_NORMAL_FOLD_RATIO = 0.75
export const COMPACT_NORMAL_FOLD_TAIL_RATIO = 0.20

/** Aggressive fold: compact harder, keep 10% of context window as tail budget */
export const COMPACT_AGGRESSIVE_FOLD_RATIO = 0.78
export const COMPACT_AGGRESSIVE_FOLD_TAIL_RATIO = 0.10

/** Force summary exit: stop the agent with a summary — no more room for folds */
export const COMPACT_FORCE_SUMMARY_RATIO = 0.80

/** Turn-start pre-fold: pre-check before the API call (used by estimateTurnStartUsage) */
export const COMPACT_PRECHECK_FOLD_RATIO = 0.90

/**
 * Compaction levels ordered by severity.
 *  - none / turn_start_prefold are soft checks
 *  - normal_fold / aggressive_fold are actual compactions with tail budgets
 *  - force_summary / fixed_buffer are hard exits (no more folds)
 */
export type CompactionLevel =
  | 'none'
  | 'turn_start_prefold'
  | 'normal_fold'
  | 'aggressive_fold'
  | 'force_summary'
  | 'fixed_buffer'

export type CompactionLevelResult = {
  level: CompactionLevel
  /** Token budget for the recent tail when level is normal_fold or aggressive_fold */
  tailBudgetTokens: number
  effectiveWindow: number
  fixedBufferThreshold: number
}

// Minimum fraction of context that must be in the compactable "head" portion
// for compaction to be worthwhile. Prevents wasting a compact API call when
// the savings are marginal (Reasonix reference: HISTORY_FOLD_MIN_SAVINGS_FRACTION).
export const MIN_COMPACTION_SAVINGS_RATIO = 0.30

// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)

  const autocompactThreshold =
    effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  // Override for easier testing of autocompact
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

/**
 * Gate for the multi-level percentage-based compaction feature.
 * When disabled, the existing fixed-buffer behavior is unchanged.
 */
export function isPercentageCompactionEnabled(): boolean {
  if (!isAutoCompactEnabled()) return false
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_multi_level_compact', true)
}

/**
 * Determine the compaction level based on percentage thresholds AND the
 * fixed-buffer threshold. Percentage thresholds act as earlier, gentler
 * interventions; the fixed-buffer threshold is the "final defense."
 *
 * Checks in descending severity order so the most urgent level wins.
 *
 * @param tokenCount - current estimated token usage
 * @param model - model name for context window lookup
 */
export function getCompactionLevel(
  tokenCount: number,
  model: string,
): CompactionLevelResult {
  const effectiveWindow = getEffectiveContextWindowSize(model)
  const fixedBufferThreshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS

  // Fixed buffer is the "final defense" — triggers closest to the window limit
  if (tokenCount >= fixedBufferThreshold) {
    return {
      level: 'fixed_buffer',
      tailBudgetTokens: Math.floor(effectiveWindow * 0.05),
      effectiveWindow,
      fixedBufferThreshold,
    }
  }

  const forceSummaryThreshold = Math.floor(
    effectiveWindow * COMPACT_FORCE_SUMMARY_RATIO,
  )
  if (tokenCount >= forceSummaryThreshold) {
    return {
      level: 'force_summary',
      tailBudgetTokens: 0, // No tail — force exit
      effectiveWindow,
      fixedBufferThreshold,
    }
  }

  const aggressiveFoldThreshold = Math.floor(
    effectiveWindow * COMPACT_AGGRESSIVE_FOLD_RATIO,
  )
  if (tokenCount >= aggressiveFoldThreshold) {
    return {
      level: 'aggressive_fold',
      tailBudgetTokens: Math.floor(
        effectiveWindow * COMPACT_AGGRESSIVE_FOLD_TAIL_RATIO,
      ),
      effectiveWindow,
      fixedBufferThreshold,
    }
  }

  const normalFoldThreshold = Math.floor(
    effectiveWindow * COMPACT_NORMAL_FOLD_RATIO,
  )
  if (tokenCount >= normalFoldThreshold) {
    return {
      level: 'normal_fold',
      tailBudgetTokens: Math.floor(
        effectiveWindow * COMPACT_NORMAL_FOLD_TAIL_RATIO,
      ),
      effectiveWindow,
      fixedBufferThreshold,
    }
  }

  return {
    level: 'none',
    tailBudgetTokens: effectiveWindow,
    effectiveWindow,
    fixedBufferThreshold,
  }
}

/**
 * Estimate whether compaction would save enough tokens to justify its cost.
 *
 * The "head portion" is the messages that would be summarized (those before
 * the last compact boundary). If this portion is less than
 * MIN_COMPACTION_SAVINGS_RATIO of the total context, the compact agent's own
 * token consumption would exceed or nearly match the savings.
 *
 * @returns true if compaction is worthwhile, false to skip
 */
export function isCompactionWorthwhile(
  estimatedTotalTokens: number,
  effectiveWindow: number,
): boolean {
  // Circuit breaker: if total tokens are somehow higher than the window,
  // compaction is definitely worthwhile (emergency scenario).
  if (estimatedTotalTokens >= effectiveWindow) return true

  // Head portion = tokens above the normal fold threshold that could be freed.
  // If most tokens are already in the "tail" (recent messages), compaction
  // would save very little — the summary alone costs thousands of tokens.
  const headFraction = estimatedTotalTokens / effectiveWindow

  logForDebugging(
    `compaction_savings_check: tokens=${estimatedTotalTokens} window=${effectiveWindow} ` +
      `headFraction=${(headFraction * 100).toFixed(1)}% ` +
      `minRequired=${(MIN_COMPACTION_SAVINGS_RATIO * 100).toFixed(0)}%`,
  )

  return headFraction >= MIN_COMPACTION_SAVINGS_RATIO
}

/**
 * Fast turn-start token estimation using rough heuristics.
 * Does NOT make an API call — intentionally a coarse estimate.
 *
 * Uses the existing roughTokenCountEstimationForMessages (~4 chars/token)
 * plus fixed overhead estimates for system prompt and tool schemas.
 *
 * @returns estimated token count for messages + overhead
 */
export function estimateTurnStartUsage(
  messages: Message[],
  effectiveWindow: number,
): { estimateTokens: number; ratio: number } {
  // Use the same token estimation pipeline that shouldAutoCompact uses
  const dynamicTokens = tokenCountWithEstimation(messages)
  // Pre-check ratio: compare against the effective context window
  const ratio = effectiveWindow > 0 ? dynamicTokens / effectiveWindow : 0

  logForDebugging(
    `turnStartEstimate: tokens=${dynamicTokens} window=${effectiveWindow} ratio=${(ratio * 100).toFixed(1)}%`,
  )

  return { estimateTokens: dynamicTokens, ratio }
}

// Hysteresis buffer: only trigger a second pre-fold when context grows by
// at least this ratio beyond the threshold, preventing oscillation when
// context hovers right at the boundary.
export const COMPACT_PRECHECK_FOLD_HYSTERESIS = 0.05

/**
 * Check whether the turn-start pre-estimation triggers a pre-fold.
 *
 * This is NOT redundant with shouldAutoCompact — it uses the 90% threshold
 * (vs 75%) and is called BEFORE the API call, catching the case where the
 * last turn's tool output pushed context way up but no assistant response
 * carried the usage data yet.
 *
 * The hysteresis buffer prevents oscillating fold/no-fold when token counts
 * hover near the threshold (Reasonix: requireTailBoundary equivalent).
 *
 * @returns true when a pre-fold is recommended before the next API call
 */
export function needsTurnStartPreFold(
  estimateTokens: number,
  effectiveWindow: number,
  lastPreFoldTokens?: number,
): boolean {
  const threshold = Math.floor(effectiveWindow * COMPACT_PRECHECK_FOLD_RATIO)
  if (estimateTokens < threshold) return false

  // Hysteresis: if we pre-folded recently, only re-trigger when context
  // has grown significantly beyond the threshold (avoids oscillation).
  if (lastPreFoldTokens !== undefined && lastPreFoldTokens > 0) {
    const hysteresisThreshold = Math.floor(
      threshold * (1 + COMPACT_PRECHECK_FOLD_HYSTERESIS),
    )
    if (estimateTokens < hysteresisThreshold) return false
  }

  return true
}

// ---------------------------------------------------------------------------
// Cache Economics — per-session cache hit/miss tracking (Reasonix SessionStats)
// ---------------------------------------------------------------------------

/** Per-turn cache metrics extracted from API usage data */
export type CacheMetrics = {
  /** Tokens read from prompt cache (HIT) */
  cacheHitTokens: number
  /** Tokens NOT read from cache — fresh input (MISS) */
  cacheMissTokens: number
  /** Tokens written to cache by this request */
  cacheWriteTokens: number
  /** Total prompt-side tokens (hit + miss + write = input_tokens total) */
  totalPromptTokens: number
  /** Cache hit ratio: hit / (hit + miss). 1.0 = perfect cache, 0.0 = all miss */
  cacheHitRatio: number
}

/**
 * Compute cache efficiency metrics from API usage data.
 *
 * Uses Anthropic's `cache_read_input_tokens` and `cache_creation_input_tokens`
 * fields. For other providers (DeepSeek, OpenAI) that use different field names,
 * the caller should normalize before passing.
 *
 * Pure function — no side effects, no state. Safe to call in any context.
 */
export function computeCacheMetrics(usage: {
  input_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}): CacheMetrics {
  const cacheHitTokens = usage.cache_read_input_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  const cacheMissTokens = Math.max(
    0,
    usage.input_tokens - cacheHitTokens - cacheWriteTokens,
  )
  const totalPromptTokens = cacheHitTokens + cacheMissTokens + cacheWriteTokens
  const cacheHitRatio =
    totalPromptTokens > 0 && (cacheHitTokens + cacheMissTokens) > 0
      ? cacheHitTokens / (cacheHitTokens + cacheMissTokens)
      : 0

  return {
    cacheHitTokens,
    cacheMissTokens,
    cacheWriteTokens,
    totalPromptTokens,
    cacheHitRatio,
  }
}

/**
 * The pre-fold decision needs `alreadyFoldedThisTurn` context — exported so
 * query.ts can thread it without reaching into tracking internals.
 */
export function shouldPreFold(
  tracking: AutoCompactTrackingState | undefined,
  estimateTokens: number,
  effectiveWindow: number,
): boolean {
  if (tracking?.alreadyFoldedThisTurn) return false
  return needsTurnStartPreFold(estimateTokens, effectiveWindow)
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  const actualContextWindow = getEffectiveContextWindowSize(model)
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // Allow override for testing
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // Allow disabling just auto-compact (keeps manual /compact working)
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // Check if user has disabled auto-compact in their settings
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip removes messages but the surviving assistant's usage still reflects
  // pre-snip context, so tokenCountWithEstimation can't see the savings.
  // Subtract the rough-delta that snip already computed.
  snipTokensFreed = 0,
): Promise<boolean> {
  // Recursion guards. session_memory and compact are forked agents that
  // would deadlock.
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // marble_origami is the ctx-agent — if ITS context blows up and
  // autocompact fires, runPostCompactCleanup calls resetContextCollapse()
  // which destroys the MAIN thread's committed log (module-level state
  // shared across forks). Inside feature() so the string DCEs from
  // external builds (it's in excluded-strings.txt).
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }

  if (!isAutoCompactEnabled()) {
    return false
  }

  // Reactive-only mode: suppress proactive autocompact, let reactive compact
  // catch the API's prompt-too-long. feature() wrapper keeps the flag string
  // out of external builds (REACTIVE_COMPACT is ant-only).
  // Note: returning false here also means autoCompactIfNeeded never reaches
  // trySessionMemoryCompaction in the query loop — the /compact call site
  // still tries session memory first. Revisit if reactive-only graduates.
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }

  // Context-collapse mode: same suppression. Collapse IS the context
  // management system when it's on — the 90% commit / 95% blocking-spawn
  // flow owns the headroom problem. Autocompact firing at effective-13k
  // (~93% of effective) sits right between collapse's commit-start (90%)
  // and blocking (95%), so it would race collapse and usually win, nuking
  // granular context that collapse was about to save. Gating here rather
  // than in isAutoCompactEnabled() keeps reactiveCompact alive as the 413
  // fallback (it consults isAutoCompactEnabled directly) and leaves
  // sessionMemory + manual /compact working.
  //
  // Consult isContextCollapseEnabled (not the raw gate) so the
  // CLAUDE_CONTEXT_COLLAPSE env override is honored here too. require()
  // inside the block breaks the init-time cycle (this file exports
  // getEffectiveContextWindowSize which collapse's index imports).
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  // Existing fixed-buffer check: final defense at ~93-98% of window
  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )

  if (isAboveAutoCompactThreshold) return true

  // New: percentage-based multi-level check — earlier, gentler intervention
  if (isPercentageCompactionEnabled()) {
    const level = getCompactionLevel(tokenCount, model)
    if (level.level !== 'none' && level.level !== 'turn_start_prefold') {
      logForDebugging(
        `autocompact: percentage threshold triggered (level=${level.level}, ratio=${(tokenCount / effectiveWindow * 100).toFixed(1)}%)`,
      )
      return true
    }
  }

  return false
}

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
  /** Pass true from query.ts turn-start pre-estimation to run a pre-fold */
  forcePreFold?: boolean,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
  /** Loggable cache metrics from the compaction call (if one ran) */
  cacheMetrics?: CacheMetrics
}> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // Circuit breaker: stop retrying after N consecutive failures.
  // Without this, sessions where context is irrecoverably over the limit
  // hammer the API with doomed compaction attempts on every turn.
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
  )

  // alreadyFoldedThisTurn guard: if compaction ran via pre-fold earlier this
  // turn, the post-response check should not re-trigger. Mirrors Reasonix's
  // decideAfterUsage: alreadyFoldedThisTurn → skip fold.
  if (!forcePreFold && tracking?.alreadyFoldedThisTurn) {
    logForDebugging('autocompact: skipping post-response check — already folded this turn')
    return { wasCompacted: false }
  }

  if (!shouldCompact && !forcePreFold) {
    return { wasCompacted: false }
  }

  // Route decision: forcePreFold overrides the passive check when the
  // turn-start pre-estimation flagged us above 90%. In that case we only
  // skip if the minimum savings check says there's nothing worth freeing.
  if (!shouldCompact && forcePreFold) {
    const tokenCount = tokenCountWithEstimation(messages) - (snipTokensFreed ?? 0)
    const effectiveWindow = getEffectiveContextWindowSize(model)
    if (!isCompactionWorthwhile(tokenCount, effectiveWindow)) {
      logForDebugging(
        `autocompact: skipping forced pre-fold — head portion too small (tokens=${tokenCount}, window=${effectiveWindow})`,
      )
      return { wasCompacted: false }
    }
    logForDebugging(
      `autocompact: forcePreFold active — triggering pre-fold (tokens=${tokenCount})`,
    )
  }

  // Minimum savings gate: skip compaction when the head portion is too small
  // to save meaningful tokens. Prevents wasting a compact API call when the
  // summary alone costs nearly as many tokens as it frees.
  // Skip this check for forcePreFold — already handled above.
  if (!forcePreFold && isPercentageCompactionEnabled()) {
    const tokenCount = tokenCountWithEstimation(messages) - (snipTokensFreed ?? 0)
    const effectiveWindow = getEffectiveContextWindowSize(model)
    if (
      !isCompactionWorthwhile(tokenCount, effectiveWindow)
    ) {
      logForDebugging(
        `autocompact: skipping — head portion too small for worthwhile savings (tokens=${tokenCount}, window=${effectiveWindow})`,
      )
      return { wasCompacted: false }
    }
  }

  // Compute the compaction level for use in recompactionInfo and to guide
  // the compaction strategy (tail budget, aggressiveness).
  const tokenCount = tokenCountWithEstimation(messages) - (snipTokensFreed ?? 0)
  const compactionLevel = isPercentageCompactionEnabled()
    ? getCompactionLevel(tokenCount, model).level
    : 'fixed_buffer'

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  logForDebugging(
    `autocompact: triggering compaction (level=${compactionLevel}, tokens=${tokenCount})`,
  )

  // EXPERIMENT: Try session memory compaction first
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // Reset lastSummarizedMessageId since session memory compaction prunes messages
    // and the old message UUID will no longer exist after the REPL replaces messages
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // Reset cache read baseline so the post-compact drop isn't flagged as a
    // break. compactConversation does this internally; SM-compact doesn't.
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    markPostCompaction()
    // Mark alreadyFoldedThisTurn to prevent the post-response check from
    // double-folding (Reasonix: decideAfterUsage returns 'none' when true).
    if (tracking) tracking.alreadyFoldedThisTurn = true
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // Suppress user questions for autocompact
      undefined, // No custom instructions for autocompact
      true, // isAutoCompact
      recompactionInfo,
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    // Compute cache metrics from the compaction agent's usage for visibility
    const compactionUsage = compactionResult.compactionUsage
    const compactionCacheMetrics = compactionUsage
      ? computeCacheMetrics({
          input_tokens: compactionUsage.input_tokens,
          cache_read_input_tokens: compactionUsage.cache_read_input_tokens,
          cache_creation_input_tokens: compactionUsage.cache_creation_input_tokens,
        })
      : undefined

    // Mark alreadyFoldedThisTurn to prevent the post-response check from
    // double-folding (Reasonix: decideAfterUsage returns 'none' when true).
    if (tracking) tracking.alreadyFoldedThisTurn = true

    return {
      wasCompacted: true,
      compactionResult,
      consecutiveFailures: 0,
      cacheMetrics: compactionCacheMetrics,
    }
  } catch (error) {
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    // Increment consecutive failure count for circuit breaker.
    // The caller threads this through autoCompactTracking so the
    // next query loop iteration can skip futile retry attempts.
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future attempts this session`,
        { level: 'warn' },
      )
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
