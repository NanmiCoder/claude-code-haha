/**
 * 为 CCR v2 兼容层提供 Session ID tag 转换辅助函数。
 *
 * 之所以单独放在这个文件里（而不是 workSecret.ts），
 * 是为了让 sessionHandle.ts 和 replBridgeTransport.ts
 * （bridge.mjs 的入口点）能够导入 workSecret.ts，
 * 同时不把这些 retag 函数一并拉进来。
 *
 * isCseShimEnabled 这个 kill switch 通过 setCseShimGate() 注入，
 * 用来避免静态导入 bridgeEnabled.ts → growthbook.ts → config.ts 这条链路；
 * 这些模块都被 sdk.mjs bundle（scripts/build-agent-sdk.sh）禁止引入。
 * 已经导入 bridgeEnabled.ts 的调用方会主动注册这个 gate；SDK 路径则不会，
 * 因此 shim 默认保持启用（与 isCseShimEnabled() 自身的默认值一致）。
 */

let _isCseShimEnabled: (() => boolean) | undefined

/**
 * 为 cse_ shim 注册 GrowthBook gate。
 * 由那些本来就导入 bridgeEnabled.ts 的 bridge 初始化代码调用。
 */
export function setCseShimGate(gate: () => boolean): void {
  _isCseShimEnabled = gate
}

/**
 * 把 `cse_*` session ID 重新标记为 `session_*`，供 v1 兼容 API 使用。
 *
 * Worker 端点（/v1/code/sessions/{id}/worker/*）需要的是 `cse_*`；
 * work poll 返回的也是这个格式。面向客户端的兼容端点
 * （/v1/sessions/{id}、/v1/sessions/{id}/archive、/v1/sessions/{id}/events）
 * 则需要 `session_*`，因为 compat/convert.go:27 会校验 TagSession。
 * UUID 还是同一个，只是换了 tag。对于并非 `cse_*` 的 ID，此函数为 no-op。
 *
 * bridgeMain 里只有一个 sessionId 变量，同时用于 worker 注册与
 * session 管理调用。在 compat gate 开启时，它会以 `cse_*` 形式从 work poll 到达，
 * 因此 archiveSession/fetchSessionTitle 在调用前需要做这次重标记。
 */
export function toCompatSessionId(id: string): string {
  if (!id.startsWith('cse_')) return id
  if (_isCseShimEnabled && !_isCseShimEnabled()) return id
  return 'session_' + id.slice('cse_'.length)
}

/**
 * 把 `session_*` session ID 重新标记为 `cse_*`，供基础设施层调用使用。
 *
 * 这是 toCompatSessionId 的逆操作。POST /v1/environments/{id}/bridge/reconnect
 * 位于 compat layer 之下：一旦服务端启用了 ccr_v2_compat_enabled，
 * 它就会按 infra tag（`cse_*`）去查 session。createBridgeSession 仍然返回
 * `session_*`（compat/convert.go:41），而 bridge-pointer 存储的也是它，
 * 所以 perpetual reconnect 会带着错误的“外衣”去请求，最终收到
 * "Session not found"。UUID 相同，但 tag 错了。对于并非 `session_*` 的 ID，
 * 此函数为 no-op。
 */
export function toInfraSessionId(id: string): string {
  if (!id.startsWith('session_')) return id
  return 'cse_' + id.slice('session_'.length)
}
