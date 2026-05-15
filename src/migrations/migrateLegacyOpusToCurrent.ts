import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { saveGlobalConfig } from '../utils/config.js'
import { isLegacyModelRemapEnabled } from '../utils/model/model.js'
import { getAPIProvider } from '../utils/model/providers.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将 first-party 用户从显式的 Opus 4.0/4.1 model string 上迁移下来。
 *
 * 对 1P 来说，'opus' 别名已经会解析到 Opus 4.7，因此任何仍在使用显式 4.0/4.1
 * 字符串的用户，都是在 4.5 发布前就在 settings 里把它钉住了。
 * parseUserSpecifiedModel 现在反正也会在运行时静默重映射这些值——
 * 这个迁移的作用是把 settings 文件清理干净，让 /model 显示正确结果，
 * 并记录一个时间戳，以便 REPL 只显示一次通知。
 *
 * 它只触碰 userSettings。project/local/policy settings 里的 legacy string
 * 会保持不动（我们不能/也不该改写它们），并且仍会在运行时由
 * parseUserSpecifiedModel 重映射。对同一来源做读写可以在没有完成标记的情况下
 * 保持幂等，也能避免把只在某一个项目里钉住的 'opus' 静默提升为全局默认值。
 */
export function migrateLegacyOpusToCurrent(): void {
  if (getAPIProvider() !== 'firstParty') {
    return
  }

  if (!isLegacyModelRemapEnabled()) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (
    model !== 'claude-opus-4-20250514' &&
    model !== 'claude-opus-4-1-20250805' &&
    model !== 'claude-opus-4-0' &&
    model !== 'claude-opus-4-1'
  ) {
    return
  }

  updateSettingsForSource('userSettings', { model: 'opus' })
  saveGlobalConfig(current => ({
    ...current,
    legacyOpusMigrationTimestamp: Date.now(),
  }))
  logEvent('tengu_legacy_opus_migration', {
    from_model:
      model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}
