import { Event } from './event.js'

/**
 * 鼠标点击事件。仅在开启鼠标跟踪时（即位于 <AlternateScreen> 内），
 * 左键无拖拽释放才会触发。
 *
 * 事件会从命中的最深节点沿着 parentNode 向上冒泡。调用
 * stopImmediatePropagation() 可阻止祖先节点的 onClick 触发。
 */
export class ClickEvent extends Event {
  /** 点击位置的屏幕列，0 索引 */
  readonly col: number
  /** 点击位置的屏幕行，0 索引 */
  readonly row: number
  /**
   * 相对于当前 handler 所属 Box 的点击列（col - box.x）。
   * dispatchClick 会在每个 handler 触发前重新计算，因此容器上的 onClick
   * 拿到的是相对于该容器的坐标，而不是点击落点子节点的坐标。
   */
  localCol = 0
  /** 相对于当前 handler 所属 Box 的点击行（row - box.y）。 */
  localRow = 0
  /**
   * 若被点击的单元格没有可见内容，则为 true（即 screen buffer 中未写入，
   * 两个 packed word 都为 0）。handler 可据此忽略文本右侧空白区域的点击，
   * 避免误点空白终端区域时切换状态。
   */
  readonly cellIsBlank: boolean

  constructor(col: number, row: number, cellIsBlank: boolean) {
    super()
    this.col = col
    this.row = row
    this.cellIsBlank = cellIsBlank
  }
}
