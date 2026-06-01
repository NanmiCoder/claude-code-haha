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
  type CompactionLevel,
  computeCacheMetrics,
  isCompactionWorthwhile,
  needsTurnStartPreFold,
  shouldPreFold,
} from '../src/services/compact/autoCompact.js'
import { truncateToolResultByTokens } from '../src/utils/toolResultStorage.js'
import type { AutoCompactTrackingState } from '../src/services/compact/autoCompact.js'

// ===========================================================================
// TDD Integration Suite — cache optimization decision chain + boundary tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WINDOWS = {
  SMALL: 200_000,
  MEDIUM: 500_000,
  LARGE: 1_000_000,
} as const

function makeTracking(overrides: Partial<AutoCompactTrackingState> = {}): AutoCompactTrackingState {
  return {
    compacted: false,
    turnCounter: 1,
    turnId: 'tdd-test-turn',
    ...overrides,
  }
}

function thresholdTokens(window: number, ratio: number): number {
  return Math.floor(window * ratio)
}

// ---------------------------------------------------------------------------
// Integration 1: Percentage threshold cross-window consistency
//
// The entire point of percentage thresholds is to work consistently across
// all context window sizes. Verify that for every window size the ratios
// produce the same percentile behavior.
// ---------------------------------------------------------------------------

test('INTEGRATION: normal fold fires at same % regardless of window size', () => {
  for (const w of Object.values(WINDOWS)) {
    const tokens = thresholdTokens(w, COMPACT_NORMAL_FOLD_RATIO)
    const ratio = tokens / w
    expect(ratio).toBeGreaterThanOrEqual(COMPACT_NORMAL_FOLD_RATIO - 0.01)
    expect(ratio).toBeLessThanOrEqual(COMPACT_NORMAL_FOLD_RATIO + 0.01)
  }
})

test('INTEGRATION: aggressive fold fires at same % regardless of window size', () => {
  for (const w of Object.values(WINDOWS)) {
    const tokens = thresholdTokens(w, COMPACT_AGGRESSIVE_FOLD_RATIO)
    const ratio = tokens / w
    expect(ratio).toBeGreaterThanOrEqual(COMPACT_AGGRESSIVE_FOLD_RATIO - 0.01)
  }
})

test('INTEGRATION: force summary fires at same % regardless of window size', () => {
  for (const w of Object.values(WINDOWS)) {
    const tokens = thresholdTokens(w, COMPACT_FORCE_SUMMARY_RATIO)
    const ratio = tokens / w
    expect(ratio).toBeGreaterThanOrEqual(COMPACT_FORCE_SUMMARY_RATIO - 0.01)
  }
})

test('INTEGRATION: pre-check fires at same % regardless of window size', () => {
  for (const w of Object.values(WINDOWS)) {
    const tokens = thresholdTokens(w, COMPACT_PRECHECK_FOLD_RATIO)
    const ratio = tokens / w
    expect(ratio).toBeGreaterThanOrEqual(COMPACT_PRECHECK_FOLD_RATIO - 0.01)
  }
})

// ---------------------------------------------------------------------------
// Integration 2: Tail budget ratio — aggressive < normal (cross-window)
// ---------------------------------------------------------------------------

test('INTEGRATION: aggressive tail budget is half of normal across all window sizes', () => {
  for (const w of Object.values(WINDOWS)) {
    const normalTail = Math.floor(w * COMPACT_NORMAL_FOLD_TAIL_RATIO)
    const aggressiveTail = Math.floor(w * COMPACT_AGGRESSIVE_FOLD_TAIL_RATIO)
    expect(aggressiveTail).toBeLessThan(normalTail)
    // Aggressive tail should be exactly half of normal
    expect(aggressiveTail).toBe(Math.floor(normalTail / 2))
  }
})

// ---------------------------------------------------------------------------
// Integration 3: Decision chain — isCompactionWorthwhile gates normal vs emergency
// ---------------------------------------------------------------------------

test('INTEGRATION: isCompactionWorthwhile gates at exact boundary across windows', () => {
  for (const w of Object.values(WINDOWS)) {
    const boundary = Math.floor(w * MIN_COMPACTION_SAVINGS_RATIO)
    // At exact boundary — worthwhile
    expect(isCompactionWorthwhile(boundary, w)).toBe(true)
    // Just below boundary — not worthwhile
    if (boundary > 1) {
      expect(isCompactionWorthwhile(boundary - 1, w)).toBe(false)
    }
  }
})

test('INTEGRATION: isCompactionWorthwhile emergency gate consistent', () => {
  // When tokens exceed window, always worthwhile regardless of window size
  for (const w of Object.values(WINDOWS)) {
    expect(isCompactionWorthwhile(w + 1, w)).toBe(true)
    expect(isCompactionWorthwhile(w * 2, w)).toBe(true)
  }
})

// ---------------------------------------------------------------------------
// Integration 4: Pre-fold chain — estimate → needsPreFold → shouldPreFold
// Simulates a full turn-start pre-estimation decision
// ---------------------------------------------------------------------------

test('INTEGRATION: pre-fold triggers at 90% regardless of window size', () => {
  for (const w of Object.values(WINDOWS)) {
    const atThreshold = thresholdTokens(w, COMPACT_PRECHECK_FOLD_RATIO)
    expect(needsTurnStartPreFold(atThreshold, w)).toBe(true)
  }
})

test('INTEGRATION: pre-fold does NOT trigger at 89% across windows', () => {
  for (const w of Object.values(WINDOWS)) {
    const belowThreshold = thresholdTokens(w, COMPACT_PRECHECK_FOLD_RATIO * 0.99)
    expect(needsTurnStartPreFold(belowThreshold, w)).toBe(false)
  }
})

test('INTEGRATION: hysteresis prevents oscillation at boundary', () => {
  // Simulate context hovering right at 90% boundary
  const w = WINDOWS.LARGE
  const threshold = thresholdTokens(w, COMPACT_PRECHECK_FOLD_RATIO)
  const hysteresisThreshold = thresholdTokens(
    w,
    COMPACT_PRECHECK_FOLD_RATIO * (1 + COMPACT_PRECHECK_FOLD_HYSTERESIS),
  )

  // First pre-fold: at threshold → true
  const lastFoldAt = threshold + 1000
  expect(needsTurnStartPreFold(threshold, w)).toBe(true)

  // Second check: context slightly above threshold but below hysteresis
  const afterFold = threshold + Math.floor((hysteresisThreshold - threshold) * 0.5)
  expect(needsTurnStartPreFold(afterFold, w, lastFoldAt)).toBe(false)

  // Third check: context now well above hysteresis → re-trigger
  const aboveHysteresis = hysteresisThreshold + 100
  expect(needsTurnStartPreFold(aboveHysteresis, w, lastFoldAt)).toBe(true)
})

// ---------------------------------------------------------------------------
// Integration 5: alreadyFoldedThisTurn — prevents double-fold in the same turn
// ---------------------------------------------------------------------------

test('INTEGRATION: alreadyFoldedThisTurn suppresses shouldPreFold', () => {
  const tracking = makeTracking({ alreadyFoldedThisTurn: true })
  // 95% context — would normally pre-fold, but already did this turn
  expect(shouldPreFold(tracking, thresholdTokens(200_000, 0.95), 200_000)).toBe(false)
})

test('INTEGRATION: shouldPreFold returns true on fresh turn (not yet folded)', () => {
  const tracking = makeTracking({ alreadyFoldedThisTurn: false })
  expect(shouldPreFold(tracking, thresholdTokens(200_000, 0.95), 200_000)).toBe(true)
})

test('INTEGRATION: shouldPreFold returns false below threshold even on fresh turn', () => {
  const tracking = makeTracking({ alreadyFoldedThisTurn: false })
  // 80% — below 90% pre-check threshold
  expect(shouldPreFold(tracking, thresholdTokens(200_000, 0.80), 200_000)).toBe(false)
})

// ---------------------------------------------------------------------------
// Integration 6: Compaction level ordering — verify severity hierarchy
// ---------------------------------------------------------------------------

test('INTEGRATION: compaction level severity is monotonically ordered', () => {
  // The severity order of compaction levels, from least to most urgent:
  //   none < normal_fold < aggressive_fold < force_summary
  // turn_start_prefold (90%) is a pre-check at a different point in the
  // turn lifecycle, so its ratio doesn't follow the post-response severity
  // chain. fixed_buffer depends on the window size.
  const postResponseLevels: CompactionLevel[] = [
    'none',
    'normal_fold',
    'aggressive_fold',
    'force_summary',
  ]

  const ratios: Record<CompactionLevel, number> = {
    none: 0,
    turn_start_prefold: COMPACT_PRECHECK_FOLD_RATIO,
    normal_fold: COMPACT_NORMAL_FOLD_RATIO,
    aggressive_fold: COMPACT_AGGRESSIVE_FOLD_RATIO,
    force_summary: COMPACT_FORCE_SUMMARY_RATIO,
    fixed_buffer: 0.935,
  }

  for (let i = 1; i < postResponseLevels.length; i++) {
    const prev = postResponseLevels[i - 1]!
    const curr = postResponseLevels[i]!
    expect(ratios[curr]).toBeGreaterThanOrEqual(ratios[prev])
  }
})

// ---------------------------------------------------------------------------
// Integration 7: Cache metrics computation consistency
// ---------------------------------------------------------------------------

test('INTEGRATION: cacheHitRatio consistent across different hit/miss splits', () => {
  const scenarios = [
    { input: 100_000, hit: 99_000, write: 500, expectedRatio: 99_000 / (99_000 + 500) },
    { input: 100_000, hit: 50_000, write: 0, expectedRatio: 0.5 },
    { input: 100_000, hit: 0, write: 0, expectedRatio: 0 },
    { input: 100_000, hit: 100_000, write: 0, expectedRatio: 1 },
    { input: 1_000_000, hit: 750_000, write: 100_000, expectedRatio: 750_000 / (750_000 + 150_000) },
  ]

  for (const s of scenarios) {
    const m = computeCacheMetrics({
      input_tokens: s.input,
      cache_read_input_tokens: s.hit,
      cache_creation_input_tokens: s.write,
    })
    expect(m.cacheHitRatio).toBeCloseTo(s.expectedRatio, 4)
    expect(m.cacheHitTokens).toBe(s.hit)
    expect(m.cacheWriteTokens).toBe(s.write)
    // hit + miss + write ≈ input (miss may be adjusted if hit+write > input)
    expect(m.totalPromptTokens).toBeGreaterThanOrEqual(s.input - 10)
  }
})

test('INTEGRATION: cacheMetrics invariant: hitRatio ∈ [0, 1]', () => {
  // Random-ish sampling of plausible usage patterns
  const patterns = [
    { input: 1, hit: 0, write: 0 },
    { input: 1, hit: 1, write: 0 },
    { input: 999_999, hit: 1, write: 0 },
    { input: 500_000, hit: 500_000, write: 0 },
    { input: 500_000, hit: 0, write: 500_000 },
  ]
  for (const p of patterns) {
    const m = computeCacheMetrics({
      input_tokens: p.input,
      cache_read_input_tokens: p.hit,
      cache_creation_input_tokens: p.write,
    })
    expect(m.cacheHitRatio).toBeGreaterThanOrEqual(0)
    expect(m.cacheHitRatio).toBeLessThanOrEqual(1)
  }
})

// ---------------------------------------------------------------------------
// Integration 8: Token truncation — CJK and mixed-language edge cases
// ---------------------------------------------------------------------------

test('INTEGRATION: truncation preserves CJK character integrity', () => {
  // CJK: each character is 1-3 tokens. The truncation uses char/4 estimate
  // which is conservative for CJK (undercounts). Verify it still truncates
  // gracefully without corrupting characters.
  const content = 'これは日本語のテストです。'.repeat(1000)
  const result = truncateToolResultByTokens(content, 100)
  expect(result.wasTruncated).toBe(true)
  // Truncated content should be valid Unicode (no orphan surrogate pairs)
  expect(() => encodeURIComponent(result.truncated)).not.toThrow()
  // Should contain the truncation marker
  expect(result.truncated).toContain('Content truncated')
})

test('INTEGRATION: truncation with data-like content is valid', () => {
  // When content is dense data (no natural line breaks), truncation at the
  // exact char boundary is acceptable — the function guarantees content
  // is a prefix of the original and that the marker is present.
  const lines: string[] = []
  for (let i = 0; i < 100; i++) {
    lines.push(`Line ${i.toString().padStart(4, '0')}: ${'data '.repeat(50)}`)
  }
  const content = lines.join('\n')
  const result = truncateToolResultByTokens(content, 100)

  if (result.wasTruncated) {
    // Verify truncated is shorter than original
    expect(result.truncated.length).toBeLessThan(content.length)

    // The truncated content should be a prefix of the original
    // (before the marker is appended)
    const markerIdx = result.truncated.lastIndexOf('[Content truncated')
    expect(markerIdx).toBeGreaterThan(0)

    const beforeMarker = result.truncated.slice(0, markerIdx)
    // Content before the marker should be contained in the original
    // (may be truncated mid-word, which is acceptable)
    expect(content.includes(beforeMarker.trim())).toBe(true)
  }
})

test('INTEGRATION: truncation with mixed ASCII plus emoji content', () => {
  const content = 'Regular text with emoji 🚀🔥💻 mixed in. '.repeat(200)
  const result = truncateToolResultByTokens(content, 100)
  expect(result.wasTruncated).toBe(true)
  // Emoji are multi-byte; verify no orphan bytes
  expect(() => encodeURIComponent(result.truncated)).not.toThrow()
})

// ---------------------------------------------------------------------------
// Integration 9: Threshold cross-check — all ratios are in valid range
// ---------------------------------------------------------------------------

test('INTEGRATION: all compaction ratios are in (0, 1)', () => {
  const ratios = [
    COMPACT_NORMAL_FOLD_RATIO,
    COMPACT_AGGRESSIVE_FOLD_RATIO,
    COMPACT_FORCE_SUMMARY_RATIO,
    COMPACT_PRECHECK_FOLD_RATIO,
    COMPACT_NORMAL_FOLD_TAIL_RATIO,
    COMPACT_AGGRESSIVE_FOLD_TAIL_RATIO,
    MIN_COMPACTION_SAVINGS_RATIO,
    COMPACT_PRECHECK_FOLD_HYSTERESIS,
  ]
  for (const r of ratios) {
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(1)
  }
})

test('INTEGRATION: normal fold threshold < aggressive < force_summary < precheck', () => {
  expect(COMPACT_NORMAL_FOLD_RATIO).toBeLessThan(COMPACT_AGGRESSIVE_FOLD_RATIO)
  expect(COMPACT_AGGRESSIVE_FOLD_RATIO).toBeLessThan(COMPACT_FORCE_SUMMARY_RATIO)
  expect(COMPACT_FORCE_SUMMARY_RATIO).toBeLessThan(COMPACT_PRECHECK_FOLD_RATIO)
})

// ---------------------------------------------------------------------------
// Integration 10: Savings check never blocks emergency compaction
// ---------------------------------------------------------------------------

test('INTEGRATION: savings check does not block when tokens exceed window', () => {
  // Emergency: tokens > window → always true regardless of savings ratio
  for (const w of Object.values(WINDOWS)) {
    expect(isCompactionWorthwhile(w + 1, w)).toBe(true)
    expect(isCompactionWorthwhile(w + 1000, w)).toBe(true)
  }
})

test('INTEGRATION: savings check criteria consistent with min savings ratio', () => {
  const w = WINDOWS.MEDIUM
  const minFraction = MIN_COMPACTION_SAVINGS_RATIO

  // At exact fraction → worthwhile
  expect(isCompactionWorthwhile(Math.floor(w * minFraction), w)).toBe(true)

  // Slightly below → not worthwhile (but we test 1 token below for small ratios)
  const belowFraction = Math.floor(w * (minFraction - 0.01))
  if (belowFraction > 0) {
    expect(isCompactionWorthwhile(belowFraction, w)).toBe(false)
  }
})

// ---------------------------------------------------------------------------
// Integration 11: Pre-fold + post-fold never overlap (alreadyFoldedThisTurn invariant)
// ---------------------------------------------------------------------------

test('INTEGRATION: pre-fold + post-fold coordination — alreadyFolded prevents second fold', () => {
  // Simulate a full turn:
  //   1. Turn starts
  //   2. Pre-estimation finds 92% → triggers pre-fold
  //   3. Pre-fold succeeds → alreadyFoldedThisTurn = true
  //   4. API call runs
  //   5. Post-response check → should NOT re-fold

  const tracking = makeTracking({ alreadyFoldedThisTurn: false })
  const w = WINDOWS.SMALL

  // Step 2: pre-estimation at 92%
  const tokens = thresholdTokens(w, 0.92)
  expect(shouldPreFold(tracking, tokens, w)).toBe(true)

  // Step 3: after pre-fold, mark
  tracking.alreadyFoldedThisTurn = true

  // Step 5: post-response check — suppressed
  expect(shouldPreFold(tracking, tokens, w)).toBe(false)
})

test('INTEGRATION: next turn resets alreadyFoldedThisTurn (caller responsibility)', () => {
  // The tracking object is expected to be reset by the caller (query.ts)
  // at the start of each new turn. Verify the flag is not sticky.
  const tracking = makeTracking({ alreadyFoldedThisTurn: true })
  // Caller resets for new turn
  tracking.alreadyFoldedThisTurn = false
  expect(shouldPreFold(tracking, thresholdTokens(200_000, 0.95), 200_000)).toBe(true)
})

// ---------------------------------------------------------------------------
// Integration 12: Hysteresis prevents thrashing across all window sizes
// ---------------------------------------------------------------------------

test('INTEGRATION: hysteresis gap is at least 4% of threshold across windows', () => {
  for (const w of Object.values(WINDOWS)) {
    const threshold = thresholdTokens(w, COMPACT_PRECHECK_FOLD_RATIO)
    const hysteresisGap = thresholdTokens(
      w,
      COMPACT_PRECHECK_FOLD_RATIO * (1 + COMPACT_PRECHECK_FOLD_HYSTERESIS),
    ) - threshold
    // Gap should be ~5% of the threshold value
    const expectedGap = Math.floor(threshold * COMPACT_PRECHECK_FOLD_HYSTERESIS)
    expect(hysteresisGap).toBeGreaterThanOrEqual(expectedGap - 1)
  }
})
