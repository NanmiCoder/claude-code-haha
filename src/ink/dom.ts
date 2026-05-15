import type { FocusManager } from './focus.js'
import { createLayoutNode } from './layout/engine.js'
import type { LayoutNode } from './layout/node.js'
import { LayoutDisplay, LayoutMeasureMode } from './layout/node.js'
import measureText from './measure-text.js'
import { addPendingClear, nodeCache } from './node-cache.js'
import squashTextNodes from './squash-text-nodes.js'
import type { Styles, TextStyles } from './styles.js'
import { expandTabs } from './tabstops.js'
import wrapText from './wrap-text.js'

type InkNode = {
  parentNode: DOMElement | undefined
  yogaNode?: LayoutNode
  style: Styles
}

export type TextName = '#text'
export type ElementNames =
  | 'ink-root'
  | 'ink-box'
  | 'ink-text'
  | 'ink-virtual-text'
  | 'ink-link'
  | 'ink-progress'
  | 'ink-raw-ansi'

export type NodeNames = ElementNames | TextName

// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMElement = {
  nodeName: ElementNames
  attributes: Record<string, DOMNodeAttribute>
  childNodes: DOMNode[]
  textStyles?: TextStyles

  // 内部属性
  onComputeLayout?: () => void
  onRender?: () => void
  onImmediateRender?: () => void
  // 用于在测试模式下跳过 React 19 effect 双调用产生的空渲染
  hasRenderedContent?: boolean

  // 为 true 时，表示该节点需要重新渲染
  dirty: boolean
  // 由 reconciler 的 hideInstance/unhideInstance 设置；样式更新后仍会保留。
  isHidden?: boolean
  // 由 reconciler 为 capture/bubble dispatcher 设置的事件处理器。
  // 单独存放而不是放进 attributes，避免 handler 身份变化导致节点被标脏，
  // 从而破坏 blit 优化。
  _eventHandlers?: Record<string, unknown>

  // overflow: 'scroll' 盒子的滚动状态。scrollTop 表示内容向下滚动了多少行。
  // scrollHeight / scrollViewportHeight 在渲染时计算，并缓存起来供命令式访问。
  // stickyScroll 会在内容增长时自动把 scrollTop 钉到底部。
  scrollTop?: number
  // 尚未应用到 scrollTop 上的累计滚动增量。renderer 会按每帧
  // SCROLL_MAX_PER_FRAME 行的速度逐步耗尽它，这样快速滑动时就能看到中间帧，
  // 而不是一次性大跳跃。方向反转会自然抵消（纯累加器，不追踪目标值）。
  pendingScrollDelta?: number
  // 虚拟滚动在渲染时使用的 clamp 边界。useVirtualScroll 会写入当前已挂载子节点的
  // 覆盖范围，render-node-to-output 会把 scrollTop 限制在这个范围内。这样当
  // scrollTo 的直接写入跑在 React 异步重渲染前面时，就不会出现白屏；renderer
  // 会先停在已挂载内容的边缘，直到 React 追上来（下一个 commit 会更新这些边界，
  // clamp 随后解除）。Undefined 表示不做 clamp（sticky-scroll、冷启动）。
  scrollClampMin?: number
  scrollClampMax?: number
  scrollHeight?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  stickyScroll?: boolean
  // 由 ScrollBox.scrollToElement 设置；render-node-to-output 会读取
  // el.yogaNode.getComputedTop()（最新值，与 scrollHeight 属于同一轮 Yoga 计算），
  // 然后设置 scrollTop = top + offset，最后清掉该字段。与把数字预先算死的
  // 命令式 scrollTo(N) 不同，元素 ref 会把位置读取延后到绘制时再进行，因此不会
  // 因节流渲染而读到过期值。该行为只生效一次。
  scrollAnchor?: { el: DOMElement; offset: number }
  // 仅设置在 ink-root 上。焦点归 document 所有，任意节点都可以像浏览器的
  // getRootNode() 一样通过 parentNode 向上查找到它。
  focusManager?: FocusManager
  // 在 createInstance 时（reconciler.ts）捕获的 React 组件栈，
  // 例如 ['ToolUseLoader', 'Messages', 'REPL']。仅在设置了
  // CLAUDE_CODE_DEBUG_REPAINTS 时才会填充。findOwnerChainAtRow 会利用它，
  // 将 scrollback-diff 导致的 full reset 归因到真正触发它的组件。
  debugOwnerChain?: string[]
} & InkNode

export type TextNode = {
  nodeName: TextName
  nodeValue: string
} & InkNode

// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMNode<T = { nodeName: NodeNames }> = T extends {
  nodeName: infer U
}
  ? U extends '#text'
    ? TextNode
    : DOMElement
  : never

// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMNodeAttribute = boolean | string | number

export const createNode = (nodeName: ElementNames): DOMElement => {
  const needsYogaNode =
    nodeName !== 'ink-virtual-text' &&
    nodeName !== 'ink-link' &&
    nodeName !== 'ink-progress'
  const node: DOMElement = {
    nodeName,
    style: {},
    attributes: {},
    childNodes: [],
    parentNode: undefined,
    yogaNode: needsYogaNode ? createLayoutNode() : undefined,
    dirty: false,
  }

  if (nodeName === 'ink-text') {
    node.yogaNode?.setMeasureFunc(measureTextNode.bind(null, node))
  } else if (nodeName === 'ink-raw-ansi') {
    node.yogaNode?.setMeasureFunc(measureRawAnsiNode.bind(null, node))
  }

  return node
}

export const appendChildNode = (
  node: DOMElement,
  childNode: DOMElement,
): void => {
  if (childNode.parentNode) {
    removeChildNode(childNode.parentNode, childNode)
  }

  childNode.parentNode = node
  node.childNodes.push(childNode)

  if (childNode.yogaNode) {
    node.yogaNode?.insertChild(
      childNode.yogaNode,
      node.yogaNode.getChildCount(),
    )
  }

  markDirty(node)
}

export const insertBeforeNode = (
  node: DOMElement,
  newChildNode: DOMNode,
  beforeChildNode: DOMNode,
): void => {
  if (newChildNode.parentNode) {
    removeChildNode(newChildNode.parentNode, newChildNode)
  }

  newChildNode.parentNode = node

  const index = node.childNodes.indexOf(beforeChildNode)

  if (index >= 0) {
    // 在修改 childNodes 之前先计算 Yoga 下标。
    // 不能直接使用 DOM 下标，因为有些子节点（例如 ink-progress、ink-link、
    // ink-virtual-text）没有 yogaNode，因此 DOM 下标与 Yoga 下标并不一致。
    let yogaIndex = 0
    if (newChildNode.yogaNode && node.yogaNode) {
      for (let i = 0; i < index; i++) {
        if (node.childNodes[i]?.yogaNode) {
          yogaIndex++
        }
      }
    }

    node.childNodes.splice(index, 0, newChildNode)

    if (newChildNode.yogaNode && node.yogaNode) {
      node.yogaNode.insertChild(newChildNode.yogaNode, yogaIndex)
    }

    markDirty(node)
    return
  }

  node.childNodes.push(newChildNode)

  if (newChildNode.yogaNode) {
    node.yogaNode?.insertChild(
      newChildNode.yogaNode,
      node.yogaNode.getChildCount(),
    )
  }

  markDirty(node)
}

export const removeChildNode = (
  node: DOMElement,
  removeNode: DOMNode,
): void => {
  if (removeNode.yogaNode) {
    removeNode.parentNode?.yogaNode?.removeChild(removeNode.yogaNode)
  }

  // 收集被移除子树中的缓存 rect，供后续清理使用
  collectRemovedRects(node, removeNode)

  removeNode.parentNode = undefined

  const index = node.childNodes.indexOf(removeNode)
  if (index >= 0) {
    node.childNodes.splice(index, 1)
  }

  markDirty(node)
}

function collectRemovedRects(
  parent: DOMElement,
  removed: DOMNode,
  underAbsolute = false,
): void {
  if (removed.nodeName === '#text') return
  const elem = removed as DOMElement
  // 如果被移除子树中的该节点或其任一祖先是 absolute 定位，
  // 那么其绘制过的像素就可能覆盖到非兄弟节点，因此要打上全局禁用 blit 的标记。
  // 普通文档流中的删除只会影响直接兄弟节点，而那部分已有 hasRemovedChild 处理。
  const isAbsolute = underAbsolute || elem.style.position === 'absolute'
  const cached = nodeCache.get(elem)
  if (cached) {
    addPendingClear(parent, cached, isAbsolute)
    nodeCache.delete(elem)
  }
  for (const child of elem.childNodes) {
    collectRemovedRects(parent, child, isAbsolute)
  }
}

export const setAttribute = (
  node: DOMElement,
  key: string,
  value: DOMNodeAttribute,
): void => {
  // 跳过 'children'：React 通过 appendChild/removeChild 管理子节点，
  // 而不是通过 attributes。React 每次都会传入新的 children 引用，若把它当作
  // attribute 跟踪，就会导致每一轮 render 都把整棵树标脏。
  if (key === 'children') {
    return
  }
  // 若未变化则跳过
  if (node.attributes[key] === value) {
    return
  }
  node.attributes[key] = value
  markDirty(node)
}

export const setStyle = (node: DOMNode, style: Styles): void => {
  // Compare style properties to avoid marking dirty unnecessarily.
  // React creates new style objects on every render even when unchanged.
  if (stylesEqual(node.style, style)) {
    return
  }
  node.style = style
  markDirty(node)
}

export const setTextStyles = (
  node: DOMElement,
  textStyles: TextStyles,
): void => {
  // Same dirty-check guard as setStyle: React (and buildTextStyles in Text.tsx)
  // allocate a new textStyles object on every render even when values are
  // unchanged, so compare by value to avoid markDirty -> yoga re-measurement
  // on every Text re-render.
  if (shallowEqual(node.textStyles, textStyles)) {
    return
  }
  node.textStyles = textStyles
  markDirty(node)
}

function stylesEqual(a: Styles, b: Styles): boolean {
  return shallowEqual(a, b)
}

function shallowEqual<T extends object>(
  a: T | undefined,
  b: T | undefined,
): boolean {
  // Fast path: same object reference (or both undefined)
  if (a === b) return true
  if (a === undefined || b === undefined) return false

  // Get all keys from both objects
  const aKeys = Object.keys(a) as (keyof T)[]
  const bKeys = Object.keys(b) as (keyof T)[]

  // Different number of properties
  if (aKeys.length !== bKeys.length) return false

  // Compare each property
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }

  return true
}

export const createTextNode = (text: string): TextNode => {
  const node: TextNode = {
    nodeName: '#text',
    nodeValue: text,
    yogaNode: undefined,
    parentNode: undefined,
    style: {},
  }

  setTextNodeValue(node, text)

  return node
}

const measureTextNode = function (
  node: DOMNode,
  width: number,
  widthMode: LayoutMeasureMode,
): { width: number; height: number } {
  const rawText =
    node.nodeName === '#text' ? node.nodeValue : squashTextNodes(node)

  // Expand tabs for measurement (worst case: 8 spaces each).
  // Actual tab expansion happens in output.ts based on screen position.
  const text = expandTabs(rawText)

  const dimensions = measureText(text, width)

  // Text fits into container, no need to wrap
  if (dimensions.width <= width) {
    return dimensions
  }

  // This is happening when <Box> is shrinking child nodes and layout asks
  // if we can fit this text node in a <1px space, so we just say "no"
  if (dimensions.width >= 1 && width > 0 && width < 1) {
    return dimensions
  }

  // For text with embedded newlines (pre-wrapped content), avoid re-wrapping
  // at measurement width when layout is asking for intrinsic size (Undefined mode).
  // This prevents height inflation during min/max size checks.
  //
  // However, when layout provides an actual constraint (Exactly or AtMost mode),
  // we must respect it and measure at that width. Otherwise, if the actual
  // rendering width is smaller than the natural width, the text will wrap to
  // more lines than layout expects, causing content to be truncated.
  if (text.includes('\n') && widthMode === LayoutMeasureMode.Undefined) {
    const effectiveWidth = Math.max(width, dimensions.width)
    return measureText(text, effectiveWidth)
  }

  const textWrap = node.style?.textWrap ?? 'wrap'
  const wrappedText = wrapText(text, width, textWrap)

  return measureText(wrappedText, width)
}

// ink-raw-ansi nodes hold pre-rendered ANSI strings with known dimensions.
// No stringWidth, no wrapping, no tab expansion — the producer (e.g. ColorDiff)
// already wrapped to the target width and each line is exactly one terminal row.
const measureRawAnsiNode = function (node: DOMElement): {
  width: number
  height: number
} {
  return {
    width: node.attributes['rawWidth'] as number,
    height: node.attributes['rawHeight'] as number,
  }
}

/**
 * Mark a node and all its ancestors as dirty for re-rendering.
 * Also marks yoga dirty for text remeasurement if this is a text node.
 */
export const markDirty = (node?: DOMNode): void => {
  let current: DOMNode | undefined = node
  let markedYoga = false

  while (current) {
    if (current.nodeName !== '#text') {
      ;(current as DOMElement).dirty = true
      // Only mark yoga dirty on leaf nodes that have measure functions
      if (
        !markedYoga &&
        (current.nodeName === 'ink-text' ||
          current.nodeName === 'ink-raw-ansi') &&
        current.yogaNode
      ) {
        current.yogaNode.markDirty()
        markedYoga = true
      }
    }
    current = current.parentNode
  }
}

// Walk to root and call its onRender (the throttled scheduleRender). Use for
// DOM-level mutations (scrollTop changes) that should trigger an Ink frame
// without going through React's reconciler. Pair with markDirty() so the
// renderer knows which subtree to re-evaluate.
export const scheduleRenderFrom = (node?: DOMNode): void => {
  let cur: DOMNode | undefined = node
  while (cur?.parentNode) cur = cur.parentNode
  if (cur && cur.nodeName !== '#text') (cur as DOMElement).onRender?.()
}

export const setTextNodeValue = (node: TextNode, text: string): void => {
  if (typeof text !== 'string') {
    text = String(text)
  }

  // Skip if unchanged
  if (node.nodeValue === text) {
    return
  }

  node.nodeValue = text
  markDirty(node)
}

function isDOMElement(node: DOMElement | TextNode): node is DOMElement {
  return node.nodeName !== '#text'
}

// Clear yogaNode references recursively before freeing.
// freeRecursive() frees the node and ALL its children, so we must clear
// all yogaNode references to prevent dangling pointers.
export const clearYogaNodeReferences = (node: DOMElement | TextNode): void => {
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      clearYogaNodeReferences(child)
    }
  }
  node.yogaNode = undefined
}

/**
 * Find the React component stack responsible for content at screen row `y`.
 *
 * DFS the DOM tree accumulating yoga offsets. Returns the debugOwnerChain of
 * the deepest node whose bounding box contains `y`. Called from ink.tsx when
 * log-update triggers a full reset, to attribute the flicker to its source.
 *
 * Only useful when CLAUDE_CODE_DEBUG_REPAINTS is set (otherwise chains are
 * undefined and this returns []).
 */
export function findOwnerChainAtRow(root: DOMElement, y: number): string[] {
  let best: string[] = []
  walk(root, 0)
  return best

  function walk(node: DOMElement, offsetY: number): void {
    const yoga = node.yogaNode
    if (!yoga || yoga.getDisplay() === LayoutDisplay.None) return

    const top = offsetY + yoga.getComputedTop()
    const height = yoga.getComputedHeight()
    if (y < top || y >= top + height) return

    if (node.debugOwnerChain) best = node.debugOwnerChain

    for (const child of node.childNodes) {
      if (isDOMElement(child)) walk(child, top)
    }
  }
}
