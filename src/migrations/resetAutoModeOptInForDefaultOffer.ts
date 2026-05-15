import { feature } from 'bun:bundle'
import { logEvent } from 'src/services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import { getAutoModeEnabledState } from '../utils/permissions/permissionSetup.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 一次性迁移：对那些接受过旧版 2 选项 AutoModeOptInDialog、但尚未把 auto
 * 设为默认模式的用户，清空 skipAutoPermissionPrompt。
 * 这样会重新弹出该对话框，让他们看到新的 “make it my default mode” 选项。
 * 守卫位保存在 GlobalConfig（~/.claude.json）里，而不是 settings.json，
 * 因此它能跨越 settings 重置而保留，也不会重新自我激活。
 *
 * 仅在 tengu_auto_mode_config.enabled === 'enabled' 时运行。对于 'opt-in'
 * 用户，清空 skipAutoPermissionPrompt 会把 auto 从 carousel 中移除
 *（permissionSetup.ts:988）——这样对话框就再也到不了，迁移本身也会自我打败。
 * 实际上，约 40 个目标 ant 用户全都是 'enabled'
 *（他们是通过裸 Shift+Tab 进入旧对话框的，而这要求为 'enabled'），
 * 但这个守卫让它在任何情况下都保持安全。
 */
export function resetAutoModeOptInForDefaultOffer(): void {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const config = getGlobalConfig()
    if (config.hasResetAutoModeOptInForDefaultOffer) return
    if (getAutoModeEnabledState() !== 'enabled') return

    try {
      const user = getSettingsForSource('userSettings')
      if (
        user?.skipAutoPermissionPrompt &&
        user?.permissions?.defaultMode !== 'auto'
      ) {
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: undefined,
        })
        logEvent('tengu_migrate_reset_auto_opt_in_for_default_offer', {})
      }

      saveGlobalConfig(c => {
        if (c.hasResetAutoModeOptInForDefaultOffer) return c
        return { ...c, hasResetAutoModeOptInForDefaultOffer: true }
      })
    } catch (error) {
      logError(new Error(`Failed to reset auto mode opt-in: ${error}`))
    }
  }
}
