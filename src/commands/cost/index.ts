/**
 * Cost 命令，仅保留最小元数据。
 * 实现从 cost.ts 懒加载，以减少启动时间。
 */
import type { Command } from '../../commands.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

const cost = {
  type: 'local',
  name: 'cost',
  description: 'Show the total cost and duration of the current session',
  get isHidden() {
    // 即使是订阅用户，也对 Ants 保持可见（他们会看到 cost 明细）
    if (process.env.USER_TYPE === 'ant') {
      return false
    }
    return isClaudeAISubscriber()
  },
  supportsNonInteractive: true,
  load: () => import('./cost.js'),
} satisfies Command

export default cost
