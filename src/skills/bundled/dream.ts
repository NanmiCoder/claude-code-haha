import { isAutoMemoryEnabled, getAutoMemPath } from '../../memdir/paths.ts'
import { isAutoDreamEnabled } from '../../services/autoDream/config.ts'
import { recordConsolidation } from '../../services/autoDream/consolidationLock.ts'
import { buildConsolidationPrompt } from '../../services/autoDream/consolidationPrompt.ts'
import { getProjectDir } from '../../utils/sessionStorage.ts'
import { getOriginalCwd } from '../../bootstrap/state.ts'
import { registerBundledSkill } from '../bundledSkills.ts'

export function registerDreamSkill(): void {
  if (!isAutoMemoryEnabled()) return

  registerBundledSkill({
    name: 'dream',
    description:
      'Run memory consolidation (auto-dream) manually — review, deduplicate, and prune your auto-memory files',
    whenToUse:
      'when you want to clean up and organize accumulated memories, or after many sessions of use',
    argumentHint: null,
    isEnabled: () => isAutoDreamEnabled(),
    context: 'inline',
    async getPromptForCommand(_args: string) {
      const memoryRoot = getAutoMemPath()
      const transcriptDir = getProjectDir(getOriginalCwd())
      await recordConsolidation()
      const extra = ''

      const prompt = buildConsolidationPrompt(memoryRoot, transcriptDir, extra)

      return [{ type: 'text', text: prompt }]
    },
  })
}
