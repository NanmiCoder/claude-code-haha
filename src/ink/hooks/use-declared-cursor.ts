import { useCallback, useContext, useLayoutEffect, useRef } from 'react'
import CursorDeclarationContext from '../components/CursorDeclarationContext.js'
import type { DOMElement } from '../dom.js'

/**
 * 声明每一帧结束后终端光标应停放的位置。
 *
 * 终端模拟器会在物理光标位置渲染 IME 预编辑文本，屏幕阅读器 / 放大镜也会
 * 跟踪原生光标，因此把光标停在文本输入框的插入点上，既能让 CJK 输入以内联
 * 方式显示，也能让无障碍工具跟随输入位置。
 *
 * 返回一个 ref callback，用于挂到包含输入框的 Box 上。
 * 声明的 (line, column) 是相对于该 Box 的 nodeCache rect 解释的
 * （由 renderNodeToOutput 填充）。
 *
 * 时序：ref 挂载和 useLayoutEffect 都发生在 React 的 layout phase，
 * 且位于 resetAfterCommit 调用 scheduleRender 之后。scheduleRender
 * 会通过 queueMicrotask 延后 onRender，因此 onRender 会在 layout
 * effects 提交之后才执行，并在首帧读取到最新声明（不会出现按下一次键才跟上
 * 的延迟）。测试环境使用的是 onImmediateRender（同步、无 microtask），
 * 因此测试会在 render 后显式调用 ink.onRender() 进行补偿。
 */
export function useDeclaredCursor({
  line,
  column,
  active,
}: {
  line: number
  column: number
  active: boolean
}): (element: DOMElement | null) => void {
  const setCursorDeclaration = useContext(CursorDeclarationContext)
  const nodeRef = useRef<DOMElement | null>(null)

  const setNode = useCallback((node: DOMElement | null) => {
    nodeRef.current = node
  }, [])

  // active 时无条件设置；inactive 时按条件清除（仅当当前声明的节点就是自己）。
  // 节点身份检查用于处理两个风险：
  //   1. 其他地方被 memo() 包裹的 active 实例（例如 memo 化 Footer 中的
  //      搜索输入框）在本次 commit 中没有重新渲染，这里重新渲染的 inactive
  //      实例不能把它的声明覆盖掉。
  //   2. 兄弟节点交接（例如菜单焦点在列表项之间移动）时，如果焦点移动方向与
  //      兄弟顺序相反，新变为 inactive 的项其 effect 会在新 active 项的 set
  //      之后运行；没有节点检查就会发生覆盖。
  // 不传 dep 数组：必须在每次 commit 时重新声明，这样当别的实例在 unmount
  // 清理或兄弟交接时把值置空后，当前 active 实例才能重新夺回声明。
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (active && node) {
      setCursorDeclaration({ relativeX: column, relativeY: line, node })
    } else {
      setCursorDeclaration(null, node)
    }
  })

  // 在 unmount 时清除（按条件执行，因为届时可能已归其他实例所有）。
  // 单独拆一个空依赖 effect，这样 cleanup 只会触发一次，而不会在每次
  // line/column 变化时触发，避免在两个 commit 之间短暂变成 null。
  useLayoutEffect(() => {
    return () => {
      setCursorDeclaration(null, nodeRef.current)
    }
  }, [setCursorDeclaration])

  return setNode
}
