/**
 * 内置插件初始化。
 *
 * 负责初始化那些随 CLI 一起发布、并会出现在 /plugin UI 中供用户启用或禁用的内置插件。
 *
 * 并不是所有 bundled feature 都应该做成内置插件；这里只适合那些
 * 需要由用户显式启用/禁用的功能。对于初始化更复杂或带自动启用逻辑的功能
 * （例如 claude-in-chrome），应放到 src/skills/bundled/ 下处理。
 *
 * 添加新的内置插件时：
 * 1. 从 '../builtinPlugins.js' 导入 registerBuiltinPlugin
 * 2. 在这里用插件定义调用 registerBuiltinPlugin()
 */

/**
 * 初始化内置插件，会在 CLI 启动期间调用。
 */
export function initBuiltinPlugins(): void {
  // 目前还没有注册任何内置插件；这里只是为后续把 bundled skills
  // 迁移成可由用户开关的插件预留脚手架。
}
