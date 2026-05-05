import type { Command } from '../../commands.js'

const buddyCommand = {
  type: 'local-jsx',
  name: 'buddy',
  description: 'Meet your companion',
  argumentHint: '[hatch|pet|mute|unmute|info|info_cn]',
  load: () => import('./buddy.js'),
} satisfies Command

export default buddyCommand
