/**
 * CSI（Control Sequence Introducer）类型
 *
 * CSI 命令参数使用的枚举与类型。
 */

import { ESC, ESC_TYPE, SEP } from './ansi.js'

export const CSI_PREFIX = ESC + String.fromCharCode(ESC_TYPE.CSI)

/**
 * CSI 参数字节范围
 */
export const CSI_RANGE = {
  PARAM_START: 0x30,
  PARAM_END: 0x3f,
  INTERMEDIATE_START: 0x20,
  INTERMEDIATE_END: 0x2f,
  FINAL_START: 0x40,
  FINAL_END: 0x7e,
} as const

/** 检查某个字节是否为 CSI 参数字节 */
export function isCSIParam(byte: number): boolean {
  return byte >= CSI_RANGE.PARAM_START && byte <= CSI_RANGE.PARAM_END
}

/** 检查某个字节是否为 CSI 中间字节 */
export function isCSIIntermediate(byte: number): boolean {
  return (
    byte >= CSI_RANGE.INTERMEDIATE_START && byte <= CSI_RANGE.INTERMEDIATE_END
  )
}

/** 检查某个字节是否为 CSI 结束字节（@ 到 ~） */
export function isCSIFinal(byte: number): boolean {
  return byte >= CSI_RANGE.FINAL_START && byte <= CSI_RANGE.FINAL_END
}

/**
 * 生成一个 CSI 序列：ESC [ p1;p2;...;pN final
 * 单个参数：按原始 body 处理
 * 多个参数：最后一个作为结束字节，其余参数用 ; 连接
 */
export function csi(...args: (string | number)[]): string {
  if (args.length === 0) return CSI_PREFIX
  if (args.length === 1) return `${CSI_PREFIX}${args[0]}`
  const params = args.slice(0, -1)
  const final = args[args.length - 1]
  return `${CSI_PREFIX}${params.join(SEP)}${final}`
}

/**
 * CSI 结束字节 - 命令标识符
 */
export const CSI = {
  // 光标移动
  CUU: 0x41, // A - Cursor Up
  CUD: 0x42, // B - Cursor Down
  CUF: 0x43, // C - Cursor Forward
  CUB: 0x44, // D - Cursor Back
  CNL: 0x45, // E - Cursor Next Line
  CPL: 0x46, // F - Cursor Previous Line
  CHA: 0x47, // G - Cursor Horizontal Absolute
  CUP: 0x48, // H - Cursor Position
  CHT: 0x49, // I - Cursor Horizontal Tab
  VPA: 0x64, // d - Vertical Position Absolute
  HVP: 0x66, // f - Horizontal Vertical Position

  // 擦除
  ED: 0x4a, // J - Erase in Display
  EL: 0x4b, // K - Erase in Line
  ECH: 0x58, // X - Erase Character

  // 插入/删除
  IL: 0x4c, // L - Insert Lines
  DL: 0x4d, // M - Delete Lines
  ICH: 0x40, // @ - Insert Characters
  DCH: 0x50, // P - Delete Characters

  // 滚动
  SU: 0x53, // S - Scroll Up
  SD: 0x54, // T - Scroll Down

  // 模式
  SM: 0x68, // h - Set Mode
  RM: 0x6c, // l - Reset Mode

  // SGR
  SGR: 0x6d, // m - Select Graphic Rendition

  // 其他
  DSR: 0x6e, // n - Device Status Report
  DECSCUSR: 0x71, // q - Set Cursor Style (with space intermediate)
  DECSTBM: 0x72, // r - Set Top and Bottom Margins
  SCOSC: 0x73, // s - Save Cursor Position
  SCORC: 0x75, // u - Restore Cursor Position
  CBT: 0x5a, // Z - Cursor Backward Tabulation
} as const

/**
 * 擦除显示区域（ED 命令参数）
 */
export const ERASE_DISPLAY = ['toEnd', 'toStart', 'all', 'scrollback'] as const

/**
 * 擦除行区域（EL 命令参数）
 */
export const ERASE_LINE_REGION = ['toEnd', 'toStart', 'all'] as const

/**
 * 光标样式（DECSCUSR）
 */
export type CursorStyle = 'block' | 'underline' | 'bar'

export const CURSOR_STYLES: Array<{ style: CursorStyle; blinking: boolean }> = [
  { style: 'block', blinking: true }, // 0 - default
  { style: 'block', blinking: true }, // 1
  { style: 'block', blinking: false }, // 2
  { style: 'underline', blinking: true }, // 3
  { style: 'underline', blinking: false }, // 4
  { style: 'bar', blinking: true }, // 5
  { style: 'bar', blinking: false }, // 6
]

// 光标移动生成器

/** 光标上移 n 行（CSI n A） */
export function cursorUp(n = 1): string {
  return n === 0 ? '' : csi(n, 'A')
}

/** 光标下移 n 行（CSI n B） */
export function cursorDown(n = 1): string {
  return n === 0 ? '' : csi(n, 'B')
}

/** 光标右移 n 列（CSI n C） */
export function cursorForward(n = 1): string {
  return n === 0 ? '' : csi(n, 'C')
}

/** 光标左移 n 列（CSI n D） */
export function cursorBack(n = 1): string {
  return n === 0 ? '' : csi(n, 'D')
}

/** 将光标移动到第 n 列（1 索引）（CSI n G） */
export function cursorTo(col: number): string {
  return csi(col, 'G')
}

/** 将光标移动到第 1 列（CSI G） */
export const CURSOR_LEFT = csi('G')

/** 将光标移动到 row, col（1 索引）（CSI row ; col H） */
export function cursorPosition(row: number, col: number): string {
  return csi(row, col, 'H')
}

/** 将光标移动到 home 位置（CSI H） */
export const CURSOR_HOME = csi('H')

/**
 * 相对当前位置移动光标
 * x 为正表示向右，负数表示向左
 * y 为正表示向下，负数表示向上
 */
export function cursorMove(x: number, y: number): string {
  let result = ''
  // 先处理水平方向（与 ansi-escapes 的行为一致）
  if (x < 0) {
    result += cursorBack(-x)
  } else if (x > 0) {
    result += cursorForward(x)
  }
  // 再处理垂直方向
  if (y < 0) {
    result += cursorUp(-y)
  } else if (y > 0) {
    result += cursorDown(y)
  }
  return result
}

// 保存/恢复光标位置

/** 保存光标位置（CSI s） */
export const CURSOR_SAVE = csi('s')

/** 恢复光标位置（CSI u） */
export const CURSOR_RESTORE = csi('u')

// 擦除生成器

/** 从光标处擦除到行尾（CSI K） */
export function eraseToEndOfLine(): string {
  return csi('K')
}

/** 从光标处擦除到行首（CSI 1 K） */
export function eraseToStartOfLine(): string {
  return csi(1, 'K')
}

/** 擦除整行（CSI 2 K） */
export function eraseLine(): string {
  return csi(2, 'K')
}

/** 擦除整行 - 常量形式 */
export const ERASE_LINE = csi(2, 'K')

/** 从光标处擦除到屏幕末尾（CSI J） */
export function eraseToEndOfScreen(): string {
  return csi('J')
}

/** 从光标处擦除到屏幕起始位置（CSI 1 J） */
export function eraseToStartOfScreen(): string {
  return csi(1, 'J')
}

/** 擦除整个屏幕（CSI 2 J） */
export function eraseScreen(): string {
  return csi(2, 'J')
}

/** 擦除整个屏幕 - 常量形式 */
export const ERASE_SCREEN = csi(2, 'J')

/** 擦除 scrollback 缓冲区（CSI 3 J） */
export const ERASE_SCROLLBACK = csi(3, 'J')

/**
 * 从光标所在行开始擦除 n 行，并持续向上移动光标
 * 会逐行擦除并上移，最终停在第 1 列
 */
export function eraseLines(n: number): string {
  if (n <= 0) return ''
  let result = ''
  for (let i = 0; i < n; i++) {
    result += ERASE_LINE
    if (i < n - 1) {
      result += cursorUp(1)
    }
  }
  result += CURSOR_LEFT
  return result
}

// 滚动

/** 向上滚动 n 行（CSI n S） */
export function scrollUp(n = 1): string {
  return n === 0 ? '' : csi(n, 'S')
}

/** 向下滚动 n 行（CSI n T） */
export function scrollDown(n = 1): string {
  return n === 0 ? '' : csi(n, 'T')
}

/** 设置滚动区域（DECSTBM，CSI top;bottom r）。1 索引，含端点。 */
export function setScrollRegion(top: number, bottom: number): string {
  return csi(top, bottom, 'r')
}

/** 将滚动区域重置为全屏（DECSTBM，CSI r），并将光标归位。 */
export const RESET_SCROLL_REGION = csi('r')

// Bracketed paste 标记（来自终端的输入，不是输出）
// 当通过 DEC 模式 2004 启用 bracketed paste 后，终端会发送这些标记来界定粘贴内容。

/** 终端在粘贴内容前发送（CSI 200 ~） */
export const PASTE_START = csi('200~')

/** 终端在粘贴内容后发送（CSI 201 ~） */
export const PASTE_END = csi('201~')

// 焦点事件标记（来自终端的输入，不是输出）
// 当通过 DEC 模式 1004 启用焦点事件后，终端会在焦点变化时发送这些标记。

/** 终端获得焦点时发送（CSI I） */
export const FOCUS_IN = csi('I')

/** 终端失去焦点时发送（CSI O） */
export const FOCUS_OUT = csi('O')

// Kitty keyboard protocol（CSI u）
// 用于开启带修饰键信息的增强按键上报
// 参见：https://sw.kovidgoyal.net/kitty/keyboard-protocol/

/**
 * 启用 Kitty keyboard protocol，并开启基础修饰键上报
 * CSI > 1 u - 以 flags=1 压入模式栈（用于消除转义码歧义）
 * 这样 Shift+Enter 会发送 CSI 13;2 u，而不再只是 CR
 */
export const ENABLE_KITTY_KEYBOARD = csi('>1u')

/**
 * 禁用 Kitty keyboard protocol
 * CSI < u - 弹出键盘模式栈
 */
export const DISABLE_KITTY_KEYBOARD = csi('<u')

/**
 * 启用 xterm modifyOtherKeys level 2。
 * tmux 接受的是这个（而不是 kitty 的栈式协议）来开启扩展按键；当
 * extended-keys-format 为 csi-u 时，tmux 随后会以 kitty 格式发出按键。
 */
export const ENABLE_MODIFY_OTHER_KEYS = csi('>4;2m')

/**
 * 禁用 xterm modifyOtherKeys（恢复默认值）。
 */
export const DISABLE_MODIFY_OTHER_KEYS = csi('>4m')
