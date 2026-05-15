// 用于提升 voice_stream 端点 STT 准确率的 voice keyterms。
//
// 提供领域词汇提示（Deepgram "keywords"），让 STT 引擎能够正确识别
// 编码术语、项目名和分支名，避免它们被误听。

import { basename } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'
import { getBranch } from '../utils/git.js'

// ─── 全局 keyterms ────────────────────────────────────────────────

const GLOBAL_KEYTERMS: readonly string[] = [
  // 这些词如果没有 keyword hint，Deepgram 往往会稳定识别错误。
  // 注意："Claude" 和 "Anthropic" 已经是服务端的基础 keyterms。
  // 避免加入那种没人会按字面拼法念出来的词（stdout 往往会念成 "standard out"）。
  'MCP',
  'symlink',
  'grep',
  'regex',
  'localhost',
  'codebase',
  'TypeScript',
  'JSON',
  'OAuth',
  'webhook',
  'gRPC',
  'dotfiles',
  'subagent',
  'worktree',
]

// ─── 辅助函数 ────────────────────────────────────────────────────────

/**
 * 将一个标识符（camelCase、PascalCase、kebab-case、snake_case，或路径片段）
 * 拆分成独立单词。长度不超过 2 个字符的片段会被丢弃，以减少噪声。
 */
export function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[-_./\s]+/)
    .map(w => w.trim())
    .filter(w => w.length > 2 && w.length <= 20)
}

function fileNameWords(filePath: string): string[] {
  const stem = basename(filePath).replace(/\.[^.]+$/, '')
  return splitIdentifier(stem)
}

// ─── 对外 API ─────────────────────────────────────────────────────

const MAX_KEYTERMS = 50

/**
 * 为 voice_stream STT 端点构建一组 keyterms。
 *
 * 无需任何 model 调用，只把硬编码的全局编码术语与会话上下文
 *（项目名、git 分支、最近文件）组合起来。
 */
export async function getVoiceKeyterms(
  recentFiles?: ReadonlySet<string>,
): Promise<string[]> {
  const terms = new Set<string>(GLOBAL_KEYTERMS)

  // 将项目根目录的 basename 作为一个整体 term。
  // 用户说的是类似 "claude CLI internal" 这样的短语，而不是彼此独立的单词。
  // 保留完整 basename，能让 STT 的 keyterm boosting 无论分隔符是什么都匹配到整句。
  try {
    const projectRoot = getProjectRoot()
    if (projectRoot) {
      const name = basename(projectRoot)
      if (name.length > 2 && name.length <= 50) {
        terms.add(name)
      }
    }
  } catch {
    // getProjectRoot() 在尚未初始化时可能抛错，直接忽略即可
  }

  // Git 分支拆词（例如 "feat/voice-keyterms" → "feat"、"voice"、"keyterms"）
  try {
    const branch = await getBranch()
    if (branch) {
      for (const word of splitIdentifier(branch)) {
        terms.add(word)
      }
    }
  } catch {
    // 如果当前不在 git repo 中，getBranch() 可能失败，直接忽略
  }

  // 最近文件名，只扫描到足够填满剩余槽位为止
  if (recentFiles) {
    for (const filePath of recentFiles) {
      if (terms.size >= MAX_KEYTERMS) break
      for (const word of fileNameWords(filePath)) {
        terms.add(word)
      }
    }
  }

  return [...terms].slice(0, MAX_KEYTERMS)
}
