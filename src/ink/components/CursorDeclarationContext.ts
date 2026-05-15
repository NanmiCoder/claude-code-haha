import { createContext } from 'react'
import type { DOMElement } from '../dom.js'

export type CursorDeclaration = {
  /** 声明节点内部的显示列（按终端单元宽度计算） */
  readonly relativeX: number
  /** 声明节点内部的行号 */
  readonly relativeY: number
  /** 用其 Yoga 布局提供绝对原点的 ink-box DOMElement */
  readonly node: DOMElement
}

/**
 * 声明式光标位置的设置器。
 *
 * 可选的第二个参数让 `null` 成为条件清除：只有当前已声明的节点与
 * `clearIfNode` 匹配时，才会清除声明。这让该 hook 在兄弟组件
 * （例如列表项）之间转移焦点时仍然安全；没有这个节点检查时，
 * 新失焦项触发的清除可能会因 layout effect 的执行顺序覆盖掉
 * 新聚焦兄弟节点刚设置的值。
 */
export type CursorDeclarationSetter = (
  declaration: CursorDeclaration | null,
  clearIfNode?: DOMElement | null,
) => void

const CursorDeclarationContext = createContext<CursorDeclarationSetter>(
  () => {},
)

export default CursorDeclarationContext
