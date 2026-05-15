import { profileCheckpoint } from '../utils/startupProfiler.js'
import '../bootstrap/state.js'
import '../utils/config.js'
import type { Attributes, MetricOptions } from '@opentelemetry/api'
import memoize from 'lodash-es/memoize.js'
import { getIsNonInteractiveSession } from 'src/bootstrap/state.js'
import type { AttributedCounter } from '../bootstrap/state.js'
import { getSessionCounter, setMeter } from '../bootstrap/state.js'
import { shutdownLspServerManager } from '../services/lsp/manager.js'
import { populateOAuthAccountInfoIfNeeded } from '../services/oauth/client.js'
import {
  initializePolicyLimitsLoadingPromise,
  isPolicyLimitsEligible,
} from '../services/policyLimits/index.js'
import {
  initializeRemoteManagedSettingsLoadingPromise,
  isEligibleForRemoteManagedSettings,
  waitForRemoteManagedSettingsToLoad,
} from '../services/remoteManagedSettings/index.js'
import { preconnectAnthropicApi } from '../utils/apiPreconnect.js'
import { applyExtraCACertsFromConfig } from '../utils/caCertsConfig.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { enableConfigs, recordFirstStartTime } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { detectCurrentRepository } from '../utils/detectRepository.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { initJetBrainsDetection } from '../utils/envDynamic.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { ConfigParseError, errorMessage } from '../utils/errors.js'
// showInvalidConfigDialog 在错误路径中通过动态导入加载，以避免在 init 时加载 React。
import {
  gracefulShutdownSync,
  setupGracefulShutdown,
} from '../utils/gracefulShutdown.js'
import {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
} from '../utils/managedEnv.js'
import { configureGlobalMTLS } from '../utils/mtls.js'
import {
  ensureScratchpadDir,
  isScratchpadEnabled,
} from '../utils/permissions/filesystem.js'
// initializeTelemetry 会在 setMeterState() 中通过 import() 懒加载，
// 从而将约 400KB 的 OpenTelemetry + protobuf 模块延后到 telemetry 真正初始化时再加载。
// gRPC exporters（约 700KB，来自 @grpc/grpc-js）也会在 instrumentation.ts 中进一步懒加载。
import { configureGlobalAgents } from '../utils/proxy.js'
import { isBetaTracingEnabled } from '../utils/telemetry/betaSessionTracing.js'
import { getTelemetryAttributes } from '../utils/telemetryAttributes.js'
import { setShellIfWindows } from '../utils/windowsPaths.js'

// initialize1PEventLogging 通过动态导入延后加载 OpenTelemetry sdk-logs/resources。

// 跟踪 telemetry 是否已经初始化，防止重复初始化。
let telemetryInitialized = false

export const init = memoize(async (): Promise<void> => {
  const initStartTime = Date.now()
  logForDiagnosticsNoPII('info', 'init_started')
  profileCheckpoint('init_function_start')

  // 校验 configs 有效，并启用配置系统。
  try {
    const configsStart = Date.now()
    enableConfigs()
    logForDiagnosticsNoPII('info', 'init_configs_enabled', {
      duration_ms: Date.now() - configsStart,
    })
    profileCheckpoint('init_configs_enabled')

    // 在 trust dialog 之前只应用安全的环境变量。
    // 完整环境变量会在 trust 建立之后再应用。
    const envVarsStart = Date.now()
    applySafeConfigEnvironmentVariables()

    // 提前把 settings.json 中的 NODE_EXTRA_CA_CERTS 应用到 process.env，
    // 必须发生在任何 TLS 连接之前。Bun 会在启动时通过 BoringSSL 缓存 TLS 证书存储，
    // 因此这一步必须先于第一次 TLS 握手。
    applyExtraCACertsFromConfig()

    logForDiagnosticsNoPII('info', 'init_safe_env_vars_applied', {
      duration_ms: Date.now() - envVarsStart,
    })
    profileCheckpoint('init_safe_env_vars_applied')

    // 确保退出时能把内容正确 flush。
    setupGracefulShutdown()
    profileCheckpoint('init_after_graceful_shutdown')

    // 初始化 1P event logging（没有安全顾虑，但为了避免在启动时加载
    // OpenTelemetry sdk-logs 而延后执行）。此时 growthbook.js 已经在
    // module cache 中（firstPartyEventLogger 会导入它），因此第二次动态导入
    // 不会带来额外加载成本。
    void Promise.all([
      import('../services/analytics/firstPartyEventLogger.js'),
      import('../services/analytics/growthbook.js'),
    ]).then(([fp, gb]) => {
      fp.initialize1PEventLogging()
      // 如果 tengu_1p_event_batch_config 在会话中途变化，就重建 logger provider。
      // 变化检测（isEqual）在 handler 内部完成，因此未变化的 refresh 会是 no-op。
      gb.onGrowthBookRefresh(() => {
        void fp.reinitialize1PEventLoggingIfConfigChanged()
      })
    })
    profileCheckpoint('init_after_1p_event_logging')

    // 如果 config 中还没有缓存 OAuth account info，就补充写入。
    // 这是必需的，因为通过 VSCode extension 登录时，OAuth account info 可能尚未被填充。
    void populateOAuthAccountInfoIfNeeded()
    profileCheckpoint('init_after_oauth_populate')

    // 异步初始化 JetBrains IDE 检测（为后续同步访问填充缓存）。
    void initJetBrainsDetection()
    profileCheckpoint('init_after_jetbrains_detection')

    // 异步检测 GitHub 仓库（为 gitDiff PR 关联填充缓存）。
    void detectCurrentRepository()

    // 提前初始化 loading promise，这样其他系统（例如 plugin hooks）
    // 就可以等待 remote settings 加载。该 promise 自带超时，避免
    // loadRemoteManagedSettings() 从未被调用时出现死锁（例如 Agent SDK tests）。
    if (isEligibleForRemoteManagedSettings()) {
      initializeRemoteManagedSettingsLoadingPromise()
    }
    if (isPolicyLimitsEligible()) {
      initializePolicyLimitsLoadingPromise()
    }
    profileCheckpoint('init_after_remote_settings_check')

    // 记录首次启动时间。
    recordFirstStartTime()

    // 配置全局 mTLS 设置。
    const mtlsStart = Date.now()
    logForDebugging('[init] configureGlobalMTLS starting')
    configureGlobalMTLS()
    logForDiagnosticsNoPII('info', 'init_mtls_configured', {
      duration_ms: Date.now() - mtlsStart,
    })
    logForDebugging('[init] configureGlobalMTLS complete')

    // 配置全局 HTTP agents（proxy 和/或 mTLS）。
    const proxyStart = Date.now()
    logForDebugging('[init] configureGlobalAgents starting')
    configureGlobalAgents()
    logForDiagnosticsNoPII('info', 'init_proxy_configured', {
      duration_ms: Date.now() - proxyStart,
    })
    logForDebugging('[init] configureGlobalAgents complete')
    profileCheckpoint('init_network_configured')

    // 预连接到 Anthropic API，让 TCP+TLS 握手
    // （约 100-200ms）与 API 请求前约 100ms 的 action-handler 工作重叠。
    // 这一步放在 CA certs + proxy agents 配置完成之后，确保预热连接
    // 使用的是正确 transport。采用 fire-and-forget；对于
    // proxy/mTLS/unix/cloud-provider 这类 SDK dispatcher 不会复用全局连接池的场景则跳过。
    preconnectAnthropicApi()

    // CCR upstreamproxy：启动本地 CONNECT relay，让 agent subprocesses
    // 能通过注入凭据访问组织配置的 upstreams。受
    // CLAUDE_CODE_REMOTE + GrowthBook 控制；任何错误都采用 fail-open。使用懒加载，
    // 避免非 CCR 启动承担模块加载成本。getUpstreamProxyEnv
    // 会注册到 subprocessEnv.ts 中，使 subprocess 创建时能够
    // 在不静态导入 upstreamproxy 模块的情况下注入 proxy vars。
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      try {
        const { initUpstreamProxy, getUpstreamProxyEnv } = await import(
          '../upstreamproxy/upstreamproxy.js'
        )
        const { registerUpstreamProxyEnvFn } = await import(
          '../utils/subprocessEnv.js'
        )
        registerUpstreamProxyEnvFn(getUpstreamProxyEnv)
        await initUpstreamProxy()
      } catch (err) {
        logForDebugging(
          `[init] upstreamproxy init failed: ${err instanceof Error ? err.message : String(err)}; continuing without proxy`,
          { level: 'warn' },
        )
      }
    }

    // 如有需要，配置 git-bash。
    setShellIfWindows()

    // 注册 LSP manager 的清理逻辑（初始化发生在 main.tsx 中、且在处理完 --plugin-dir 之后）。
    registerCleanup(shutdownLspServerManager)

    // gh-32730：由 subagents 创建的 teams（或主 agent 在未显式 TeamDelete 时创建的 teams）
    // 以前会永久留在磁盘上。这里为本 session 创建的所有 teams 注册清理逻辑。
    // 使用懒加载：swarm 代码受 feature gate 控制，而且大多数 session 都不会创建 teams。
    registerCleanup(async () => {
      const { cleanupSessionTeams } = await import(
        '../utils/swarm/teamHelpers.js'
      )
      await cleanupSessionTeams()
    })

    // 如果启用，则初始化 scratchpad 目录。
    if (isScratchpadEnabled()) {
      const scratchpadStart = Date.now()
      await ensureScratchpadDir()
      logForDiagnosticsNoPII('info', 'init_scratchpad_created', {
        duration_ms: Date.now() - scratchpadStart,
      })
    }

    logForDiagnosticsNoPII('info', 'init_completed', {
      duration_ms: Date.now() - initStartTime,
    })
    profileCheckpoint('init_function_end')
  } catch (error) {
    if (error instanceof ConfigParseError) {
      // 在无法安全渲染时，跳过交互式 Ink dialog。
      // 该 dialog 会破坏 JSON 消费方（例如在 VM sandbox 中运行 `plugin marketplace list --json` 的
      // desktop marketplace plugin manager）。
      if (getIsNonInteractiveSession()) {
        process.stderr.write(
          `Configuration error in ${error.filePath}: ${error.message}\n`,
        )
        gracefulShutdownSync(1)
        return
      }

      // 用 error 对象展示 invalid config dialog，并等待其完成。
      return import('../components/InvalidConfigDialog.js').then(m =>
        m.showInvalidConfigDialog({ error }),
      )
      // dialog 自己会处理 process.exit，因此这里不需要额外清理。
    } else {
      // 非 config 错误则继续向上抛出。
      throw error
    }
  }
})

/**
 * Initialize telemetry after trust has been granted.
 * For remote-settings-eligible users, waits for settings to load (non-blocking),
 * then re-applies env vars (to include remote settings) before initializing telemetry.
 * For non-eligible users, initializes telemetry immediately.
 * This should only be called once, after the trust dialog has been accepted.
 */
export function initializeTelemetryAfterTrust(): void {
  if (isEligibleForRemoteManagedSettings()) {
    // 对启用了 beta tracing 的 SDK/headless 模式，先执行 eager 初始化，
    // 以确保 tracer 在第一次 query 运行前就已就绪。
    // 下方的异步路径仍会运行，但 doInitializeTelemetry() 会防止重复初始化。
    if (getIsNonInteractiveSession() && isBetaTracingEnabled()) {
      void doInitializeTelemetry().catch(error => {
        logForDebugging(
          `[3P telemetry] Eager telemetry init failed (beta tracing): ${errorMessage(error)}`,
          { level: 'error' },
        )
      })
    }
    logForDebugging(
      '[3P telemetry] Waiting for remote managed settings before telemetry init',
    )
    void waitForRemoteManagedSettingsToLoad()
      .then(async () => {
        logForDebugging(
          '[3P telemetry] Remote managed settings loaded, initializing telemetry',
        )
        // 在初始化 telemetry 前重新应用 env vars，以吸收 remote settings 的变化。
        applyConfigEnvironmentVariables()
        await doInitializeTelemetry()
      })
      .catch(error => {
        logForDebugging(
          `[3P telemetry] Telemetry init failed (remote settings path): ${errorMessage(error)}`,
          { level: 'error' },
        )
      })
  } else {
    void doInitializeTelemetry().catch(error => {
      logForDebugging(
        `[3P telemetry] Telemetry init failed: ${errorMessage(error)}`,
        { level: 'error' },
      )
    })
  }
}

async function doInitializeTelemetry(): Promise<void> {
  if (telemetryInitialized) {
    // 已经初始化过，无需再做任何事。
    return
  }

  // 在初始化前先设置标记，防止重复初始化。
  telemetryInitialized = true
  try {
    await setMeterState()
  } catch (error) {
    // 失败时重置标记，以便后续调用能够重试。
    telemetryInitialized = false
    throw error
  }
}

async function setMeterState(): Promise<void> {
  // 懒加载 instrumentation，将约 400KB 的 OpenTelemetry + protobuf 延后加载。
  const { initializeTelemetry } = await import(
    '../utils/telemetry/instrumentation.js'
  )
  // 初始化客户侧 OTLP telemetry（metrics、logs、traces）。
  const meter = await initializeTelemetry()
  if (meter) {
    // 为 attributed counters 创建工厂函数。
    const createAttributedCounter = (
      name: string,
      options: MetricOptions,
    ): AttributedCounter => {
      const counter = meter?.createCounter(name, options)

      return {
        add(value: number, additionalAttributes: Attributes = {}) {
          // 始终获取最新的 telemetry attributes，确保它们保持最新。
          const currentAttributes = getTelemetryAttributes()
          const mergedAttributes = {
            ...currentAttributes,
            ...additionalAttributes,
          }
          counter?.add(value, mergedAttributes)
        },
      }
    }

    setMeter(meter, createAttributedCounter)

    // 在这里递增 session counter，因为启动期的 telemetry 路径
    // 会早于这个异步初始化完成而运行，否则那里的 counter
    // 会是 null。
    getSessionCounter()?.add(1)
  }
}
