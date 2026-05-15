import axios from 'axios'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { WorkSecret } from './types.js'

/** 解码 base64url 编码的 work secret，并校验其版本。 */
export function decodeWorkSecret(secret: string): WorkSecret {
  const json = Buffer.from(secret, 'base64url').toString('utf-8')
  const parsed: unknown = jsonParse(json)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    parsed.version !== 1
  ) {
    throw new Error(
      `Unsupported work secret version: ${parsed && typeof parsed === 'object' && 'version' in parsed ? parsed.version : 'unknown'}`,
    )
  }
  const obj = parsed as Record<string, unknown>
  if (
    typeof obj.session_ingress_token !== 'string' ||
    obj.session_ingress_token.length === 0
  ) {
    throw new Error(
      'Invalid work secret: missing or empty session_ingress_token',
    )
  }
  if (typeof obj.api_base_url !== 'string') {
    throw new Error('Invalid work secret: missing api_base_url')
  }
  return parsed as WorkSecret
}

/**
 * 基于 API base URL 和 session ID 构造 WebSocket SDK URL。
 * 会去掉 HTTP(S) 协议，并组装出 ws(s):// ingress URL。
 *
 * localhost 使用 /v2/（直连 session-ingress，无 Envoy 重写），
 * 生产环境使用 /v1/（Envoy 会将 /v1/ 重写为 /v2/）。
 */
export function buildSdkUrl(apiBaseUrl: string, sessionId: string): string {
  const isLocalhost =
    apiBaseUrl.includes('localhost') || apiBaseUrl.includes('127.0.0.1')
  const protocol = isLocalhost ? 'ws' : 'wss'
  const version = isLocalhost ? 'v2' : 'v1'
  const host = apiBaseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return `${protocol}://${host}/${version}/session_ingress/ws/${sessionId}`
}

/**
 * 比较两个 session ID，而不受其 tagged-ID 前缀影响。
 *
 * Tagged ID 的形式为 {tag}_{body} 或 {tag}_staging_{body}，其中 body
 * 编码的是 UUID。CCR v2 的 compat 层会向 v1 API 客户端返回 `session_*`
 * （compat/convert.go:41），但基础设施层（sandbox-gateway work queue、
 * work poll response）使用的是 `cse_*`（compat/CLAUDE.md:13）。
 * 两者底层 UUID 相同。
 *
 * 如果没有这个比较逻辑，在 ccr_v2_compat_enabled gate 打开时，
 * replBridge 会在 work-received 检查中把自己的 session 误判为“foreign”。
 */
export function sameSessionId(a: string, b: string): boolean {
  if (a === b) return true
  // body 是最后一个下划线之后的全部内容，这样同时兼容
  // `{tag}_{body}` 和 `{tag}_staging_{body}`。
  const aBody = a.slice(a.lastIndexOf('_') + 1)
  const bBody = b.slice(b.lastIndexOf('_') + 1)
  // 防御没有下划线的 ID（裸 UUID）：此时 lastIndexOf 返回 -1，
  // slice(0) 会返回整个字符串，而上面已经先检查过 a === b。
  // 这里要求最小长度，以避免短后缀意外匹配
  // （例如畸形 ID 中残留的单字符 tag）。
  return aBody.length >= 4 && aBody === bBody
}

/**
 * 基于 API base URL 和 session ID 构造 CCR v2 session URL。
 * 与 buildSdkUrl 不同，它返回的是 HTTP(S) URL（不是 ws://），并指向
 * /v1/code/sessions/{id}；子 CC 会基于此 URL 推导 SSE stream 路径和
 * worker endpoints 等地址。
 */
export function buildCCRv2SdkUrl(
  apiBaseUrl: string,
  sessionId: string,
): string {
  const base = apiBaseUrl.replace(/\/+$/, '')
  return `${base}/v1/code/sessions/${sessionId}`
}

/**
 * 将当前 bridge 注册为 CCR v2 session 的 worker。
 * 返回 worker_epoch，必须传给子 CC 进程，以便其 CCRClient 能在每次
 * heartbeat/state/event 请求中携带该值。
 *
 * 该行为与容器路径中的 environment-manager 保持一致
 * （api-go/environment-manager/cmd/cmd_task_run.go RegisterWorker）。
 */
export async function registerWorker(
  sessionUrl: string,
  accessToken: string,
): Promise<number> {
  const response = await axios.post(
    `${sessionUrl}/worker/register`,
    {},
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      timeout: 10_000,
    },
  )
  // protojson 会把 int64 序列化为字符串，以避免 JS number 精度丢失；
  // Go 侧也可能根据 encoder 设置直接返回 number。
  const raw = response.data?.worker_epoch
  const epoch = typeof raw === 'string' ? Number(raw) : raw
  if (
    typeof epoch !== 'number' ||
    !Number.isFinite(epoch) ||
    !Number.isSafeInteger(epoch)
  ) {
    throw new Error(
      `registerWorker: invalid worker_epoch in response: ${jsonStringify(response.data)}`,
    )
  }
  return epoch
}
