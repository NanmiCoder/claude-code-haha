import { z } from 'zod/v4'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../services/analytics/growthbook.js'
import { lazySchema } from '../utils/lazySchema.js'
import {
  DEFAULT_POLL_CONFIG,
  type PollIntervalConfig,
} from './pollConfigDefaults.js'

// 在 seek-work 间隔上使用 .min(100)，恢复了旧的 Math.max(..., 100)
// 这一层防御性下限，用来防止 GrowthBook 配置手误。与 clamp 不同，
// Zod 在违反约束时会拒绝整个对象，因此只要有一个字段错误，配置就会整体
// 回退到 DEFAULT_POLL_CONFIG，而不是部分信任。
//
// at_capacity 间隔使用“0 或 ≥100”的 refine：0 表示“禁用”
// （仅 heartbeat 模式），≥100 是防手误下限。1–99 会被拒绝，
// 这样就不会因为单位误解（ops 以为是秒，填了 10）而每 10ms 去轮询
// VerifyEnvironmentSecretAuth DB 路径。
//
// 对象级 refine 要求至少启用一种满容量活性机制：heartbeat 或对应的
// poll 间隔。否则，hb=0、atCapMs=0 这种漂移配置（ops 关闭 heartbeat 却
// 没恢复 at_capacity）会在所有节流点都不 sleep，导致 /poll 以 HTTP
// 往返速度紧密循环。
const zeroOrAtLeast100 = {
  message: 'must be 0 (disabled) or ≥100ms',
}
const pollIntervalConfigSchema = lazySchema(() =>
  z
    .object({
      poll_interval_ms_not_at_capacity: z.number().int().min(100),
      // 0 = 不进行满容量轮询。它与 heartbeat 独立，两者可同时启用
      // （heartbeat 运行时会周期性跳出执行 poll）。
      poll_interval_ms_at_capacity: z
        .number()
        .int()
        .refine(v => v === 0 || v >= 100, zeroOrAtLeast100),
      // 0 = 禁用；正值 = 满容量时按此间隔发送 heartbeat。
      // 它与满容量轮询并行运行，而不是替代后者。
      // 命名为 non_exclusive，用于区别旧的 heartbeat_interval_ms
      // （#22145 之前客户端中的二选一语义）。设置 .default(0)
      // 是为了让缺少该字段的现有 GrowthBook 配置仍能成功解析。
      non_exclusive_heartbeat_interval_ms: z.number().int().min(0).default(0),
      // 多 session（bridgeMain.ts）间隔。默认值与单 session 一致，
      // 因此现有缺少这些字段的配置会保持当前行为。
      multisession_poll_interval_ms_not_at_capacity: z
        .number()
        .int()
        .min(100)
        .default(
          DEFAULT_POLL_CONFIG.multisession_poll_interval_ms_not_at_capacity,
        ),
      multisession_poll_interval_ms_partial_capacity: z
        .number()
        .int()
        .min(100)
        .default(
          DEFAULT_POLL_CONFIG.multisession_poll_interval_ms_partial_capacity,
        ),
      multisession_poll_interval_ms_at_capacity: z
        .number()
        .int()
        .refine(v => v === 0 || v >= 100, zeroOrAtLeast100)
        .default(DEFAULT_POLL_CONFIG.multisession_poll_interval_ms_at_capacity),
      // .min(1) 与服务端 ge=1 约束保持一致（work_v1.py:230）。
      reclaim_older_than_ms: z.number().int().min(1).default(5000),
      session_keepalive_interval_v2_ms: z
        .number()
        .int()
        .min(0)
        .default(120_000),
    })
    .refine(
      cfg =>
        cfg.non_exclusive_heartbeat_interval_ms > 0 ||
        cfg.poll_interval_ms_at_capacity > 0,
      {
        message:
          'at-capacity liveness requires non_exclusive_heartbeat_interval_ms > 0 or poll_interval_ms_at_capacity > 0',
      },
    )
    .refine(
      cfg =>
        cfg.non_exclusive_heartbeat_interval_ms > 0 ||
        cfg.multisession_poll_interval_ms_at_capacity > 0,
      {
        message:
          'at-capacity liveness requires non_exclusive_heartbeat_interval_ms > 0 or multisession_poll_interval_ms_at_capacity > 0',
      },
    ),
)

/**
 * 从 GrowthBook 获取 bridge 轮询间隔配置，刷新窗口为 5 分钟。
 * 会用 schema 校验返回的 JSON；如果 flag 缺失、格式错误或字段不完整，
 * 则回退到默认值。
 *
 * 由 bridgeMain.ts（独立模式）和 replBridge.ts（REPL）共享，便于 ops
 * 通过一次配置下发统一调节两边的轮询速率。
 */
export function getPollIntervalConfig(): PollIntervalConfig {
  const raw = getFeatureValue_CACHED_WITH_REFRESH<unknown>(
    'tengu_bridge_poll_interval_config',
    DEFAULT_POLL_CONFIG,
    5 * 60 * 1000,
  )
  const parsed = pollIntervalConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_POLL_CONFIG
}
