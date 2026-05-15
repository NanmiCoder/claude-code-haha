import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
} from '../entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemMessage,
} from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { fromSDKCompactMetadata } from '../utils/messages/mappers.js'
import { createUserMessage } from '../utils/messages.js'

/**
 * 将来自 CCR 的 SDKMessage 转换为 REPL Message 类型。
 *
 * CCR 后端通过 WebSocket 发送 SDK 格式消息，而 REPL 期望的是内部 Message
 * 类型用于渲染。这个适配器负责连接两者。
 */

/**
 * 将 SDKAssistantMessage 转换为 AssistantMessage。
 */
function convertAssistantMessage(msg: SDKAssistantMessage): AssistantMessage {
  return {
    type: 'assistant',
    message: msg.message,
    uuid: msg.uuid,
    requestId: undefined,
    timestamp: new Date().toISOString(),
    error: msg.error,
  }
}

/**
 * 将 SDKPartialAssistantMessage（流式消息）转换为 StreamEvent。
 */
function convertStreamEvent(msg: SDKPartialAssistantMessage): StreamEvent {
  return {
    type: 'stream_event',
    event: msg.event,
  }
}

/**
 * 将 SDKResultMessage 转换为 SystemMessage。
 */
function convertResultMessage(msg: SDKResultMessage): SystemMessage {
  const isError = msg.subtype !== 'success'
  const content = isError
    ? msg.errors?.join(', ') || 'Unknown error'
    : 'Session completed successfully'

  return {
    type: 'system',
    subtype: 'informational',
    content,
    level: isError ? 'warning' : 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将 SDKSystemMessage（init）转换为 SystemMessage。
 */
function convertInitMessage(msg: SDKSystemMessage): SystemMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Remote session initialized (model: ${msg.model})`,
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将 SDKStatusMessage 转换为 SystemMessage。
 */
function convertStatusMessage(msg: SDKStatusMessage): SystemMessage | null {
  if (!msg.status) {
    return null
  }

  return {
    type: 'system',
    subtype: 'informational',
    content:
      msg.status === 'compacting'
        ? 'Compacting conversation…'
        : `Status: ${msg.status}`,
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将 SDKToolProgressMessage 转换为 SystemMessage。
 * 这里使用 system message 而不是 ProgressMessage，因为 Progress 类型是复杂联合，
 * 需要 CCR 并未提供的 tool 专属数据。
 */
function convertToolProgressMessage(
  msg: SDKToolProgressMessage,
): SystemMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Tool ${msg.tool_name} running for ${msg.elapsed_time_seconds}s…`,
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
    toolUseID: msg.tool_use_id,
  }
}

/**
 * 将 SDKCompactBoundaryMessage 转换为 SystemMessage。
 */
function convertCompactBoundaryMessage(
  msg: SDKCompactBoundaryMessage,
): SystemMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
    compactMetadata: fromSDKCompactMetadata(msg.compact_metadata),
  }
}

/**
 * 转换 SDKMessage 的结果。
 */
export type ConvertedMessage =
  | { type: 'message'; message: Message }
  | { type: 'stream_event'; event: StreamEvent }
  | { type: 'ignored' }

type ConvertOptions = {
  /** 将包含 tool_result 内容块的用户消息转换为 UserMessage。
   * 用于 direct connect 模式，在该模式下 tool result 来自远端服务端，
   * 需要在本地渲染。CCR 模式会忽略用户消息，因为它们的处理方式不同。 */
  convertToolResults?: boolean
  /**
   * 将用户文本消息转换为 UserMessage 以供展示。用于转换历史事件时，
   * 因为用户输入的消息需要显示出来。在实时 WS 模式下，这些消息已由 REPL
   * 本地加入，因此默认会被忽略。
   */
  convertUserTextMessages?: boolean
}

/**
 * 将 SDKMessage 转换为 REPL 消息格式。
 */
export function convertSDKMessage(
  msg: SDKMessage,
  opts?: ConvertOptions,
): ConvertedMessage {
  switch (msg.type) {
    case 'assistant':
      return { type: 'message', message: convertAssistantMessage(msg) }

    case 'user': {
      const content = msg.message?.content
      // 来自远端服务端的 tool result 消息需要被转换，这样它们的渲染和折叠行为
      // 才能与本地 tool result 一致。通过内容形状（tool_result block）来检测。
      // parent_tool_use_id 并不可靠：agent 侧 normalizeMessage() 会把顶层
      // tool result 的该字段硬编码为 null，因此无法借此区分 tool result 和
      // prompt 回显。
      const isToolResult =
        Array.isArray(content) && content.some(b => b.type === 'tool_result')
      if (opts?.convertToolResults && isToolResult) {
        return {
          type: 'message',
          message: createUserMessage({
            content,
            toolUseResult: msg.tool_use_result,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
          }),
        }
      }
      // 在转换历史事件时，用户输入的消息需要被渲染出来
      // （因为它们没有由 REPL 在本地补上）。这里跳过 tool_result，
      // 因为上面已经处理过了。
      if (opts?.convertUserTextMessages && !isToolResult) {
        if (typeof content === 'string' || Array.isArray(content)) {
          return {
            type: 'message',
            message: createUserMessage({
              content,
              toolUseResult: msg.tool_use_result,
              uuid: msg.uuid,
              timestamp: msg.timestamp,
            }),
          }
        }
      }
      // 用户输入的消息（string content）已经由 REPL 本地加入。
      // 在 CCR 模式下，所有用户消息都会被忽略（tool result 另行处理）。
      return { type: 'ignored' }
    }

    case 'stream_event':
      return { type: 'stream_event', event: convertStreamEvent(msg) }

    case 'result':
      // 只展示错误类 result 消息。成功 result 在多轮 session 中只是噪音，
      // 因为 isLoading=false 已经足够表达完成状态。
      if (msg.subtype !== 'success') {
        return { type: 'message', message: convertResultMessage(msg) }
      }
      return { type: 'ignored' }

    case 'system':
      if (msg.subtype === 'init') {
        return { type: 'message', message: convertInitMessage(msg) }
      }
      if (msg.subtype === 'status') {
        const statusMsg = convertStatusMessage(msg)
        return statusMsg
          ? { type: 'message', message: statusMsg }
          : { type: 'ignored' }
      }
      if (msg.subtype === 'compact_boundary') {
        return {
          type: 'message',
          message: convertCompactBoundaryMessage(msg),
        }
      }
      // hook_response 和其他 subtype
      logForDebugging(
        `[sdkMessageAdapter] Ignoring system message subtype: ${msg.subtype}`,
      )
      return { type: 'ignored' }

    case 'tool_progress':
      return { type: 'message', message: convertToolProgressMessage(msg) }

    case 'auth_status':
      // Auth status 单独处理，不转换为展示消息
      logForDebugging('[sdkMessageAdapter] Ignoring auth_status message')
      return { type: 'ignored' }

    case 'tool_use_summary':
      // Tool use summary 是仅供 SDK 使用的事件，不在 REPL 中展示
      logForDebugging('[sdkMessageAdapter] Ignoring tool_use_summary message')
      return { type: 'ignored' }

    case 'rate_limit_event':
      // Rate limit event 是仅供 SDK 使用的事件，不在 REPL 中展示
      logForDebugging('[sdkMessageAdapter] Ignoring rate_limit_event message')
      return { type: 'ignored' }

    default: {
      // 平滑忽略未知消息类型。后端可能会在客户端更新前先发送新类型；
      // 记录日志有助于排查问题，同时避免崩溃或丢失 session。
      logForDebugging(
        `[sdkMessageAdapter] Unknown message type: ${(msg as { type: string }).type}`,
      )
      return { type: 'ignored' }
    }
  }
}

/**
 * 检查 SDKMessage 是否表示 session 已结束。
 */
export function isSessionEndMessage(msg: SDKMessage): boolean {
  return msg.type === 'result'
}

/**
 * 检查 SDKResultMessage 是否表示成功。
 */
export function isSuccessResult(msg: SDKResultMessage): boolean {
  return msg.subtype === 'success'
}

/**
 * 从成功的 SDKResultMessage 中提取结果文本。
 */
export function getResultText(msg: SDKResultMessage): string | null {
  if (msg.subtype === 'success') {
    return msg.result
  }
  return null
}
