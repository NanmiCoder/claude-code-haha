/**
 * ANSI 解析器 - 语义类型
 *
 * 这些类型表示 ANSI 转义序列的语义含义，
 * 而不是它们的字符串表示形式。设计受 ghostty 基于 action 的方案启发。
 */

// =============================================================================
// 颜色
// =============================================================================

/** 16 色调色板中的命名颜色 */
export type NamedColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'

/** 颜色描述，可为命名色、索引色（256 色）或 RGB */
export type Color =
  | { type: 'named'; name: NamedColor }
  | { type: 'indexed'; index: number } // 0-255
  | { type: 'rgb'; r: number; g: number; b: number }
  | { type: 'default' }

// =============================================================================
// 文本样式
// =============================================================================

/** 下划线样式变体 */
export type UnderlineStyle =
  | 'none'
  | 'single'
  | 'double'
  | 'curly'
  | 'dotted'
  | 'dashed'

/** 文本样式属性，表示当前样式状态 */
export type TextStyle = {
  bold: boolean
  dim: boolean
  italic: boolean
  underline: UnderlineStyle
  blink: boolean
  inverse: boolean
  hidden: boolean
  strikethrough: boolean
  overline: boolean
  fg: Color
  bg: Color
  underlineColor: Color
}

/** 创建默认（重置后）的文本样式 */
export function defaultStyle(): TextStyle {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: 'none',
    blink: false,
    inverse: false,
    hidden: false,
    strikethrough: false,
    overline: false,
    fg: { type: 'default' },
    bg: { type: 'default' },
    underlineColor: { type: 'default' },
  }
}

/** 检查两种样式是否相等 */
export function stylesEqual(a: TextStyle, b: TextStyle): boolean {
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.blink === b.blink &&
    a.inverse === b.inverse &&
    a.hidden === b.hidden &&
    a.strikethrough === b.strikethrough &&
    a.overline === b.overline &&
    colorsEqual(a.fg, b.fg) &&
    colorsEqual(a.bg, b.bg) &&
    colorsEqual(a.underlineColor, b.underlineColor)
  )
}

/** 检查两种颜色是否相等 */
export function colorsEqual(a: Color, b: Color): boolean {
  if (a.type !== b.type) return false
  switch (a.type) {
    case 'named':
      return a.name === (b as typeof a).name
    case 'indexed':
      return a.index === (b as typeof a).index
    case 'rgb':
      return (
        a.r === (b as typeof a).r &&
        a.g === (b as typeof a).g &&
        a.b === (b as typeof a).b
      )
    case 'default':
      return true
  }
}

// =============================================================================
// 光标动作
// =============================================================================

export type CursorDirection = 'up' | 'down' | 'forward' | 'back'

export type CursorAction =
  | { type: 'move'; direction: CursorDirection; count: number }
  | { type: 'position'; row: number; col: number }
  | { type: 'column'; col: number }
  | { type: 'row'; row: number }
  | { type: 'save' }
  | { type: 'restore' }
  | { type: 'show' }
  | { type: 'hide' }
  | {
      type: 'style'
      style: 'block' | 'underline' | 'bar'
      blinking: boolean
    }
  | { type: 'nextLine'; count: number }
  | { type: 'prevLine'; count: number }

// =============================================================================
// 擦除动作
// =============================================================================

export type EraseAction =
  | { type: 'display'; region: 'toEnd' | 'toStart' | 'all' | 'scrollback' }
  | { type: 'line'; region: 'toEnd' | 'toStart' | 'all' }
  | { type: 'chars'; count: number }

// =============================================================================
// 滚动动作
// =============================================================================

export type ScrollAction =
  | { type: 'up'; count: number }
  | { type: 'down'; count: number }
  | { type: 'setRegion'; top: number; bottom: number }

// =============================================================================
// 模式动作
// =============================================================================

export type ModeAction =
  | { type: 'alternateScreen'; enabled: boolean }
  | { type: 'bracketedPaste'; enabled: boolean }
  | { type: 'mouseTracking'; mode: 'off' | 'normal' | 'button' | 'any' }
  | { type: 'focusEvents'; enabled: boolean }

// =============================================================================
// 链接动作（OSC 8）
// =============================================================================

export type LinkAction =
  | { type: 'start'; url: string; params?: Record<string, string> }
  | { type: 'end' }

// =============================================================================
// 标题动作（OSC 0/1/2）
// =============================================================================

export type TitleAction =
  | { type: 'windowTitle'; title: string }
  | { type: 'iconName'; name: string }
  | { type: 'both'; title: string }

// =============================================================================
// 标签状态动作（OSC 21337）
// =============================================================================

/**
 * 每个标签页的 chrome 元数据。每个字段都是三态：
 *  - 属性缺失：序列中未提及，不做修改
 *  - null：显式清除（裸 key，或 key= 且值为空）
 *  - value：设置为该值
 */
export type TabStatusAction = {
  indicator?: Color | null
  status?: string | null
  statusColor?: Color | null
}

// =============================================================================
// 解析后片段 - 解析器的输出
// =============================================================================

/** 一段带样式的文本 */
export type TextSegment = {
  type: 'text'
  text: string
  style: TextStyle
}

/** 带宽度信息的字素（可视字符单元） */
export type Grapheme = {
  value: string
  width: 1 | 2 // 以列为单位的显示宽度
}

/** 所有可能的解析动作 */
export type Action =
  | { type: 'text'; graphemes: Grapheme[]; style: TextStyle }
  | { type: 'cursor'; action: CursorAction }
  | { type: 'erase'; action: EraseAction }
  | { type: 'scroll'; action: ScrollAction }
  | { type: 'mode'; action: ModeAction }
  | { type: 'link'; action: LinkAction }
  | { type: 'title'; action: TitleAction }
  | { type: 'tabStatus'; action: TabStatusAction }
  | { type: 'sgr'; params: string } // Select Graphic Rendition（样式变更）
  | { type: 'bell' }
  | { type: 'reset' } // 完整终端重置（ESC c）
  | { type: 'unknown'; sequence: string } // 无法识别的序列
