import { logForDebugging } from '../utils/debug.js'
import { BridgeFatalError } from './bridgeApi.js'
import type { BridgeApiClient } from './types.js'

/**
 * 仅供 ant 使用的故障注入，用于手动测试 bridge 恢复路径。
 *
 * 它针对的真实故障模式（BQ 2026-03-12，7 天窗口）：
 *   poll 404 not_found_error   — 每周 147K 个 session，onEnvironmentLost gate 失效
 *   ws_closed 1002/1006        — 每周 22K 个 session，关闭后仍有僵尸 poll
 *   register transient failure — 剩余问题：doReconnect 期间的网络抖动
 *
 * 用法：在 Remote Control 已连接时，从 REPL 执行 /bridge-kick <subcommand>，
 * 然后 tail debug.log，观察恢复机制如何响应。
 *
 * 这里刻意使用模块级状态：每个 REPL 进程只有一个 bridge，
 * /bridge-kick slash command 没有其他方式进入 initBridgeCore 的闭包，
 * 且 teardown 会清理该槽位。
 */

/** 下一次匹配到对应 API 调用时注入的一次性故障。 */
type BridgeFault = {
  method:
    | 'pollForWork'
    | 'registerBridgeEnvironment'
    | 'reconnectSession'
    | 'heartbeatWork'
  /** Fatal 错误会走 handleErrorStatus → BridgeFatalError。Transient
   *  错误则表现为普通 axios rejection（5xx / network）。恢复代码会据此区分：
  *  具体行为是 fatal → teardown，transient → retry/backoff。 */
  kind: 'fatal' | 'transient'
  status: number
  errorType?: string
  /** 剩余注入次数。consume 时递减；减到 0 后移除。 */
  count: number
}

export type BridgeDebugHandle = {
  /** 直接调用 transport 的 permanent-close handler。用于测试
   *  ws_closed → reconnectEnvironmentWithSession 升级路径（#22148）。 */
  fireClose: (code: number) => void
  /** 调用 reconnectEnvironmentWithSession()，与 SIGUSR2 等效，但
   *  可以从 slash command 触达。 */
  forceReconnect: () => void
  /** 为指定 API 方法接下来的 N 次调用排入一个故障。 */
  injectFault: (fault: BridgeFault) => void
  /** 中止满容量 sleep，使注入的 poll 故障立即生效，
   *  而不是最多延后 10 分钟。 */
  wakePollLoop: () => void
  /** 供 debug.log grep 使用的 env/session ID。 */
  describe: () => string
}

let debugHandle: BridgeDebugHandle | null = null
const faultQueue: BridgeFault[] = []

export function registerBridgeDebugHandle(h: BridgeDebugHandle): void {
  debugHandle = h
}

export function clearBridgeDebugHandle(): void {
  debugHandle = null
  faultQueue.length = 0
}

export function getBridgeDebugHandle(): BridgeDebugHandle | null {
  return debugHandle
}

export function injectBridgeFault(fault: BridgeFault): void {
  faultQueue.push(fault)
  logForDebugging(
    `[bridge:debug] Queued fault: ${fault.method} ${fault.kind}/${fault.status}${fault.errorType ? `/${fault.errorType}` : ''} ×${fault.count}`,
  )
}

/**
 * 包装 BridgeApiClient，使每次调用都先检查故障队列。如果存在匹配故障，
 * 就抛出指定错误而不是继续调用真实客户端。其他情况全部委托给真实客户端。
 *
 * 仅在 USER_TYPE === 'ant' 时调用，因此对外部构建没有额外开销。
 */
export function wrapApiForFaultInjection(
  api: BridgeApiClient,
): BridgeApiClient {
  function consume(method: BridgeFault['method']): BridgeFault | null {
    const idx = faultQueue.findIndex(f => f.method === method)
    if (idx === -1) return null
    const fault = faultQueue[idx]!
    fault.count--
    if (fault.count <= 0) faultQueue.splice(idx, 1)
    return fault
  }

  function throwFault(fault: BridgeFault, context: string): never {
    logForDebugging(
      `[bridge:debug] Injecting ${fault.kind} fault into ${context}: status=${fault.status} errorType=${fault.errorType ?? 'none'}`,
    )
    if (fault.kind === 'fatal') {
      throw new BridgeFatalError(
        `[injected] ${context} ${fault.status}`,
        fault.status,
        fault.errorType,
      )
    }
    // Transient：模拟 axios rejection（5xx / network）。错误对象本身不带
    // .status，catch 代码块正是据此进行区分。
    throw new Error(`[injected transient] ${context} ${fault.status}`)
  }

  return {
    ...api,
    async pollForWork(envId, secret, signal, reclaimMs) {
      const f = consume('pollForWork')
      if (f) throwFault(f, 'Poll')
      return api.pollForWork(envId, secret, signal, reclaimMs)
    },
    async registerBridgeEnvironment(config) {
      const f = consume('registerBridgeEnvironment')
      if (f) throwFault(f, 'Registration')
      return api.registerBridgeEnvironment(config)
    },
    async reconnectSession(envId, sessionId) {
      const f = consume('reconnectSession')
      if (f) throwFault(f, 'ReconnectSession')
      return api.reconnectSession(envId, sessionId)
    },
    async heartbeatWork(envId, workId, token) {
      const f = consume('heartbeatWork')
      if (f) throwFault(f, 'Heartbeat')
      return api.heartbeatWork(envId, workId, token)
    },
  }
}
