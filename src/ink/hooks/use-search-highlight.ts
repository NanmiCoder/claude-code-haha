import { useContext, useMemo } from 'react'
import StdinContext from '../components/StdinContext.js'
import type { DOMElement } from '../dom.js'
import instances from '../instances.js'
import type { MatchPosition } from '../render-to-screen.js'

/**
 * 在 Ink 实例上设置搜索高亮查询。非空时，下一帧会将所有可见匹配项反相显示
 * （SGR 7、screen-buffer overlay，使用与 selection 相同的 damage 机制）。
 * 为空时则清除。
 *
 * 这是屏幕空间上的高亮，它匹配的是渲染后的文本，而不是消息源码文本。
 * 只要最终可见，无论内容来自消息树的哪里（bash 输出、文件路径、错误信息），
 * 都能工作。若查询在源码中能匹配，但渲染后被截断或省略，就不会被高亮；这是
 * 可以接受的，因为我们高亮的是你实际看到的内容。
 */
export function useSearchHighlight(): {
  setQuery: (query: string) => void
  /** 将现有 DOM 子树（来自主树）按其自然高度绘制到一个全新的 Screen 上并扫描。
   *  位置相对于元素本身（row 0 = 元素顶部）。不会复制任何 context，
   *  因为这个元素本身就是在所有真实 provider 下构建出来的。 */
  scanElement: (el: DOMElement) => MatchPosition[]
  /** 基于位置的 CURRENT 高亮。每一帧都会在 positions[currentIdx] + rowOffset
   *  上写入黄色。scan-highlight（对所有匹配做反相）仍会照常运行，这一层只是在
   *  其上叠加。rowOffset 跟踪滚动；positions 保持稳定（相对于消息）。
   *  传入 null 可清除。 */
  setPositions: (
    state: {
      positions: MatchPosition[]
      rowOffset: number
      currentIdx: number
    } | null,
  ) => void
} {
  useContext(StdinContext) // anchor to App subtree for hook rules
  const ink = instances.get(process.stdout)
  return useMemo(() => {
    if (!ink) {
      return {
        setQuery: () => {},
        scanElement: () => [],
        setPositions: () => {},
      }
    }
    return {
      setQuery: (query: string) => ink.setSearchHighlight(query),
      scanElement: (el: DOMElement) => ink.scanElementSubtree(el),
      setPositions: state => ink.setSearchPositions(state),
    }
  }, [ink])
}
