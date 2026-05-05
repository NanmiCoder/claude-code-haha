import { afterEach, describe, expect, test } from 'bun:test'
import { createBashShellProvider } from './bashProvider.js'

const ORIGINAL_CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH
afterEach(() => {
  if (ORIGINAL_CLAUDE_CLI_PATH === undefined) {
    delete process.env.CLAUDE_CLI_PATH
  } else {
    process.env.CLAUDE_CLI_PATH = ORIGINAL_CLAUDE_CLI_PATH
  }
})

describe('createBashShellProvider', () => {
  test('injects a claude wrapper for custom CLI paths', async () => {
    process.env.CLAUDE_CLI_PATH = '/tmp/claude-custom'

    const provider = await createBashShellProvider('/bin/bash', {
      skipSnapshot: true,
    })

    const { commandString } = await provider.buildExecCommand(
      'claude plugin install demo@claude-plugins-official --scope user',
      {
        id: 'wrapper-test',
        useSandbox: false,
      },
    )

    expect(commandString).toContain('claude() {')
    expect(commandString).toContain('/tmp/claude-custom "$@"')
  })
})
