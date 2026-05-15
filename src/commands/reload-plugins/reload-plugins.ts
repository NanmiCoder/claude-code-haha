import { feature } from 'bun:bundle'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { redownloadUserSettings } from '../../services/settingsSync/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { plural } from '../../utils/stringUtils.js'

export const call: LocalCommandCall = async (_args, context) => {
  // CCR：先重新拉取用户 settings，再清扫缓存，这样从用户本地 CLI（settingsSync）
  // 推送的 enabledPlugins / extraKnownMarketplaces 才会生效。
  // 非 CCR 的 headless 模式（例如 vscode SDK subprocess）与 settings 的写入方共享磁盘，
  // 文件监视器会递送变更，因此那里无需重新拉取。
  //
  // Managed settings 故意不重新拉取：它本来就按小时轮询
  // （POLLING_INTERVAL_MS），而且按设计 policy enforcement 是最终一致的
  // （拉取失败时回退到 stale cache）。交互式
  // /reload-plugins 过去也从不重新拉取它。
  //
  // 不重试：这是用户主动发起的命令，只尝试一次且失败时 fail-open。用户
  // 可以重新运行 /reload-plugins 重试。启动路径仍保留重试。
  if (
    feature('DOWNLOAD_USER_SETTINGS') &&
    (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) || getIsRemoteMode())
  ) {
    const applied = await redownloadUserSettings()
    // applyRemoteEntriesToLocal 会使用 markInternalWrite 抑制
    // file watcher（对启动期是正确的，因为那时还没人监听）；这里需要触发
    // notifyChange，这样会话中途的 applySettingsChange 才会运行。
    if (applied) {
      settingsChangeDetector.notifyChange('userSettings')
    }
  }

  const r = await refreshActivePlugins(context.setAppState)

  const parts = [
    n(r.enabled_count, 'plugin'),
    n(r.command_count, 'skill'),
    n(r.agent_count, 'agent'),
    n(r.hook_count, 'hook'),
    // "plugin MCP/LSP" 用来与 user-config/built-in servers 区分，
    // /reload-plugins 不会触碰后两者。commands/hooks 只统计 plugin；
    // agent_count 则是 agent 总数（包括 built-ins）。(gh-31321)
    n(r.mcp_count, 'plugin MCP server'),
    n(r.lsp_count, 'plugin LSP server'),
  ]
  let msg = `Reloaded: ${parts.join(' · ')}`

  if (r.error_count > 0) {
    msg += `\n${n(r.error_count, 'error')} during load. Run /doctor for details.`
  }

  return { type: 'text', value: msg }
}

function n(count: number, noun: string): string {
  return `${count} ${plural(count, noun)}`
}
