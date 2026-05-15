import { sleep } from '../../utils/sleep.js'

/**
 * 面向 PUT /worker（session state + metadata）的合并上传器。
 *
 * - 1 个 in-flight PUT + 1 个待处理 patch
 * - 新调用会并入 pending（永远不会超过 1 个槽位）
 * - 成功时：如果存在 pending 就继续发送
 * - 失败时：使用指数退避（带上限），无限重试
 *   直到成功或 close()。每次重试前都会吸收所有待处理 patch。
 * - 不需要 backpressure——天然只会占用 2 个槽位
 *
 * 合并规则：
 * - 顶层键（worker_status、external_metadata）——最后一个值生效
 * - external_metadata / internal_metadata 内部——按 RFC 7396 合并：
 *   键会被新增/覆盖，null 值会保留（由 server 执行删除）
 */

type WorkerStateUploaderConfig = {
  send: (body: Record<string, unknown>) => Promise<boolean>
  /** 指数退避的基础延迟（毫秒）。 */
  baseDelayMs: number
  /** 最大延迟上限（毫秒）。 */
  maxDelayMs: number
  /** 追加到重试延迟中的随机抖动范围（毫秒）。 */
  jitterMs: number
}

export class WorkerStateUploader {
  private inflight: Promise<void> | null = null
  private pending: Record<string, unknown> | null = null
  private closed = false
  private readonly config: WorkerStateUploaderConfig

  constructor(config: WorkerStateUploaderConfig) {
    this.config = config
  }

  /**
   * 向 PUT /worker 入队一个 patch。会与现有 pending
   * patch 合并。Fire-and-forget，调用方无需 await。
   */
  enqueue(patch: Record<string, unknown>): void {
    if (this.closed) return
    this.pending = this.pending ? coalescePatches(this.pending, patch) : patch
    void this.drain()
  }

  close(): void {
    this.closed = true
    this.pending = null
  }

  private async drain(): Promise<void> {
    if (this.inflight || this.closed) return
    if (!this.pending) return

    const payload = this.pending
    this.pending = null

    this.inflight = this.sendWithRetry(payload).then(() => {
      this.inflight = null
      if (this.pending && !this.closed) {
        void this.drain()
      }
    })
  }

  /** 使用指数退避无限重试，直到成功或 close()。 */
  private async sendWithRetry(payload: Record<string, unknown>): Promise<void> {
    let current = payload
    let failures = 0
    while (!this.closed) {
      const ok = await this.config.send(current)
      if (ok) return

      failures++
      await sleep(this.retryDelay(failures))

      // 吸收重试期间到达的所有 patch
      if (this.pending && !this.closed) {
        current = coalescePatches(current, this.pending)
        this.pending = null
      }
    }
  }

  private retryDelay(failures: number): number {
    const exponential = Math.min(
      this.config.baseDelayMs * 2 ** (failures - 1),
      this.config.maxDelayMs,
    )
    const jitter = Math.random() * this.config.jitterMs
    return exponential + jitter
  }
}

/**
 * 为 PUT /worker 合并两个 patch。
 *
 * 顶层键：overlay 替换 base（最后一个值生效）。
 * 元数据键（external_metadata、internal_metadata）：按 RFC 7396 做一层深度的合并，
 * overlay 的键会新增/覆盖，null 值会保留以供 server 端删除。
 */
function coalescePatches(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base }

  for (const [key, value] of Object.entries(overlay)) {
    if (
      (key === 'external_metadata' || key === 'internal_metadata') &&
      merged[key] &&
      typeof merged[key] === 'object' &&
      typeof value === 'object' &&
      value !== null
    ) {
      // RFC 7396 合并——overlay 的键胜出，null 为 server 保留
      merged[key] = {
        ...(merged[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      }
    } else {
      merged[key] = value
    }
  }

  return merged
}
