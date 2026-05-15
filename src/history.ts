import { appendFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getProjectRoot, getSessionId } from './bootstrap/state.js'
import { registerCleanup } from './utils/cleanupRegistry.js'
import type { HistoryEntry, PastedContent } from './utils/config.js'
import { logForDebugging } from './utils/debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './utils/envUtils.js'
import { getErrnoCode } from './utils/errors.js'
import { readLinesReverse } from './utils/fsOperations.js'
import { lock } from './utils/lockfile.js'
import {
  hashPastedText,
  retrievePastedText,
  storePastedText,
} from './utils/pasteStore.js'
import { sleep } from './utils/sleep.js'
import { jsonParse, jsonStringify } from './utils/slowOperations.js'

const MAX_HISTORY_ITEMS = 100
const MAX_PASTED_CONTENT_LENGTH = 1024

/**
 * 存储态的粘贴内容：要么是内联内容，要么是指向 paste store 的哈希引用。
 */
type StoredPastedContent = {
  id: number
  type: 'text' | 'image'
  content?: string // 小型粘贴的内联内容
  contentHash?: string // 大型粘贴内容外置存储时使用的哈希引用
  mediaType?: string
  filename?: string
}

/**
 * Claude Code 会解析历史记录中的粘贴内容引用，并回溯匹配到对应的
 * 粘贴内容。引用格式如下：
 *   Text: [Pasted text #1 +10 lines]
 *   Image: [Image #2]
 * 这些编号预计在单个 prompt 内唯一，但不要求跨 prompt 唯一。
 * 我们选择数字自增 ID，因为相较其他方案对用户更友好。
 */

// 注意：原始文本粘贴实现会把类似
// "line1\nline2\nline3" 的输入视为 +2 行，而不是 3 行。这里保留
// 这一行为。
export function getPastedTextRefNumLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) || []).length
}

export function formatPastedTextRef(id: number, numLines: number): string {
  if (numLines === 0) {
    return `[Pasted text #${id}]`
  }
  return `[Pasted text #${id} +${numLines} lines]`
}

export function formatImageRef(id: number): string {
  return `[Image #${id}]`
}

export function parseReferences(
  input: string,
): Array<{ id: number; match: string; index: number }> {
  const referencePattern =
    /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g
  const matches = [...input.matchAll(referencePattern)]
  return matches
    .map(match => ({
      id: parseInt(match[2] || '0'),
      match: match[0],
      index: match.index,
    }))
    .filter(match => match.id > 0)
}

/**
 * 将 input 中的 [Pasted text #N] 占位符替换为其实际内容。
 * Image 引用保持不变——它们会变成 content block，而不是内联文本。
 */
export function expandPastedTextRefs(
  input: string,
  pastedContents: Record<number, PastedContent>,
): string {
  const refs = parseReferences(input)
  let expanded = input
  // 按原始匹配偏移执行 splice，这样粘贴内容里看似占位符的字符串
  // 永远不会被误认为真实引用。逆序处理可确保后面的替换发生后，
  // 前面的偏移仍然有效。
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!
    const content = pastedContents[ref.id]
    if (content?.type !== 'text') continue
    expanded =
      expanded.slice(0, ref.index) +
      content.content +
      expanded.slice(ref.index + ref.match.length)
  }
  return expanded
}

function deserializeLogEntry(line: string): LogEntry {
  return jsonParse(line) as LogEntry
}

async function* makeLogEntryReader(): AsyncGenerator<LogEntry> {
  const currentSession = getSessionId()

  // 先从尚未刷到磁盘的条目开始
  for (let i = pendingEntries.length - 1; i >= 0; i--) {
    yield pendingEntries[i]!
  }

  // 从全局历史文件中读取（所有项目共享）
  const historyPath = join(getClaudeConfigHomeDir(), 'history.jsonl')

  try {
    for await (const line of readLinesReverse(historyPath)) {
      try {
        const entry = deserializeLogEntry(line)
        // removeLastFromHistory 的慢路径：条目在删除前已经被刷盘，
        // 因此要在这里过滤，确保 getHistory（上箭头）和
        // makeHistoryReader（ctrl+r 搜索）都能一致地跳过它。
        if (
          entry.sessionId === currentSession &&
          skippedTimestamps.has(entry.timestamp)
        ) {
          continue
        }
        yield entry
      } catch (error) {
        // 这不是关键错误，直接跳过格式损坏的行即可
        logForDebugging(`Failed to parse history line: ${error}`)
      }
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return
    }
    throw e
  }
}

export async function* makeHistoryReader(): AsyncGenerator<HistoryEntry> {
  for await (const entry of makeLogEntryReader()) {
    yield await logEntryToHistoryEntry(entry)
  }
}

export type TimestampedHistoryEntry = {
  display: string
  timestamp: number
  resolve: () => Promise<HistoryEntry>
}

/**
 * 当前项目在 ctrl+r 选择器中的历史：按 display 文本去重、最新优先，
 * 并附带时间戳。粘贴内容通过 `resolve()` 惰性解析——
 * 选择器列表只读取 display 和 timestamp。
 */
export async function* getTimestampedHistory(): AsyncGenerator<TimestampedHistoryEntry> {
  const currentProject = getProjectRoot()
  const seen = new Set<string>()

  for await (const entry of makeLogEntryReader()) {
    if (!entry || typeof entry.project !== 'string') continue
    if (entry.project !== currentProject) continue
    if (seen.has(entry.display)) continue
    seen.add(entry.display)

    yield {
      display: entry.display,
      timestamp: entry.timestamp,
      resolve: () => logEntryToHistoryEntry(entry),
    }

    if (seen.size >= MAX_HISTORY_ITEMS) return
  }
}

/**
 * 获取当前项目的历史条目，并优先返回当前会话的条目。
 *
 * 当前会话的条目会先于其他会话的条目产出，
 * 这样并发会话的上箭头历史不会互相交错。每组内部都按最新优先。
 * 扫描窗口仍与之前相同，都是 MAX_HISTORY_ITEMS——只是在这个窗口内重新排序，
 * 不会超出该范围。
 */
export async function* getHistory(): AsyncGenerator<HistoryEntry> {
  const currentProject = getProjectRoot()
  const currentSession = getSessionId()
  const otherSessionEntries: LogEntry[] = []
  let yielded = 0

  for await (const entry of makeLogEntryReader()) {
    // 跳过格式损坏的条目（文件损坏、旧格式或无效的 JSON 结构）
    if (!entry || typeof entry.project !== 'string') continue
    if (entry.project !== currentProject) continue

    if (entry.sessionId === currentSession) {
      yield await logEntryToHistoryEntry(entry)
      yielded++
    } else {
      otherSessionEntries.push(entry)
    }

    // 与之前相同的 MAX_HISTORY_ITEMS 窗口——只是窗口内顺序被重排。
    if (yielded + otherSessionEntries.length >= MAX_HISTORY_ITEMS) break
  }

  for (const entry of otherSessionEntries) {
    if (yielded >= MAX_HISTORY_ITEMS) return
    yield await logEntryToHistoryEntry(entry)
    yielded++
  }
}

type LogEntry = {
  display: string
  pastedContents: Record<number, StoredPastedContent>
  timestamp: number
  project: string
  sessionId?: string
}

/**
 * 必要时从 paste store 拉取数据，将存储态粘贴内容解析为完整的 PastedContent。
 */
async function resolveStoredPastedContent(
  stored: StoredPastedContent,
): Promise<PastedContent | null> {
  // 如果有内联内容，直接使用
  if (stored.content) {
    return {
      id: stored.id,
      type: stored.type,
      content: stored.content,
      mediaType: stored.mediaType,
      filename: stored.filename,
    }
  }

  // 如果有哈希引用，则从 paste store 拉取
  if (stored.contentHash) {
    const content = await retrievePastedText(stored.contentHash)
    if (content) {
      return {
        id: stored.id,
        type: stored.type,
        content,
        mediaType: stored.mediaType,
        filename: stored.filename,
      }
    }
  }

  // 内容不可用
  return null
}

/**
 * 通过解析 paste store 引用，将 LogEntry 转换为 HistoryEntry。
 */
async function logEntryToHistoryEntry(entry: LogEntry): Promise<HistoryEntry> {
  const pastedContents: Record<number, PastedContent> = {}

  for (const [id, stored] of Object.entries(entry.pastedContents || {})) {
    const resolved = await resolveStoredPastedContent(stored)
    if (resolved) {
      pastedContents[Number(id)] = resolved
    }
  }

  return {
    display: entry.display,
    pastedContents,
  }
}

let pendingEntries: LogEntry[] = []
let isWriting = false
let currentFlushPromise: Promise<void> | null = null
let cleanupRegistered = false
let lastAddedEntry: LogEntry | null = null
// 已经刷到磁盘、但读取时应跳过的条目时间戳。由 removeLastFromHistory
// 在条目已经越过 pending buffer 时使用。作用域为当前会话
//（进程重启时模块状态会重置）。
const skippedTimestamps = new Set<number>()

// 核心 flush 逻辑：将 pending 条目写入磁盘
async function immediateFlushHistory(): Promise<void> {
  if (pendingEntries.length === 0) {
    return
  }

  let release
  try {
    const historyPath = join(getClaudeConfigHomeDir(), 'history.jsonl')

    // 在获取锁之前确保文件存在（append 模式在缺失时会创建）
    await writeFile(historyPath, '', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'a',
    })

    release = await lock(historyPath, {
      stale: 10000,
      retries: {
        retries: 3,
        minTimeout: 50,
      },
    })

    const jsonLines = pendingEntries.map(entry => jsonStringify(entry) + '\n')
    pendingEntries = []

    await appendFile(historyPath, jsonLines.join(''), { mode: 0o600 })
  } catch (error) {
    logForDebugging(`Failed to write prompt history: ${error}`)
  } finally {
    if (release) {
      await release()
    }
  }
}

async function flushPromptHistory(retries: number): Promise<void> {
  if (isWriting || pendingEntries.length === 0) {
    return
  }

  // 在下一次用户 prompt 之前停止继续尝试刷写历史
  if (retries > 5) {
    return
  }

  isWriting = true

  try {
    await immediateFlushHistory()
  } finally {
    isWriting = false

    if (pendingEntries.length > 0) {
      // 避免在热循环里反复重试
      await sleep(500)

      void flushPromptHistory(retries + 1)
    }
  }
}

async function addToPromptHistory(
  command: HistoryEntry | string,
): Promise<void> {
  const entry =
    typeof command === 'string'
      ? { display: command, pastedContents: {} }
      : command

  const storedPastedContents: Record<number, StoredPastedContent> = {}
  if (entry.pastedContents) {
    for (const [id, content] of Object.entries(entry.pastedContents)) {
      // 过滤掉图片（它们会单独存储在 image-cache 中）
      if (content.type === 'image') {
        continue
      }

      // 小文本内容直接内联存储
      if (content.content.length <= MAX_PASTED_CONTENT_LENGTH) {
        storedPastedContents[Number(id)] = {
          id: content.id,
          type: content.type,
          content: content.content,
          mediaType: content.mediaType,
          filename: content.filename,
        }
      } else {
        // 大文本内容同步计算哈希并存储引用
        // 实际的磁盘写入异步执行（fire-and-forget）
        const hash = hashPastedText(content.content)
        storedPastedContents[Number(id)] = {
          id: content.id,
          type: content.type,
          contentHash: hash,
          mediaType: content.mediaType,
          filename: content.filename,
        }
        // fire-and-forget 的磁盘写入：不要阻塞历史条目的创建
        void storePastedText(hash, content.content)
      }
    }
  }

  const logEntry: LogEntry = {
    ...entry,
    pastedContents: storedPastedContents,
    timestamp: Date.now(),
    project: getProjectRoot(),
    sessionId: getSessionId(),
  }

  pendingEntries.push(logEntry)
  lastAddedEntry = logEntry
  currentFlushPromise = flushPromptHistory(0)
  void currentFlushPromise
}

export function addToHistory(command: HistoryEntry | string): void {
  // 当运行在 Claude Code 的 Tungsten 工具拉起的 tmux 会话中时，跳过历史记录。
  // 这样可避免验证/测试会话污染用户真实的命令历史。
  if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY)) {
    return
  }

  // 首次使用时注册清理逻辑
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      // 如果有正在进行的 flush，则等待它完成
      if (currentFlushPromise) {
        await currentFlushPromise
      }
      // 如果 flush 完成后仍有 pending 条目，则再做一次最终 flush
      if (pendingEntries.length > 0) {
        await immediateFlushHistory()
      }
    })
  }

  void addToPromptHistory(command)
}

export function clearPendingHistoryEntries(): void {
  pendingEntries = []
  lastAddedEntry = null
  skippedTimestamps.clear()
}

/**
 * 撤销最近一次 addToHistory 调用。用于 auto-restore-on-interrupt：
 * 当 Esc 在任何响应到达前回退对话时，这次提交在语义上也应被撤销——
 * 历史条目也应如此，否则上箭头会把恢复的文本显示两次
 *（一次来自输入框，一次来自磁盘）。
 *
 * 快路径会直接从 pending buffer 弹出。如果异步 flush 已经抢先完成
 *（TTFT 通常远大于磁盘写入延迟），则把该条目的时间戳加入 getHistory
 * 查询的 skip-set。一次性语义：清掉已跟踪的条目，因此第二次调用不会做任何事。
 */
export function removeLastFromHistory(): void {
  if (!lastAddedEntry) return
  const entry = lastAddedEntry
  lastAddedEntry = null

  const idx = pendingEntries.lastIndexOf(entry)
  if (idx !== -1) {
    pendingEntries.splice(idx, 1)
  } else {
    skippedTimestamps.add(entry.timestamp)
  }
}
