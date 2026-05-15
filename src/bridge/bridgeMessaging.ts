/**
 * 用于 bridge 消息处理的共享 transport 层辅助函数。
 *
 * 从 replBridge.ts 中提取出来，使基于 env 的 core（initBridgeCore）和
 * env-less core（initEnvLessBridgeCore）都能复用同一套 ingress 解析、
 * control-request 处理和 echo 去重机制。
 *
 * 这里的所有逻辑都是纯函数式的，不闭包依赖 bridge 专属状态。
 * 所有协作者（transport、sessionId、UUID set、callback）都通过参数传入。
 */

import { randomUUID } from 'crypto'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import type { SDKResultSuccess } from '../entrypoints/sdk/coreTypes.js'
import { logEvent } from '../services/analytics/index.js'
import { EMPTY_USAGE } from '../services/api/emptyUsage.js'
import type { Message } from '../types/message.js'
import { normalizeControlMessageKeys } from '../utils/controlMessageCompat.js'
import { logForDebugging } from '../utils/debug.js'
import { stripDisplayTagsAllowEmpty } from '../utils/displayTags.js'
import { errorMessage } from '../utils/errors.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { jsonParse } from '../utils/slowOperations.js'
import type { ReplBridgeTransport } from './replBridgeTransport.js'

// ─── 类型守卫 ─────────────────────────────────────────────────────────────

/** 用于已解析 WebSocket 消息的类型谓词。SDKMessage 是基于 `type` 的判别联合，
 *  因此校验该判别字段就足以完成谓词判断；调用方会再基于联合类型继续收窄。 */
export function isSDKMessage(value: unknown): value is SDKMessage {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    typeof value.type === 'string'
  )
}

/** 用于服务端 control_response 消息的类型谓词。 */
export function isSDKControlResponse(
  value: unknown,
): value is SDKControlResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'control_response' &&
    'response' in value
  )
}

/** 用于服务端 control_request 消息的类型谓词。 */
export function isSDKControlRequest(
  value: unknown,
): value is SDKControlRequest {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'control_request' &&
    'request_id' in value &&
    'request' in value
  )
}

/**
 * 对应需要转发给 bridge transport 的消息类型时返回 true。
 * 服务端只关心 user/assistant 轮次以及 slash-command 的 system 事件；
 * 其余内容（tool_result、progress 等）都属于 REPL 内部噪声。
 */
export function isEligibleBridgeMessage(m: Message): boolean {
  // Virtual message（REPL 内部调用）仅用于展示。bridge/SDK 消费者看到的是
  // 汇总工作内容的 REPL tool_use/result。
  if ((m.type === 'user' || m.type === 'assistant') && m.isVirtual) {
    return false
  }
  return (
    m.type === 'user' ||
    m.type === 'assistant' ||
    (m.type === 'system' && m.subtype === 'local_command')
  )
}

/**
 * 从 Message 中提取适合用于标题的文本，供 onUserMessage 使用。
 * 对于不应作为 session 标题的消息返回 undefined：非 user、meta
 * （提示类）、tool result、compact summary、非人类来源（task 通知、channel message），
 * 或纯 display-tag 内容（<ide_opened_file>、<session-start-hook> 等）。
 *
 * Synthetic interrupt（[Request interrupted by user]）不会在这里被过滤。
 * isSyntheticMessage 位于 messages.ts 中，属于重量级导入，会拉入 command registry。
 * initReplBridge 中的 initialMessages 路径会检查它；而在 writeMessages 路径中，
 * 把 interrupt 当作“第一条”消息几乎不可能发生，因为 interrupt 意味着之前必然已有 prompt。
 */
export function extractTitleText(m: Message): string | undefined {
  if (m.type !== 'user' || m.isMeta || m.toolUseResult || m.isCompactSummary)
    return undefined
  if (m.origin && m.origin.kind !== 'human') return undefined
  const content = m.message.content
  let raw: string | undefined
  if (typeof content === 'string') {
    raw = content
  } else {
    for (const block of content) {
      if (block.type === 'text') {
        raw = block.text
        break
      }
    }
  }
  if (!raw) return undefined
  const clean = stripDisplayTagsAllowEmpty(raw)
  return clean || undefined
}

// ─── Ingress 路由 ─────────────────────────────────────────────────────────

/**
 * 解析 ingress WebSocket 消息，并将其路由到合适的 handler。
 * 会忽略 UUID 出现在 recentPostedUUIDs 中的消息（也就是我们自己发出的回显），
 * 以及出现在 recentInboundUUIDs 中的消息（我们已转发过的重复投递，例如 transport
 * 切换导致 seq-num 游标丢失后，服务端又重放了历史记录）。
 */
export function handleIngressMessage(
  data: string,
  recentPostedUUIDs: BoundedUUIDSet,
  recentInboundUUIDs: BoundedUUIDSet,
  onInboundMessage: ((msg: SDKMessage) => void | Promise<void>) | undefined,
  onPermissionResponse?: ((response: SDKControlResponse) => void) | undefined,
  onControlRequest?: ((request: SDKControlRequest) => void) | undefined,
): void {
  try {
    const parsed: unknown = normalizeControlMessageKeys(jsonParse(data))

    // control_response 不是 SDKMessage，因此要在类型守卫前先检查
    if (isSDKControlResponse(parsed)) {
      logForDebugging('[bridge:repl] Ingress message type=control_response')
      onPermissionResponse?.(parsed)
      return
    }

    // 来自服务端的 control_request（initialize、set_model、can_use_tool）。
    // 必须尽快响应，否则服务端会关闭 WS（超时约 10-14 秒）。
    if (isSDKControlRequest(parsed)) {
      logForDebugging(
        `[bridge:repl] Inbound control_request subtype=${parsed.request.subtype}`,
      )
      onControlRequest?.(parsed)
      return
    }

    if (!isSDKMessage(parsed)) return

    // 检查 UUID，以识别我们自己消息的回显
    const uuid =
      'uuid' in parsed && typeof parsed.uuid === 'string'
        ? parsed.uuid
        : undefined

    if (uuid && recentPostedUUIDs.has(uuid)) {
      logForDebugging(
        `[bridge:repl] Ignoring echo: type=${parsed.type} uuid=${uuid}`,
      )
      return
    }

    // 防御性去重：丢弃已经转发过的 inbound prompt。SSE 的 seq-num 延续
    // （lastTransportSequenceNum）是修复历史重放的主方案；这里用来兜住协商失败的
    // 边缘情况（例如服务端忽略 from_sequence_num、transport 在收到任何 frame 前就挂掉等）。
    if (uuid && recentInboundUUIDs.has(uuid)) {
      logForDebugging(
        `[bridge:repl] Ignoring re-delivered inbound: type=${parsed.type} uuid=${uuid}`,
      )
      return
    }

    logForDebugging(
      `[bridge:repl] Ingress message type=${parsed.type}${uuid ? ` uuid=${uuid}` : ''}`,
    )

    if (parsed.type === 'user') {
      if (uuid) recentInboundUUIDs.add(uuid)
      logEvent('tengu_bridge_message_received', {
        is_repl: true,
      })
      // Fire-and-forget：handler 可能是异步的（例如附件解析）。
      void onInboundMessage?.(parsed)
    } else {
      logForDebugging(
        `[bridge:repl] Ignoring non-user inbound message: type=${parsed.type}`,
      )
    }
  } catch (err) {
    logForDebugging(
      `[bridge:repl] Failed to parse ingress message: ${errorMessage(err)}`,
    )
  }
}

// ─── 服务端发起的 control request ───────────────────────────────────────

export type ServerControlRequestHandlers = {
  transport: ReplBridgeTransport | null
  sessionId: string
  /**
    * 为 true 时，所有可变请求（interrupt、set_model、set_permission_mode、
    * set_max_thinking_tokens）都会返回 error，而不是假成功。
    * initialize 仍然返回 success，否则服务端会杀掉连接。
    * 用于 outbound-only bridge 模式和 SDK 的 /bridge 子路径，让 claude.ai 能看到
    * 正确错误，而不是“操作成功但本地什么都没发生”。
   */
  outboundOnly?: boolean
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
}

const OUTBOUND_ONLY_ERROR =
  'This session is outbound-only. Enable Remote Control locally to allow inbound control.'

/**
 * 响应服务端发来的 inbound control_request。服务端会为 session 生命周期事件
 * （initialize、set_model）以及轮次级协调（interrupt、set_max_thinking_tokens）
 * 发送这些请求。如果我们不响应，服务端会卡住并在约 10-14 秒后关闭 WS。
 *
 * 之前它是 initBridgeCore 的 onWorkReceived 内部闭包；现在改为通过参数接收
 * 协作者，以便两套 core 都能复用。
 */
export function handleServerControlRequest(
  request: SDKControlRequest,
  handlers: ServerControlRequestHandlers,
): void {
  const {
    transport,
    sessionId,
    outboundOnly,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
  } = handlers
  if (!transport) {
    logForDebugging(
      '[bridge:repl] Cannot respond to control_request: transport not configured',
    )
    return
  }

  let response: SDKControlResponse

  // Outbound-only：对可变请求返回 error，避免 claude.ai 显示假成功。
  // initialize 仍必须成功，否则服务端会杀掉连接（见上文说明）。
  if (outboundOnly && request.request.subtype !== 'initialize') {
    response = {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: request.request_id,
        error: OUTBOUND_ONLY_ERROR,
      },
    }
    const event = { ...response, session_id: sessionId }
    void transport.write(event)
    logForDebugging(
      `[bridge:repl] Rejected ${request.request.subtype} (outbound-only) request_id=${request.request_id}`,
    )
    return
  }

  switch (request.request.subtype) {
    case 'initialize':
      // 返回最小能力集，commands、models 和 account info 由 REPL 自己处理。
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
          response: {
            commands: [],
            output_style: 'normal',
            available_output_styles: ['normal'],
            models: [],
            account: {},
            pid: process.pid,
          },
        },
      }
      break

    case 'set_model':
      onSetModel?.(request.request.model)
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
        },
      }
      break

    case 'set_max_thinking_tokens':
      onSetMaxThinkingTokens?.(request.request.max_thinking_tokens)
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
        },
      }
      break

    case 'set_permission_mode': {
      // callback 返回策略裁决，这样我们就能在不引入
      // isAutoModeGateEnabled / isBypassPermissionsModeDisabled 的前提下
      // 发送 error control_response（保持 bootstrap 隔离）。如果没有注册 callback
      // （例如 daemon 上下文没有接这根线，见 daemonBridge.ts），就返回错误裁决，
      // 而不是静默假成功，因为该上下文里实际上根本不会应用该 mode，
      // 返回 success 等于欺骗客户端。
      const verdict = onSetPermissionMode?.(request.request.mode) ?? {
        ok: false,
        error:
          'set_permission_mode is not supported in this context (onSetPermissionMode callback not registered)',
      }
      if (verdict.ok) {
        response = {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: request.request_id,
          },
        }
      } else {
        response = {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: request.request_id,
            error: verdict.error,
          },
        }
      }
      break
    }

    case 'interrupt':
      onInterrupt?.()
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
        },
      }
      break

    default:
      // 未知 subtype：返回 error，避免服务端一直等待永远不会到来的回复。
      response = {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: request.request_id,
          error: `REPL bridge does not handle control_request subtype: ${request.request.subtype}`,
        },
      }
  }

  const event = { ...response, session_id: sessionId }
  void transport.write(event)
  logForDebugging(
    `[bridge:repl] Sent control_response for ${request.request.subtype} request_id=${request.request_id} result=${response.response.subtype}`,
  )
}

// ─── Result 消息（用于 teardown 时归档 session） ───────────────────────

/**
 * 为 session 归档构造一个最小化的 `SDKResultSuccess` 消息。
 * 服务端需要在 WS 关闭前先收到这个事件，才能触发归档。
 */
export function makeResultMessage(sessionId: string): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 0,
    result: '',
    stop_reason: null,
    total_cost_usd: 0,
    usage: { ...EMPTY_USAGE },
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId,
    uuid: randomUUID(),
  }
}

// ─── BoundedUUIDSet（回显去重环形缓冲区） ─────────────────────────────────

/**
 * 由循环缓冲区支撑的 FIFO 有界集合。达到容量上限时会驱逐最旧条目，
 * 从而将内存占用稳定在 O(capacity)。
 *
 * 消息按时间顺序加入，因此被驱逐的总是最旧条目。调用方把外部顺序
 * （hook 的 lastWrittenIndexRef）作为主要去重依据；这个 set 只是回显过滤和
 * 竞态条件去重的第二道保险。
 */
export class BoundedUUIDSet {
  private readonly capacity: number
  private readonly ring: (string | undefined)[]
  private readonly set = new Set<string>()
  private writeIdx = 0

  constructor(capacity: number) {
    this.capacity = capacity
    this.ring = new Array<string | undefined>(capacity)
  }

  add(uuid: string): void {
    if (this.set.has(uuid)) return
    // 驱逐当前写入位置上的条目（如果该位置已被占用）
    const evicted = this.ring[this.writeIdx]
    if (evicted !== undefined) {
      this.set.delete(evicted)
    }
    this.ring[this.writeIdx] = uuid
    this.set.add(uuid)
    this.writeIdx = (this.writeIdx + 1) % this.capacity
  }

  has(uuid: string): boolean {
    return this.set.has(uuid)
  }

  clear(): void {
    this.set.clear()
    this.ring.fill(undefined)
    this.writeIdx = 0
  }
}
