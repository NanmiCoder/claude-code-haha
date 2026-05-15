import { logEvent } from 'src/services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
/**
 * 迁移：把用户设置的 autoUpdates 偏好迁移到 settings.json 的 env var 中。
 * 仅在用户明确禁用了 auto-updates 时才迁移（不是出于保护机制自动禁用的情况）。
 * 这样既保留了用户意图，也允许原生安装继续自动更新。
 */
export function migrateAutoUpdatesToSettings(): void {
  const globalConfig = getGlobalConfig()

  // 只有当 autoUpdates 是用户偏好明确设为 false 时才迁移
  //（不是因为 native protection 自动设置的）
  if (
    globalConfig.autoUpdates !== false ||
    globalConfig.autoUpdatesProtectedForNative === true
  ) {
    return
  }

  try {
    const userSettings = getSettingsForSource('userSettings') || {}

    // 始终设置 DISABLE_AUTOUPDATER，以保留用户意图
    // 即便它已经存在，也需要覆盖，才能确保迁移真正完成
    updateSettingsForSource('userSettings', {
      ...userSettings,
      env: {
        ...userSettings.env,
        DISABLE_AUTOUPDATER: '1',
      },
    })

    logEvent('tengu_migrate_autoupdates_to_settings', {
      was_user_preference: true,
      already_had_env_var: !!userSettings.env?.DISABLE_AUTOUPDATER,
    })

    // 这里是显式设置，因此会立即生效
    process.env.DISABLE_AUTOUPDATER = '1'

    // 迁移成功后，从 global config 中移除 autoUpdates
    saveGlobalConfig(current => {
      const {
        autoUpdates: _,
        autoUpdatesProtectedForNative: __,
        ...updatedConfig
      } = current
      return updatedConfig
    })
  } catch (error) {
    logError(new Error(`Failed to migrate auto-updates: ${error}`))
    logEvent('tengu_migrate_autoupdates_error', {
      has_error: true,
    })
  }
}
