import { logEvent } from '../services/analytics/index.js'
import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 对那些在 settings 中把 'opus' 钉住、且有资格体验合并后 Opus 1M 的用户，
 * 将其迁移到 'opus[1m]'（1P 上的 Max/Team Premium）。
 *
 * 带 --model opus 的 CLI 调用不受影响：该 flag 只是运行时 override，
 * 不会触碰 userSettings，因此它仍会继续使用普通的 Opus。
 *
 * Pro 订阅用户会被跳过——他们仍保留分开的 Opus 和 Opus 1M 选项。
 * 3P 用户也会被跳过——他们的 model string 是完整 model ID，而不是别名。
 *
 * 幂等：只有当 userSettings.model 恰好等于 'opus' 时才会写入。
 */
export function migrateOpusToOpus1m(): void {
  if (!isOpus1mMergeEnabled()) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (model !== 'opus') {
    return
  }

  const migrated = 'opus[1m]'
  const modelToSet =
    parseUserSpecifiedModel(migrated) ===
    parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
      ? undefined
      : migrated
  updateSettingsForSource('userSettings', { model: modelToSet })

  logEvent('tengu_opus_to_opus1m_migration', {})
}
