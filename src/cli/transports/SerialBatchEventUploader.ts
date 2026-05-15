import { jsonStringify } from '../../utils/slowOperations.js'

/**
 * 串行有序的事件上传器，支持 batching、retry 与 backpressure。
 *
 * - enqueue() 会把事件加入待发送缓冲区
 * - 任意时刻最多只有 1 个 POST 在飞
 * - 每次 POST 最多发送 maxBatchSize 条
 * - 新事件会在前一个请求进行中持续累积
 * - 发送失败时会做指数退避重试（带上限）
 *   并一直重试到成功或 close()，除非设置了 maxConsecutiveFailures，
 *   这时失败 batch 会被丢弃，drain 会继续处理后续项目
 * - flush() 会阻塞到 pending 为空，并在必要时主动触发 drain
 * - 当达到 maxQueueSize 时，enqueue() 会阻塞形成 backpressure
 */

/**
 * 让 config.send() 抛出该错误，可以让 uploader 在服务端指定的时长后再重试
 *（例如 429 搭配 Retry-After）。当 retryAfterMs 存在时，
 * 它会覆盖本次尝试的指数退避值，但仍会被钳制到 [baseDelayMs, maxDelayMs]，
 * 并再叠加 jitter，避免异常服务端导致客户端热循环或长时间僵死，
 * 也避免共享同一速率限制的多个 session 在同一时刻集体冲上去。
 * 若没有 retryAfterMs，则行为与其他抛错完全一致，也就是走指数退避。
 */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

type SerialBatchEventUploaderConfig<T> = {
  /** 每个 POST 最多包含多少项（1 表示不做 batching）。 */
  maxBatchSize: number
  /**
   * 每个 POST 允许的最大序列化字节数。
   * 第一项无论多大都会被放入；后续项目只有在累计 JSON 字节数不超限时才会继续加入。
   * Undefined 表示不限制字节数，只按条数 batching。
   */
  maxBatchBytes?: number
  /** pending 项达到多少后，enqueue() 会开始阻塞。 */
  maxQueueSize: number
  /** 真正执行 HTTP 调用的函数，payload 格式由调用方决定。 */
  send: (batch: T[]) => Promise<void>
  /** 指数退避的基础延迟（毫秒）。 */
  baseDelayMs: number
  /** 延迟上限（毫秒）。 */
  maxDelayMs: number
  /** 重试延迟上额外附加的随机 jitter 范围（毫秒）。 */
  jitterMs: number
  /**
   * 连续 send() 失败达到这个次数后，直接丢弃当前失败 batch，
   * 并以全新的失败预算继续处理下一个 pending 项。
   * Undefined 表示无限重试，也是默认行为。
   */
  maxConsecutiveFailures?: number
  /** 当某个 batch 因触达 maxConsecutiveFailures 被丢弃时调用。 */
  onBatchDropped?: (batchSize: number, failures: number) => void
}

export class SerialBatchEventUploader<T> {
  private pending: T[] = []
  private pendingAtClose = 0
  private draining = false
  private closed = false
  private backpressureResolvers: Array<() => void> = []
  private sleepResolve: (() => void) | null = null
  private flushResolvers: Array<() => void> = []
  private droppedBatches = 0
  private readonly config: SerialBatchEventUploaderConfig<T>

  constructor(config: SerialBatchEventUploaderConfig<T>) {
    this.config = config
  }

  /**
   * 通过 maxConsecutiveFailures 被丢弃的 batch 的单调递增计数。
   * 调用方可以在 flush() 前后各取一次快照，以检测静默丢弃
   *（因为即便发生丢弃，flush() 依然会正常 resolve）。
   */
  get droppedBatchCount(): number {
    return this.droppedBatches
  }

  /**
   * pending 队列当前深度。
   * close() 之后会返回关闭当刻的数量快照，因为 close() 会清空队列，
   * 但 shutdown 诊断代码可能之后还会读取该值。
   */
  get pendingCount(): number {
    return this.closed ? this.pendingAtClose : this.pending.length
  }

  /**
   * 把事件加入 pending 缓冲区。
   * 若空间充足则立即返回；若缓冲区已满，则会阻塞等待，直到 drain 释放出空间。
   */
  async enqueue(events: T | T[]): Promise<void> {
    if (this.closed) return
    const items = Array.isArray(events) ? events : [events]
    if (items.length === 0) return

    // backpressure：等到队列有空间再继续。
    while (
      this.pending.length + items.length > this.config.maxQueueSize &&
      !this.closed
    ) {
      await new Promise<void>(resolve => {
        this.backpressureResolvers.push(resolve)
      })
    }

    if (this.closed) return
    this.pending.push(...items)
    void this.drain()
  }

  /**
   * 阻塞直到所有 pending 事件都发送完毕。
   * 主要用于 turn 边界与 graceful shutdown。
   */
  flush(): Promise<void> {
    if (this.pending.length === 0 && !this.draining) {
      return Promise.resolve()
    }
    void this.drain()
    return new Promise<void>(resolve => {
      this.flushResolvers.push(resolve)
    })
  }

  /**
   * 丢弃所有 pending 事件并停止处理。
   * 同时会唤醒所有被阻塞的 enqueue() 与 flush() 调用方。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.pendingAtClose = this.pending.length
    this.pending = []
    this.sleepResolve?.()
    this.sleepResolve = null
    for (const resolve of this.backpressureResolvers) resolve()
    this.backpressureResolvers = []
    for (const resolve of this.flushResolvers) resolve()
    this.flushResolvers = []
  }

  /**
   * drain 循环。
   * 任意时刻最多只会有一个实例在运行（由 this.draining 保护）。
   * 它会串行发送 batch，失败时按退避策略无限重试。
   */
  private async drain(): Promise<void> {
    if (this.draining || this.closed) return
    this.draining = true
    let failures = 0

    try {
      while (this.pending.length > 0 && !this.closed) {
        const batch = this.takeBatch()
        if (batch.length === 0) continue

        try {
          await this.config.send(batch)
          failures = 0
        } catch (err) {
          failures++
          if (
            this.config.maxConsecutiveFailures !== undefined &&
            failures >= this.config.maxConsecutiveFailures
          ) {
            this.droppedBatches++
            this.config.onBatchDropped?.(batch.length, failures)
            failures = 0
            this.releaseBackpressure()
            continue
          }
          // 把失败 batch 重新插回队首。
          // 这里用 concat（单次分配），而不是 unshift(...batch)，
          // 避免把所有 pending 项平移 batch.length 次。这个路径只会在失败时触发。
          this.pending = batch.concat(this.pending)
          const retryAfterMs =
            err instanceof RetryableError ? err.retryAfterMs : undefined
          await this.sleep(this.retryDelay(failures, retryAfterMs))
          continue
        }

        // 若腾出了空间，就释放那些因 backpressure 而等待的调用方。
        this.releaseBackpressure()
      }
    } finally {
      this.draining = false
      // 如果队列已经空了，就通知 flush 等待者。
      if (this.pending.length === 0) {
        for (const resolve of this.flushResolvers) resolve()
        this.flushResolvers = []
      }
    }
  }

  /**
   * 从 pending 中提取下一个 batch。
   * 同时遵守 maxBatchSize 与 maxBatchBytes 两个限制。
   * 第一项总会被取走；后续项目只有在加入后累计 JSON 大小仍未超出 maxBatchBytes 时才会继续纳入。
   *
   * 无法序列化的项目（如 BigInt、循环引用、会抛错的 toJSON）会被就地丢弃；
   * 它们本来就永远无法发送，若一直卡在 pending[0]，整个队列都会被毒死，flush() 也会永久挂起。
   */
  private takeBatch(): T[] {
    const { maxBatchSize, maxBatchBytes } = this.config
    if (maxBatchBytes === undefined) {
      return this.pending.splice(0, maxBatchSize)
    }
    let bytes = 0
    let count = 0
    while (count < this.pending.length && count < maxBatchSize) {
      let itemBytes: number
      try {
        itemBytes = Buffer.byteLength(jsonStringify(this.pending[count]))
      } catch {
        this.pending.splice(count, 1)
        continue
      }
      if (count > 0 && bytes + itemBytes > maxBatchBytes) break
      bytes += itemBytes
      count++
    }
    return this.pending.splice(0, count)
  }

  private retryDelay(failures: number, retryAfterMs?: number): number {
    const jitter = Math.random() * this.config.jitterMs
    if (retryAfterMs !== undefined) {
      // 在服务端提示值之上再叠一层 jitter，
      // 可避免多个共享同一速率限制的 session 因收到相同 Retry-After 而同时冲击。
      // 先钳制，再扩散，与指数退避路径保持同样的形状。
      const clamped = Math.max(
        this.config.baseDelayMs,
        Math.min(retryAfterMs, this.config.maxDelayMs),
      )
      return clamped + jitter
    }
    const exponential = Math.min(
      this.config.baseDelayMs * 2 ** (failures - 1),
      this.config.maxDelayMs,
    )
    return exponential + jitter
  }

  private releaseBackpressure(): void {
    const resolvers = this.backpressureResolvers
    this.backpressureResolvers = []
    for (const resolve of resolvers) resolve()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.sleepResolve = resolve
      setTimeout(
        (self, resolve) => {
          self.sleepResolve = null
          resolve()
        },
        ms,
        this,
        resolve,
      )
    })
  }
}
