import type { Cursor } from './cursor.js'
import type { Size } from './layout/geometry.js'
import type { ScrollHint } from './render-node-to-output.js'
import {
  type CharPool,
  createScreen,
  type HyperlinkPool,
  type Screen,
  type StylePool,
} from './screen.js'

export type Frame = {
  readonly screen: Screen
  readonly viewport: Size
  readonly cursor: Cursor
  /** DECSTBM 滚动优化提示（仅 alt-screen 使用，否则为 null）。 */
  readonly scrollHint?: ScrollHint | null
  /** 某个 ScrollBox 仍有待处理的 pendingScrollDelta，需要继续调度下一帧。 */
  readonly scrollDrainPending?: boolean
}

export function emptyFrame(
  rows: number,
  columns: number,
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): Frame {
  return {
    screen: createScreen(0, 0, stylePool, charPool, hyperlinkPool),
    viewport: { width: columns, height: rows },
    cursor: { x: 0, y: 0, visible: true },
  }
}

export type FlickerReason = 'resize' | 'offscreen' | 'clear'

export type FrameEvent = {
  durationMs: number
  /** 各阶段耗时（毫秒）及 patch 数量。仅当 ink 实例启用了帧耗时埋点
   *  （通过 onFrame 接线）时才会填充。 */
  phases?: {
    /** createRenderer 的输出：DOM → Yoga 布局 → screen buffer */
    renderer: number
    /** LogUpdate.render()：screen diff → Patch[]（本 PR 优化的热点路径） */
    diff: number
    /** optimize()：patch 合并 / 去重 */
    optimize: number
    /** writeDiffToTerminal()：patch 序列化 → ANSI → stdout */
    write: number
    /** optimize 之前的 patch 数量（可作为本帧改动规模的代理指标） */
    patches: number
    /** Yoga calculateLayout() 耗时（在 resetAfterCommit 中、onRender 之前执行） */
    yoga: number
    /** React reconcile 耗时：scrollMutated → resetAfterCommit。若无 commit，则为 0。 */
    commit: number
    /** 本帧 layoutNode() 调用次数（递归统计，包含命中缓存后的返回） */
    yogaVisited: number
    /** measureFunc（文本换行 / 宽度计算）调用次数，这是较昂贵的部分 */
    yogaMeasured: number
    /** 通过 _hasL 单槽缓存触发的提前返回次数 */
    yogaCacheHits: number
    /** 当前存活的 Yoga Node 实例总数（create - free）。持续增长意味着泄漏。 */
    yogaLive: number
  }
  flickers: Array<{
    desiredHeight: number
    availableHeight: number
    reason: FlickerReason
  }>
}

export type Patch =
  | { type: 'stdout'; content: string }
  | { type: 'clear'; count: number }
  | {
      type: 'clearTerminal'
      reason: FlickerReason
      // 当 scrollback diff 触发 reset 时，由 log-update 填充。
      // ink.tsx 会结合 triggerY 与 findOwnerChainAtRow，将 flicker 归因到
      // 触发它的 React 组件上。
      debug?: { triggerY: number; prevLine: string; nextLine: string }
    }
  | { type: 'cursorHide' }
  | { type: 'cursorShow' }
  | { type: 'cursorMove'; x: number; y: number }
  | { type: 'cursorTo'; col: number }
  | { type: 'carriageReturn' }
  | { type: 'hyperlink'; uri: string }
  // 来自 StylePool.transition() 的预序列化样式过渡字符串，
  // 以 (fromId, toId) 为键缓存，预热后可做到零分配。
  | { type: 'styleStr'; str: string }

export type Diff = Patch[]

/**
 * 根据当前帧与前一帧判断是否需要清屏。
 * 若需要清屏则返回原因，否则返回 undefined。
 *
 * 以下情况会触发清屏：
 * 1. 终端尺寸发生变化（viewport 尺寸变化）→ 'resize'
 * 2. 当前帧的 screen 高度超过了可用终端行数 → 'offscreen'
 * 3. 前一帧的 screen 高度超过了可用终端行数 → 'offscreen'
 */
export function shouldClearScreen(
  prevFrame: Frame,
  frame: Frame,
): FlickerReason | undefined {
  const didResize =
    frame.viewport.height !== prevFrame.viewport.height ||
    frame.viewport.width !== prevFrame.viewport.width
  if (didResize) {
    return 'resize'
  }

  const currentFrameOverflows = frame.screen.height >= frame.viewport.height
  const previousFrameOverflowed =
    prevFrame.screen.height >= prevFrame.viewport.height
  if (currentFrameOverflows || previousFrameOverflowed) {
    return 'offscreen'
  }

  return undefined
}
