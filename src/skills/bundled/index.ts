import { feature } from 'bun:bundle'
import { shouldAutoEnableClaudeInChrome } from 'src/utils/claudeInChrome/setup.js'

/**
 * Initialize all bundled skills.
 * Called at startup to register skills that ship with the CLI.
 *
 * To add a new bundled skill:
 * 1. Create a new file in src/skills/bundled/ (e.g., myskill.ts)
 * 2. Export a register function that calls registerBundledSkill()
 * 3. Import and call that function here
 */
export function initBundledSkills(): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  require('./updateConfig.js').registerUpdateConfigSkill()
  require('./keybindings.js').registerKeybindingsSkill()
  require('./verify.js').registerVerifySkill()
  require('./debug.js').registerDebugSkill()
  require('./loremIpsum.js').registerLoremIpsumSkill()
  require('./skillify.js').registerSkillifySkill()
  require('./remember.js').registerRememberSkill()
  require('./simplify.js').registerSimplifySkill()
  require('./batch.js').registerBatchSkill()
  require('./stuck.js').registerStuckSkill()
  const { registerDreamSkill } = require('./dream.js')
  registerDreamSkill()
  if (feature('REVIEW_ARTIFACT')) {
    const { registerHunterSkill } = require('./hunter.js')
    registerHunterSkill()
  }
  if (feature('AGENT_TRIGGERS')) {
    const { registerLoopSkill } = require('./loop.js')
    // /loop's isEnabled delegates to isKairosCronEnabled() — same lazy
    // per-invocation pattern as the cron tools. Registered unconditionally;
    // the skill's own isEnabled callback decides visibility.
    registerLoopSkill()
  }
  if (feature('AGENT_TRIGGERS_REMOTE')) {
    const {
      registerScheduleRemoteAgentsSkill,
    } = require('./scheduleRemoteAgents.js')
    registerScheduleRemoteAgentsSkill()
  }
  if (feature('BUILDING_CLAUDE_APPS')) {
    const { registerClaudeApiSkill } = require('./claudeApi.js')
    registerClaudeApiSkill()
  }
  if (shouldAutoEnableClaudeInChrome()) {
    require('./claudeInChrome.js').registerClaudeInChromeSkill()
  }
  if (feature('RUN_SKILL_GENERATOR')) {
    const { registerRunSkillGeneratorSkill } = require('./runSkillGenerator.js')
    registerRunSkillGeneratorSkill()
  }
  /* eslint-enable @typescript-eslint/no-require-imports */
}
