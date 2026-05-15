// Anthropic voice_stream 的 push-to-talk speech-to-text 客户端。
//
// 仅在 ant 构建中可达（由 useVoice.ts 导入处的 feature('VOICE_MODE') 门控）。
//
// 它使用与 Claude Code 相同的 OAuth 凭据连接到 Anthropic 的 voice_stream
// WebSocket 端点。该端点使用由 conversation_engine 驱动的 speech-to-text
// 模型。它按 hold-to-talk 方式设计：按住快捷键开始录音，松开后停止并提交。
//
// 线协议使用 JSON 控制消息（KeepAlive、CloseStream）和二进制音频帧。
// 服务端会返回 TranscriptText 和 TranscriptEndpoint 这两类 JSON 消息。

import type { ClientRequest, IncomingMessage } from 'http'
import WebSocket from 'ws'
import { getOauthConfig } from '../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  isAnthropicAuthEnabled,
} from '../utils/auth.js'
import { logForDebugging } from '../utils/debug.js'
import { getUserAgent } from '../utils/http.js'
import { logError } from '../utils/log.js'
import { getWebSocketTLSOptions } from '../utils/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../utils/proxy.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'

const KEEPALIVE_MSG = '{"type":"KeepAlive"}'
const CLOSE_STREAM_MSG = '{"type":"CloseStream"}'

import { getFeatureValue_CACHED_MAY_BE_STALE } from './analytics/growthbook.js'

// ─── 常量 ───────────────────────────────────────────────────────

const VOICE_STREAM_PATH = '/api/ws/speech_to_text/voice_stream'

const KEEPALIVE_INTERVAL_MS = 8_000

// finalize() 的完成定时器。`noData` 会在 CloseStream 之后迟迟收不到
// TranscriptText 时触发，表示服务端已经没有内容；无需再等待完整的
// ~3-5 秒 WS 清理过程来确认为空。`safety` 是 WS 挂起时的最后兜底上限。
// 这里导出它们，方便测试时缩短时长。
export const FINALIZE_TIMEOUTS_MS = {
  safety: 5_000,
  noData: 1_500,
}

// ─── 类型 ──────────────────────────────────────────────────────────

export type VoiceStreamCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void
  onError: (error: string, opts?: { fatal?: boolean }) => void
  onClose: () => void
  onReady: (connection: VoiceStreamConnection) => void
}

// finalize() 的完成来源。`no_data_timeout` 表示在 CloseStream 之后
// 没有收到任何服务端消息，即 silent-drop 特征（anthropics/anthropic#287008）。
export type FinalizeSource =
  | 'post_closestream_endpoint'
  | 'no_data_timeout'
  | 'safety_timeout'
  | 'ws_close'
  | 'ws_already_closed'

export type VoiceStreamConnection = {
  send: (audioChunk: Buffer) => void
  finalize: () => Promise<FinalizeSource>
  close: () => void
  isConnected: () => boolean
}

// voice_stream 端点会返回 transcript 分片和 endpoint 标记。
type VoiceStreamTranscriptText = {
  type: 'TranscriptText'
  data: string
}

type VoiceStreamTranscriptEndpoint = {
  type: 'TranscriptEndpoint'
}

type VoiceStreamTranscriptError = {
  type: 'TranscriptError'
  error_code?: string
  description?: string
}

type VoiceStreamMessage =
  | VoiceStreamTranscriptText
  | VoiceStreamTranscriptEndpoint
  | VoiceStreamTranscriptError
  | { type: 'error'; message?: string }

// ─── 可用性 ──────────────────────────────────────────────────────

export function isVoiceStreamAvailable(): boolean {
  // voice_stream 与 Claude Code 使用相同的 OAuth；当用户已通过 Anthropic
  // 完成认证时即可使用（Claude.ai 订阅用户，或持有有效 OAuth token）。
  if (!isAnthropicAuthEnabled()) {
    return false
  }
  const tokens = getClaudeAIOAuthTokens()
  return tokens !== null && tokens.accessToken !== null
}

// ─── 连接 ────────────────────────────────────────────────────────

export async function connectVoiceStream(
  callbacks: VoiceStreamCallbacks,
  options?: { language?: string; keyterms?: string[] },
): Promise<VoiceStreamConnection | null> {
  // 连接前先确保 OAuth token 是最新的
  await checkAndRefreshOAuthTokenIfNeeded()

  const tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) {
    logForDebugging('[voice_stream] No OAuth token available')
    return null
  }

  // voice_stream 是 private_api 路由，但 /api/ws/ 也暴露在
  // api.anthropic.com 监听器上（service_definitions.yaml private-api:
  // visibility.external: true）。我们把目标主机设为它而不是 claude.ai，
  // 因为 claude.ai 的 CF 区域会做 TLS 指纹识别，并对非浏览器客户端发起挑战
  //（anthropics/claude-code#34094）。后端仍是同一个 private-api pod，
  // OAuth Bearer auth 也相同，只是换到了不会拦截我们的 CF 区域。
  // 桌面听写仍然使用 claude.ai（Swift URLSession 具有浏览器级 JA3 指纹，
  // 因此 CF 会放行）。
  const wsBaseUrl =
    process.env.VOICE_STREAM_BASE_URL ||
    getOauthConfig()
      .BASE_API_URL.replace('https://', 'wss://')
      .replace('http://', 'ws://')

  if (process.env.VOICE_STREAM_BASE_URL) {
    logForDebugging(
      `[voice_stream] Using VOICE_STREAM_BASE_URL override: ${process.env.VOICE_STREAM_BASE_URL}`,
    )
  }

  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    endpointing_ms: '300',
    utterance_end_ms: '1000',
    language: options?.language ?? 'en',
  })

  // 通过 conversation-engine 走 Deepgram Nova 3（绕过服务端的
  // project_bell_v2_config GrowthBook 门控）。服务端改动见
  // anthropics/anthropic#278327 和 #281372；这样可以让客户端独立灰度。
  const isNova3 = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_cobalt_frost',
    false,
  )
  if (isNova3) {
    params.set('use_conversation_engine', 'true')
    params.set('stt_provider', 'deepgram-nova3')
    logForDebugging('[voice_stream] Nova 3 gate enabled (tengu_cobalt_frost)')
  }

  // 将 keyterms 作为 query 参数附加上去；voice_stream 代理会把它们转发给
  // STT 服务，由后者施加相应的 boosting。
  if (options?.keyterms?.length) {
    for (const term of options.keyterms) {
      params.append('keyterms', term)
    }
  }

  const url = `${wsBaseUrl}${VOICE_STREAM_PATH}?${params.toString()}`

  logForDebugging(`[voice_stream] Connecting to ${url}`)

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.accessToken}`,
    'User-Agent': getUserAgent(),
    'x-app': 'cli',
  }

  const tlsOptions = getWebSocketTLSOptions()
  const wsOptions =
    typeof Bun !== 'undefined'
      ? {
          headers,
          proxy: getWebSocketProxyUrl(url),
          tls: tlsOptions || undefined,
        }
      : { headers, agent: getWebSocketProxyAgent(url), ...tlsOptions }

  const ws = new WebSocket(url, wsOptions)

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  let connected = false
  // 一旦发送了 CloseStream（或 ws 已关闭）就设为 true。
  // 之后继续发送的音频都会被丢弃。
  let finalized = false
  // finalize() 首次调用时设为 true，防止重复触发。
  let finalizing = false
  // 当 HTTP upgrade 被拒绝（unexpected-response）时设为 true。
  // 随后的 close 事件（来自 req.destroy() 的 1006）只是机械式清理；
  // upgrade handler 已经报告过该错误。
  let upgradeRejected = false
  // 用来 resolve finalize()。有四个触发条件：CloseStream 之后收到
  // TranscriptEndpoint（~300ms）、no-data 定时器（1.5s）、WS close
  //（~3-5s）以及 safety 定时器（5s）。
  let resolveFinalize: ((source: FinalizeSource) => void) | null = null
  let cancelNoDataTimer: (() => void) | null = null

  // 在注册事件处理器之前先定义 connection 对象，这样 WebSocket 打开时
  // 就能把它传给 onReady。
  const connection: VoiceStreamConnection = {
    send(audioChunk: Buffer): void {
      if (ws.readyState !== WebSocket.OPEN) {
        return
      }
      if (finalized) {
        // 发送 CloseStream 之后，服务端会拒绝后续音频。
        // 直接丢弃该 chunk，避免触发协议错误。
        logForDebugging(
          `[voice_stream] Dropping audio chunk after CloseStream: ${String(audioChunk.length)} bytes`,
        )
        return
      }
      logForDebugging(
        `[voice_stream] Sending audio chunk: ${String(audioChunk.length)} bytes`,
      )
      // 发送前先复制 buffer：原生模块里的 NAPI Buffer 对象可能共享池化的
      // ArrayBuffer。若使用 `new Uint8Array(buf.buffer, offset, len)`
      // 创建视图，等 ws 库真正读取时，可能已经引用到了过期或重叠的内存。
      // `Buffer.from()` 会生成一份自有副本，ws 库便可安全地把它当作二进制
      // WebSocket frame 来消费。
      ws.send(Buffer.from(audioChunk))
    },
    finalize(): Promise<FinalizeSource> {
      if (finalizing || finalized) {
        // 已经 finalize，或 WebSocket 已关闭，直接立刻 resolve。
        return Promise.resolve('ws_already_closed')
      }
      finalizing = true

      return new Promise<FinalizeSource>(resolve => {
        const safetyTimer = setTimeout(
          () => resolveFinalize?.('safety_timeout'),
          FINALIZE_TIMEOUTS_MS.safety,
        )
        const noDataTimer = setTimeout(
          () => resolveFinalize?.('no_data_timeout'),
          FINALIZE_TIMEOUTS_MS.noData,
        )
        cancelNoDataTimer = () => {
          clearTimeout(noDataTimer)
          cancelNoDataTimer = null
        }

        resolveFinalize = (source: FinalizeSource) => {
          clearTimeout(safetyTimer)
          clearTimeout(noDataTimer)
          resolveFinalize = null
          cancelNoDataTimer = null
          // 旧版 Deepgram 可能把 interim 留在 lastTranscriptText 里，
          // 却没有发出 TranscriptEndpoint（websocket_manager.py 会把
          // TranscriptChunk 和 TranscriptEndpoint 当作独立的 channel item 发送）。
          // 因此所有 resolve 触发点都必须把它提升为 final；逻辑集中在这里。
          // 如果 close handler 已经做过，则这里是 no-op。
          if (lastTranscriptText) {
            logForDebugging(
              `[voice_stream] Promoting unreported interim before ${source} resolve`,
            )
            const t = lastTranscriptText
            lastTranscriptText = ''
            callbacks.onTranscript(t, true)
          }
          logForDebugging(`[voice_stream] Finalize resolved via ${source}`)
          resolve(source)
        }

        // 如果 WebSocket 已经关闭，直接立刻 resolve。
        if (
          ws.readyState === WebSocket.CLOSED ||
          ws.readyState === WebSocket.CLOSING
        ) {
          resolveFinalize('ws_already_closed')
          return
        }

        // 将 CloseStream 延后到下一轮 event loop，再通知服务端停止接收音频，
        // 这样原生录音模块里已经排队的 audio callback 就能先 flush 到 WebSocket。
        // 否则 stopRecording() 可能同步返回，但原生模块仍有待执行的 onData
        // callback 留在事件队列中，导致音频在 CloseStream 之后才到达。
        setTimeout(() => {
          finalized = true
          if (ws.readyState === WebSocket.OPEN) {
            logForDebugging('[voice_stream] Sending CloseStream (finalize)')
            ws.send(CLOSE_STREAM_MSG)
          }
        }, 0)
      })
    },
    close(): void {
      finalized = true
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
      connected = false
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
    },
    isConnected(): boolean {
      return connected && ws.readyState === WebSocket.OPEN
    },
  }

  ws.on('open', () => {
    logForDebugging('[voice_stream] WebSocket connected')
    connected = true

    // 立即发送一个 KeepAlive，让服务端知道客户端已经处于活动状态。
    // 音频硬件初始化可能超过 1 秒，这样可以避免在音频采集开始前就被服务端断开。
    logForDebugging('[voice_stream] Sending initial KeepAlive')
    ws.send(KEEPALIVE_MSG)

    // 周期性发送 keepalive，防止空闲超时
    keepaliveTimer = setInterval(
      ws => {
        if (ws.readyState === WebSocket.OPEN) {
          logForDebugging('[voice_stream] Sending periodic KeepAlive')
          ws.send(KEEPALIVE_MSG)
        }
      },
      KEEPALIVE_INTERVAL_MS,
      ws,
    )

    // 把 connection 交给调用方，以便开始发送音频。
    // 它只会在 WebSocket 真正打开后触发，从而确保 send() 不会被静默丢弃。
    callbacks.onReady(connection)
  })

  // 记录最后一条 TranscriptText，这样在 TranscriptEndpoint 到达时，
  // 就能把它作为最终 transcript 发出。服务端有时会连续发送多条
  // 非累计的 TranscriptText，中间却没有 endpoint；此时 TranscriptText
  // handler 会在检测到文本发生了非累计变化时，自动将上一个 segment finalize。
  let lastTranscriptText = ''

  ws.on('message', (raw: Buffer | string) => {
    const text = raw.toString()
    logForDebugging(
      `[voice_stream] Message received (${String(text.length)} chars): ${text.slice(0, 200)}`,
    )
    let msg: VoiceStreamMessage
    try {
      msg = jsonParse(text) as VoiceStreamMessage
    } catch {
      return
    }

    switch (msg.type) {
      case 'TranscriptText': {
        const transcript = msg.data
        logForDebugging(`[voice_stream] TranscriptText: "${transcript ?? ''}"`)
        // CloseStream 之后如果仍有数据到达，就解除 no-data 定时器，
        // 以免把慢但真实存在的 flush 提前截断。只有在 finalized
        //（即 CloseStream 已发送）后才会解除；否则，CloseStream 之前的
        // 数据若刚好和延迟发送竞争，就会过早取消定时器，进而退回到更慢的
        // 5 秒 safety timeout，而不是 1.5 秒 no-data 定时器。
        if (finalized) {
          cancelNoDataTimer?.()
        }
        if (transcript) {
          // 检测服务端何时已经进入新的语音 segment。
          // 渐进式修正通常只会扩展或缩短上一段文本
          //（例如 "hello" → "hello world"，或 "hello wor" → "hello wo"）。
          // 新 segment 的特征则是文本完全不同（双方都不是对方的前缀）。
          // 一旦检测到，就把上一段文本作为 final 发出，让调用方可以累积它，
          // 避免新 segment 覆盖并丢失旧内容。
          //
          // Nova 3 的 interim 会跨 segment 累积，而且还可能修正更早的文本
          //（"Hello?" → "Hello."）。这种修正会破坏前缀判断，导致错误地
          // auto-finalize：同一段文本先被提交一次，又在后续累计 interim 中
          // 再出现一次，最终造成重复。Nova 3 只会在最终 flush 时给出 endpoint，
          // 因此对它来说 auto-finalize 永远都不正确。
          if (!isNova3 && lastTranscriptText) {
            const prev = lastTranscriptText.trimStart()
            const next = transcript.trimStart()
            if (
              prev &&
              next &&
              !next.startsWith(prev) &&
              !prev.startsWith(next)
            ) {
              logForDebugging(
                `[voice_stream] Auto-finalizing previous segment (new segment detected): "${lastTranscriptText}"`,
              )
              callbacks.onTranscript(lastTranscriptText, true)
            }
          }
          lastTranscriptText = transcript
          // 作为 interim 发出，便于调用方展示实时预览。
          callbacks.onTranscript(transcript, false)
        }
        break
      }
      case 'TranscriptEndpoint': {
        logForDebugging(
          `[voice_stream] TranscriptEndpoint received, lastTranscriptText="${lastTranscriptText}"`,
        )
        // 服务端在这里表示一次话语已经结束。
        // 将最后一条 TranscriptText 作为 final transcript 发出，供调用方提交。
        const finalText = lastTranscriptText
        lastTranscriptText = ''
        if (finalText) {
          callbacks.onTranscript(finalText, true)
        }
        // 如果 TranscriptEndpoint 在 CloseStream 发送之后到达，说明服务端已经
        // flush 完最终 transcript，不会再有更多内容。此时立刻 resolve finalize，
        // 调用方就能马上读取累积缓冲（~300ms），而不用再等 WebSocket close
        // 事件（服务端清理通常要 ~3-5 秒）。这里正确的门控条件是 `finalized`
        // 而不是 `finalizing`：它只会在真正发送 CloseStream 的 setTimeout(0)
        // 回调里翻转，因此即便 TranscriptEndpoint 与延迟发送竞争，也会继续等待。
        if (finalized) {
          resolveFinalize?.('post_closestream_endpoint')
        }
        break
      }
      case 'TranscriptError': {
        const desc =
          msg.description ?? msg.error_code ?? 'unknown transcription error'
        logForDebugging(`[voice_stream] TranscriptError: ${desc}`)
        if (!finalizing) {
          callbacks.onError(desc)
        }
        break
      }
      case 'error': {
        const errorDetail = msg.message ?? jsonStringify(msg)
        logForDebugging(`[voice_stream] Server error: ${errorDetail}`)
        if (!finalizing) {
          callbacks.onError(errorDetail)
        }
        break
      }
      default:
        break
    }
  })

  ws.on('close', (code, reason) => {
    const reasonStr = reason?.toString() ?? ''
    logForDebugging(
      `[voice_stream] WebSocket closed: code=${String(code)} reason="${reasonStr}"`,
    )
    connected = false
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
    // 如果服务端在发送 TranscriptEndpoint 之前就关闭了连接，
    // 就把最后一条 interim transcript 提升为 final，避免文本丢失。
    if (lastTranscriptText) {
      logForDebugging(
        '[voice_stream] Promoting unreported interim transcript to final on close',
      )
      const finalText = lastTranscriptText
      lastTranscriptText = ''
      callbacks.onTranscript(finalText, true)
    }
    // finalize 期间要抑制 onError，因为这次会话已经把能给的内容都给完了。
    // useVoice 的 onError 路径会清空 accumulatedRef，这会让 finalize .then()
    // 在读取 transcript 之前就把内容破坏掉。这里正确的门控是 `finalizing`
    // 而不是 resolveFinalize：它在 finalize() 入口处置为 true 后就不会清除，
    // 因此即使走了 fast path 或某个定时器已先完成，判断仍然准确。
    resolveFinalize?.('ws_close')
    if (!finalizing && !upgradeRejected && code !== 1000 && code !== 1005) {
      callbacks.onError(
        `Connection closed: code ${String(code)}${reasonStr ? ` — ${reasonStr}` : ''}`,
      )
    }
    callbacks.onClose()
  })

  // 当 HTTP upgrade 返回非 101 状态时，ws 库会触发 'unexpected-response'。
  // 监听它后，我们就能拿到真实状态码，并把 4xx 标记为 fatal
  //（重试时 token/TLS 指纹都不会变化）。注册该监听器后，ws 不会再替我们中止；
  // 因此需要自己 destroy request。此时不会触发 'error'，但会触发 'close'
  //（通过上面的 upgradeRejected 进行抑制）。
  //
  // Bun 的 ws shim 历史上并未实现这个事件（注册时只会记录一次 warning）。
  // 在 Bun 下，非 101 的 upgrade 会落到通用的 'error' + 'close' 1002 路径，
  // 无法恢复出状态码；不过 useVoice.ts 中的 attemptGenRef guard 仍然能暴露
  // 本次重试失败，用户只会看到 "Expected 101 status code"，而不是 "HTTP 503"。
  // 问题不大，真正关键的是那层 gen 修复。
  ws.on('unexpected-response', (req: ClientRequest, res: IncomingMessage) => {
    const status = res.statusCode ?? 0
    // Bun 在 Windows 上的 ws 实现可能会对成功的
    // 101 Switching Protocols 响应也触发这个事件（anthropics/claude-code#40510）。
    // 101 绝不表示拒绝，因此必须先退出，避免把正常的 upgrade 误销毁。
    if (status === 101) {
      logForDebugging(
        '[voice_stream] unexpected-response fired with 101; ignoring',
      )
      return
    }
    logForDebugging(
      `[voice_stream] Upgrade rejected: status=${String(status)} cf-mitigated=${String(res.headers['cf-mitigated'])} cf-ray=${String(res.headers['cf-ray'])}`,
    )
    upgradeRejected = true
    res.resume()
    req.destroy()
    if (finalizing) return
    callbacks.onError(
      `WebSocket upgrade rejected with HTTP ${String(status)}`,
      { fatal: status >= 400 && status < 500 },
    )
  })

  ws.on('error', (err: Error) => {
    logError(err)
    logForDebugging(`[voice_stream] WebSocket error: ${err.message}`)
    if (!finalizing) {
      callbacks.onError(`Voice stream connection error: ${err.message}`)
    }
  })

  return connection
}
