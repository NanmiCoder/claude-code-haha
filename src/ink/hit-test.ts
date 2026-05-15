import type { DOMElement } from './dom.js'
import { ClickEvent } from './events/click-event.js'
import type { EventHandlerProps } from './events/event-handlers.js'
import { nodeCache } from './node-cache.js'

/**
 * 找到渲染矩形中包含 (col, row) 的最深层 DOM 元素。
 *
 * 使用 renderNodeToOutput 填充的 nodeCache，其中 rect 已是屏幕坐标，
 * 所有偏移（包括 scrollTop 平移）都已生效。子节点会倒序遍历，因此后绘制的兄弟节点
 *（位于上层）会优先生效。不在 nodeCache 中的节点（本帧未渲染，或没有 yogaNode）
 * 会连同其整棵子树一起被跳过。
 *
 * 即使命中的节点本身没有 onClick，也会返回它，因为 dispatchClick 还会沿着
 * parentNode 向上查找 handler。
 */
export function hitTest(
  node: DOMElement,
  col: number,
  row: number,
): DOMElement | null {
  const rect = nodeCache.get(node)
  if (!rect) return null
  if (
    col < rect.x ||
    col >= rect.x + rect.width ||
    row < rect.y ||
    row >= rect.y + rect.height
  ) {
    return null
  }
  // 后出现的兄弟节点绘制在上层，因此倒序遍历才能返回最上面的命中项。
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i]!
    if (child.nodeName === '#text') continue
    const hit = hitTest(child, col, row)
    if (hit) return hit
  }
  return node
}

/**
 * 在根节点上对 (col, row) 做 hit-test，并将 ClickEvent 从最深层命中节点沿着
 * parentNode 向上冒泡。只有带 onClick handler 的节点会触发。若某个 handler
 * 调用了 stopImmediatePropagation()，就会停止传播。只要至少触发了一个 onClick
 * handler，就返回 true。
 */
export function dispatchClick(
  root: DOMElement,
  col: number,
  row: number,
  cellIsBlank = false,
): boolean {
  let target: DOMElement | undefined = hitTest(root, col, row) ?? undefined
  if (!target) return false

  // 点击即聚焦：找到最近的可聚焦祖先并让它获得焦点。
  // root 总是 ink-root，它持有 FocusManager。
  if (root.focusManager) {
    let focusTarget: DOMElement | undefined = target
    while (focusTarget) {
      if (typeof focusTarget.attributes['tabIndex'] === 'number') {
        root.focusManager.handleClickFocus(focusTarget)
        break
      }
      focusTarget = focusTarget.parentNode
    }
  }
  const event = new ClickEvent(col, row, cellIsBlank)
  let handled = false
  while (target) {
    const handler = target._eventHandlers?.onClick as
      | ((event: ClickEvent) => void)
      | undefined
    if (handler) {
      handled = true
      const rect = nodeCache.get(target)
      if (rect) {
        event.localCol = col - rect.x
        event.localRow = row - rect.y
      }
      handler(event)
      if (event.didStopImmediatePropagation()) return true
    }
    target = target.parentNode
  }
  return handled
}

/**
 * 当指针移动时触发 onMouseEnter/onMouseLeave。它与 DOM 的
 * mouseenter/mouseleave 一致：不会冒泡，因此在子节点之间移动时不会在父节点上
 * 重新触发。实现方式是从命中节点向上收集所有带 hover handler 的祖先，
 * 与上一次 hovered 集合做 diff，然后对已离开的节点触发 leave，
 * 对新进入的节点触发 enter。
 *
 * 会原地修改 `hovered`，这样调用方（App 实例）就能在多次调用之间持有它。
 * 当 hit 为 null 时（光标移入未渲染间隙，或移出根 rect），会清空该集合。
 */
export function dispatchHover(
  root: DOMElement,
  col: number,
  row: number,
  hovered: Set<DOMElement>,
): void {
  const next = new Set<DOMElement>()
  let node: DOMElement | undefined = hitTest(root, col, row) ?? undefined
  while (node) {
    const h = node._eventHandlers as EventHandlerProps | undefined
    if (h?.onMouseEnter || h?.onMouseLeave) next.add(node)
    node = node.parentNode
  }
  for (const old of hovered) {
    if (!next.has(old)) {
      hovered.delete(old)
      // 跳过已脱离树的节点上的 handler（它们在两次鼠标事件之间被移除了）
      if (old.parentNode) {
        ;(old._eventHandlers as EventHandlerProps | undefined)?.onMouseLeave?.()
      }
    }
  }
  for (const n of next) {
    if (!hovered.has(n)) {
      hovered.add(n)
      ;(n._eventHandlers as EventHandlerProps | undefined)?.onMouseEnter?.()
    }
  }
}
