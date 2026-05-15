import { useCallback, useContext, useLayoutEffect, useRef } from 'react'
import { TerminalSizeContext } from '../components/TerminalSizeContext.js'
import type { DOMElement } from '../dom.js'

type ViewportEntry = {
  /**
   * 元素当前是否位于终端视口内
   */
  isVisible: boolean
}

/**
 * 用于检测组件是否位于终端视口内的 hook。
 *
 * 返回一个 callback ref 和一个 viewport entry 对象。
 * 将该 ref 挂到你要跟踪的组件上。
 *
 * entry 会在 layout phase（useLayoutEffect）期间更新，因此调用方在 render
 * 时总能读取到最新值。可见性变化本身不会主动触发重新渲染；调用方如果因其他
 * 原因重新渲染（例如动画 tick、状态变化），会自然拿到最新值。
 * 这样可以避免与其他同样会调用 setState 的 layout effect 组合时出现无限更新循环。
 *
 * @example
 * const [ref, entry] = useTerminalViewport()
 * return <Box ref={ref}><Animation enabled={entry.isVisible}>...</Animation></Box>
 */
export function useTerminalViewport(): [
  ref: (element: DOMElement | null) => void,
  entry: ViewportEntry,
] {
  const terminalSize = useContext(TerminalSizeContext)
  const elementRef = useRef<DOMElement | null>(null)
  const entryRef = useRef<ViewportEntry>({ isVisible: true })

  const setElement = useCallback((el: DOMElement | null) => {
    elementRef.current = el
  }, [])

  // 每次 render 都要执行，因为 Yoga 布局值可能在 React 不知情时发生变化。
  // 这里只更新 ref，不调用 setState，避免在 commit phase 期间级联重渲染。
  // 每次都重新遍历 DOM 祖先链，避免在 Yoga 树重建后持有过期引用。
  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element?.yogaNode || !terminalSize) {
      return
    }

    const height = element.yogaNode.getComputedHeight()
    const rows = terminalSize.rows

    // 遍历 DOM 父链（而不是 yoga.getParent()），这样才能识别滚动容器并减去
    // 它们的 scrollTop。Yoga 计算布局位置时并不包含滚动偏移，scrollTop 是在
    // 渲染时才应用的。没有这一步时，ScrollBox 内 Yoga 位置超过 terminalRows
    // 的元素即使已经被滚动到可见区域，也会被误判为离屏
    // （例如全屏模式下消息积累够多之后的 spinner）。
    let absoluteTop = element.yogaNode.getComputedTop()
    let parent: DOMElement | undefined = element.parentNode
    let root = element.yogaNode
    while (parent) {
      if (parent.yogaNode) {
        absoluteTop += parent.yogaNode.getComputedTop()
        root = parent.yogaNode
      }
      // scrollTop 只会出现在滚动容器上（由 ScrollBox + renderer 设置）。
      // 非滚动节点的 scrollTop 为 undefined，可走这个 falsy 快路径。
      if (parent.scrollTop) absoluteTop -= parent.scrollTop
      parent = parent.parentNode
    }

    // 只有根节点的高度才重要
    const screenHeight = root.getComputedHeight()

    const bottom = absoluteTop + height
    // 当内容溢出视口（screenHeight > rows）时，帧尾的 cursor-restore 会把
    // 额外一行滚进 scrollback。log-update.ts 通过
    // scrollbackRows = viewportY + 1 来处理这一点。
    // 这里必须保持一致，否则边界上的元素会在这里被视为“可见”
    // （动画继续 tick），但其所在行又会被 log-update 当成 scrollback
    // （内容变化 → full reset → 闪烁）。
    const cursorRestoreScroll = screenHeight > rows ? 1 : 0
    const viewportY = Math.max(0, screenHeight - rows) + cursorRestoreScroll
    const viewportBottom = viewportY + rows
    const visible = bottom > viewportY && absoluteTop < viewportBottom

    if (visible !== entryRef.current.isVisible) {
      entryRef.current = { isVisible: visible }
    }
  })

  return [setElement, entryRef.current]
}
