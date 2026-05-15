/**
 * ESC 序列解析器
 *
 * 处理简单转义序列：ESC + 一个或两个字符
 */

import type { Action } from './types.js'

/**
 * 解析简单 ESC 序列
 *
 * @param chars - ESC 之后的字符（不包含 ESC 本身）
 */
export function parseEsc(chars: string): Action | null {
  if (chars.length === 0) return null

  const first = chars[0]!

  // 完全重置（RIS）
  if (first === 'c') {
    return { type: 'reset' }
  }

  // 保存光标（DECSC）
  if (first === '7') {
    return { type: 'cursor', action: { type: 'save' } }
  }

  // 恢复光标（DECRC）
  if (first === '8') {
    return { type: 'cursor', action: { type: 'restore' } }
  }

  // Index - 向下移动光标（IND）
  if (first === 'D') {
    return {
      type: 'cursor',
      action: { type: 'move', direction: 'down', count: 1 },
    }
  }

  // Reverse index - 向上移动光标（RI）
  if (first === 'M') {
    return {
      type: 'cursor',
      action: { type: 'move', direction: 'up', count: 1 },
    }
  }

  // 下一行（NEL）
  if (first === 'E') {
    return { type: 'cursor', action: { type: 'nextLine', count: 1 } }
  }

  // 设置水平制表位（HTS）
  if (first === 'H') {
    return null // Tab stop, not commonly needed
  }

  // 字符集选择（ESC ( X、ESC ) X 等）- 静默忽略
  if ('()'.includes(first) && chars.length >= 2) {
    return null
  }

  // 未知序列
  return { type: 'unknown', sequence: `\x1b${chars}` }
}
