/**
 * Memory 目录扫描原语。它从 findRelevantMemories.ts 中拆出，
 * 这样 extractMemories 就能引入扫描逻辑，而不用连带引入 sideQuery 和
 * API 客户端链（它们曾通过 memdir.ts 形成一个循环——#25372）。
 */

import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { type MemoryType, parseMemoryType } from './memoryTypes.js'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

const MAX_MEMORY_FILES = 200
const FRONTMATTER_MAX_LINES = 30

/**
 * 扫描 memory 目录中的 .md 文件，读取它们的 frontmatter，并返回一个按最新优先
 * 排序的 header 列表（上限为 MAX_MEMORY_FILES）。由 findRelevantMemories
 *（查询时 recall）和 extractMemories（预先注入列表，避免 extraction agent
 * 把一轮浪费在 `ls` 上）共享。
 *
 * 单次遍历：readFileInRange 会在内部取 stat 并返回 mtimeMs，因此我们选择
 * 先读后排，而不是先 stat 再排再读。对常见场景（N ≤ 200）来说，
 * 这相比单独做一轮 stat 能把系统调用数减半；对大 N 情况，我们会多读几个
 * 小文件，但仍能避免对最终保留下来的 200 个文件做双重 stat。
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const mdFiles = entries.filter(
      f => f.endsWith('.md') && basename(f) !== 'MEMORY.md',
    )

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath)
        const { content, mtimeMs } = await readFileInRange(
          filePath,
          0,
          FRONTMATTER_MAX_LINES,
          undefined,
          signal,
        )
        const { frontmatter } = parseFrontmatter(content, filePath)
        return {
          filename: relativePath,
          filePath,
          mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.type),
        }
      }),
    )

    return headerResults
      .filter(
        (r): r is PromiseFulfilledResult<MemoryHeader> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES)
  } catch {
    return []
  }
}

/**
 * 将 memory headers 格式化为文本清单：每个文件一行，格式为
 * [type] filename (timestamp): description。供 recall selector prompt
 * 和 extraction-agent prompt 共同使用。
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
