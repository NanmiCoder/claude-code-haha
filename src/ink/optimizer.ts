import type { Diff } from './frame.js'

/**
 * 通过单次遍历应用所有优化规则来优化 diff。
 * 这样可以减少最终需要写入终端的 patch 数量。
 *
 * 应用的规则：
 * - 删除空的 stdout patch
 * - 合并连续的 cursorMove patch
 * - 删除无实际效果的 cursorMove (0,0) patch
 * - 拼接相邻的 style patch（它们是 transition diff，任一都不能随意丢弃）
 * - 对连续且 URI 相同的 hyperlink 去重
 * - 抵消成对出现的 cursor hide/show
 * - 删除 count 为 0 的 clear patch
 */
export function optimize(diff: Diff): Diff {
  if (diff.length <= 1) {
    return diff
  }

  const result: Diff = []
  let len = 0

  for (const patch of diff) {
    const type = patch.type

    // 跳过 no-op
    if (type === 'stdout') {
      if (patch.content === '') continue
    } else if (type === 'cursorMove') {
      if (patch.x === 0 && patch.y === 0) continue
    } else if (type === 'clear') {
      if (patch.count === 0) continue
    }

    // 尝试与前一个 patch 合并
    if (len > 0) {
      const lastIdx = len - 1
      const last = result[lastIdx]!
      const lastType = last.type

      // 合并连续的 cursorMove
      if (type === 'cursorMove' && lastType === 'cursorMove') {
        result[lastIdx] = {
          type: 'cursorMove',
          x: last.x + patch.x,
          y: last.y + patch.y,
        }
        continue
      }

      // 折叠连续的 cursorTo（只有最后一个有意义）
      if (type === 'cursorTo' && lastType === 'cursorTo') {
        result[lastIdx] = patch
        continue
      }

      // 拼接相邻的 style patch。styleStr 是 transition diff
      //（由 diffAnsiCodes(from, to) 计算），而不是 setter，因此只有在前一个 patch
      // 的 undo code 是后一个的子集时，丢掉前一个才安全，而这并无保证。
      // 例如 [\e[49m, \e[2m]：若丢掉 bg reset，背景色会通过 BCE 泄漏到后续的
      // \e[2J/\e[2K。
      if (type === 'styleStr' && lastType === 'styleStr') {
        result[lastIdx] = { type: 'styleStr', str: last.str + patch.str }
        continue
      }

      // 超链接去重
      if (
        type === 'hyperlink' &&
        lastType === 'hyperlink' &&
        patch.uri === last.uri
      ) {
        continue
      }

      // 抵消成对的 cursor hide/show
      if (
        (type === 'cursorShow' && lastType === 'cursorHide') ||
        (type === 'cursorHide' && lastType === 'cursorShow')
      ) {
        result.pop()
        len--
        continue
      }
    }

    result.push(patch)
    len++
  }

  return result
}
