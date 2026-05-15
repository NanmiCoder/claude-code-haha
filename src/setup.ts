/* eslint-disable custom-rules/no-process-exit */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getCwd } from 'src/utils/cwd.js'
import { checkForReleaseNotes } from 'src/utils/releaseNotes.js'
import { setCwd } from 'src/utils/Shell.js'
import { initSinks } from 'src/utils/sinks.js'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
  getSessionId,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from './bootstrap/state.js'
import { getCommands } from './commands.js'
import { initSessionMemory } from './services/SessionMemory/sessionMemory.js'
import { asSessionId } from './types/ids.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { checkAndRestoreTerminalBackup } from './utils/appleTerminalBackup.js'
import { prefetchApiKeyFromApiKeyHelperIfSafe } from './utils/auth.js'
import { clearMemoryFileCaches } from './utils/claudemd.js'
import { getCurrentProjectConfig, getGlobalConfig } from './utils/config.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { env } from './utils/env.js'
import { envDynamic } from './utils/envDynamic.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { errorMessage } from './utils/errors.js'
import { findCanonicalGitRoot, findGitRoot, getIsGit } from './utils/git.js'
import { initializeFileChangedWatcher } from './utils/hooks/fileChangedWatcher.js'
import {
  captureHooksConfigSnapshot,
  updateHooksConfigSnapshot,
} from './utils/hooks/hooksConfigSnapshot.js'
import { hasWorktreeCreateHook } from './utils/hooks.js'
import { checkAndRestoreITerm2Backup } from './utils/iTermBackup.js'
import { logError } from './utils/log.js'
import { getRecentActivity } from './utils/logoV2Utils.js'
import { lockCurrentVersion } from './utils/nativeInstaller/index.js'
import type { PermissionMode } from './utils/permissions/PermissionMode.js'
import { getPlanSlug } from './utils/plans.js'
import { saveWorktreeState } from './utils/sessionStorage.js'
import { profileCheckpoint } from './utils/startupProfiler.js'
import {
  createTmuxSessionForWorktree,
  createWorktreeForSession,
  generateTmuxSessionName,
  worktreeBranchName,
} from './utils/worktree.js'

export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  worktreeBaseRef?: string,
  messagingSocketPath?: string,
): Promise<void> {
  logForDiagnosticsNoPII('info', 'setup_started')

  // 检查 Node.js 版本是否低于 18
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1]
  if (!nodeVersion || parseInt(nodeVersion) < 18) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      chalk.bold.red(
        'Error: Claude Code requires Node.js version 18 or higher.',
      ),
    )
    process.exit(1)
  }

  // 如果提供了自定义 session ID，则设置它
  if (customSessionId) {
    switchSession(asSessionId(customSessionId))
  }

  // --bare / SIMPLE：跳过 UDS 消息服务器和 teammate 快照。
  // 脚本化调用不会接收注入消息，也不会使用 swarm teammates。
  // 显式的 --messaging-socket-path 是逃生口（沿用 #23222 的 gate 模式）。
  if (!isBareMode() || messagingSocketPath !== undefined) {
    // 启动 UDS 消息服务器（仅 Mac/Linux）。
    // 默认对 ants 启用——如果未传 --messaging-socket-path，
    // 则会在 tmpdir 中创建 socket。这里要 await，确保服务器已绑定，
    // 且 $CLAUDE_CODE_MESSAGING_SOCKET 已在任何 hook
    //（尤其是 SessionStart）可能拉起并快照 process.env 之前导出。
    if (feature('UDS_INBOX')) {
      const m = await import('./utils/udsMessaging.js')
      await m.startUdsMessaging(
        messagingSocketPath ?? m.getDefaultUdsSocketPath(),
        { isExplicit: messagingSocketPath !== undefined },
      )
    }
  }

  // Teammate 快照——仅受 SIMPLE 门控（无逃生口，bare 下不会使用 swarm）
  if (!isBareMode() && isAgentSwarmsEnabled()) {
    const { captureTeammateModeSnapshot } = await import(
      './utils/swarm/backends/teammateModeSnapshot.js'
    )
    captureTeammateModeSnapshot()
  }

  // 终端备份恢复——仅交互模式。Print 模式不会与终端设置交互；
  // 下一次交互式会话会检测并恢复任何被中断的 setup。
  if (!getIsNonInteractiveSession()) {
    // 仅在启用 swarms 时检查 iTerm2 备份
    if (isAgentSwarmsEnabled()) {
      const restoredIterm2Backup = await checkAndRestoreITerm2Backup()
      if (restoredIterm2Backup.status === 'restored') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.yellow(
            'Detected an interrupted iTerm2 setup. Your original settings have been restored. You may need to restart iTerm2 for the changes to take effect.',
          ),
        )
      } else if (restoredIterm2Backup.status === 'failed') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.red(
            `Failed to restore iTerm2 settings. Please manually restore your original settings with: defaults import com.googlecode.iterm2 ${restoredIterm2Backup.backupPath}.`,
          ),
        )
      }
    }

    // 如果 setup 被中断，则检查并恢复 Terminal.app 备份
    try {
      const restoredTerminalBackup = await checkAndRestoreTerminalBackup()
      if (restoredTerminalBackup.status === 'restored') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.yellow(
            'Detected an interrupted Terminal.app setup. Your original settings have been restored. You may need to restart Terminal.app for the changes to take effect.',
          ),
        )
      } else if (restoredTerminalBackup.status === 'failed') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.red(
            `Failed to restore Terminal.app settings. Please manually restore your original settings with: defaults import com.apple.Terminal ${restoredTerminalBackup.backupPath}.`,
          ),
        )
      }
    } catch (error) {
      // 记录日志，但不要因为 Terminal.app 备份恢复失败而崩溃
      logError(error)
    }
  }

  // 重要：setCwd() 必须在任何依赖 cwd 的代码之前调用
  setCwd(cwd)
  setOriginalCwd(cwd)
  setProjectRoot(cwd)

  // 本地恢复模式：当显式设置 CLAUDE_CODE_LOCAL_RECOVERY=1 时，
  // 将启动流程裁剪到最小。否则为 Ink TUI 执行完整 setup。
  if (process.env.CLAUDE_CODE_LOCAL_RECOVERY === '1') {
    process.stderr.write('[local-recovery] setup early return\n')
    profileCheckpoint('setup_local_recovery_early_return')
    return
  }

  // 捕获 hooks 配置快照，避免隐藏的 hook 修改。
  // 重要：必须在 setCwd() 之后调用，这样 hooks 才会从正确目录加载
  const hooksStart = Date.now()
  captureHooksConfigSnapshot()
  logForDiagnosticsNoPII('info', 'setup_hooks_captured', {
    duration_ms: Date.now() - hooksStart,
  })

  // 初始化 FileChanged hook watcher——同步执行，会读取 hook 配置快照
  initializeFileChangedWatcher(cwd)

  // 如有请求则处理 worktree 创建
  // 重要：这必须在 getCommands() 之前调用，否则 /eject 将不可用。
  if (worktreeEnabled) {
    // 与 bridgeMain.ts 保持一致：配置了 hook 的会话可以在没有 git 的情况下继续，
    // 因此 createWorktreeForSession() 可以委托给 hook（非 git VCS）。
    const hasHook = hasWorktreeCreateHook()
    const inGit = await getIsGit()
    if (!hasHook && !inGit) {
      process.stderr.write(
        chalk.red(
          `Error: Can only use --worktree in a git repository, but ${chalk.bold(cwd)} is not a git repository. ` +
            `Configure a WorktreeCreate hook in settings.json to use --worktree with other VCS systems.\n`,
        ),
      )
      process.exit(1)
    }

    const slug = worktreePRNumber
      ? `pr-${worktreePRNumber}`
      : (worktreeName ?? getPlanSlug())

    // 只要位于 git 仓库中，就会执行 git 预处理——即便已配置 hook 也是如此——
    // 这样同时拥有 WorktreeCreate hook 的 git 用户仍可继续使用 --tmux。
    // 只有纯 hook（非 git）模式会跳过这一步。
    let tmuxSessionName: string | undefined
    if (inGit) {
      // 解析到主仓库根目录（处理从 worktree 内部调用的情况）。
      // findCanonicalGitRoot 是同步/仅文件系统/带 memoization 的；底层的
      // findGitRoot 缓存在上面的 getIsGit() 中已被预热，因此这里几乎零成本。
      const mainRepoRoot = findCanonicalGitRoot(getCwd())
      if (!mainRepoRoot) {
        process.stderr.write(
          chalk.red(
            `Error: Could not determine the main git repository root.\n`,
          ),
        )
        process.exit(1)
      }

      // 如果当前位于 worktree 内部，则切换到主仓库来创建 worktree
      if (mainRepoRoot !== (findGitRoot(getCwd()) ?? getCwd())) {
        logForDiagnosticsNoPII('info', 'worktree_resolved_to_main_repo')
        process.chdir(mainRepoRoot)
        setCwd(mainRepoRoot)
      }

      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(mainRepoRoot, worktreeBranchName(slug))
        : undefined
    } else {
      // 非 git 的 hook 模式：没有可解析的 canonical root，因此从 cwd
      // 派生 tmux session 名称——generateTmuxSessionName 只会取路径 basename。
      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(getCwd(), worktreeBranchName(slug))
        : undefined
    }

    let worktreeSession: Awaited<ReturnType<typeof createWorktreeForSession>>
    try {
      worktreeSession = await createWorktreeForSession(
        getSessionId(),
        slug,
        tmuxSessionName,
        worktreePRNumber || worktreeBaseRef
          ? {
              ...(worktreePRNumber ? { prNumber: worktreePRNumber } : {}),
              ...(worktreeBaseRef ? { baseRef: worktreeBaseRef } : {}),
            }
          : undefined,
      )
    } catch (error) {
      process.stderr.write(
        chalk.red(`Error creating worktree: ${errorMessage(error)}\n`),
      )
      process.exit(1)
    }

    logEvent('tengu_worktree_created', { tmux_enabled: tmuxEnabled })

    // 如果启用，则为 worktree 创建 tmux session
    if (tmuxEnabled && tmuxSessionName) {
      const tmuxResult = await createTmuxSessionForWorktree(
        tmuxSessionName,
        worktreeSession.worktreePath,
      )
      if (tmuxResult.created) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.green(
            `Created tmux session: ${chalk.bold(tmuxSessionName)}\nTo attach: ${chalk.bold(`tmux attach -t ${tmuxSessionName}`)}`,
          ),
        )
      } else {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.yellow(
            `Warning: Failed to create tmux session: ${tmuxResult.error}`,
          ),
        )
      }
    }

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    // --worktree 表示该 worktree 就是本次会话的项目，因此 skills/hooks/
    // cron 等都应解析到这里。（会话中途的 EnterWorktreeTool 不会触碰
    // projectRoot——那是一次性 worktree，项目本体应保持稳定。）
    setProjectRoot(getCwd())
    saveWorktreeState(worktreeSession)
    // 由于 originalCwd 已改变，清理 memory files 缓存
    clearMemoryFileCaches()
    // Settings 缓存在 init() 中（通过 applySafeConfigEnvironmentVariables）
    // 以及上方 captureHooksConfigSnapshot() 中都已填充，二者都来自原目录的
    // .claude/settings.json。这里要从 worktree 重新读取，并重新捕获 hooks。
    updateHooksConfigSnapshot()
  }

  // 后台任务：只做那些必须在第一次 query 前完成的关键注册
  logForDiagnosticsNoPII('info', 'setup_background_jobs_starting')
  // 打包内置的 skills/plugins 会在 main.tsx 中、并行触发 getCommands()
  // 之前完成注册——见那里的注释。之所以从 setup() 挪出，是因为上面的
  // await 点（startUdsMessaging，约 20ms）会让 getCommands() 先跑，
  // 从而把空的 bundledSkills 列表错误地 memoize 住。
  if (!isBareMode()) {
    initSessionMemory() // 同步执行：注册 hook，gate 检查会延后惰性发生
    if (feature('CONTEXT_COLLAPSE')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;(
        require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js')
      ).initContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  void lockCurrentVersion() // 锁定当前版本，防止被其他进程删除
  logForDiagnosticsNoPII('info', 'setup_background_jobs_launched')

  profileCheckpoint('setup_before_prefetch')
  // 预取 promise：仅包含 render 前需要的项
  logForDiagnosticsNoPII('info', 'setup_prefetch_starting')
  // 当设置了 CLAUDE_CODE_SYNC_PLUGIN_INSTALL 时，跳过全部 plugin 预取。
  // print.ts 中的同步安装路径会在安装后调用 refreshPluginState()，
  // 重新加载 commands、hooks 和 agents。这里做预取会与安装流程竞争
  //（在同一目录上并发执行 copyPluginToVersionedCache / cachePlugin），
  // 而且当 policySettings 到达时，热重载处理器还会在安装过程中触发
  // clearPluginCache()。
  const skipPluginPrefetch =
    (getIsNonInteractiveSession() &&
      isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) ||
    // --bare：loadPluginHooks -> loadAllPlugins 属于文件系统工作，
    // 而在 --bare 下 executeHooks 本就会提前返回，这些开销都属于浪费。
    isBareMode()
  if (!skipPluginPrefetch) {
    void getCommands(getProjectRoot())
  }
  void import('./utils/plugins/loadPluginHooks.js').then(m => {
    if (!skipPluginPrefetch) {
      void m.loadPluginHooks() // 预加载 plugin hooks（render 前会被 processSessionStartHooks 使用）
      m.setupPluginHookHotReload() // 在 settings 变化时为 plugin hooks 配置热重载
    }
  })
  // --bare：跳过 attribution hook 安装、repo 分类、
  // session-file-access analytics 以及 team memory watcher。这些都是用于
  // commit attribution 和使用指标的后台记账逻辑——脚本化调用不会提交代码，
  // 而且 49ms 的 attribution hook stat 检查（已实测）纯属额外开销。
  // 这里不是提前 return：下方的 --dangerously-skip-permissions 安全门、
  // tengu_started 信标以及 apiKeyHelper 预取仍然必须执行。
  if (!isBareMode()) {
    if (process.env.USER_TYPE === 'ant') {
      // 为 auto-undercover 模式预热 repo 分类缓存。默认是在证明为内部仓库前
      // 将 undercover 视为开启；如果这里解析出是内部仓库，就清掉 prompt 缓存，
      // 让下一轮能拿到关闭后的状态。
      void import('./utils/commitAttribution.js').then(async m => {
        if (await m.isInternalModelRepo()) {
          const { clearSystemPromptSections } = await import(
            './constants/systemPromptSections.js'
          )
          clearSystemPromptSections()
        }
      })
    }
    if (feature('COMMIT_ATTRIBUTION')) {
      // 用动态导入来启用 dead code elimination（模块内含被排除的字符串）。
      // 延后到下一 tick，让 git 子进程在首次 render 之后启动，
      // 而不是挤在 setup() 的微任务窗口里。
      setImmediate(() => {
        void import('./utils/attributionHooks.js').then(
          ({ registerAttributionHooks }) => {
            registerAttributionHooks() // 注册 attribution tracking hooks（仅 ant 功能）
          },
        )
      })
    }
    void import('./utils/sessionFileAccessHooks.js').then(m =>
      m.registerSessionFileAccessHooks(),
    ) // 注册 session file access analytics hooks
    if (feature('TEAMMEM')) {
      void import('./services/teamMemorySync/watcher.js').then(m =>
        m.startTeamMemoryWatcher(),
      ) // 启动 team memory sync watcher
    }
  }
  initSinks() // 挂接错误日志与 analytics sinks，并冲刷排队事件

  // session-success-rate 的分母事件。要在 analytics sink 挂好后立刻发出——
  // 早于任何可能抛错的解析、抓取或 I/O。
  // inc-3694（P0 CHANGELOG 崩溃）就死在下面的 checkForReleaseNotes；
  // 从那之后的所有事件都发不出来。这个 beacon 是发布健康监控里
  // 最早且可靠的“process started”信号。
  logEvent('tengu_started', {})

  void prefetchApiKeyFromApiKeyHelperIfSafe(getIsNonInteractiveSession()) // 安全预取：仅在 trust 已确认时执行
  profileCheckpoint('setup_after_prefetch')

  // 为 Logo v2 预取数据——这里要 await，确保 logo 渲染前已准备就绪。
  // --bare / SIMPLE：跳过——release notes 属于交互式 UI 展示数据，
  // 而 getRecentActivity() 最多会读取 10 个 session JSONL 文件。
  if (!isBareMode()) {
    const { hasReleaseNotes } = await checkForReleaseNotes(
      getGlobalConfig().lastReleaseNotesSeen,
    )
    if (hasReleaseNotes) {
      await getRecentActivity()
    }
  }

  // 如果 permission mode 被设为 bypass，确认当前环境是安全的
  if (
    permissionMode === 'bypassPermissions' ||
    allowDangerouslySkipPermissions
  ) {
    // 检查是否在类 Unix 系统中以 root/sudo 身份运行
    // 如果处于 sandbox 中，则允许 root（例如要求 root 的 TPU devspaces）
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== '1' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_BUBBLEWRAP)
    ) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(
        `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`,
      )
      process.exit(1)
    }

    if (
      process.env.USER_TYPE === 'ant' &&
      // Desktop 的 local agent 模式跳过此检查——其 trust 模型与 CCR/BYOC 相同
      //（受信任的 Anthropic 托管 launcher 会有意预批准所有内容）。
      // 先例：permissionSetup.ts:861, applySettingsChange.ts:55 (PR #19116)
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent' &&
      // CCD（Claude Code in Desktop）同样如此——apps#29127 无条件传递该标志，
      // 以便解锁会话中途切换 bypass
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop'
    ) {
      // 仅当 permission mode 为 bypass 时才等待这些检查
      const [isDocker, hasInternet] = await Promise.all([
        envDynamic.getIsDocker(),
        env.hasInternetAccess(),
      ])
      const isBubblewrap = envDynamic.getIsBubblewrapSandbox()
      const isSandbox = process.env.IS_SANDBOX === '1'
      const isSandboxed = isDocker || isBubblewrap || isSandbox
      if (!isSandboxed || hasInternet) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          `--dangerously-skip-permissions can only be used in Docker/sandbox containers with no internet access but got Docker: ${isDocker}, Bubblewrap: ${isBubblewrap}, IS_SANDBOX: ${isSandbox}, hasInternet: ${hasInternet}`,
        )
        process.exit(1)
      }
    }
  }

  if (process.env.NODE_ENV === 'test') {
    return
  }

  // 记录上一会话的 tengu_exit 事件？
  const projectConfig = getCurrentProjectConfig()
  if (
    projectConfig.lastCost !== undefined &&
    projectConfig.lastDuration !== undefined
  ) {
    logEvent('tengu_exit', {
      last_session_cost: projectConfig.lastCost,
      last_session_api_duration: projectConfig.lastAPIDuration,
      last_session_tool_duration: projectConfig.lastToolDuration,
      last_session_duration: projectConfig.lastDuration,
      last_session_lines_added: projectConfig.lastLinesAdded,
      last_session_lines_removed: projectConfig.lastLinesRemoved,
      last_session_total_input_tokens: projectConfig.lastTotalInputTokens,
      last_session_total_output_tokens: projectConfig.lastTotalOutputTokens,
      last_session_total_cache_creation_input_tokens:
        projectConfig.lastTotalCacheCreationInputTokens,
      last_session_total_cache_read_input_tokens:
        projectConfig.lastTotalCacheReadInputTokens,
      last_session_fps_average: projectConfig.lastFpsAverage,
      last_session_fps_low_1_pct: projectConfig.lastFpsLow1Pct,
      last_session_id:
        projectConfig.lastSessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...projectConfig.lastSessionMetrics,
    })
    // 注意：我们有意在记录后不清除这些值。
    // 恢复会话时仍需要它们来恢复成本状态。
    // 下一次会话退出时，这些值会被覆盖。
  }
}
