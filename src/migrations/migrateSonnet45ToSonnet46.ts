import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import {
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getAPIProvider } from '../utils/model/providers.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将 first-party 的 Pro/Max/Team Premium 用户从显式的 Sonnet 4.5 model string
 * 迁移到 'sonnet' 别名（它现在会解析为 Sonnet 4.6）。
 *
 * 用户之所以可能被钉在显式 Sonnet 4.5 字符串上，原因包括：
 * - 更早的 migrateSonnet1mToSonnet45 迁移（sonnet[1m] → 显式 4.5[1m]）
 * - 通过 /model 手动选择
 *
 * 这里专门读取 userSettings（不是 merged settings），因此我们只迁移 /model
 * 写进去的内容——project/local 级别的 pin 保持不动。
 * 幂等：只有当 userSettings.model 命中某个 Sonnet 4.5 字符串时才会写入。
 */
export function migrateSonnet45ToSonnet46(): void {
  if (getAPIProvider() !== 'firstParty') {
    return
  }

  if (!isProSubscriber() && !isMaxSubscriber() && !isTeamPremiumSubscriber()) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (
    model !== 'claude-sonnet-4-5-20250929' &&
    model !== 'claude-sonnet-4-5-20250929[1m]' &&
    model !== 'sonnet-4-5-20250929' &&
    model !== 'sonnet-4-5-20250929[1m]'
  ) {
    return
  }

  const has1m = model.endsWith('[1m]')
  updateSettingsForSource('userSettings', {
    model: has1m ? 'sonnet[1m]' : 'sonnet',
  })

  // 对全新用户跳过通知——他们从未经历过旧的默认值
  const config = getGlobalConfig()
  if (config.numStartups > 1) {
    saveGlobalConfig(current => ({
      ...current,
      sonnet45To46MigrationTimestamp: Date.now(),
    }))
  }

  logEvent('tengu_sonnet45_to_46_migration', {
    from_model:
      model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    has_1m: has1m,
  })
}
