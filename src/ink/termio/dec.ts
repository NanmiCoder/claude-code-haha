/**
 * DEC（Digital Equipment Corporation）私有模式序列
 *
 * DEC 私有模式使用 CSI ? N h（设置）和 CSI ? N l（重置）格式。
 * 它们是 ANSI 标准之上的终端专有扩展。
 */

import { csi } from './csi.js'

/**
 * DEC 私有模式编号
 */
export const DEC = {
  CURSOR_VISIBLE: 25,
  ALT_SCREEN: 47,
  ALT_SCREEN_CLEAR: 1049,
  MOUSE_NORMAL: 1000,
  MOUSE_BUTTON: 1002,
  MOUSE_ANY: 1003,
  MOUSE_SGR: 1006,
  FOCUS_EVENTS: 1004,
  BRACKETED_PASTE: 2004,
  SYNCHRONIZED_UPDATE: 2026,
} as const

/** 生成 CSI ? N h 序列（设置模式） */
export function decset(mode: number): string {
  return csi(`?${mode}h`)
}

/** 生成 CSI ? N l 序列（重置模式） */
export function decreset(mode: number): string {
  return csi(`?${mode}l`)
}

// 预生成的常用模式序列
export const BSU = decset(DEC.SYNCHRONIZED_UPDATE)
export const ESU = decreset(DEC.SYNCHRONIZED_UPDATE)
export const EBP = decset(DEC.BRACKETED_PASTE)
export const DBP = decreset(DEC.BRACKETED_PASTE)
export const EFE = decset(DEC.FOCUS_EVENTS)
export const DFE = decreset(DEC.FOCUS_EVENTS)
export const SHOW_CURSOR = decset(DEC.CURSOR_VISIBLE)
export const HIDE_CURSOR = decreset(DEC.CURSOR_VISIBLE)
export const ENTER_ALT_SCREEN = decset(DEC.ALT_SCREEN_CLEAR)
export const EXIT_ALT_SCREEN = decreset(DEC.ALT_SCREEN_CLEAR)
// 鼠标跟踪：1000 上报按下/释放/滚轮，1002 增加拖拽事件（button-motion），
// 1003 增加全量移动事件（未按按钮时，用于 hover），1006 使用 SGR 格式
//（CSI < btn;col;row M/m）而不是旧式 X10 字节。组合起来即可支持：
// 滚轮 + 用于选择的点击/拖拽 + hover。
export const ENABLE_MOUSE_TRACKING =
  decset(DEC.MOUSE_NORMAL) +
  decset(DEC.MOUSE_BUTTON) +
  decset(DEC.MOUSE_ANY) +
  decset(DEC.MOUSE_SGR)
export const DISABLE_MOUSE_TRACKING =
  decreset(DEC.MOUSE_SGR) +
  decreset(DEC.MOUSE_ANY) +
  decreset(DEC.MOUSE_BUTTON) +
  decreset(DEC.MOUSE_NORMAL)
