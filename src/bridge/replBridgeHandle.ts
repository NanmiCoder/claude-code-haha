import { updateSessionBridgeId } from '../utils/concurrentSessions.js'
import type { ReplBridgeHandle } from './replBridge.js'
import { toCompatSessionId } from './sessionIdCompat.js'

/**
 * 指向当前活跃 REPL bridge handle 的全局指针，这样位于
 * useReplBridge React 树之外的调用方（tools、slash commands）也能调用
 * subscribePR 之类的 handle 方法。理由与 bridgeDebug.ts 中“每个进程仅一个
 * bridge”相同：handle 的闭包捕获了创建该 session 的 sessionId 和
 * getAccessToken，若独立重新推导这些值（BriefTool/upload.ts 模式），
 * 可能导致 staging/prod token 不一致。
 *
 * 在 useReplBridge.tsx 初始化完成后设置；在 teardown 时清除。
 */

let handle: ReplBridgeHandle | null = null

export function setReplBridgeHandle(h: ReplBridgeHandle | null): void {
  handle = h
  // 在 session 记录中发布（或清除）我们的 bridge session ID，便于其他
  // 本地 peer 在其 bridge 列表中将我们去重排除，优先保留本地项。
  void updateSessionBridgeId(getSelfBridgeCompatId() ?? null).catch(() => {})
}

export function getReplBridgeHandle(): ReplBridgeHandle | null {
  return handle
}

/**
 * 我们自己的 bridge session ID，采用 API 在 /v1/sessions 响应中返回的
 * session_* 兼容格式；如果 bridge 未连接，则为 undefined。
 */
export function getSelfBridgeCompatId(): string | undefined {
  const h = getReplBridgeHandle()
  return h ? toCompatSessionId(h.bridgeSessionId) : undefined
}
