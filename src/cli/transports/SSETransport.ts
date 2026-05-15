import axios, { type AxiosError } from 'axios'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { errorMessage } from '../../utils/errors.js'
import { getSessionIngressAuthHeaders } from '../../utils/sessionIngressAuth.js'
import { sleep } from '../../utils/sleep.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import type { Transport } from './Transport.js'

// ---------------------------------------------------------------------------
// 配置项
// ---------------------------------------------------------------------------

const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30_000
/** 重连尝试的总时间预算，超出后放弃（10 分钟）。 */
const RECONNECT_GIVE_UP_MS = 600_000
/** 服务端每 15 秒发送一次 keepalive；若静默超过 45 秒，则视为连接已失效。 */
const LIVENESS_TIMEOUT_MS = 45_000

/**
 * 表示服务端永久拒绝的 HTTP 状态码。
 * 命中后 transport 会立即进入 'closed'，不再重试。
 */
const PERMANENT_HTTP_CODES = new Set([401, 403, 404])

// POST 重试配置（与 HybridTransport 保持一致）。
const POST_MAX_RETRIES = 10
const POST_BASE_DELAY_MS = 500
const POST_MAX_DELAY_MS = 8000

/** 提升到模块级的 TextDecoder 选项，避免 readStream 中每个 chunk 都重新分配。 */
const STREAM_DECODE_OPTS: TextDecodeOptions = { stream: true }

/** 提升到模块级的 axios validateStatus 回调，避免每次请求都新建闭包。 */
function alwaysValidStatus(): boolean {
  return true
}

// ---------------------------------------------------------------------------
// SSE 帧解析器
// ---------------------------------------------------------------------------

type SSEFrame = {
  event?: string
  id?: string
  data?: string
}

/**
 * 增量式地从文本 buffer 中解析 SSE 帧。
 * 返回已解析的帧，以及尚未完整构成一帧的剩余 buffer。
 *
 * @internal 导出仅用于测试
 */
export function parseSSEFrames(buffer: string): {
  frames: SSEFrame[]
  remaining: string
} {
  const frames: SSEFrame[] = []
  let pos = 0

  // SSE 帧以双换行作为分隔。
  let idx: number
  while ((idx = buffer.indexOf('\n\n', pos)) !== -1) {
    const rawFrame = buffer.slice(pos, idx)
    pos = idx + 2

    // 跳过空帧。
    if (!rawFrame.trim()) continue

    const frame: SSEFrame = {}
    let isComment = false

    for (const line of rawFrame.split('\n')) {
      if (line.startsWith(':')) {
        // SSE 注释（例如 `:keepalive`）。
        isComment = true
        continue
      }

      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue

      const field = line.slice(0, colonIdx)
      // 按 SSE 规范，如果冒号后紧跟一个空格，则去掉这一个前导空格。
      const value =
        line[colonIdx + 1] === ' '
          ? line.slice(colonIdx + 2)
          : line.slice(colonIdx + 1)

      switch (field) {
        case 'event':
          frame.event = value
          break
        case 'id':
          frame.id = value
          break
        case 'data':
          // 按 SSE 规范，多条 data: 行需要用 \n 拼接起来。
          frame.data = frame.data ? frame.data + '\n' + value : value
          break
        // 其他字段（如 retry:）忽略不处理。
      }
    }

    // 只产出包含 data 的帧，或那些纯注释但可用于重置 liveness 的帧。
    if (frame.data || isComment) {
      frames.push(frame)
    }
  }

  return { frames, remaining: buffer.slice(pos) }
}

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

type SSETransportState =
  | 'idle'
  | 'connected'
  | 'reconnecting'
  | 'closing'
  | 'closed'

/**
 * `event: client_event` 帧对应的 payload，
 * 与 session_stream.proto 中的 StreamClientEvent proto message 保持一致。
 * 这是发送给 worker subscriber 的唯一事件类型；
 * delivery_update、session_update、ephemeral_event 和 catch_up_truncated
 * 只会出现在 client channel（见 notifier.go 与 event_stream.go 中的 SubscriberClient guard）。
 */
export type StreamClientEvent = {
  event_id: string
  sequence_num: number
  event_type: string
  source: string
  payload: Record<string, unknown>
  created_at: string
}

// ---------------------------------------------------------------------------
// SSETransport 实现
// ---------------------------------------------------------------------------

/**
 * 读取走 SSE、写入走 HTTP POST 的 transport。
 *
 * 它通过 CCR v2 的事件流端点，以 Server-Sent Events 方式接收事件；
 * 通过带重试逻辑的 HTTP POST 发送事件（模式与 HybridTransport 一致）。
 *
 * 每个 `event: client_event` 帧都会把 StreamClientEvent 的 proto JSON
 * 直接放进 `data:` 中。transport 会提取其中的 `payload`，
 * 并以换行分隔 JSON 的形式传给 `onData`，供 StructuredIO 消费。
 *
 * 支持自动重连，带指数退避，以及利用 Last-Event-ID 在断线后恢复续传。
 */
export class SSETransport implements Transport {
  private state: SSETransportState = 'idle'
  private onData?: (data: string) => void
  private onCloseCallback?: (closeCode?: number) => void
  private onEventCallback?: (event: StreamClientEvent) => void
  private headers: Record<string, string>
  private sessionId?: string
  private refreshHeaders?: () => Record<string, string>
  private readonly getAuthHeaders: () => Record<string, string>

  // SSE 连接状态。
  private abortController: AbortController | null = null
  private lastSequenceNum = 0
  private seenSequenceNums = new Set<number>()

  // 重连状态。
  private reconnectAttempts = 0
  private reconnectStartTime: number | null = null
  private reconnectTimer: NodeJS.Timeout | null = null

  // 活性检测。
  private livenessTimer: NodeJS.Timeout | null = null

  // POST URL（由 SSE URL 推导而来）。
  private postUrl: string

  // CCR v2 事件格式对应的运行时时期。

  constructor(
    private readonly url: URL,
    headers: Record<string, string> = {},
    sessionId?: string,
    refreshHeaders?: () => Record<string, string>,
    initialSequenceNum?: number,
    /**
     * 当前实例专属的认证 header 来源。
     * 省略时会读取进程级别的 CLAUDE_CODE_SESSION_ACCESS_TOKEN
     * （适用于单 session 调用方）。
     * 并发多 session 场景必须显式提供它，因为环境变量路径是进程全局的，
     * 会在不同 session 之间互相覆盖。
     */
    getAuthHeaders?: () => Record<string, string>,
  ) {
    this.headers = headers
    this.sessionId = sessionId
    this.refreshHeaders = refreshHeaders
    this.getAuthHeaders = getAuthHeaders ?? getSessionIngressAuthHeaders
    this.postUrl = convertSSEUrlToPostUrl(url)
    // 使用调用方给出的 high-water mark 作为初值，
    // 让第一次 connect() 就能带上 from_sequence_num / Last-Event-ID。
    // 否则新建的 SSETransport 总会要求服务端从 sequence 0 开始回放，
    // 导致每次 transport 切换都重放整段 session 历史。
    if (initialSequenceNum !== undefined && initialSequenceNum > 0) {
      this.lastSequenceNum = initialSequenceNum
    }
    logForDebugging(`SSETransport: SSE URL = ${url.href}`)
    logForDebugging(`SSETransport: POST URL = ${this.postUrl}`)
    logForDiagnosticsNoPII('info', 'cli_sse_transport_initialized')
  }

  /**
    * 当前流中已看到的最大 sequence number。
    * 那些会重建 transport 的调用方（例如 replBridge 的 onWorkReceived）
    * 会在 close() 前读出它，并把它作为 `initialSequenceNum` 传给下一实例，
    * 从而让服务端从正确位置恢复，而不是把全部历史重新回放一遍。
   */
  getLastSequenceNum(): number {
    return this.lastSequenceNum
  }

  async connect(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'reconnecting') {
      logForDebugging(
        `SSETransport: Cannot connect, current state is ${this.state}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_connect_failed')
      return
    }

    this.state = 'reconnecting'
    const connectStartTime = Date.now()

    // 构造带 sequence number 的 SSE URL，以便断线后恢复。
    const sseUrl = new URL(this.url.href)
    if (this.lastSequenceNum > 0) {
      sseUrl.searchParams.set('from_sequence_num', String(this.lastSequenceNum))
    }

    // 构造 headers，优先使用最新的认证头（支持通过 Cookie 传 session key）。
    // 如果当前使用的是 Cookie 认证，需要删掉 this.headers 里的旧 Authorization，
    // 因为两者同时发送会让认证拦截器产生歧义。
    const authHeaders = this.getAuthHeaders()
    const headers: Record<string, string> = {
      ...this.headers,
      ...authHeaders,
      Accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'User-Agent': getClaudeCodeUserAgent(),
    }
    if (authHeaders['Cookie']) {
      delete headers['Authorization']
    }
    if (this.lastSequenceNum > 0) {
      headers['Last-Event-ID'] = String(this.lastSequenceNum)
    }

    logForDebugging(`SSETransport: Opening ${sseUrl.href}`)
    logForDiagnosticsNoPII('info', 'cli_sse_connect_opening')

    this.abortController = new AbortController()

    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const response = await fetch(sseUrl.href, {
        headers,
        signal: this.abortController.signal,
      })

      if (!response.ok) {
        const isPermanent = PERMANENT_HTTP_CODES.has(response.status)
        logForDebugging(
          `SSETransport: HTTP ${response.status}${isPermanent ? ' (permanent)' : ''}`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_sse_connect_http_error', {
          status: response.status,
        })

        if (isPermanent) {
          this.state = 'closed'
          this.onCloseCallback?.(response.status)
          return
        }

        this.handleConnectionError()
        return
      }

      if (!response.body) {
        logForDebugging('SSETransport: No response body')
        this.handleConnectionError()
        return
      }

      // 连接成功。
      const connectDuration = Date.now() - connectStartTime
      logForDebugging('SSETransport: Connected')
      logForDiagnosticsNoPII('info', 'cli_sse_connect_connected', {
        duration_ms: connectDuration,
      })

      this.state = 'connected'
      this.reconnectAttempts = 0
      this.reconnectStartTime = null
      this.resetLivenessTimer()

      // 开始读取 SSE stream。
      await this.readStream(response.body)
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        // 主动关闭，不算错误。
        return
      }

      logForDebugging(
        `SSETransport: Connection error: ${errorMessage(error)}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_connect_error')
      this.handleConnectionError()
    }
  }

  /**
    * 读取并处理 SSE stream 的响应体。
   */
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, STREAM_DECODE_OPTS)
        const { frames, remaining } = parseSSEFrames(buffer)
        buffer = remaining

        for (const frame of frames) {
          // 任意一帧（包括 keepalive 注释）都能证明连接仍然存活。
          this.resetLivenessTimer()

          if (frame.id) {
            const seqNum = parseInt(frame.id, 10)
            if (!isNaN(seqNum)) {
              if (this.seenSequenceNums.has(seqNum)) {
                logForDebugging(
                  `SSETransport: DUPLICATE frame seq=${seqNum} (lastSequenceNum=${this.lastSequenceNum}, seenCount=${this.seenSequenceNums.size})`,
                  { level: 'warn' },
                )
                logForDiagnosticsNoPII('warn', 'cli_sse_duplicate_sequence')
              } else {
                this.seenSequenceNums.add(seqNum)
                // 防止无限膨胀：当条目足够多时，裁掉那些远低于 high-water mark 的旧 sequence。
                // 对去重真正有意义的，只是 lastSequenceNum 附近的那些值。
                if (this.seenSequenceNums.size > 1000) {
                  const threshold = this.lastSequenceNum - 200
                  for (const s of this.seenSequenceNums) {
                    if (s < threshold) {
                      this.seenSequenceNums.delete(s)
                    }
                  }
                }
              }
              if (seqNum > this.lastSequenceNum) {
                this.lastSequenceNum = seqNum
              }
            }
          }

          if (frame.event && frame.data) {
            this.handleSSEFrame(frame.event, frame.data)
          } else if (frame.data) {
            // 只有 data: 没有 event:，意味着服务端发出了旧的 envelope 格式，
            // 或者存在 bug。这里记录日志，避免问题被静默吞掉。
            logForDebugging(
              'SSETransport: Frame has data: but no event: field — dropped',
              { level: 'warn' },
            )
            logForDiagnosticsNoPII('warn', 'cli_sse_frame_missing_event_field')
          }
        }
      }
    } catch (error) {
      if (this.abortController?.signal.aborted) return
      logForDebugging(
        `SSETransport: Stream read error: ${errorMessage(error)}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_stream_read_error')
    } finally {
      reader.releaseLock()
    }

    // stream 已结束；除非当前正在关闭，否则尝试重连。
    if (this.state !== 'closing' && this.state !== 'closed') {
      logForDebugging('SSETransport: Stream ended, reconnecting')
      this.handleConnectionError()
    }
  }

  /**
    * 处理单个 SSE 帧。event: 字段用于标识变体类型；
    * data: 直接承载内部 proto JSON（没有额外 envelope）。
   *
    * worker subscriber 只会收到 client_event 帧（见 notifier.go）；
    * 任何其他事件类型都意味着服务端行为发生了 CC 尚未适配的变化。
    * 这里会记录诊断日志，以便在 telemetry 中及时发现。
   */
  private handleSSEFrame(eventType: string, data: string): void {
    if (eventType !== 'client_event') {
      logForDebugging(
        `SSETransport: Unexpected SSE event type '${eventType}' on worker stream`,
        { level: 'warn' },
      )
      logForDiagnosticsNoPII('warn', 'cli_sse_unexpected_event_type', {
        event_type: eventType,
      })
      return
    }

    let ev: StreamClientEvent
    try {
      ev = jsonParse(data) as StreamClientEvent
    } catch (error) {
      logForDebugging(
        `SSETransport: Failed to parse client_event data: ${errorMessage(error)}`,
        { level: 'error' },
      )
      return
    }

    const payload = ev.payload
    if (payload && typeof payload === 'object' && 'type' in payload) {
      const sessionLabel = this.sessionId ? ` session=${this.sessionId}` : ''
      logForDebugging(
        `SSETransport: Event seq=${ev.sequence_num} event_id=${ev.event_id} event_type=${ev.event_type} payload_type=${String(payload.type)}${sessionLabel}`,
      )
      logForDiagnosticsNoPII('info', 'cli_sse_message_received')
      // 把解包后的 payload 按换行分隔 JSON 形式传出，
      // 与 StructuredIO/WebSocketTransport 消费者期待的格式保持一致。
      this.onData?.(jsonStringify(payload) + '\n')
    } else {
      logForDebugging(
        `SSETransport: Ignoring client_event with no type in payload: event_id=${ev.event_id}`,
      )
    }

    this.onEventCallback?.(ev)
  }

  /**
    * 使用指数退避和时间预算来处理连接错误。
   */
  private handleConnectionError(): void {
    this.clearLivenessTimer()

    if (this.state === 'closing' || this.state === 'closed') return

    // 中止所有仍在进行中的 SSE fetch。
    this.abortController?.abort()
    this.abortController = null

    const now = Date.now()
    if (!this.reconnectStartTime) {
      this.reconnectStartTime = now
    }

    const elapsed = now - this.reconnectStartTime
    if (elapsed < RECONNECT_GIVE_UP_MS) {
      // 清除已有的重连定时器。
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }

      // 重连前刷新 headers。
      if (this.refreshHeaders) {
        const freshHeaders = this.refreshHeaders()
        Object.assign(this.headers, freshHeaders)
        logForDebugging('SSETransport: Refreshed headers for reconnect')
      }

      this.state = 'reconnecting'
      this.reconnectAttempts++

      const baseDelay = Math.min(
        RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
        RECONNECT_MAX_DELAY_MS,
      )
      // 增加 ±25% 的抖动。
      const delay = Math.max(
        0,
        baseDelay + baseDelay * 0.25 * (2 * Math.random() - 1),
      )

      logForDebugging(
        `SSETransport: Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}, ${Math.round(elapsed / 1000)}s elapsed)`,
      )
      logForDiagnosticsNoPII('error', 'cli_sse_reconnect_attempt', {
        reconnectAttempts: this.reconnectAttempts,
      })

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        void this.connect()
      }, delay)
    } else {
      logForDebugging(
        `SSETransport: Reconnection time budget exhausted after ${Math.round(elapsed / 1000)}s`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_reconnect_exhausted', {
        reconnectAttempts: this.reconnectAttempts,
        elapsedMs: elapsed,
      })
      this.state = 'closed'
      this.onCloseCallback?.()
    }
  }

  /**
    * 绑定好的超时回调。之所以从内联闭包中提出来，
    * 是为了避免 resetLivenessTimer（每帧都会调用）在每个 SSE 帧上都分配新闭包。
   */
  private readonly onLivenessTimeout = (): void => {
    this.livenessTimer = null
    logForDebugging('SSETransport: Liveness timeout, reconnecting', {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_sse_liveness_timeout')
    this.abortController?.abort()
    this.handleConnectionError()
  }

  /**
    * 重置活性计时器。如果在超时时间内没有任何 SSE 帧到达，
    * 就把连接视为已失效并触发重连。
   */
  private resetLivenessTimer(): void {
    this.clearLivenessTimer()
    this.livenessTimer = setTimeout(this.onLivenessTimeout, LIVENESS_TIMEOUT_MS)
  }

  private clearLivenessTimer(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  // -----------------------------------------------------------------------
  // 写入（HTTP POST）——与 HybridTransport 采用相同模式
  // -----------------------------------------------------------------------

  async write(message: StdoutMessage): Promise<void> {
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) {
      logForDebugging('SSETransport: No session token available for POST')
      logForDiagnosticsNoPII('warn', 'cli_sse_post_no_token')
      return
    }

    const headers: Record<string, string> = {
      ...authHeaders,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'User-Agent': getClaudeCodeUserAgent(),
    }

    logForDebugging(
      `SSETransport: POST body keys=${Object.keys(message as Record<string, unknown>).join(',')}`,
    )

    for (let attempt = 1; attempt <= POST_MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post(this.postUrl, message, {
          headers,
          validateStatus: alwaysValidStatus,
        })

        if (response.status === 200 || response.status === 201) {
          logForDebugging(`SSETransport: POST success type=${message.type}`)
          return
        }

        logForDebugging(
          `SSETransport: POST ${response.status} body=${jsonStringify(response.data).slice(0, 200)}`,
        )
        // 4xx 错误（除了 429）都视为永久错误，不再重试。
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          logForDebugging(
            `SSETransport: POST returned ${response.status} (client error), not retrying`,
          )
          logForDiagnosticsNoPII('warn', 'cli_sse_post_client_error', {
            status: response.status,
          })
          return
        }

        // 429 或 5xx 视为可重试错误。
        logForDebugging(
          `SSETransport: POST returned ${response.status}, attempt ${attempt}/${POST_MAX_RETRIES}`,
        )
        logForDiagnosticsNoPII('warn', 'cli_sse_post_retryable_error', {
          status: response.status,
          attempt,
        })
      } catch (error) {
        const axiosError = error as AxiosError
        logForDebugging(
          `SSETransport: POST error: ${axiosError.message}, attempt ${attempt}/${POST_MAX_RETRIES}`,
        )
        logForDiagnosticsNoPII('warn', 'cli_sse_post_network_error', {
          attempt,
        })
      }

      if (attempt === POST_MAX_RETRIES) {
        logForDebugging(
          `SSETransport: POST failed after ${POST_MAX_RETRIES} attempts, continuing`,
        )
        logForDiagnosticsNoPII('warn', 'cli_sse_post_retries_exhausted')
        return
      }

      const delayMs = Math.min(
        POST_BASE_DELAY_MS * Math.pow(2, attempt - 1),
        POST_MAX_DELAY_MS,
      )
      await sleep(delayMs)
    }
  }

  // -----------------------------------------------------------------------
  // Transport 接口实现
  // -----------------------------------------------------------------------

  isConnectedStatus(): boolean {
    return this.state === 'connected'
  }

  isClosedStatus(): boolean {
    return this.state === 'closed'
  }

  setOnData(callback: (data: string) => void): void {
    this.onData = callback
  }

  setOnClose(callback: (closeCode?: number) => void): void {
    this.onCloseCallback = callback
  }

  setOnEvent(callback: (event: StreamClientEvent) => void): void {
    this.onEventCallback = callback
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearLivenessTimer()

    this.state = 'closing'
    this.abortController?.abort()
    this.abortController = null
  }
}

// ---------------------------------------------------------------------------
// URL 转换
// ---------------------------------------------------------------------------

/**
 * 把 SSE URL 转换成 HTTP POST 端点 URL。
 * SSE stream URL 与 POST URL 共享相同的基路径；
 * POST 端点位于 `/events`（不带 `/stream`）。
 *
 * 示例输入：https://api.example.com/v2/session_ingress/session/<session_id>/events/stream
 * 示例输出：https://api.example.com/v2/session_ingress/session/<session_id>/events
 */
function convertSSEUrlToPostUrl(sseUrl: URL): string {
  let pathname = sseUrl.pathname
  // 去掉 /stream 后缀，得到 POST events 端点。
  if (pathname.endsWith('/stream')) {
    pathname = pathname.slice(0, -'/stream'.length)
  }
  return `${sseUrl.protocol}//${sseUrl.host}${pathname}`
}
