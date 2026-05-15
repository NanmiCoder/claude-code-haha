import type { ParsedKey } from '../parse-keypress.js'
import { TerminalEvent } from './terminal-event.js'

/**
 * 通过 capture/bubble 机制沿 DOM 树分发的键盘事件。
 *
 * 遵循浏览器 KeyboardEvent 的语义：`key` 对于可打印按键是字面字符
 * （'a'、'3'、' '、'/'），对于特殊按键则是多字符名称
 * （'down'、'return'、'escape'、'f1'）。惯用的可打印字符判断方式是
 * `e.key.length === 1`。
 */
export class KeyboardEvent extends TerminalEvent {
  readonly key: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly superKey: boolean
  readonly fn: boolean

  constructor(parsedKey: ParsedKey) {
    super('keydown', { bubbles: true, cancelable: true })

    this.key = keyFromParsed(parsedKey)
    this.ctrl = parsedKey.ctrl
    this.shift = parsedKey.shift
    this.meta = parsedKey.meta || parsedKey.option
    this.superKey = parsedKey.super
    this.fn = parsedKey.fn
  }
}

function keyFromParsed(parsed: ParsedKey): string {
  const seq = parsed.sequence ?? ''
  const name = parsed.name ?? ''

  // Ctrl 组合键：sequence 是控制字节（ctrl+c 为 \x03），name 是字母。
  // 浏览器会把这种情况报告为 e.key === 'c' 且 e.ctrlKey === true。
  if (parsed.ctrl) return name

  // 单个可打印字符（从空格到 ~，以及所有高于 ASCII 的字符）：
  // 直接使用字面字符。浏览器会报告 e.key === '3'，而不是 'Digit3'。
  if (seq.length === 1) {
    const code = seq.charCodeAt(0)
    if (code >= 0x20 && code !== 0x7f) return seq
  }

  // 特殊按键（方向键、F 键、return、tab、escape 等）：sequence
  // 要么是转义序列（\x1b[B），要么是控制字节（\r、\t），因此使用
  // 解析后的 name。浏览器会报告 e.key === 'ArrowDown'。
  return name || seq
}
