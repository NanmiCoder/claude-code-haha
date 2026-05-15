/**
 * 内置插件注册表。
 *
 * 用于管理那些随 CLI 一起发布、并可由用户在 /plugin UI 中启用或禁用的内置插件。
 *
 * 内置插件与 bundled skills（src/skills/bundled/）的区别在于：
 * - 它们会出现在 /plugin UI 的“Built-in”分组下
 * - 用户可以启用或禁用它们（并持久化到用户设置）
 * - 它们可以提供多个组件（skills、hooks、MCP servers）
 *
 * 插件 ID 使用 `{name}@builtin` 格式，以区别于 marketplace 插件
 * （`{name}@{marketplace}`）。
 */

import type { Command } from '../commands.js'
import type { BundledSkillDefinition } from '../skills/bundledSkills.js'
import type { BuiltinPluginDefinition, LoadedPlugin } from '../types/plugin.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

const BUILTIN_PLUGINS: Map<string, BuiltinPluginDefinition> = new Map()

export const BUILTIN_MARKETPLACE_NAME = 'builtin'

/**
 * 注册内置插件。应在启动阶段由 initBuiltinPlugins() 调用。
 */
export function registerBuiltinPlugin(
  definition: BuiltinPluginDefinition,
): void {
  BUILTIN_PLUGINS.set(definition.name, definition)
}

/**
 * 判断某个插件 ID 是否表示内置插件（即以 @builtin 结尾）。
 */
export function isBuiltinPluginId(pluginId: string): boolean {
  return pluginId.endsWith(`@${BUILTIN_MARKETPLACE_NAME}`)
}

/**
 * 按名称获取某个内置插件的定义。
 * 这对 /plugin UI 很有用，因为它可以直接展示 skills/hooks/MCP 列表，
 * 而不需要走 marketplace 查询。
 */
export function getBuiltinPluginDefinition(
  name: string,
): BuiltinPluginDefinition | undefined {
  return BUILTIN_PLUGINS.get(name)
}

/**
 * 以 LoadedPlugin 对象形式返回所有已注册的内置插件，
 * 并根据用户设置拆分为 enabled/disabled 两组（默认回退到 defaultEnabled）。
 * 如果插件的 isAvailable() 返回 false，则会被完全忽略。
 */
export function getBuiltinPlugins(): {
  enabled: LoadedPlugin[]
  disabled: LoadedPlugin[]
} {
  const settings = getSettings_DEPRECATED()
  const enabled: LoadedPlugin[] = []
  const disabled: LoadedPlugin[] = []

  for (const [name, definition] of BUILTIN_PLUGINS) {
    if (definition.isAvailable && !definition.isAvailable()) {
      continue
    }

    const pluginId = `${name}@${BUILTIN_MARKETPLACE_NAME}`
    const userSetting = settings?.enabledPlugins?.[pluginId]
    // 启用状态优先级：用户设置 > 插件默认值 > true。
    const isEnabled =
      userSetting !== undefined
        ? userSetting === true
        : (definition.defaultEnabled ?? true)

    const plugin: LoadedPlugin = {
      name,
      manifest: {
        name,
        description: definition.description,
        version: definition.version,
      },
      path: BUILTIN_MARKETPLACE_NAME, // 哨兵值：没有真实文件系统路径。
      source: pluginId,
      repository: pluginId,
      enabled: isEnabled,
      isBuiltin: true,
      hooksConfig: definition.hooks,
      mcpServers: definition.mcpServers,
    }

    if (isEnabled) {
      enabled.push(plugin)
    } else {
      disabled.push(plugin)
    }
  }

  return { enabled, disabled }
}

/**
 * 以 Command 对象形式返回已启用内置插件提供的 skills。
 * 已禁用插件的 skill 不会出现在结果中。
 */
export function getBuiltinPluginSkillCommands(): Command[] {
  const { enabled } = getBuiltinPlugins()
  const commands: Command[] = []

  for (const plugin of enabled) {
    const definition = BUILTIN_PLUGINS.get(plugin.name)
    if (!definition?.skills) continue
    for (const skill of definition.skills) {
      commands.push(skillDefinitionToCommand(skill))
    }
  }

  return commands
}

/**
 * 清空内置插件注册表（供测试使用）。
 */
export function clearBuiltinPlugins(): void {
  BUILTIN_PLUGINS.clear()
}

// --

function skillDefinitionToCommand(definition: BundledSkillDefinition): Command {
  return {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    hasUserSpecifiedDescription: true,
    allowedTools: definition.allowedTools ?? [],
    argumentHint: definition.argumentHint,
    whenToUse: definition.whenToUse,
    model: definition.model,
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable: definition.userInvocable ?? true,
    contentLength: 0,
    // 这里用 'bundled' 而不是 'builtin'。
    // 因为 Command.source 里的 'builtin' 表示硬编码 slash command
    // （如 /help、/clear）。使用 'bundled' 可以让这些 skill 继续出现在
    // Skill 工具列表、analytics 名称日志和 prompt 截断豁免逻辑中。
    // “可由用户开关”的属性则由 LoadedPlugin.isBuiltin 来表达。
    source: 'bundled',
    loadedFrom: 'bundled',
    hooks: definition.hooks,
    context: definition.context,
    agent: definition.agent,
    isEnabled: definition.isEnabled ?? (() => true),
    isHidden: !(definition.userInvocable ?? true),
    progressMessage: 'running',
    getPromptForCommand: definition.getPromptForCommand,
  }
}
