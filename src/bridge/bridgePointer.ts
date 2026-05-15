import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { z } from 'zod/v4'
import { logForDebugging } from '../utils/debug.js'
import { isENOENT } from '../utils/errors.js'
import { getWorktreePathsPortable } from '../utils/getWorktreePathsPortable.js'
import { lazySchema } from '../utils/lazySchema.js'
import {
  getProjectsDir,
  sanitizePath,
} from '../utils/sessionStoragePortable.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'

/**
 * worktree 扇出数量的上限。git worktree list 本身通常有自然上限
 * （50 已经很多了），但这里额外限制并行 stat() 的突发量，并防御异常环境。
 * 超过此值时，--continue 会回退为只检查当前目录。
 */
const MAX_WORKTREE_FANOUT = 50

/**
 * Remote Control session 的 crash-recovery pointer。
 *
 * 在 bridge session 创建后立即写入，session 期间周期性刷新，并在正常关闭时
 * 清除。如果进程异常退出（crash、kill -9、终端关闭），pointer 会保留。
 * 下次启动时，`claude remote-control` 会检测到它，并通过 #20460 的
 * --session-id 流程提供恢复选项。
 *
 * 陈旧性通过文件 mtime 检查（而不是嵌入时间戳），这样即便内容不变，周期性
 * 重写也能起到刷新作用。这与后端滚动 BRIDGE_LAST_POLL_TTL（4h）的语义一致。
 * 一个已轮询 5 小时以上后崩溃的 bridge，只要刷新发生在窗口期内，pointer
 * 仍然是新的。
 *
 * 它按工作目录隔离存放（与 transcript JSONL 文件同级），这样不同仓库里的
 * 两个并发 bridge 不会互相覆盖。
 */

export const BRIDGE_POINTER_TTL_MS = 4 * 60 * 60 * 1000

const BridgePointerSchema = lazySchema(() =>
  z.object({
    sessionId: z.string(),
    environmentId: z.string(),
    source: z.enum(['standalone', 'repl']),
  }),
)

export type BridgePointer = z.infer<ReturnType<typeof BridgePointerSchema>>

export function getBridgePointerPath(dir: string): string {
  return join(getProjectsDir(), sanitizePath(dir), 'bridge-pointer.json')
}

/**
 * 写入 pointer。长 session 期间也用它来刷新 mtime。即使用相同 ID 调用，
 * 也会以一次低成本、内容不变的写入推进陈旧性时钟。Best-effort 原则：
 * crash-recovery 文件本身绝不能引发崩溃。错误只记录日志并吞掉。
 */
export async function writeBridgePointer(
  dir: string,
  pointer: BridgePointer,
): Promise<void> {
  const path = getBridgePointerPath(dir)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, jsonStringify(pointer), 'utf8')
    logForDebugging(`[bridge:pointer] wrote ${path}`)
  } catch (err: unknown) {
    logForDebugging(`[bridge:pointer] write failed: ${err}`, { level: 'warn' })
  }
}

/**
 * 读取 pointer 及其年龄（距离上次写入经过的毫秒数）。直接操作并自行处理错误，
 * 不做存在性检查（遵守 CLAUDE.md 的 TOCTOU 规则）。任意失败都返回 null：
 * 文件缺失、JSON 损坏、schema 不匹配或已过期（mtime 超过 4 小时）。
 * 过期/无效的 pointer 会被删除，避免在后端已 GC 掉 env 后仍反复提示用户。
 */
export async function readBridgePointer(
  dir: string,
): Promise<(BridgePointer & { ageMs: number }) | null> {
  const path = getBridgePointerPath(dir)
  let raw: string
  let mtimeMs: number
  try {
    // 先 stat 获取 mtime（陈旧性的锚点），再读取。虽然是两次 syscall，
    // 但两者都需要，因为 mtime 本身就是要返回的数据，而不是 TOCTOU 防护。
    mtimeMs = (await stat(path)).mtimeMs
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }

  const parsed = BridgePointerSchema().safeParse(safeJsonParse(raw))
  if (!parsed.success) {
    logForDebugging(`[bridge:pointer] invalid schema, clearing: ${path}`)
    await clearBridgePointer(dir)
    return null
  }

  const ageMs = Math.max(0, Date.now() - mtimeMs)
  if (ageMs > BRIDGE_POINTER_TTL_MS) {
    logForDebugging(`[bridge:pointer] stale (>4h mtime), clearing: ${path}`)
    await clearBridgePointer(dir)
    return null
  }

  return { ...parsed.data, ageMs }
}

/**
 * 面向 `--continue` 的 worktree 感知读取。REPL bridge 会把 pointer 写到
 * `getOriginalCwd()`，而 EnterWorktreeTool/activeWorktreeSession 可能把它改成
 * worktree 路径；但 `claude remote-control --continue` 运行时的 `resolve('.')`
 * 等于 shell CWD。这里会在 git worktree 同级目录间扇出搜索，找出最新的
 * pointer，以匹配 /resume 的语义。
 *
 * 快速路径：先检查 `dir`。只有在这里没命中时才执行 `git worktree list`。
 * 常见情况（pointer 就在启动目录）只需一次 stat、零次 exec。扇出读取并行进行，
 * 且受 MAX_WORKTREE_FANOUT 限制。
 *
 * 返回 pointer 以及找到它的目录，这样调用方在恢复失败时能清理正确的文件。
 */
export async function readBridgePointerAcrossWorktrees(
  dir: string,
): Promise<{ pointer: BridgePointer & { ageMs: number }; dir: string } | null> {
  // 快速路径：当前目录。覆盖 standalone bridge（始终匹配）以及
  // 未发生 worktree 迁移时的 REPL bridge。
  const here = await readBridgePointer(dir)
  if (here) {
    return { pointer: here, dir }
  }

  // 扇出：扫描 worktree 同级目录。getWorktreePathsPortable 有 5s 超时，
  // 并在任意错误时返回 []（例如不是 git 仓库、未安装 git）。
  const worktrees = await getWorktreePathsPortable(dir)
  if (worktrees.length <= 1) return null
  if (worktrees.length > MAX_WORKTREE_FANOUT) {
    logForDebugging(
      `[bridge:pointer] ${worktrees.length} worktrees exceeds fanout cap ${MAX_WORKTREE_FANOUT}, skipping`,
    )
    return null
  }

  // 相对 `dir` 去重，避免重复 stat。sanitizePath 会标准化大小写和分隔符，
  // 因此即使在 Windows 上 git 输出 C:/ 而存储的是 c:/，也能与快速路径键匹配。
  const dirKey = sanitizePath(dir)
  const candidates = worktrees.filter(wt => sanitizePath(wt) !== dirKey)

  // 并行执行 stat+read。每个 readBridgePointer 对于没有 pointer 的 worktree
  // 都只是一次很便宜的 ENOENT stat()；少数存在 pointer 的情况则多一次约 100B
  // 的读取。Promise.all 的延迟约等于最慢那次 stat。
  const results = await Promise.all(
    candidates.map(async wt => {
      const p = await readBridgePointer(wt)
      return p ? { pointer: p, dir: wt } : null
    }),
  )

  // 选择最新的那个（ageMs 最小）。pointer 存有 environmentId，因此无论
  // --continue 是从哪个 worktree 调起，resume 都能连回正确的 env。
  let freshest: {
    pointer: BridgePointer & { ageMs: number }
    dir: string
  } | null = null
  for (const r of results) {
    if (r && (!freshest || r.pointer.ageMs < freshest.pointer.ageMs)) {
      freshest = r
    }
  }
  if (freshest) {
    logForDebugging(
      `[bridge:pointer] fanout found pointer in worktree ${freshest.dir} (ageMs=${freshest.pointer.ageMs})`,
    )
  }
  return freshest
}

/**
 * 删除 pointer。该操作是幂等的；如果进程之前已经正常关闭，则出现 ENOENT
 * 是预期行为。
 */
export async function clearBridgePointer(dir: string): Promise<void> {
  const path = getBridgePointerPath(dir)
  try {
    await unlink(path)
    logForDebugging(`[bridge:pointer] cleared ${path}`)
  } catch (err: unknown) {
    if (!isENOENT(err)) {
      logForDebugging(`[bridge:pointer] clear failed: ${err}`, {
        level: 'warn',
      })
    }
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return jsonParse(raw)
  } catch {
    return null
  }
}
