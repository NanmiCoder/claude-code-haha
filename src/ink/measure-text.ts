import { lineWidth } from './line-width-cache.js'

type Output = {
  width: number
  height: number
}

// 单次遍历测量：在一轮迭代中同时计算宽度和高度，
// 而不是分成两轮（widestLine + countVisualLines）。
// 使用 indexOf 来避免 split('\n') 产生的数组分配。
function measureText(text: string, maxWidth: number): Output {
  if (text.length === 0) {
    return {
      width: 0,
      height: 0,
    }
  }

  // 无限宽度或非正宽度表示不换行，即每一行都只对应一条可视行。
  // 必须在循环前判断，因为 Math.ceil(w / Infinity) = 0。
  const noWrap = maxWidth <= 0 || !Number.isFinite(maxWidth)

  let height = 0
  let width = 0
  let start = 0

  while (start <= text.length) {
    const end = text.indexOf('\n', start)
    const line = end === -1 ? text.substring(start) : text.substring(start, end)

    const w = lineWidth(line)
    width = Math.max(width, w)

    if (noWrap) {
      height++
    } else {
      height += w === 0 ? 1 : Math.ceil(w / maxWidth)
    }

    if (end === -1) break
    start = end + 1
  }

  return { width, height }
}

export default measureText
