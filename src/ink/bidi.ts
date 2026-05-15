/**
 * 供终端渲染使用的双向文本重排。
 *
 * Windows 上的终端并未实现 Unicode Bidi Algorithm，
 * 因此 RTL 文本（希伯来语、阿拉伯语等）会反向显示。该模块会在 Ink 的
 * LTR 单元格放置循环之前，应用 bidi 算法，将 ClusteredChar 数组从逻辑顺序
 * 重排为视觉顺序。
 *
 * 在 macOS 终端（Terminal.app、iTerm2）中，bidi 原生可用。
 * Windows Terminal（包括 WSL）则没有实现 bidi
 *（https://github.com/microsoft/terminal/issues/538）。
 *
 * 检测方式：Windows Terminal 会设置 WT_SESSION；原生 Windows cmd/conhost
 * 同样缺失 bidi。因此只要运行在 Windows 上，或位于 Windows Terminal 中
 *（涵盖 WSL），我们就启用 bidi 重排。
 */
import bidiFactory from 'bidi-js'

type ClusteredChar = {
  value: string
  width: number
  styleId: number
  hyperlink: string | undefined
}

let bidiInstance: ReturnType<typeof bidiFactory> | undefined
let needsSoftwareBidi: boolean | undefined

function needsBidi(): boolean {
  if (needsSoftwareBidi === undefined) {
    needsSoftwareBidi =
      process.platform === 'win32' ||
      typeof process.env['WT_SESSION'] === 'string' || // WSL in Windows Terminal
      process.env['TERM_PROGRAM'] === 'vscode' // VS Code integrated terminal (xterm.js)
  }
  return needsSoftwareBidi
}

function getBidi() {
  if (!bidiInstance) {
    bidiInstance = bidiFactory()
  }
  return bidiInstance
}

/**
 * 使用 Unicode Bidi Algorithm 将 ClusteredChar 数组从逻辑顺序重排为视觉顺序。
 * 仅在缺少原生 bidi 支持的终端上启用（Windows Terminal、conhost、WSL）。
 *
 * 在支持 bidi 的终端上，直接返回原数组（no-op）。
 */
export function reorderBidi(characters: ClusteredChar[]): ClusteredChar[] {
  if (!needsBidi() || characters.length === 0) {
    return characters
  }

  // 从 clustered chars 构建纯文本字符串，交给 bidi 算法处理
  const plainText = characters.map(c => c.value).join('')

  // 检查是否存在 RTL 字符；如果是纯 LTR，就跳过 bidi
  if (!hasRTLCharacters(plainText)) {
    return characters
  }

  const bidi = getBidi()
  const { levels } = bidi.getEmbeddingLevels(plainText, 'auto')

  // 将 bidi level 映射回 ClusteredChar 下标。
  // 拼接后的字符串里，一个 ClusteredChar 可能对应多个 code unit。
  const charLevels: number[] = []
  let offset = 0
  for (let i = 0; i < characters.length; i++) {
    charLevels.push(levels[offset]!)
    offset += characters[i]!.value.length
  }

  // 虽然可以从 bidi-js 获取重排片段，但这里需要在 ClusteredChar 层级上工作，
  // 而不是字符串层级。因此直接实现标准 bidi 重排：先找到最大 level，
  // 再从 max 递减到 1，反转所有 level >= 当前值的连续区间。
  const reordered = [...characters]
  const maxLevel = Math.max(...charLevels)

  for (let level = maxLevel; level >= 1; level--) {
    let i = 0
    while (i < reordered.length) {
      if (charLevels[i]! >= level) {
        // 找到该连续区间的末尾
        let j = i + 1
        while (j < reordered.length && charLevels[j]! >= level) {
          j++
        }
        // 在两个数组中同时反转该区间
        reverseRange(reordered, i, j - 1)
        reverseRangeNumbers(charLevels, i, j - 1)
        i = j
      } else {
        i++
      }
    }
  }

  return reordered
}

function reverseRange<T>(arr: T[], start: number, end: number): void {
  while (start < end) {
    const temp = arr[start]!
    arr[start] = arr[end]!
    arr[end] = temp
    start++
    end--
  }
}

function reverseRangeNumbers(arr: number[], start: number, end: number): void {
  while (start < end) {
    const temp = arr[start]!
    arr[start] = arr[end]!
    arr[end] = temp
    start++
    end--
  }
}

/**
 * 快速检查是否包含 RTL 字符（希伯来语、阿拉伯语及相关文字）。
 * 以避免在纯 LTR 文本上运行完整的 bidi 算法。
 */
function hasRTLCharacters(text: string): boolean {
  // Hebrew: U+0590-U+05FF, U+FB1D-U+FB4F
  // Arabic: U+0600-U+06FF, U+0750-U+077F, U+08A0-U+08FF, U+FB50-U+FDFF, U+FE70-U+FEFF
  // Thaana: U+0780-U+07BF
  // Syriac: U+0700-U+074F
  return /[\u0590-\u05FF\uFB1D-\uFB4F\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0780-\u07BF\u0700-\u074F]/u.test(
    text,
  )
}
