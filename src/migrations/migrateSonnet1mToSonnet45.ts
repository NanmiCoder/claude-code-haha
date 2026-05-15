import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将保存了 "sonnet[1m]" 的用户迁移到显式的 "sonnet-4-5-20250929[1m]"。
 *
 * 现在 "sonnet" 别名会解析到 Sonnet 4.6，因此那些之前设置了
 * "sonnet[1m]"（即面向带 1M context 的 Sonnet 4.5）的用户，需要被钉到
 * 显式版本上，以保住他们原本想用的模型。
 *
 * 这样做是必要的，因为 Sonnet 4.6 1M 面向的用户群与 Sonnet 4.5 1M 不同，
 * 所以我们必须把现有的 sonnet[1m] 用户钉在 Sonnet 4.5 1M 上。
 *
 * 这里专门读取 userSettings（不是 merged settings），这样就不会把项目级的
 * "sonnet[1m]" 提升成全局默认值。该迁移只运行一次，
 * 通过 global config 中的完成标记追踪。
 */
export function migrateSonnet1mToSonnet45(): void {
  const config = getGlobalConfig()
  if (config.sonnet1m45MigrationComplete) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (model === 'sonnet[1m]') {
    updateSettingsForSource('userSettings', {
      model: 'sonnet-4-5-20250929[1m]',
    })
  }

  // 如果内存中的 override 已经设置，也一并迁移
  const override = getMainLoopModelOverride()
  if (override === 'sonnet[1m]') {
    setMainLoopModelOverride('sonnet-4-5-20250929[1m]')
  }

  saveGlobalConfig(current => ({
    ...current,
    sonnet1m45MigrationComplete: true,
  }))
}
