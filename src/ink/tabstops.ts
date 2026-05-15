// Tab 展开逻辑，灵感来自 Ghostty 的 Tabstops.zig
// 使用 8 列间隔（POSIX 默认值，在 Ghostty 等终端中也是硬编码的）

import { stringWidth } from './stringWidth.js'
import { createTokenizer } from './termio/tokenize.js'

const DEFAULT_TAB_INTERVAL = 8

export function expandTabs(
  text: string,
  interval = DEFAULT_TAB_INTERVAL,
): string {
  if (!text.includes('\t')) {
    return text
  }

  const tokenizer = createTokenizer()
  const tokens = tokenizer.feed(text)
  tokens.push(...tokenizer.flush())

  let result = ''
  let column = 0

  for (const token of tokens) {
    if (token.type === 'sequence') {
      result += token.value
    } else {
      const parts = token.value.split(/(\t|\n)/)
      for (const part of parts) {
        if (part === '\t') {
          const spaces = interval - (column % interval)
          result += ' '.repeat(spaces)
          column += spaces
        } else if (part === '\n') {
          result += part
          column = 0
        } else {
          result += part
          column += stringWidth(part)
        }
      }
    }
  }

  return result
}
