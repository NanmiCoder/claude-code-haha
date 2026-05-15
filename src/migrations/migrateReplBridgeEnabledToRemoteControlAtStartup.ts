import { saveGlobalConfig } from '../utils/config.js'

/**
 * 将 `replBridgeEnabled` 配置键迁移到 `remoteControlAtStartup`。
 *
 * 旧键原本是一个实现细节，却泄漏到了面向用户的配置中。
 * 这个迁移会把它的值复制到新键，然后移除旧键。
 * 幂等——只有在旧键存在且新键不存在时才会生效。
 */
export function migrateReplBridgeEnabledToRemoteControlAtStartup(): void {
  saveGlobalConfig(prev => {
    // 旧键已经不在 GlobalConfig 类型里了，所以这里通过
    // 非类型化的 cast 访问它。只有当旧键存在且新键尚未设置时才迁移。
    const oldValue = (prev as Record<string, unknown>)['replBridgeEnabled']
    if (oldValue === undefined) return prev
    if (prev.remoteControlAtStartup !== undefined) return prev
    const next = { ...prev, remoteControlAtStartup: Boolean(oldValue) }
    delete (next as Record<string, unknown>)['replBridgeEnabled']
    return next
  })
}
