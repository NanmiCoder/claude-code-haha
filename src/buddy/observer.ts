import type { Message } from '../types/message.js'
import { getCompanion } from './companion.js'
import { getGlobalConfig } from '../utils/config.js'

// 简单的 companion observer：根据最后一条 assistant 消息挑选一个反应。
// 这是一个轻量占位实现，不依赖 LLM 调用，只负责生成一些有趣的反馈。

const DEBUGGING_QUIPS = [
  'Found it!',
  'Interesting...',
  'Have you tried rubber duck debugging?',
  'Stack trace time!',
  'I see what happened.',
]

const GENERAL_QUIPS = [
  'Looking good!',
  'Keep it up!',
  'Nice work!',
  'I believe in you!',
  'You got this!',
]

const CODE_QUIPS = [
  'Fancy!',
  'Clean code!',
  'Elegant solution!',
  'Ship it!',
]

function pickQuip(messages: Message[]): string | undefined {
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
  if (!lastAssistant) return undefined

  const content = Array.isArray(lastAssistant.content)
    ? lastAssistant.content.map(c => (typeof c === 'string' ? c : c.type === 'text' ? c.text : '')).join('')
    : typeof lastAssistant.content === 'string'
      ? lastAssistant.content
      : ''

  if (!content) return undefined

  // 只在少数轮次触发反应（约 5 轮 1 次）。
  if (Math.random() > 0.2) return undefined

  const lower = content.toLowerCase()
  if (lower.includes('error') || lower.includes('bug') || lower.includes('fix') || lower.includes('debug')) {
    return DEBUGGING_QUIPS[Math.floor(Math.random() * DEBUGGING_QUIPS.length)]
  }
  if (lower.includes('function') || lower.includes('class') || lower.includes('const') || lower.includes('```')) {
    return CODE_QUIPS[Math.floor(Math.random() * CODE_QUIPS.length)]
  }
  return GENERAL_QUIPS[Math.floor(Math.random() * GENERAL_QUIPS.length)]
}

export async function fireCompanionObserver(
  messages: Message[],
  onReaction: (reaction: string) => void,
): Promise<void> {
  const companion = getCompanion()
  if (!companion || getGlobalConfig().companionMuted) return

  const quip = pickQuip(messages)
  if (quip) {
    onReaction(quip)
  }
}
