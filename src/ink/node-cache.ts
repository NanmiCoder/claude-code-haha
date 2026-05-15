import type { DOMElement } from './dom.js'
import type { Rectangle } from './layout/geometry.js'

/**
 * 为每个已渲染节点缓存布局边界（用于 blit 与清理）。
 * `top` 是 Yoga 局部坐标系下的 getComputedTop()，之所以缓存它，是为了让
 * ScrollBox 视口裁剪在处理位置未变化的干净子节点时可以跳过 Yoga 读取，
 * 将首轮开销从 O(mounted) 降到 O(dirty)。
 */
export type CachedLayout = {
  x: number
  y: number
  width: number
  height: number
  top?: number
}

export const nodeCache = new WeakMap<DOMElement, CachedLayout>()

/** 已删除子节点的矩形区域，需要在下一次渲染时清理 */
export const pendingClears = new WeakMap<DOMElement, Rectangle[]>()

/**
 * 当为 absolute 定位节点添加 pendingClear 时置位。
 * 它会通知 renderer 在下一帧禁用 blit：被删除的节点可能覆盖过非兄弟节点
 *（例如树顺序更靠前的 ScrollBox 上方的 overlay），此时若继续从 prevScreen
 * 执行 blit，就会把 overlay 的像素重新恢复出来。普通文档流节点的删除已经由
 * 父节点级别的 hasRemovedChild 处理；只有 absolute 定位才会跨子树绘制。
 * 该标志会在每次渲染开始时重置。
 */
let absoluteNodeRemoved = false

export function addPendingClear(
  parent: DOMElement,
  rect: Rectangle,
  isAbsolute: boolean,
): void {
  const existing = pendingClears.get(parent)
  if (existing) {
    existing.push(rect)
  } else {
    pendingClears.set(parent, [rect])
  }
  if (isAbsolute) {
    absoluteNodeRemoved = true
  }
}

export function consumeAbsoluteRemovedFlag(): boolean {
  const had = absoluteNodeRemoved
  absoluteNodeRemoved = false
  return had
}
