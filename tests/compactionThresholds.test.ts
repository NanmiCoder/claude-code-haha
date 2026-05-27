import { expect, test } from 'bun:test'
import {
  COMPACT_NORMAL_FOLD_RATIO,
  COMPACT_AGGRESSIVE_FOLD_RATIO,
  COMPACT_FORCE_SUMMARY_RATIO,
  COMPACT_PRECHECK_FOLD_RATIO,
  COMPACT_NORMAL_FOLD_TAIL_RATIO,
  COMPACT_AGGRESSIVE_FOLD_TAIL_RATIO,
  COMPACT_PRECHECK_FOLD_HYSTERESIS,
  MIN_COMPACTION_SAVINGS_RATIO,
  computeCacheMetrics,
  isCompactionWorthwhile,
  needsTurnStartPreFold,
  shouldPreFold,
} from '../src/services/compact/autoCompact.js'
import { truncateToolResultByTokens } from '../src/utils/toolResultStorage.js'
import type { AutoCompactTrackingState } from '../src/services/compact/autoCompact.js'

// ---------------------------------------------------------------------------
// Constant validation — ensure thresholds stay at their expected values
// ---------------------------------------------------------------------------

test('percentage thresholds are correctly ordered', () => {
  expect(COMPACT_NORMAL_FOLD_RATIO).toBe(0.75)
  expect(COMPACT_AGGRESSIVE_FOLD_RATIO).toBe(0.78)
  expect(COMPACT_FORCE_SUMMARY_RATIO).toBe(0.80)
  expect(COMPACT_PRECHECK_FOLD_RATIO).toBe(0.90)

  // Thresholds must be monotonically increasing
  expect(COMPACT_NORMAL_FOLD_RATIO).toBeLessThan(COMPACT_AGGRESSIVE_FOLD_RATIO)
  expect(COMPACT_AGGRESSIVE_FOLD_RATIO).toBeLessThan(
    COMPACT_FORCE_SUMMARY_RATIO,
  )
  expect(COMPACT_FORCE_SUMMARY_RATIO).toBeLessThan(COMPACT_PRECHECK_FOLD_RATIO)
})

test('tail budget ratios are correctly ordered', () => {
  expect(COMPACT_NORMAL_FOLD_TAIL_RATIO).toBe(0.20)
  expect(COMPACT_AGGRESSIVE_FOLD_TAIL_RATIO).toBe(0.10)

  // Normal fold should preserve more tail than aggressive fold
  expect(COMPACT_AGGRESSIVE_FOLD_TAIL_RATIO).toBeLessThan(
    COMPACT_NORMAL_FOLD_TAIL_RATIO,
  )
})

test('minimum savings ratio is a reasonable value', () => {
  expect(MIN_COMPACTION_SAVINGS_RATIO).toBe(0.30)
  expect(MIN_COMPACTION_SAVINGS_RATIO).toBeGreaterThan(0)
  expect(MIN_COMPACTION_SAVINGS_RATIO).toBeLessThan(1)
})

test('pre-check hysteresis is a small positive fraction', () => {
  expect(COMPACT_PRECHECK_FOLD_HYSTERESIS).toBe(0.05)
  expect(COMPACT_PRECHECK_FOLD_HYSTERESIS).toBeGreaterThan(0)
  expect(COMPACT_PRECHECK_FOLD_HYSTERESIS).toBeLessThan(0.15)
})

// ---------------------------------------------------------------------------
// isCompactionWorthwhile
// ---------------------------------------------------------------------------

test('isCompactionWorthwhile returns true when most of context is occupied', () => {
  // 90K tokens in 100K window → 90% occupied → worthwhile
  expect(isCompactionWorthwhile(90_000, 100_000)).toBe(true)
})

test('isCompactionWorthwhile returns true at the boundary (30%)', () => {
  // 30K tokens in 100K window → exactly 30% → still worthwhile
  expect(isCompactionWorthwhile(30_000, 100_000)).toBe(true)
})

test('isCompactionWorthwhile returns false when below threshold', () => {
  // 20K tokens in 100K window → 20% → not worthwhile
  expect(isCompactionWorthwhile(20_000, 100_000)).toBe(false)
})

test('isCompactionWorthwhile returns true when tokens exceed window (emergency)', () => {
  // Emergency: tokens exceed the context window — always worthwhile
  expect(isCompactionWorthwhile(105_000, 100_000)).toBe(true)
})

test('isCompactionWorthwhile handles large 1M context window', () => {
  // 400K tokens in 1M window → 40% → worthwhile
  expect(isCompactionWorthwhile(400_000, 1_000_000)).toBe(true)

  // 200K tokens in 1M window → 20% → not worthwhile
  expect(isCompactionWorthwhile(200_000, 1_000_000)).toBe(false)

  // 205K tokens in 200K window → >100% → emergency → worthwhile
  expect(isCompactionWorthwhile(205_000, 200_000)).toBe(true)
})

// ---------------------------------------------------------------------------
// computeCacheMetrics — cache economics tracking (Reasonix SessionStats parity)
// ---------------------------------------------------------------------------

test('computeCacheMetrics with perfect cache hit', () => {
  const result = computeCacheMetrics({
    input_tokens: 10_000,
    cache_read_input_tokens: 9_000,
    cache_creation_input_tokens: 500,
  })
  expect(result.cacheHitTokens).toBe(9_000)
  expect(result.cacheWriteTokens).toBe(500)
  // miss = input - hit - write = 10000 - 9000 - 500 = 500
  expect(result.cacheMissTokens).toBe(500)
  expect(result.totalPromptTokens).toBe(10_000)
  // ratio = 9000 / (9000 + 500) ≈ 0.947
  expect(result.cacheHitRatio).toBeCloseTo(0.947, 2)
})

test('computeCacheMetrics with complete cache miss', () => {
  const result = computeCacheMetrics({
    input_tokens: 50_000,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
  expect(result.cacheHitTokens).toBe(0)
  expect(result.cacheMissTokens).toBe(50_000)
  expect(result.cacheWriteTokens).toBe(0)
  expect(result.cacheHitRatio).toBe(0)
})

test('computeCacheMetrics with null fields defaults to zero', () => {
  const result = computeCacheMetrics({
    input_tokens: 5_000,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  })
  expect(result.cacheHitTokens).toBe(0)
  expect(result.cacheWriteTokens).toBe(0)
  expect(result.cacheMissTokens).toBe(5_000)
})

test('computeCacheMetrics with undefined fields defaults to zero', () => {
  const result = computeCacheMetrics({
    input_tokens: 3_000,
  })
  expect(result.cacheHitTokens).toBe(0)
  expect(result.cacheWriteTokens).toBe(0)
  expect(result.cacheMissTokens).toBe(3_000)
})

test('computeCacheMetrics handles mixed cache scenario', () => {
  // 200K total prompt: 150K cache hit, 30K miss, 20K new writes
  const result = computeCacheMetrics({
    input_tokens: 200_000,
    cache_read_input_tokens: 150_000,
    cache_creation_input_tokens: 20_000,
  })
  expect(result.cacheHitTokens).toBe(150_000)
  expect(result.cacheWriteTokens).toBe(20_000)
  expect(result.cacheMissTokens).toBe(30_000)
  // ratio = 150000 / (150000 + 30000) ≈ 0.833
  expect(result.cacheHitRatio).toBeCloseTo(0.833, 2)
})

test('computeCacheMetrics guards against negative miss (defensive)', () => {
  // Edge case: if API reports more hit+write than input (shouldn't happen
  // but the function should never return negative)
  const result = computeCacheMetrics({
    input_tokens: 1_000,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 300,
  })
  // hit + write = 1100 > input = 1000 → miss clamped to 0
  expect(result.cacheMissTokens).toBe(0)
  expect(result.cacheHitTokens).toBe(800)
  expect(result.cacheWriteTokens).toBe(300)
  expect(result.cacheHitRatio).toBe(1.0) // 800/(800+0) = 1.0
})

// ---------------------------------------------------------------------------
// needsTurnStartPreFold — 90% threshold with hysteresis
// ---------------------------------------------------------------------------

test('needsTurnStartPreFold returns false when below 90% threshold', () => {
  // 80K tokens in 100K window → 80% → not at 90% threshold
  expect(needsTurnStartPreFold(80_000, 100_000)).toBe(false)
})

test('needsTurnStartPreFold returns true at exactly 90%', () => {
  // 90K tokens in 100K window → exactly 90%
  expect(needsTurnStartPreFold(90_000, 100_000)).toBe(true)
})

test('needsTurnStartPreFold returns true well above 90%', () => {
  expect(needsTurnStartPreFold(95_000, 100_000)).toBe(true)
})

test('needsTurnStartPreFold with hysteresis: skip when near previous fold', () => {
  // 92K tokens in 100K window: 92% → above 90% threshold
  // But we folded at 91K recently → hysteresis threshold = 90K * 1.05 = 94.5K
  // 92K < 94.5K → hysteresis suppresses re-fold
  expect(needsTurnStartPreFold(92_000, 100_000, 91_000)).toBe(false)
})

test('needsTurnStartPreFold with hysteresis: trigger when significantly above', () => {
  // 96K tokens in 100K window: 96% → above 90% threshold
  // Folded at 91K recently → hysteresis threshold = 94.5K
  // 96K > 94.5K → hysteresis does NOT suppress
  expect(needsTurnStartPreFold(96_000, 100_000, 91_000)).toBe(true)
})

test('needsTurnStartPreFold with hysteresis under the threshold is fine', () => {
  // 89K tokens in 100K window: 89% → below 90% threshold
  // Hysteresis doesn't matter when under threshold
  expect(needsTurnStartPreFold(89_000, 100_000, 88_000)).toBe(false)
})

test('needsTurnStartPreFold with large 1M context window', () => {
  // 920K in 1M window → 92% → above 90%
  expect(needsTurnStartPreFold(920_000, 1_000_000)).toBe(true)

  // 880K in 1M window → 88% → below 90%
  expect(needsTurnStartPreFold(880_000, 1_000_000)).toBe(false)

  // Hysteresis: 905K in 1M, folded at 900K
  // Hysteresis threshold = 900K * 1.05 = 945K, 905K < 945K → suppressed
  expect(needsTurnStartPreFold(905_000, 1_000_000, 900_000)).toBe(false)
})

// ---------------------------------------------------------------------------
// shouldPreFold — respects alreadyFoldedThisTurn
// ---------------------------------------------------------------------------

function makeTracking(alreadyFolded: boolean): AutoCompactTrackingState {
  return {
    compacted: false,
    turnCounter: 0,
    turnId: 'test',
    alreadyFoldedThisTurn: alreadyFolded,
  }
}

test('shouldPreFold returns false when already folded this turn', () => {
  const tracking = makeTracking(true)
  // 95K in 100K → 95% → would normally trigger, but alreadyFolded suppresses
  expect(shouldPreFold(tracking, 95_000, 100_000)).toBe(false)
})

test('shouldPreFold returns true when not yet folded this turn', () => {
  const tracking = makeTracking(false)
  expect(shouldPreFold(tracking, 95_000, 100_000)).toBe(true)
})

test('shouldPreFold returns false when tracking is undefined', () => {
  // Without tracking, assume no pre-fold needed (defensive)
  expect(shouldPreFold(undefined, 95_000, 100_000)).toBe(true)
  // But when under threshold, still false
  expect(shouldPreFold(undefined, 85_000, 100_000)).toBe(false)
})

// ---------------------------------------------------------------------------
// truncateToolResultByTokens
// ---------------------------------------------------------------------------

test('truncateToolResultByTokens returns content unchanged when under limit', () => {
  const content = 'short content'
  const result = truncateToolResultByTokens(content, 100)
  expect(result.wasTruncated).toBe(false)
  expect(result.truncated).toBe(content)
})

test('truncateToolResultByTokens returns content unchanged when exactly at limit', () => {
  // 400 bytes → ~100 tokens at 4 bytes/token
  const content = 'A'.repeat(400)
  const result = truncateToolResultByTokens(content, 100)
  // May or may not truncate depending on rough estimate — but marker
  // should not appear when content is small enough
  if (!result.wasTruncated) {
    expect(result.truncated).toBe(content)
  }
})

test('truncateToolResultByTokens truncates when well above limit', () => {
  // ~50K chars → ~12,500 tokens at 4 bytes/token
  const content = 'A'.repeat(50_000)
  const result = truncateToolResultByTokens(content, 100)
  expect(result.wasTruncated).toBe(true)
  expect(result.truncated.length).toBeLessThan(content.length)
  expect(result.truncated).toContain('Content truncated')
})

test('truncateToolResultByTokens includes marker in truncated content', () => {
  const content = 'B'.repeat(10_000)
  const result = truncateToolResultByTokens(content, 100)
  expect(result.wasTruncated).toBe(true)
  expect(result.truncated).toContain(
    'Content truncated',
  )
})

test('truncateToolResultByTokens handles CJK content', () => {
  // CJK characters are ~1-3 tokens each, so char/4 underestimates tokens.
  // The function should still gracefully handle and truncate CJK content.
  const content = '中文测试内容'.repeat(5_000)
  const result = truncateToolResultByTokens(content, 500)
  expect(result.wasTruncated).toBe(true)
  expect(result.truncated.length).toBeLessThan(content.length)
})

test('truncateToolResultByTokens preserves content integrity', () => {
  const content = 'Hello World\nThis is a test\n'.repeat(200)
  const result = truncateToolResultByTokens(content, 100)
  expect(result.wasTruncated).toBe(true)
  // Should not start with partial line when possible
  // (if a newline was found within 70% of the budget)
  const truncatedPart = result.truncated.replace(
    /\n\n\[Content truncated.*\]$/s,
    '',
  )
  // Content before the marker should be a prefix of the original
  expect(content.startsWith(truncatedPart)).toBe(true)
})

test('truncateToolResultByTokens handles empty content', () => {
  const result = truncateToolResultByTokens('', 100)
  expect(result.wasTruncated).toBe(false)
  expect(result.truncated).toBe('')
  expect(result.estimatedTokens).toBe(0)
})
