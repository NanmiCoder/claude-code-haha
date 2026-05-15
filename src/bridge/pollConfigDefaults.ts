/**
 * Bridge 轮询间隔默认值。从 pollConfig.ts 中提取出来，这样不需要实时
 * GrowthBook 调优的调用方（例如通过 Agent SDK 的 daemon）可以避免引入
 * growthbook.ts → config.ts → file.ts → sessionStorage.ts → commands.ts
 * 这条传递依赖链。
 */

/**
 * 主动拉取 work 时的轮询间隔（无 transport / 未达到 maxSessions）。
 * 决定首次获取 work 时用户可见的“connecting…”延迟，以及服务端重新分发
 * work item 之后的恢复速度。
 */
const POLL_INTERVAL_MS_NOT_AT_CAPACITY = 2000

/**
 * transport 已连接时的轮询间隔。它与 heartbeat 独立运行；当两者都启用时，
 * heartbeat 循环会按此间隔跳出并执行轮询。设为 0 可完全禁用满容量时轮询。
 *
 * 约束该值的服务端条件：
 * - BRIDGE_LAST_POLL_TTL = 4h（Redis key 过期 → environment 自动归档）
 * - max_poll_stale_seconds = 24h（session 创建健康门控，当前已禁用）
 *
 * 10 分钟在 Redis TTL 上提供 24 倍余量，同时仍能在一个轮询周期内接住
 * 服务端发起的 token 轮转重分发。对于瞬时 WS 故障，transport 内部会自动
 * 重连 10 分钟，因此轮询不是恢复路径，而只是活性信号以及永久关闭时的兜底。
 */
const POLL_INTERVAL_MS_AT_CAPACITY = 600_000

/**
 * 多 session bridge（bridgeMain.ts）的轮询间隔。默认值与单 session
 * 一致，因此现有未包含这些字段的 GrowthBook 配置会保持当前行为。
 * Ops 可通过 tengu_bridge_poll_interval_config GB flag 单独调节这些值。
 */
const MULTISESSION_POLL_INTERVAL_MS_NOT_AT_CAPACITY =
  POLL_INTERVAL_MS_NOT_AT_CAPACITY
const MULTISESSION_POLL_INTERVAL_MS_PARTIAL_CAPACITY =
  POLL_INTERVAL_MS_NOT_AT_CAPACITY
const MULTISESSION_POLL_INTERVAL_MS_AT_CAPACITY = POLL_INTERVAL_MS_AT_CAPACITY

export type PollIntervalConfig = {
  poll_interval_ms_not_at_capacity: number
  poll_interval_ms_at_capacity: number
  non_exclusive_heartbeat_interval_ms: number
  multisession_poll_interval_ms_not_at_capacity: number
  multisession_poll_interval_ms_partial_capacity: number
  multisession_poll_interval_ms_at_capacity: number
  reclaim_older_than_ms: number
  session_keepalive_interval_v2_ms: number
}

export const DEFAULT_POLL_CONFIG: PollIntervalConfig = {
  poll_interval_ms_not_at_capacity: POLL_INTERVAL_MS_NOT_AT_CAPACITY,
  poll_interval_ms_at_capacity: POLL_INTERVAL_MS_AT_CAPACITY,
  // 0 = disabled。> 0 时，满容量循环会按此间隔为每个 work item 发送
  // heartbeat。它独立于 poll_interval_ms_at_capacity，两者可同时运行
  // （heartbeat 会周期性让出给 poll）。60s 相比服务端 300s heartbeat TTL
  // 仍有 5 倍余量。命名为 non_exclusive 是为了区别旧的 heartbeat_interval_ms
  // 字段（#22145 之前客户端中的二选一语义，即 heartbeat 会抑制 poll）。
  // 旧客户端会忽略该键；ops 可以在 rollout 期间同时设置两个字段。
  non_exclusive_heartbeat_interval_ms: 0,
  multisession_poll_interval_ms_not_at_capacity:
    MULTISESSION_POLL_INTERVAL_MS_NOT_AT_CAPACITY,
  multisession_poll_interval_ms_partial_capacity:
    MULTISESSION_POLL_INTERVAL_MS_PARTIAL_CAPACITY,
  multisession_poll_interval_ms_at_capacity:
    MULTISESSION_POLL_INTERVAL_MS_AT_CAPACITY,
  // Poll 查询参数：回收早于该时长、尚未 ack 的 work item。
  // 与服务端 DEFAULT_RECLAIM_OLDER_THAN_MS 一致（work_service.py:24）。
  // 这样在 JWT 过期、先前 ack 因 session_ingress_token 已陈旧而失败后，
  // 仍能重新拿到 stale-pending work。
  reclaim_older_than_ms: 5000,
  // 0 = disabled。> 0 时，按此间隔向 session-ingress 推送静默的
  // {type:'keep_alive'} 帧，避免上游代理回收空闲的 remote-control session。
  // 默认值为 2 分钟。_v2 表示仅对 bridge 生效的 gate
  // （v2 之前客户端读取旧键，新客户端忽略它）。
  session_keepalive_interval_v2_ms: 120_000,
}
