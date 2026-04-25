/**
 * WebSocket connection handler
 *
 * 管理 WebSocket 连接生命周期，处理消息路由。
 * 用户消息通过 CLI 子进程（stream-json 模式）处理，
 * CLI stdout 消息被转换为 ServerMessage 并转发到 WebSocket。
 */

import type { ServerWebSocket } from 'bun'
import type { ClientMessage, ServerMessage } from './events.js'
import * as os from 'node:os'
import {
  ConversationStartupError,
  conversationService,
} from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import { sessionService } from '../services/sessionService.js'
import { SettingsService } from '../services/settingsService.js'
import { ProviderService } from '../services/providerService.js'
import { deriveTitle, generateTitle, saveAiTitle } from '../services/titleService.js'
import { normalizeModelRouting, toModelEnv } from '../services/modelRoutingService.js'
import { patchSettingsEnv } from '../services/settingsSyncService.js'
import { getXiaomuModelCatalog } from '../services/xiaomuModelService.js'

const settingsService = new SettingsService()
const providerService = new ProviderService()
const XIAOMU_CONFIG_FALLBACK_DIR = '.xiaomu-ai'

/**
 * Cache slash commands from CLI init messages, keyed by sessionId.
 */
const sessionSlashCommands = new Map<string, Array<{ name: string; description: string }>>()

/**
 * Timers for delayed session cleanup after client disconnect.
 * If a client reconnects within 5 minutes, the timer is cancelled.
 */
const sessionCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Track sessions where user requested stop — suppress the CLI_ERROR that
 * follows an interrupt so the frontend doesn't show "处理过程中发生错误".
 */
const sessionStopRequested = new Set<string>()

/**
 * Track user message count and title state per session for auto-title generation.
 */
const sessionTitleState = new Map<string, {
  userMessageCount: number
  hasCustomTitle: boolean
  firstUserMessage: string
  allUserMessages: string[]
}>()

export function getSlashCommands(sessionId: string): Array<{ name: string; description: string }> {
  return sessionSlashCommands.get(sessionId) || []
}

export type WebSocketData = {
  sessionId: string
  connectedAt: number
  channel: 'client' | 'sdk'
  sdkToken: string | null
  serverPort: number
  serverHost: string
}

// Active WebSocket sessions
const activeSessions = new Map<string, ServerWebSocket<WebSocketData>>()

export const handleWebSocket = {
  open(ws: ServerWebSocket<WebSocketData>) {
    const { sessionId, channel, sdkToken } = ws.data

    if (channel === 'sdk') {
      if (!conversationService.authorizeSdkConnection(sessionId, sdkToken)) {
        console.warn(`[WS] Rejected SDK connection for session: ${sessionId}`)
        ws.close(1008, 'Invalid SDK token')
        return
      }

      conversationService.attachSdkConnection(sessionId, ws)
      console.log(`[WS] SDK connected for session: ${sessionId}`)
      return
    }

    console.log(`[WS] Client connected for session: ${sessionId}`)

    // Cancel pending cleanup timer if client reconnects
    const pendingTimer = sessionCleanupTimers.get(sessionId)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      sessionCleanupTimers.delete(sessionId)
    }

    activeSessions.set(sessionId, ws)

    const msg: ServerMessage = { type: 'connected', sessionId }
    ws.send(JSON.stringify(msg))
  },

  message(ws: ServerWebSocket<WebSocketData>, rawMessage: string | Buffer) {
    if (ws.data.channel === 'sdk') {
      const payload = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
      conversationService.handleSdkPayload(ws.data.sessionId, payload)
      return
    }

    try {
      const message = JSON.parse(
        typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
      ) as ClientMessage

      switch (message.type) {
        case 'user_message':
          handleUserMessage(ws, message).catch((err) => {
            console.error(`[WS] Unhandled error in handleUserMessage:`, err)
          })
          break

        case 'permission_response':
          handlePermissionResponse(ws, message)
          break

        case 'computer_use_permission_response':
          handleComputerUsePermissionResponse(ws, message)
          break

        case 'set_permission_mode':
          handleSetPermissionMode(ws, message)
          break

        case 'stop_generation':
          handleStopGeneration(ws)
          break

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' } satisfies ServerMessage))
          break

        default:
          sendError(ws, `Unknown message type: ${(message as any).type}`, 'UNKNOWN_TYPE')
      }
    } catch (error) {
      sendError(ws, `Invalid message format: ${error}`, 'PARSE_ERROR')
    }
  },

  close(ws: ServerWebSocket<WebSocketData>, code: number, reason: string) {
    const { sessionId, channel } = ws.data

    if (channel === 'sdk') {
      console.log(`[WS] SDK disconnected from session: ${sessionId} (${code}: ${reason})`)
      conversationService.detachSdkConnection(sessionId)
      return
    }

    console.log(`[WS] Client disconnected from session: ${sessionId} (${code}: ${reason})`)
    computerUseApprovalService.cancelSession(sessionId)
    activeSessions.delete(sessionId)
    cleanupStreamState(sessionId)
    sessionSlashCommands.delete(sessionId)
    sessionTitleState.delete(sessionId)

    // Schedule delayed cleanup: if the client doesn't reconnect within 30 seconds,
    // stop the CLI subprocess to avoid leaking resources.
    const cleanupTimer = setTimeout(() => {
      sessionCleanupTimers.delete(sessionId)
      if (!activeSessions.has(sessionId)) {
        console.log(`[WS] Session ${sessionId} not reconnected after 30s, stopping CLI subprocess`)
        conversationService.stopSession(sessionId)
      }
    }, 30_000)
    sessionCleanupTimers.set(sessionId, cleanupTimer)
  },

  drain(ws: ServerWebSocket<WebSocketData>) {
    // Backpressure handling - called when the socket is ready to receive more data
  },
}

// ============================================================================
// Message handlers
// ============================================================================

async function handleUserMessage(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'user_message' }>
) {
  const { sessionId } = ws.data
  let workDir = os.homedir()

  // Clear any stale stop flag from a previous turn
  sessionStopRequested.delete(sessionId)

  // Send thinking status
  sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Thinking' })

  const runtimeSettings = await getRuntimeSettings()
  const hasSession = conversationService.hasSession(sessionId)
  const shouldRestartForRuntime =
    hasSession && conversationService.needsRestartForRuntimeOptions(sessionId, runtimeSettings)

  // 启动 CLI 子进程（如果还没有）
  if (!hasSession || shouldRestartForRuntime) {
    try {
      // Resolve the session's actual working directory
      try {
        const resolved =
          shouldRestartForRuntime
            ? conversationService.getSessionWorkDir(sessionId) || await sessionService.getSessionWorkDir(sessionId)
            : await sessionService.getSessionWorkDir(sessionId)
        if (resolved) workDir = resolved
        console.log(
          `[WS] handleUserMessage: sessionId=${sessionId}, resolved workDir=${JSON.stringify(
            resolved,
          )}, will spawn CLI with workDir=${workDir}`,
        )
      } catch (resolveErr) {
        // fallback to cwd if session file not found
        console.warn(
          `[WS] handleUserMessage: failed to resolve workDir for ${sessionId}, using fallback=${workDir}: ${
            resolveErr instanceof Error ? resolveErr.message : String(resolveErr)
          }`,
        )
      }
      if (shouldRestartForRuntime) {
        console.log(`[WS] Restarting CLI for ${sessionId} because runtime model/settings changed`)
        conversationService.stopSession(sessionId)
      }
      const sdkUrl =
        `ws://${ws.data.serverHost}:${ws.data.serverPort}/sdk/${sessionId}` +
        `?token=${encodeURIComponent(crypto.randomUUID())}`
      await conversationService.startSession(sessionId, workDir, sdkUrl, runtimeSettings)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const code =
        err instanceof ConversationStartupError ? err.code : 'CLI_START_FAILED'
      console.error(`[WS] CLI start failed for ${sessionId}: ${errMsg}`)
      sendMessage(ws, {
        type: 'error',
        message: errMsg,
        code,
        retryable:
          err instanceof ConversationStartupError ? err.retryable : false,
      })
      sendMessage(ws, { type: 'status', state: 'idle' })
      return
    }
  }

  // Track user message for title generation
  let titleState = sessionTitleState.get(sessionId)
  if (!titleState) {
    titleState = { userMessageCount: 0, hasCustomTitle: false, firstUserMessage: '', allUserMessages: [] }
    sessionTitleState.set(sessionId, titleState)
  }
  titleState.userMessageCount++
  titleState.allUserMessages.push(message.content)
  if (titleState.userMessageCount === 1) {
    titleState.firstUserMessage = message.content
  }

  // Register the callback before sending the turn so startup errors are not lost.
  // Keep output muted until the current user turn is enqueued to avoid forwarding
  // any pre-turn SDK chatter as fresh chat history.
  let userMessageSent = false

  conversationService.clearOutputCallbacks(sessionId)
  conversationService.onOutput(sessionId, (cliMsg) => {
    // Before the current turn is sent, only surface startup errors.
    if (!userMessageSent) {
      if (cliMsg.type === 'result' && cliMsg.is_error) {
        const serverMsgs = translateCliMessage(cliMsg, sessionId)
        for (const msg of serverMsgs) {
          sendMessage(ws, msg)
        }
      }
      return
    }
    const serverMsgs = translateCliMessage(cliMsg, sessionId)
    for (const msg of serverMsgs) {
      sendMessage(ws, msg)
    }
    // Trigger title generation on message_complete
    if (cliMsg.type === 'result') {
      triggerTitleGeneration(ws, sessionId)
    }
  })

  const sent = conversationService.sendMessage(
    sessionId,
    message.content,
    message.attachments
  )
  if (!sent) {
    sendMessage(ws, {
      type: 'error',
      message: 'CLI process is not running. The session may have ended or the process crashed.',
      code: 'CLI_NOT_RUNNING',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
    return
  }

  userMessageSent = true
}

function handlePermissionResponse(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'permission_response' }>
) {
  const { sessionId } = ws.data
  conversationService.respondToPermission(
    sessionId,
    message.requestId,
    message.allowed,
    message.rule,
  )
  console.log(`[WS] Permission response for ${message.requestId}: ${message.allowed}`)
}

function handleComputerUsePermissionResponse(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'computer_use_permission_response' }>
) {
  const { sessionId } = ws.data
  const ok = computerUseApprovalService.resolveApproval(
    message.requestId,
    message.response,
  )
  if (!ok) {
    console.warn(
      `[WS] Ignored Computer Use permission response for unknown request ${message.requestId} from ${sessionId}`
    )
  }
}

function handleSetPermissionMode(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'set_permission_mode' }>
) {
  const { sessionId } = ws.data

  // Switching to/from bypassPermissions requires the CLI to be (re)started with
  // --dangerously-skip-permissions. The CLI rejects a runtime set_permission_mode
  // to bypassPermissions if it wasn't launched with that flag.  Rather than just
  // sending the SDK message (which would silently fail), restart the CLI subprocess
  // with the correct arguments so the new permission mode takes effect.
  const needsRestart =
    conversationService.hasSession(sessionId) &&
    (message.mode === 'bypassPermissions' || conversationService.getSessionPermissionMode(sessionId) === 'bypassPermissions')

  if (needsRestart) {
    void restartSessionWithPermissionMode(ws, sessionId, message.mode)
    return
  }

  const ok = conversationService.setPermissionMode(sessionId, message.mode)
  if (!ok) {
    console.warn(`[WS] Ignored permission mode update for inactive session ${sessionId}`)
  }
}

async function restartSessionWithPermissionMode(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  mode: string,
): Promise<void> {
  try {
    sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Restarting session with new permissions...' })

    // Persist the new mode first so it's read on restart
    await settingsService.setPermissionMode(mode)

    const workDir = conversationService.getSessionWorkDir(sessionId)
    conversationService.stopSession(sessionId)

    // Rebuild runtime settings (will pick up the persisted mode)
    const runtimeSettings = await getRuntimeSettings()
    const sdkUrl =
      `ws://${ws.data.serverHost}:${ws.data.serverPort}/sdk/${sessionId}` +
      `?token=${encodeURIComponent(crypto.randomUUID())}`
    await conversationService.startSession(sessionId, workDir, sdkUrl, runtimeSettings)

    sendMessage(ws, { type: 'status', state: 'idle' })
    console.log(`[WS] Restarted CLI for ${sessionId} with permission mode: ${mode}`)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[WS] Failed to restart CLI for ${sessionId}: ${errMsg}`)
    sendMessage(ws, {
      type: 'error',
      message: `Failed to restart session with new permission mode: ${errMsg}`,
      code: 'CLI_RESTART_FAILED',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
  }
}

function handleStopGeneration(ws: ServerWebSocket<WebSocketData>) {
  const { sessionId } = ws.data
  console.log(`[WS] Stop generation requested for session: ${sessionId}`)

  sessionStopRequested.add(sessionId)

  if (conversationService.hasSession(sessionId)) {
    // First try graceful interrupt via SDK control message
    conversationService.sendInterrupt(sessionId)

    // Force-kill if still running after 3 seconds
    setTimeout(() => {
      if (conversationService.hasSession(sessionId)) {
        console.log(`[WS] Force-killing CLI subprocess for session: ${sessionId}`)
        conversationService.stopSession(sessionId)
      }
    }, 3_000)
  }

  sendMessage(ws, { type: 'status', state: 'idle' })
}

// ============================================================================
// Title generation
// ============================================================================

function triggerTitleGeneration(ws: ServerWebSocket<WebSocketData>, sessionId: string): void {
  const state = sessionTitleState.get(sessionId)
  if (!state || state.hasCustomTitle) return

  const count = state.userMessageCount

  // Generate on count 1 (first response) and count 3 (with more context)
  if (count !== 1 && count !== 3) return

  const text = count === 1
    ? state.firstUserMessage
    : state.allUserMessages.join('\n')

  // Fire-and-forget: derive quick title, then upgrade with AI
  void (async () => {
    try {
      // Stage 1: quick placeholder (only on first message)
      if (count === 1) {
        const placeholder = deriveTitle(text)
        if (placeholder) {
          await saveAiTitle(sessionId, placeholder)
          sendMessage(ws, { type: 'session_title_updated', sessionId, title: placeholder })
        }
      }

      // Stage 2: AI-generated title
      const aiTitle = await generateTitle(text)
      if (aiTitle) {
        await saveAiTitle(sessionId, aiTitle)
        sendMessage(ws, { type: 'session_title_updated', sessionId, title: aiTitle })
      }
    } catch (err) {
      console.error(`[Title] Failed to generate title for ${sessionId}:`, err)
    }
  })()
}

// ============================================================================
// CLI message translation
// ============================================================================

/**
 * Per-session streaming state to avoid cross-session interference.
 * Each session tracks its own dedup flag, active block types, and tool blocks.
 */
type SessionStreamState = {
  hasReceivedStreamEvents: boolean
  hasReceivedTextDelta: boolean
  hasReceivedThinkingDelta: boolean
  activeBlockTypes: Map<number, 'text' | 'tool_use'>
  activeToolBlocks: Map<number, { toolName: string; toolUseId: string; inputJson: string }>
  /** Tool blocks whose input JSON failed to parse in content_block_stop.
   *  The assistant message carries the complete input - defer to that. */
  pendingToolBlocks: Map<string, { toolName: string; toolUseId: string; parentToolUseId?: string }>
}

const sessionStreamStates = new Map<string, SessionStreamState>()

function getStreamState(sessionId: string): SessionStreamState {
  let state = sessionStreamStates.get(sessionId)
  if (!state) {
    state = {
      hasReceivedStreamEvents: false,
      hasReceivedTextDelta: false,
      hasReceivedThinkingDelta: false,
      activeBlockTypes: new Map(),
      activeToolBlocks: new Map(),
      pendingToolBlocks: new Map(),
    }
    sessionStreamStates.set(sessionId, state)
  }
  return state
}

/** Clean up stream state when session disconnects */
function cleanupStreamState(sessionId: string) {
  sessionStreamStates.delete(sessionId)
}

function resetStreamTurnState(streamState: SessionStreamState): void {
  streamState.hasReceivedStreamEvents = false
  streamState.hasReceivedTextDelta = false
  streamState.hasReceivedThinkingDelta = false
  streamState.pendingToolBlocks.clear()
}

export function translateCliMessage(cliMsg: any, sessionId: string): ServerMessage[] {
  const streamState = getStreamState(sessionId)
  switch (cliMsg.type) {
    case 'assistant': {
      if (cliMsg.error) {
        return [{
          type: 'error',
          message: cliMsg.message?.content?.[0]?.text || cliMsg.error,
          code: cliMsg.error,
        }]
      }

      // If we already received stream_events, text/thinking were usually already
      // sent. Some providers only emit partial stream events, so fall back to
      // the final assistant payload when no renderable text/thinking delta was
      // actually forwarded to the frontend.
      if (cliMsg.message?.content && Array.isArray(cliMsg.message.content)) {
        const messages: ServerMessage[] = []

        for (const block of cliMsg.message.content) {
          if (streamState.hasReceivedStreamEvents) {
            if (
              block.type === 'thinking' &&
              block.thinking &&
              !streamState.hasReceivedThinkingDelta
            ) {
              messages.push({ type: 'thinking', text: block.thinking })
              continue
            }

            if (
              block.type === 'text' &&
              block.text &&
              !streamState.hasReceivedTextDelta
            ) {
              messages.push({ type: 'content_start', blockType: 'text' })
              messages.push({ type: 'content_delta', text: block.text })
              continue
            }
            // Stream events handled most blocks — but any tool_use whose
            // input JSON failed to parse in content_block_stop was deferred.
            // Emit those now with the complete input from the assistant message.
            if (block.type === 'tool_use' && streamState.pendingToolBlocks.has(block.id)) {
              const pending = streamState.pendingToolBlocks.get(block.id)!
              streamState.pendingToolBlocks.delete(block.id)
              messages.push({
                type: 'tool_use_complete',
                toolName: pending.toolName || block.name,
                toolUseId: block.id,
                input: block.input,
                parentToolUseId: pending.parentToolUseId,
              })
            }
          } else {
            // No stream events received — this is the only source, process everything
            if (block.type === 'thinking' && block.thinking) {
              messages.push({ type: 'thinking', text: block.thinking })
            } else if (block.type === 'text' && block.text) {
              messages.push({ type: 'content_start', blockType: 'text' })
              messages.push({ type: 'content_delta', text: block.text })
            } else if (block.type === 'tool_use') {
              messages.push({
                type: 'tool_use_complete',
                toolName: block.name,
                toolUseId: block.id,
                input: block.input,
                parentToolUseId:
                  typeof cliMsg.parent_tool_use_id === 'string'
                    ? cliMsg.parent_tool_use_id
                    : undefined,
              })
            }
          }
        }

        // Reset flags for next turn
        resetStreamTurnState(streamState)
        return messages
      }
      return []
    }

    case 'user': {
      // Bug #1: 处理 tool_result 消息
      // CLI 发送 type:'user' 消息，其中 content 包含 tool_result 块
      const messages: ServerMessage[] = []

      if (cliMsg.message?.content && Array.isArray(cliMsg.message.content)) {
        for (const block of cliMsg.message.content) {
          if (block.type === 'tool_result') {
            messages.push({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              content: block.content,
              isError: !!block.is_error,
              parentToolUseId:
                typeof cliMsg.parent_tool_use_id === 'string'
                  ? cliMsg.parent_tool_use_id
                  : undefined,
            })
          }
        }
      }

      return messages
    }

    case 'stream_event': {
      streamState.hasReceivedStreamEvents = true
      const event = cliMsg.event
      if (!event) return []

      switch (event.type) {
        case 'message_start': {
          return [{ type: 'status', state: 'streaming' }]
        }

        case 'content_block_start': {
          const contentBlock = event.content_block
          if (!contentBlock) return []

          const index = event.index ?? 0
          streamState.activeBlockTypes.set(index, contentBlock.type === 'tool_use' ? 'tool_use' : 'text')

          if (contentBlock.type === 'tool_use') {
            // Track tool info so content_block_stop can emit complete data
            streamState.activeToolBlocks.set(index, {
              toolName: contentBlock.name || '',
              toolUseId: contentBlock.id || '',
              inputJson: '',
            })
            return [{
              type: 'content_start',
              blockType: 'tool_use',
              toolName: contentBlock.name,
              toolUseId: contentBlock.id,
              parentToolUseId:
                typeof cliMsg.parent_tool_use_id === 'string'
                  ? cliMsg.parent_tool_use_id
                  : undefined,
            }]
          }
          return [{ type: 'content_start', blockType: 'text' }]
        }

        case 'content_block_delta': {
          const delta = event.delta
          if (!delta) return []

          if (delta.type === 'text_delta' && delta.text) {
            streamState.hasReceivedTextDelta = true
            return [{ type: 'content_delta', text: delta.text }]
          }
          if (delta.type === 'input_json_delta' && delta.partial_json) {
            // Accumulate tool input JSON
            const index = event.index ?? 0
            const toolBlock = streamState.activeToolBlocks.get(index)
            if (toolBlock) toolBlock.inputJson += delta.partial_json
            return [{ type: 'content_delta', toolInput: delta.partial_json }]
          }
          if (delta.type === 'thinking_delta' && delta.thinking) {
            streamState.hasReceivedThinkingDelta = true
            return [{ type: 'thinking', text: delta.thinking }]
          }
          return []
        }

        case 'content_block_stop': {
          const index = event.index ?? 0
          const blockType = streamState.activeBlockTypes.get(index)
          streamState.activeBlockTypes.delete(index)

          if (blockType === 'tool_use') {
            const toolBlock = streamState.activeToolBlocks.get(index)
            streamState.activeToolBlocks.delete(index)
            if (toolBlock) {
              const parentToolUseId =
                typeof cliMsg.parent_tool_use_id === 'string'
                  ? cliMsg.parent_tool_use_id
                  : undefined
              let parsedInput = null
              try { parsedInput = JSON.parse(toolBlock.inputJson) } catch {}

              if (parsedInput !== null) {
                return [{
                  type: 'tool_use_complete',
                  toolName: toolBlock.toolName,
                  toolUseId: toolBlock.toolUseId,
                  input: parsedInput,
                  parentToolUseId,
                }]
              }

              // JSON parse failed — defer to the assistant message which
              // carries the complete, already-parsed tool input.
              console.warn(
                `[WS] Tool input JSON parse failed for ${toolBlock.toolName} (${toolBlock.toolUseId}), deferring to assistant message`,
              )
              streamState.pendingToolBlocks.set(toolBlock.toolUseId, {
                toolName: toolBlock.toolName,
                toolUseId: toolBlock.toolUseId,
                parentToolUseId,
              })
            }
          }
          return []
        }

        case 'message_stop': {
          // message_stop is handled by the 'result' message
          return []
        }

        case 'message_delta': {
          // message_delta may contain stop_reason or usage updates
          return []
        }

        default:
          return []
      }
    }

    case 'control_request': {
      // 权限请求 — CLI 需要用户授权才能执行工具
      if (cliMsg.request?.subtype === 'can_use_tool') {
        return [{
          type: 'permission_request',
          requestId: cliMsg.request_id,
          toolName: cliMsg.request.tool_name || 'Unknown',
          input: cliMsg.request.input || {},
          description: cliMsg.request.description,
        }]
      }
      return []
    }

    case 'control_response':
      return []

    case 'result': {
      // 对话结果（成功或错误）
      const usage = {
        input_tokens: cliMsg.usage?.input_tokens || 0,
        output_tokens: cliMsg.usage?.output_tokens || 0,
      }
      resetStreamTurnState(streamState)

      if (cliMsg.is_error) {
        // If the user requested stop, this "error" is just the interrupt
        // result — don't show it as an error in the chat UI.
        if (sessionStopRequested.has(sessionId)) {
          sessionStopRequested.delete(sessionId)
          return [{ type: 'message_complete', usage }]
        }

        const resultMessage =
          (typeof cliMsg.result === 'string' && cliMsg.result) ||
          (Array.isArray(cliMsg.errors) && cliMsg.errors.length > 0
            ? cliMsg.errors.join('\n')
            : 'Unknown error')
        // 错误和完成消息都发送
        return [
          {
            type: 'error',
            message: resultMessage,
            code: 'CLI_ERROR',
          },
          { type: 'message_complete', usage },
        ]
      }

      // Clear stop flag on successful completion too
      sessionStopRequested.delete(sessionId)
      return [{ type: 'message_complete', usage }]
    }

    case 'system': {
      // 区分不同的 system 子类型
      const subtype = cliMsg.subtype
      if (subtype === 'init') {
        // CLI 初始化完成 — 缓存 slash commands 并发送模型信息
        // NOTE: Do NOT send status:idle here — the CLI init fires while
        // processing the first user message, and sending idle would reset
        // the frontend's streaming state prematurely.
        if (cliMsg.slash_commands && Array.isArray(cliMsg.slash_commands)) {
          sessionSlashCommands.set(sessionId, cliMsg.slash_commands.map((cmd: any) => ({
            name: typeof cmd === 'string' ? cmd : (cmd.name || cmd.command || ''),
            description: typeof cmd === 'string' ? '' : (cmd.description || ''),
          })))
        }
        const messages: ServerMessage[] = [
          // Send model info as a system notification, not a status change
          { type: 'system_notification', subtype: 'init', message: `Model: ${cliMsg.model || 'unknown'}`, data: { model: cliMsg.model } },
        ]
        // Send slash commands to frontend
        const cmds = sessionSlashCommands.get(sessionId)
        if (cmds && cmds.length > 0) {
          messages.push({
            type: 'system_notification',
            subtype: 'slash_commands',
            data: cmds,
          })
        }
        return messages
      }
      if (subtype === 'hook_started' || subtype === 'hook_response') {
        // Hook 执行中 — 不转发给前端
        return []
      }
      // Bug #7: 处理 task/team system 消息
      if (subtype === 'task_notification') {
        return [{
          type: 'system_notification',
          subtype: 'task_notification',
          message: cliMsg.message || cliMsg.title,
          data: cliMsg,
        }]
      }
      if (subtype === 'task_started') {
        return [{
          type: 'status',
          state: 'tool_executing',
          verb: cliMsg.message || 'Task started',
        }]
      }
      if (subtype === 'task_progress') {
        return [{
          type: 'status',
          state: 'tool_executing',
          verb: cliMsg.message || 'Task in progress',
        }]
      }
      if (subtype === 'session_state_changed') {
        return [{
          type: 'system_notification',
          subtype: 'session_state_changed',
          message: cliMsg.message,
          data: cliMsg,
        }]
      }
      // 其他 system 消息
      return []
    }

    default:
      // 未知类型 — 调试输出但不转发
      console.log(`[WS] Unknown CLI message type: ${cliMsg.type}`, JSON.stringify(cliMsg).substring(0, 200))
      return []
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sendMessage(ws: ServerWebSocket<WebSocketData>, message: ServerMessage) {
  ws.send(JSON.stringify(message))
}

function sendError(ws: ServerWebSocket<WebSocketData>, message: string, code: string) {
  sendMessage(ws, { type: 'error', message, code })
}

async function getRuntimeSettings(): Promise<{
  permissionMode?: string
  model?: string
  effort?: string
  runtimeRevision?: number
}> {
  const userSettings = await settingsService.getUserSettings()
  const modelContext =
    typeof userSettings.modelContext === 'string' && userSettings.modelContext.trim()
      ? userSettings.modelContext
      : undefined
  const effort =
    typeof userSettings.effort === 'string' && userSettings.effort.trim()
      ? userSettings.effort
      : undefined

  // Check if a custom provider is active
  const { activeId } = await providerService.listProviders()

  let model: string | undefined
  if (activeId) {
    // Provider is active — only pass --model if user explicitly selected a non-default model.
    // Otherwise the CLI should use ANTHROPIC_MODEL from env (set by syncToSettings).
    // Default Anthropic model should be overridden by the provider's model.
    const baseModel = (userSettings.model as string) || ''
    if (baseModel && baseModel !== 'claude-sonnet-4-6') {
      // User explicitly selected a different model — pass it through
      model = baseModel
      if (modelContext) model += `:${modelContext}`
    }
  } else {
    // No provider — pass model normally
    let baseModel =
      typeof userSettings.model === 'string' && userSettings.model.trim()
        ? userSettings.model
        : undefined
    if (!baseModel) {
      const catalog = await getXiaomuModelCatalog()
      baseModel = catalog.defaultModelId
      const routing =
        catalog.routingById[baseModel] || normalizeModelRouting(undefined, baseModel)
      await patchSettingsEnv(toModelEnv(routing), {
        fallbackDirName: XIAOMU_CONFIG_FALLBACK_DIR,
        topLevel: true,
        ccHaha: true,
      }).catch((error) => {
        console.warn('[WS] failed to sync remote default model routing:', error)
      })
    }
    model = baseModel ? (modelContext ? `${baseModel}:${modelContext}` : baseModel) : undefined
  }

  return {
    permissionMode: await settingsService.getPermissionMode().catch(() => undefined),
    model,
    effort,
    runtimeRevision: conversationService.getRuntimeRevision(),
  }
}

/**
 * Send a message to a specific session's WebSocket (for use by services)
 */
export function sendToSession(sessionId: string, message: ServerMessage): boolean {
  const ws = activeSessions.get(sessionId)
  if (!ws) return false
  ws.send(JSON.stringify(message))
  return true
}

export function getActiveSessionIds(): string[] {
  return Array.from(activeSessions.keys())
}
