/**
 * /reload-plugins — Layer-3 refresh. Applies pending plugin changes to the
 * running session. Implementation lazy-loaded.
 */
import type { Command } from '../../commands.js'

const reloadPlugins = {
  type: 'local',
  name: 'reload-plugins',
  description: 'Activate pending plugin changes in the current session',
  // SDK 调用方通过 query.reloadPlugins()（control request）而不是
  // 把它当作文本 prompt 发送，这样会返回结构化数据
  // （commands、agents、plugins、mcpServers）用于 UI 更新。
  supportsNonInteractive: false,
  load: () => import('./reload-plugins.js'),
} satisfies Command

export default reloadPlugins
