import axios, { type AxiosError } from 'axios'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { SerialBatchEventUploader } from './SerialBatchEventUploader.js'
import {
  WebSocketTransport,
  type WebSocketTransportOptions,
} from './WebSocketTransport.js'

const BATCH_FLUSH_INTERVAL_MS = 100
// 每次 POST 尝试的超时时间。
// 它限制了单次卡死 POST 能阻塞串行队列多久；没有它，挂死连接会拖住所有写入。
const POST_TIMEOUT_MS = 15_000
// close() 时为排队写入保留的宽限期。
// 它覆盖一次健康 POST（约 100ms）再加一点余量；这只是 best-effort，
// 不是退化网络下的交付保证。
// 由于这段逻辑是 void 掉的，没人会 await，因此它只是最后兜底；
// replBridge teardown 现在会在 archive 之后才 close，archive 延迟才是主要 drain 窗口。
// 注意：gracefulShutdown 的 cleanup 预算其实是 2 秒，而不是外层 5 秒 failsafe；
// 3s here exceeds it, but the process lives ~2s longer for hooks+analytics.
const CLOSE_GRACE_MS = 3000

/**
 * Hybrid transport：读走 WebSocket，写走 HTTP POST。
 *
 * 写入流程：
 *
 *   调用 write(stream_event) ─┐
 *                        │（100ms 定时器）
 *                        │
 *                        ▼
 *   调用 write(other) ────► uploader.enqueue()  （SerialBatchEventUploader）
 *                        ▲    │
 *   writeBatch() ────────┘    │ 串行、可 batching、无限重试，
 *                             │ 并在 maxQueueSize 处形成 backpressure
 *                             ▼
 *                        postOnce()  （单次 HTTP POST，遇到可重试错误就抛出）
 *
 * stream_event 会先在 streamEventBuffer 中累积最多 100ms 后再 enqueue，
 * 以减少高频内容 delta 场景下的 POST 数量。
 * 任何非 stream 写入都会先 flush 缓冲中的 stream_event，以保持顺序正确。
 *
 * 序列化、重试与 backpressure 全部委托给 SerialBatchEventUploader
 *（CCR 也使用同一套原语）。任意时刻最多一个 POST 在飞；
 * 过程中到来的新事件会自动落到下一批。失败时 uploader 会重新入队并按
 * 指数退避 + jitter 重试。若队列超过 maxQueueSize，enqueue() 就会阻塞，
 * 从而给 await 它的调用方施加 backpressure。
 *
 * 为什么必须串行？因为 bridge 模式大量使用 `void transport.write()`，
 * 也就是 fire-and-forget。如果不串行，多个并发 POST 会造成对同一 Firestore 文档的并发写入，
 * 继而引发冲突、重试风暴，最终把 oncall 叫醒。
 */
export class HybridTransport extends WebSocketTransport {
  private postUrl: string
  private uploader: SerialBatchEventUploader<StdoutMessage>

  // stream_event 的延迟缓冲区。
  // 最多累积 BATCH_FLUSH_INTERVAL_MS 后再统一 enqueue，以减少 POST 数量。
  private streamEventBuffer: StdoutMessage[] = []
  private streamEventTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    url: URL,
    headers: Record<string, string> = {},
    sessionId?: string,
    refreshHeaders?: () => Record<string, string>,
    options?: WebSocketTransportOptions & {
      maxConsecutiveFailures?: number
      onBatchDropped?: (batchSize: number, failures: number) => void
    },
  ) {
    super(url, headers, sessionId, refreshHeaders, options)
    const { maxConsecutiveFailures, onBatchDropped } = options ?? {}
    this.postUrl = convertWsUrlToPostUrl(url)
    this.uploader = new SerialBatchEventUploader<StdoutMessage>({
      // 这里给一个较大的上限。
      // session-ingress 本身接受任意 batch 大小；事件天然会在 POST 进行中聚合，
      // 这个限制只是为了给 payload 设一个边界。
      maxBatchSize: 500,
      // bridge 调用方大量使用 `void transport.write()`，也就是根本不会 await，
      // 因而 backpressure 对它们不起作用。
      // 如果出现一个 batch > maxQueueSize，就会直接死锁；
      // 因此这里把它设得足够高，让它更多只充当内存边界。
      // 等调用方未来开始 await 后，再补真正的 backpressure 机制。
      maxQueueSize: 100_000,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      jitterMs: 1000,
      // 可选上限，用来防止一个持续失败的服务端把 drain loop 钉死到整个进程生命周期。
      // Undefined 表示无限重试。replBridge 会设置它；1P 的 transportUtils 路径不会。
      maxConsecutiveFailures,
      onBatchDropped: (batchSize, failures) => {
        logForDiagnosticsNoPII(
          'error',
          'cli_hybrid_batch_dropped_max_failures',
          {
            batchSize,
            failures,
          },
        )
        onBatchDropped?.(batchSize, failures)
      },
      send: batch => this.postOnce(batch),
    })
    logForDebugging(`HybridTransport: POST URL = ${this.postUrl}`)
    logForDiagnosticsNoPII('info', 'cli_hybrid_transport_initialized')
  }

  /**
   * 把消息 enqueue 后，再等待队列真正 drain 完成。
   * 通过返回 flush()，可以保持 `await write()` 只有在事件真正 POST 完后才 resolve 的契约；
   * 测试以及 replBridge 的初始 flush 都依赖这个语义。
   * fire-and-forget 调用方（`void transport.write()`）不会受影响，
   * 因为它们本来就不 await，后续 resolve 不会额外增加延迟。
   */
  override async write(message: StdoutMessage): Promise<void> {
    if (message.type === 'stream_event') {
      // 延迟发送：先短暂聚合 stream_event，再统一 enqueue。
      // Promise 立即 resolve，因为调用方通常不会等待 stream_event。
      this.streamEventBuffer.push(message)
      if (!this.streamEventTimer) {
        this.streamEventTimer = setTimeout(
          () => this.flushStreamEvents(),
          BATCH_FLUSH_INTERVAL_MS,
        )
      }
      return
    }
    // 立即发送路径：先把缓冲中的 stream_event flush 掉以保持顺序，再发送当前事件。
    await this.uploader.enqueue([...this.takeStreamEvents(), message])
    return this.uploader.flush()
  }

  async writeBatch(messages: StdoutMessage[]): Promise<void> {
    await this.uploader.enqueue([...this.takeStreamEvents(), ...messages])
    return this.uploader.flush()
  }

  /** 在 writeBatch() 前后做快照，用于检测静默丢弃。 */
  get droppedBatchCount(): number {
    return this.uploader.droppedBatchCount
  }

  /**
   * 阻塞直到所有 pending 事件都已完成 POST。
   * bridge 的初始历史 flush 依赖它，确保 onStateChange('connected') 发生在持久化之后。
   */
  flush(): Promise<void> {
    void this.uploader.enqueue(this.takeStreamEvents())
    return this.uploader.flush()
  }

  /** 接管当前缓冲的 stream_event，并清掉延迟定时器。 */
  private takeStreamEvents(): StdoutMessage[] {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    const buffered = this.streamEventBuffer
    this.streamEventBuffer = []
    return buffered
  }

  /** 延迟定时器触发后，把已累积的 stream_event 统一 enqueue。 */
  private flushStreamEvents(): void {
    this.streamEventTimer = null
    void this.uploader.enqueue(this.takeStreamEvents())
  }

  override close(): void {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    this.streamEventBuffer = []
    // 为排队写入保留一个宽限期，作为兜底手段。
    // replBridge teardown 现在会在 write 与 close 之间等待 archive，
    // 因而 archive 延迟才是主要 drain 窗口，这里只是最后一道保险。
    // close() 仍保持同步返回，但 uploader.close() 会延后，给剩余队列一次完成机会。
    const uploader = this.uploader
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    void Promise.race([
      uploader.flush(),
      new Promise<void>(r => {
        // eslint-disable-next-line no-restricted-syntax -- need timer ref for clearTimeout
        graceTimer = setTimeout(r, CLOSE_GRACE_MS)
      }),
    ]).finally(() => {
      clearTimeout(graceTimer)
      uploader.close()
    })
    super.close()
  }

  /**
   * 单次 POST 尝试。
   * 遇到可重试错误（429、5xx、网络错误）时抛出，
   * 让 SerialBatchEventUploader 负责重新入队并重试。
   * 成功时返回；永久错误（4xx 且非 429，或没有 token）也直接返回，
   * 让 uploader 继续处理后续项目。
   */
  private async postOnce(events: StdoutMessage[]): Promise<void> {
    const sessionToken = getSessionIngressAuthToken()
    if (!sessionToken) {
      logForDebugging('HybridTransport: No session token available for POST')
      logForDiagnosticsNoPII('warn', 'cli_hybrid_post_no_token')
      return
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    }

    let response
    try {
      response = await axios.post(
        this.postUrl,
        { events },
        {
          headers,
          validateStatus: () => true,
          timeout: POST_TIMEOUT_MS,
        },
      )
    } catch (error) {
      const axiosError = error as AxiosError
      logForDebugging(`HybridTransport: POST error: ${axiosError.message}`)
      logForDiagnosticsNoPII('warn', 'cli_hybrid_post_network_error')
      throw error
    }

    if (response.status >= 200 && response.status < 300) {
      logForDebugging(`HybridTransport: POST success count=${events.length}`)
      return
    }

    // 4xx（429 除外）视为永久错误，直接丢弃，不再重试。
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429
    ) {
      logForDebugging(
        `HybridTransport: POST returned ${response.status} (permanent), dropping`,
      )
      logForDiagnosticsNoPII('warn', 'cli_hybrid_post_client_error', {
        status: response.status,
      })
      return
    }

    // 429 / 5xx 属于可重试错误。通过抛出让 uploader 重新入队并执行退避。
    logForDebugging(
      `HybridTransport: POST returned ${response.status} (retryable)`,
    )
    logForDiagnosticsNoPII('warn', 'cli_hybrid_post_retryable_error', {
      status: response.status,
    })
    throw new Error(`POST failed with ${response.status}`)
  }
}

/**
 * 把 WebSocket URL 转换成对应的 HTTP POST endpoint URL。
 * 来源：wss://api.example.com/v2/session_ingress/ws/<session_id>
 * 目标：https://api.example.com/v2/session_ingress/session/<session_id>/events
 */
function convertWsUrlToPostUrl(wsUrl: URL): string {
  const protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:'

  // 把 /ws/ 替换成 /session/，再补上 /events。
  let pathname = wsUrl.pathname
  pathname = pathname.replace('/ws/', '/session/')
  if (!pathname.endsWith('/events')) {
    pathname = pathname.endsWith('/')
      ? pathname + 'events'
      : pathname + '/events'
  }

  return `${protocol}//${wsUrl.host}${pathname}${wsUrl.search}`
}
