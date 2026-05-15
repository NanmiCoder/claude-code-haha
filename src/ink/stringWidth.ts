import emojiRegex from 'emoji-regex'
import { eastAsianWidth } from 'get-east-asian-width'
import stripAnsi from 'strip-ansi'
import { getGraphemeSegmenter } from '../utils/intl.js'

const EMOJI_REGEX = emojiRegex()

/**
 * 当 Bun.stringWidth 不可用时，stringWidth 的 JavaScript 兜底实现。
 *
 * 获取字符串在终端中显示时的宽度。
 *
 * 这是比 string-width 包更准确的替代实现，能够正确处理像 ⚠ (U+26A0)
 * 这样的字符，而 string-width 会错误地把它报告为宽度 2。
 *
 * 该实现直接使用 eastAsianWidth，并设置 ambiguousAsWide: false，
 * 从而按照 Unicode 标准针对西文环境的建议，把宽度有歧义的字符正确地视为窄字符
 *（宽度 1）。
 */
function stringWidthJavaScript(str: string): number {
  if (typeof str !== 'string' || str.length === 0) {
    return 0
  }

  // 快路径：纯 ASCII 字符串（无 ANSI 码、无宽字符）
  let isPureAscii = true
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    // 检查是否包含非 ASCII 字符或 ANSI 转义（0x1b）
    if (code >= 127 || code === 0x1b) {
      isPureAscii = false
      break
    }
  }
  if (isPureAscii) {
    // 统计可打印字符数量（排除控制字符）
    let width = 0
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i)
      if (code > 0x1f) {
        width++
      }
    }
    return width
  }

  // 若存在转义字符，则先去掉 ANSI 序列
  if (str.includes('\x1b')) {
    str = stripAnsi(str)
    if (str.length === 0) {
      return 0
    }
  }

  // 快路径：简单 Unicode（无 emoji、variation selector 或 joiner）
  if (!needsSegmentation(str)) {
    let width = 0
    for (const char of str) {
      const codePoint = char.codePointAt(0)!
      if (!isZeroWidth(codePoint)) {
        width += eastAsianWidth(codePoint, { ambiguousAsWide: false })
      }
    }
    return width
  }

  let width = 0

  for (const { segment: grapheme } of getGraphemeSegmenter().segment(str)) {
    // 优先检查 emoji（大多数 emoji 序列宽度为 2）
    EMOJI_REGEX.lastIndex = 0
    if (EMOJI_REGEX.test(grapheme)) {
      width += getEmojiWidth(grapheme)
      continue
    }

    // 计算非 emoji 字素的宽度。
    // 对于字素簇（例如包含 virama+ZWJ 的天城文连字），只统计第一个非零宽字符的宽度，
    // 因为整个字素簇会渲染成一个字形。
    for (const char of grapheme) {
      const codePoint = char.codePointAt(0)!
      if (!isZeroWidth(codePoint)) {
        width += eastAsianWidth(codePoint, { ambiguousAsWide: false })
        break
      }
    }
  }

  return width
}

function needsSegmentation(str: string): boolean {
  for (const char of str) {
    const cp = char.codePointAt(0)!
    // Emoji ranges
    if (cp >= 0x1f300 && cp <= 0x1faff) return true
    if (cp >= 0x2600 && cp <= 0x27bf) return true
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true
    // Variation selectors, ZWJ
    if (cp >= 0xfe00 && cp <= 0xfe0f) return true
    if (cp === 0x200d) return true
  }
  return false
}

function getEmojiWidth(grapheme: string): number {
  // 区域指示符：单个宽度为 1，成对时宽度为 2
  const first = grapheme.codePointAt(0)!
  if (first >= 0x1f1e6 && first <= 0x1f1ff) {
    let count = 0
    for (const _ of grapheme) count++
    return count === 1 ? 1 : 2
  }

  // 不完整的 keycap：数字 / 符号 + VS16，但不含 U+20E3
  if (grapheme.length === 2) {
    const second = grapheme.codePointAt(1)
    if (
      second === 0xfe0f &&
      ((first >= 0x30 && first <= 0x39) || first === 0x23 || first === 0x2a)
    ) {
      return 1
    }
  }

  return 2
}

function isZeroWidth(codePoint: number): boolean {
  // 常见可打印区间的快路径
  if (codePoint >= 0x20 && codePoint < 0x7f) return false
  if (codePoint >= 0xa0 && codePoint < 0x0300) return codePoint === 0x00ad

  // 控制字符
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true

  // 零宽与不可见字符
  if (
    (codePoint >= 0x200b && codePoint <= 0x200d) || // ZW space/joiner
    codePoint === 0xfeff || // BOM
    (codePoint >= 0x2060 && codePoint <= 0x2064) // Word joiner etc.
  ) {
    return true
  }

  // 变体选择符
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return true
  }

  // 组合附加符号
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return true
  }

  // 印度文字组合标记（覆盖天城文到马拉雅拉姆文）
  if (codePoint >= 0x0900 && codePoint <= 0x0d4f) {
    // 各文字块起始处的符号与元音记号
    const offset = codePoint & 0x7f
    if (offset <= 0x03) return true // 文字块起始处的符号
    if (offset >= 0x3a && offset <= 0x4f) return true // 元音符号、virama
    if (offset >= 0x51 && offset <= 0x57) return true // 重音符号
    if (offset >= 0x62 && offset <= 0x63) return true // 元音符号
  }

  // 泰语 / 老挝语组合标记
  // 注意：U+0E32（SARA AA）、U+0E33（SARA AM）、U+0EB2、U+0EB3 是占位元音
  //（宽度 1），不是组合标记。
  if (
    codePoint === 0x0e31 || // Thai MAI HAN-AKAT
    (codePoint >= 0x0e34 && codePoint <= 0x0e3a) || // Thai vowel signs (skip U+0E32, U+0E33)
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) || // Thai vowel signs and marks
    codePoint === 0x0eb1 || // Lao MAI KAN
    (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) || // Lao vowel signs (skip U+0EB2, U+0EB3)
    (codePoint >= 0x0ec8 && codePoint <= 0x0ecd) // Lao tone marks
  ) {
    return true
  }

  // 阿拉伯文格式控制字符
  if (
    (codePoint >= 0x0600 && codePoint <= 0x0605) ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    codePoint === 0x08e2
  ) {
    return true
  }

  // 代理项、tag 字符
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true

  return false
}

// 注意：像天城文 क्ष（ka+virama+ZWJ+ssa）这样的复杂文字字素虽然会渲染成一个
// 连字字形，但会占用 2 个终端单元格（wcwidth 会累加其基础辅音）。
// Bun.stringWidth=2 与终端单元格分配一致，这正是光标定位所需要的行为；
// 若使用 JS 兜底实现给出的 1 列字素簇宽度，会让 Ink 的布局与终端实际显示失步。
//
// Bun.stringWidth 会在模块作用域解析一次，而不是每次调用都检查；
// typeof 守卫会让属性访问失去优化，而这里本身就是热点路径（约 10 万次调用 / 帧）。
const bunStringWidth =
  typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function'
    ? Bun.stringWidth
    : null

const BUN_STRING_WIDTH_OPTS = { ambiguousIsNarrow: true } as const

export const stringWidth: (str: string) => number = bunStringWidth
  ? str => bunStringWidth(str, BUN_STRING_WIDTH_OPTS)
  : stringWidthJavaScript
