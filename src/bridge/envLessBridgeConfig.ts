import { z } from 'zod/v4'
import { getFeatureValue_DEPRECATED } from '../services/analytics/growthbook.js'
import { lazySchema } from '../utils/lazySchema.js'
import { lt } from '../utils/semver.js'
import { isEnvLessBridgeEnabled } from './bridgeEnabled.js'

export type EnvLessBridgeConfig = {
  // withRetry：初始化阶段退避（createSession、POST /bridge、恢复用 /bridge）
  init_retry_max_attempts: number
  init_retry_base_delay_ms: number
  init_retry_jitter_fraction: number
  init_retry_max_delay_ms: number
  // POST /sessions、POST /bridge、POST /archive 的 axios 超时
  http_timeout_ms: number
  // BoundedUUIDSet 环大小（echo + 重新投递去重）
  uuid_dedup_buffer_size: number
  // CCRClient worker heartbeat 节奏。服务端 TTL 为 60s，20s 提供 3 倍余量。
  heartbeat_interval_ms: number
  // 间隔的 ±fraction，按次 heartbeat 加抖动以分散集群负载。
  heartbeat_jitter_fraction: number
  // 在距 expires_in 还有这么久时触发主动 JWT 刷新。buffer 越大，
  // 刷新越频繁（刷新周期约等于 expires_in - buffer）。
  token_refresh_buffer_ms: number
  // teardown() 中 Archive POST 的超时。之所以不同于 http_timeout_ms，
  // 是因为 gracefulShutdown 会让 runCleanupFunctions() 与 2s 上限竞速。
  // 如果一个缓慢/卡住的 archive 还保留 10s axios 超时，就会耗尽整个预算，
  // 但最终 forceExit 仍会把这个请求杀掉。
  teardown_archive_timeout_ms: number
  // transport.connect() 之后等待 onConnect 的截止时间。如果在此之前既没有
  // onConnect 也没有 onClose 触发，就发出 tengu_bridge_repl_connect_timeout。
  // 这是对那约 1% 只发出 `started` 然后沉默的 session 的唯一遥测
  // （没有错误、没有事件，什么都没有）。
  connect_timeout_ms: number
  // env-less bridge 路径的 semver 下限。它独立于 v1 的
  // tengu_bridge_min_version 配置，这样 v2 特有 bug 可以强制升级，
  // 但不会阻塞 v1（基于 env）客户端，反之亦然。
  min_version: string
  // 为 true 时，提示用户其 claude.ai 应用版本可能太旧，无法看到 v2
  // session。这让我们能在应用发布新 session-list query 之前先 rollout v2 bridge。
  should_show_app_upgrade_message: boolean
}

export const DEFAULT_ENV_LESS_BRIDGE_CONFIG: EnvLessBridgeConfig = {
  init_retry_max_attempts: 3,
  init_retry_base_delay_ms: 500,
  init_retry_jitter_fraction: 0.25,
  init_retry_max_delay_ms: 4000,
  http_timeout_ms: 10_000,
  uuid_dedup_buffer_size: 2000,
  heartbeat_interval_ms: 20_000,
  heartbeat_jitter_fraction: 0.1,
  token_refresh_buffer_ms: 300_000,
  teardown_archive_timeout_ms: 1500,
  connect_timeout_ms: 15_000,
  min_version: '0.0.0',
  should_show_app_upgrade_message: false,
}

// 这些下限在违反约束时会拒绝整个对象（回退到 DEFAULT），而不是部分信任，
// 与 pollConfig.ts 中的防御性策略相同。
const envLessBridgeConfigSchema = lazySchema(() =>
  z.object({
    init_retry_max_attempts: z.number().int().min(1).max(10).default(3),
    init_retry_base_delay_ms: z.number().int().min(100).default(500),
    init_retry_jitter_fraction: z.number().min(0).max(1).default(0.25),
    init_retry_max_delay_ms: z.number().int().min(500).default(4000),
    http_timeout_ms: z.number().int().min(2000).default(10_000),
    uuid_dedup_buffer_size: z.number().int().min(100).max(50_000).default(2000),
    // 服务端 TTL 为 60s。5s 下限可防止抖动；30s 上限保留至少 2 倍余量。
    heartbeat_interval_ms: z
      .number()
      .int()
      .min(5000)
      .max(30_000)
      .default(20_000),
    // 每次 heartbeat 使用 ±fraction 抖动。上限 0.5：在最大间隔 30s 下，
    // 乘以 1.5 的最坏情况是 45s，仍低于 60s TTL。
    heartbeat_jitter_fraction: z.number().min(0).max(0.5).default(0.1),
    // 30s 下限可防止紧密循环。30min 上限用于拦截 buffer 与 delay 的语义反转：
    // 如果 ops 填的是 expires_in-5min（距离刷新还有多久），而不是 5min
    // （过期前的 buffer），就会得到 delayMs = expires_in - buffer ≈ 5min，
    // 而不是 ≈4h。两者都是正时长，单靠 .min() 无法区分；.max() 能捕获这种
    // 反转，因为对于多小时 JWT 来说，buffer ≥ 30min 明显不合理。
    token_refresh_buffer_ms: z
      .number()
      .int()
      .min(30_000)
      .max(1_800_000)
      .default(300_000),
    // 2000 上限保证它低于 gracefulShutdown 的 2s cleanup 竞速窗口；更高的
    // 超时只是对 axios 的假象，因为无论如何 forceExit 都会杀掉 socket。
    teardown_archive_timeout_ms: z
      .number()
      .int()
      .min(500)
      .max(2000)
      .default(1500),
    // 观测到的 p99 connect 大约是 2-3s；15s 提供约 5 倍余量。5s 下限可限制
    // 瞬时变慢时的误报率；60s 上限可限制真正卡死的 session 保持沉默的时长。
    connect_timeout_ms: z.number().int().min(5_000).max(60_000).default(15_000),
    min_version: z
      .string()
      .refine(v => {
        try {
          lt(v, '0.0.0')
          return true
        } catch {
          return false
        }
      })
      .default('0.0.0'),
    should_show_app_upgrade_message: z.boolean().default(false),
  }),
)

/**
 * 从 GrowthBook 获取 env-less bridge 的时序配置。每次调用
 * initEnvLessBridgeCore 只读取一次，bridge session 生命周期内该配置固定。
 *
 * 这里使用阻塞 getter（不是 _CACHED_MAY_BE_STALE），因为 /remote-control
 * 运行时机远晚于 GrowthBook 初始化。initializeGrowthBook() 会立刻完成，
 * 因此没有启动惩罚，而且我们拿到的是内存中最新的 remoteEval 值，而不是
 * 首次读取时可能陈旧的磁盘缓存。_DEPRECATED 后缀只是提醒不要用于启动路径，
 * 这里并不属于那种情况。
 */
export async function getEnvLessBridgeConfig(): Promise<EnvLessBridgeConfig> {
  const raw = await getFeatureValue_DEPRECATED<unknown>(
    'tengu_bridge_repl_v2_config',
    DEFAULT_ENV_LESS_BRIDGE_CONFIG,
  )
  const parsed = envLessBridgeConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_ENV_LESS_BRIDGE_CONFIG
}

/**
 * 如果当前 CLI 版本低于 env-less（v2）bridge 路径要求的最小版本，
 * 则返回错误消息；否则返回 null。
 *
 * 这是 checkBridgeMinVersion() 的 v2 对应实现。它读取的是
 * tengu_bridge_repl_v2_config，而不是 tengu_bridge_min_version，
 * 从而让两套实现可以各自维护独立下限。
 */
export async function checkEnvLessBridgeMinVersion(): Promise<string | null> {
  const cfg = await getEnvLessBridgeConfig()
  if (cfg.min_version && lt(MACRO.VERSION, cfg.min_version)) {
    return `Your version of Claude Code (${MACRO.VERSION}) is too old for Remote Control.\nVersion ${cfg.min_version} or higher is required. Run \`claude update\` to update.`
  }
  return null
}

/**
 * Remote Control session 启动时，是否提示用户升级 claude.ai 应用。
 * 只有在 v2 bridge 激活且 should_show_app_upgrade_message 配置位开启时才为 true，
 * 这样我们就能在应用发布新 session-list query 之前先 rollout v2 bridge。
 */
export async function shouldShowAppUpgradeMessage(): Promise<boolean> {
  if (!isEnvLessBridgeEnabled()) return false
  const cfg = await getEnvLessBridgeConfig()
  return cfg.should_show_app_upgrade_message
}
