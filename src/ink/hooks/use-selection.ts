import { useContext, useMemo, useSyncExternalStore } from 'react'
import StdinContext from '../components/StdinContext.js'
import instances from '../instances.js'
import {
  type FocusMove,
  type SelectionState,
  shiftAnchor,
} from '../selection.js'

/**
 * 访问 Ink 实例上的文本选择操作（仅全屏模式可用）。
 * 当全屏模式关闭时，返回的都是 no-op 函数。
 */
export function useSelection(): {
  copySelection: () => string
  /** 复制但不清除高亮（用于 copy-on-select）。 */
  copySelectionNoClear: () => string
  clearSelection: () => void
  hasSelection: () => boolean
  /** 读取原始的可变选择状态（用于 drag-to-scroll）。 */
  getState: () => SelectionState | null
  /** 订阅选择状态变化（start/update/finish/clear）。 */
  subscribe: (cb: () => void) => () => void
  /** 将 anchor 行按 dRow 平移，并限制在 [minRow, maxRow] 内。 */
  shiftAnchor: (dRow: number, minRow: number, maxRow: number) => void
  /** 将 anchor 和 focus 一起按 dRow 平移（键盘滚动时，整个 selection
   *  都跟着内容移动）。被截断到边界的点，其 col 会被重置到整行宽度边缘，
   *  因为对应内容已经被 captureScrolledRows 捕获。col 重置边界取自
   *  ink 实例中的 screen.width。 */
  shiftSelection: (dRow: number, minRow: number, maxRow: number) => void
  /** 键盘方式扩展选择（shift+arrow）：移动 focus，anchor 固定。
   *  左右方向会跨行换行；上下方向会在视口边缘处截断。 */
  moveFocus: (move: FocusMove) => void
  /** 捕获即将滚出视口的行中的文本（必须在 scrollBy 之前调用，
   *  这样 screen buffer 里还保留着将被滚走的那些行）。 */
  captureScrolledRows: (
    firstRow: number,
    lastRow: number,
    side: 'above' | 'below',
  ) => void
  /** 设置选择高亮的背景色（用于主题透传；纯色背景会替换旧的 SGR-7 反相，
   *  这样语法高亮在被选中时仍然可读）。在挂载时调用一次，并在主题变化时重新调用。 */
  setSelectionBgColor: (color: string) => void
} {
  // 通过 stdout 查找 Ink 实例，模式与 instances map 一致。
  // StdinContext 一定存在，而 Ink 实例是以 stdout 为键的；在实践里每个进程
  // 只有一个 Ink 实例，因此这里直接使用 process.stdout 即可。
  useContext(StdinContext) // anchor to App subtree for hook rules
  const ink = instances.get(process.stdout)
  // 进行 memoize，使调用方可以安全地把返回值放进依赖数组中。
  // 对于同一个 stdout，ink 是单例，因此跨 render 保持稳定。
  return useMemo(() => {
    if (!ink) {
      return {
        copySelection: () => '',
        copySelectionNoClear: () => '',
        clearSelection: () => {},
        hasSelection: () => false,
        getState: () => null,
        subscribe: () => () => {},
        shiftAnchor: () => {},
        shiftSelection: () => {},
        moveFocus: () => {},
        captureScrolledRows: () => {},
        setSelectionBgColor: () => {},
      }
    }
    return {
      copySelection: () => ink.copySelection(),
      copySelectionNoClear: () => ink.copySelectionNoClear(),
      clearSelection: () => ink.clearTextSelection(),
      hasSelection: () => ink.hasTextSelection(),
      getState: () => ink.selection,
      subscribe: (cb: () => void) => ink.subscribeToSelectionChange(cb),
      shiftAnchor: (dRow: number, minRow: number, maxRow: number) =>
        shiftAnchor(ink.selection, dRow, minRow, maxRow),
      shiftSelection: (dRow, minRow, maxRow) =>
        ink.shiftSelectionForScroll(dRow, minRow, maxRow),
      moveFocus: (move: FocusMove) => ink.moveSelectionFocus(move),
      captureScrolledRows: (firstRow, lastRow, side) =>
        ink.captureScrolledRows(firstRow, lastRow, side),
      setSelectionBgColor: (color: string) => ink.setSelectionBgColor(color),
    }
  }, [ink])
}

const NO_SUBSCRIBE = () => () => {}
const ALWAYS_FALSE = () => false

/**
 * 响应式的“是否存在选择”状态。当文本选择被创建或清除时，会触发调用方重渲染。
 * 在非全屏模式下始终返回 false（selection 仅在 alt-screen 中可用）。
 */
export function useHasSelection(): boolean {
  useContext(StdinContext)
  const ink = instances.get(process.stdout)
  return useSyncExternalStore(
    ink ? ink.subscribeToSelectionChange : NO_SUBSCRIBE,
    ink ? ink.hasTextSelection : ALWAYS_FALSE,
  )
}
