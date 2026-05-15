/**
 * 带 scrollback 支持的跨平台终端清屏实现。
 * 会检测支持使用 ESC[3J 清除 scrollback 的现代终端。
 */

import {
  CURSOR_HOME,
  csi,
  ERASE_SCREEN,
  ERASE_SCROLLBACK,
} from './termio/csi.js'

// HVP（Horizontal Vertical Position）- 旧版 Windows 的光标归位方式
const CURSOR_HOME_WINDOWS = csi(0, 'f')

function isWindowsTerminal(): boolean {
  return process.platform === 'win32' && !!process.env.WT_SESSION
}

function isMintty(): boolean {
  // mintty 3.1.5+ 会把 TERM_PROGRAM 设为 'mintty'
  if (process.env.TERM_PROGRAM === 'mintty') {
    return true
  }
  // GitBash/MSYS2/MINGW 使用 mintty，并会设置 MSYSTEM
  if (process.platform === 'win32' && process.env.MSYSTEM) {
    return true
  }
  return false
}

function isModernWindowsTerminal(): boolean {
  // Windows Terminal 会设置 WT_SESSION 环境变量
  if (isWindowsTerminal()) {
    return true
  }

  // Windows 上带 ConPTY 支持的 VS Code 集成终端
  if (
    process.platform === 'win32' &&
    process.env.TERM_PROGRAM === 'vscode' &&
    process.env.TERM_PROGRAM_VERSION
  ) {
    return true
  }

  // mintty（GitBash/MSYS2/Cygwin）支持现代转义序列
  if (isMintty()) {
    return true
  }

  return false
}

/**
 * 返回用于清理终端及其 scrollback 的 ANSI 转义序列。
 * 会自动检测终端能力。
 */
export function getClearTerminalSequence(): string {
  if (process.platform === 'win32') {
    if (isModernWindowsTerminal()) {
      return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
    } else {
      // 旧版 Windows 控制台，无法清除 scrollback
      return ERASE_SCREEN + CURSOR_HOME_WINDOWS
    }
  }
  return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
}

/**
 * 清理终端屏幕。在受支持的终端上，也会一并清理 scrollback。
 */
export const clearTerminal = getClearTerminalSequence()
