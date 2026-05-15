import {
  getClaudeAiBaseUrl,
  getRemoteSessionUrl,
} from '../constants/product.js'
import { stringWidth } from '../ink/stringWidth.js'
import { formatDuration, truncateToWidth } from '../utils/format.js'
import { getGraphemeSegmenter } from '../utils/intl.js'

/** Bridge 状态机的状态。 */
export type StatusState =
  | 'idle'
  | 'attached'
  | 'titled'
  | 'reconnecting'
  | 'failed'

/** 工具活动行在最后一次 tool_start 之后保持可见的时长（毫秒）。 */
export const TOOL_DISPLAY_EXPIRY_MS = 30_000

/** shimmer 动画 tick 的间隔（毫秒）。 */
export const SHIMMER_INTERVAL_MS = 150

export function timestamp(): string {
  const now = new Date()
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

export { formatDuration, truncateToWidth as truncatePrompt }

/** 为 trail 展示缩写工具活动摘要。 */
export function abbreviateActivity(summary: string): string {
  return truncateToWidth(summary, 30)
}

/** 构造 bridge 空闲时显示的连接 URL。 */
export function buildBridgeConnectUrl(
  environmentId: string,
  ingressUrl?: string,
): string {
  const baseUrl = getClaudeAiBaseUrl(undefined, ingressUrl)
  return `${baseUrl}/code?bridge=${environmentId}`
}

/**
 * 构造 session 已附着时显示的 session URL。委托给 getRemoteSessionUrl
 * 完成 cse_→session_ 前缀转换，然后追加 v1 特有的
 * ?bridge={environmentId} 查询参数。
 */
export function buildBridgeSessionUrl(
  sessionId: string,
  environmentId: string,
  ingressUrl?: string,
): string {
  return `${getRemoteSessionUrl(sessionId, ingressUrl)}?bridge=${environmentId}`
}

/** 为反向扫过的 shimmer 动画计算 glimmer 索引。 */
export function computeGlimmerIndex(
  tick: number,
  messageWidth: number,
): number {
  const cycleLength = messageWidth + 20
  return messageWidth + 10 - (tick % cycleLength)
}

/**
 * 按视觉列位置将文本拆成三段，用于 shimmer 渲染。
 *
 * 使用 grapheme segmentation 和 `stringWidth`，确保对多字节字符、emoji
 * 和 CJK 字形的拆分都正确。
 *
 * 返回 `{ before, shimmer, after }` 字符串。两个渲染器
 * （bridgeUI.ts 中的 chalk，以及 bridge.tsx 中的 React/Ink）
 * 会各自为这些片段着色。
 */
export function computeShimmerSegments(
  text: string,
  glimmerIndex: number,
): { before: string; shimmer: string; after: string } {
  const messageWidth = stringWidth(text)
  const shimmerStart = glimmerIndex - 1
  const shimmerEnd = glimmerIndex + 1

  // 当 shimmer 位于屏幕外时，把全部文本作为 "before" 返回
  if (shimmerStart >= messageWidth || shimmerEnd < 0) {
    return { before: text, shimmer: '', after: '' }
  }

  // 按视觉列位置最多拆成 3 段
  const clampedStart = Math.max(0, shimmerStart)
  let colPos = 0
  let before = ''
  let shimmer = ''
  let after = ''
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const segWidth = stringWidth(segment)
    if (colPos + segWidth <= clampedStart) {
      before += segment
    } else if (colPos > shimmerEnd) {
      after += segment
    } else {
      shimmer += segment
    }
    colPos += segWidth
  }

  return { before, shimmer, after }
}

/** 根据连接状态计算得到的 bridge 状态标签和颜色。 */
export type BridgeStatusInfo = {
  label:
    | 'Remote Control failed'
    | 'Remote Control reconnecting'
    | 'Remote Control active'
    | 'Remote Control connecting\u2026'
  color: 'error' | 'warning' | 'success'
}

/** 从 bridge 连接状态推导状态标签和颜色。 */
export function getBridgeStatus({
  error,
  connected,
  sessionActive,
  reconnecting,
}: {
  error: string | undefined
  connected: boolean
  sessionActive: boolean
  reconnecting: boolean
}): BridgeStatusInfo {
  if (error) return { label: 'Remote Control failed', color: 'error' }
  if (reconnecting)
    return { label: 'Remote Control reconnecting', color: 'warning' }
  if (sessionActive || connected)
    return { label: 'Remote Control active', color: 'success' }
  return { label: 'Remote Control connecting\u2026', color: 'warning' }
}

/** bridge 空闲时（Ready 状态）显示的页脚文本。 */
export function buildIdleFooterText(url: string): string {
  return `Code everywhere with the Claude app or ${url}`
}

/** session 活跃时（Connected 状态）显示的页脚文本。 */
export function buildActiveFooterText(url: string): string {
  return `Continue coding in the Claude app or ${url}`
}

/** bridge 失败时显示的页脚文本。 */
export const FAILED_FOOTER_TEXT = 'Something went wrong, please try again'

/**
 * 使用 OSC 8 终端超链接包装文本。出于布局目的，其视觉宽度为 0。
 * strip-ansi（被 stringWidth 使用）会正确移除这些序列，因此
 * bridgeUI.ts 中的 countVisualLines 仍然准确。
 */
export function wrapWithOsc8Link(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
}
