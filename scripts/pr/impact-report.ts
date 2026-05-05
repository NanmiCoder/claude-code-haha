#!/usr/bin/env bun

import { evaluateChangePolicy } from './change-policy'

async function output(cmd: string[]) {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited

  if (code !== 0) {
    throw new Error(stderr || stdout || `Command failed: ${cmd.join(' ')}`)
  }

  return stdout.trim()
}

async function outputOrEmpty(cmd: string[]) {
  try {
    return await output(cmd)
  } catch {
    return ''
  }
}

async function localChangedFiles() {
  const staged = await outputOrEmpty(['git', 'diff', '--name-only', '--cached'])
  const unstaged = await outputOrEmpty(['git', 'diff', '--name-only'])
  const untracked = await outputOrEmpty(['git', 'ls-files', '--others', '--exclude-standard'])

  return [...staged.split(/\r?\n/), ...unstaged.split(/\r?\n/), ...untracked.split(/\r?\n/)]
    .filter(Boolean)
}

function parseListArg(name: string) {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return []
  }

  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    return []
  }

  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

async function changedFiles() {
  const files = parseListArg('--files')
  if (files.length > 0) {
    return files
  }

  const base = process.env.PR_BASE_REF ?? 'origin/main'
  const localFiles = await localChangedFiles()
  try {
    const diff = await output(['git', 'diff', '--name-only', `${base}...HEAD`])
    return [...new Set([...diff.split(/\r?\n/), ...localFiles].filter(Boolean))]
  } catch {
    try {
      const diff = await output(['git', 'diff', '--name-only', 'main...HEAD'])
      return [...new Set([...diff.split(/\r?\n/), ...localFiles].filter(Boolean))]
    } catch {
      return [...new Set(localFiles)]
    }
  }
}

function commandList(result: ReturnType<typeof evaluateChangePolicy>) {
  const commands = ['bun run check:policy']

  if (result.checks.server) {
    commands.push('bun run check:server')
  }
  if (result.checks.adapters) {
    commands.push('bun run check:adapters')
  }
  if (result.checks.docs) {
    commands.push('bun run check:docs')
  }

  return commands
}

function hasMatchingTest(files: string[], predicate: (file: string) => boolean) {
  return files.some((file) => (
    predicate(file) &&
    (/\.test\.[cm]?[jt]sx?$/.test(file) || file.includes('/__tests__/'))
  ))
}

function changedProductionFiles(files: string[], predicate: (file: string) => boolean) {
  return files.filter((file) => (
    predicate(file) &&
    !/\.test\.[cm]?[jt]sx?$/.test(file) &&
    !file.includes('/__tests__/') &&
    !file.includes('/fixtures/')
  ))
}

function coverageWarnings(files: string[]) {
  const warnings: string[] = []
  const serverProd = changedProductionFiles(files, (file) => file.startsWith('src/server/'))
  const adapterProd = changedProductionFiles(files, (file) => file.startsWith('adapters/'))
  const agentRuntimeProd = changedProductionFiles(files, (file) => (
    file.startsWith('src/server/ws/') ||
    file.startsWith('src/server/services/conversation') ||
    file.startsWith('src/tools/') ||
    file.startsWith('src/utils/')
  ))

  if (serverProd.length > 0 && !hasMatchingTest(files, (file) => file.startsWith('src/server/'))) {
    warnings.push('Server product files changed without a server test file in the PR.')
  }

  if (adapterProd.length > 0 && !hasMatchingTest(files, (file) => file.startsWith('adapters/'))) {
    warnings.push('Adapter product files changed without an adapter test file in the PR.')
  }

  if (agentRuntimeProd.length > 0) {
    warnings.push('Agent/model runtime path changed: prefer request-shape/mock tests in PR and maintainer live-model smoke before release.')
  }

  return warnings
}

function riskNotes(files: string[]) {
  const notes: string[] = []

  if (files.some((file) => file.startsWith('src/server/ws/') || file.startsWith('src/server/services/conversation'))) {
    notes.push('Session runtime changed: review reconnect, startup diagnostics, provider selection, and thinking settings.')
  }
  if (files.some((file) => file.includes('provider') || file.includes('WebSearchTool'))) {
    notes.push('Provider/search behavior changed: PR gate uses mock tests; live-provider tests should stay maintainer-only.')
  }
  if (files.some((file) => file.startsWith('.github/workflows/') || file.startsWith('scripts/pr/'))) {
    notes.push('CI/policy changed: inspect the PR workflow behavior itself, not just application tests.')
  }

  return notes
}

const labels = [
  ...parseListArg('--labels'),
  ...(process.env.PR_LABELS?.split(',').map((label) => label.trim()).filter(Boolean) ?? []),
]

if (process.env.ALLOW_CLI_CORE_CHANGE === '1') {
  labels.push('allow-cli-core-change')
}

const files = await changedFiles()
const result = evaluateChangePolicy(files, labels)
const commands = commandList(result)
const warnings = coverageWarnings(result.files)
const notes = riskNotes(result.files)

console.log('# PR impact report')
console.log('')
console.log(`Changed files: ${result.files.length}`)
console.log(`Areas: ${result.areas.length ? result.areas.join(', ') : 'none'}`)
console.log(`Labels: ${result.labels.length ? result.labels.join(', ') : 'none'}`)
console.log(`Blocked: ${result.blocked ? 'yes' : 'no'}`)

if (result.blockingReason) {
  console.log(`Blocking reason: ${result.blockingReason}`)
}

console.log('')
console.log('## Required local checks')
for (const command of commands) {
  console.log(`- \`${command}\``)
}

console.log('')
console.log('## Test coverage signals')
if (warnings.length === 0) {
  console.log('- No obvious missing-test signal from changed paths.')
} else {
  for (const warning of warnings) {
    console.log(`- ${warning}`)
  }
}

console.log('')
console.log('## Risk notes')
if (notes.length === 0) {
  console.log('- No special risk notes from changed paths.')
} else {
  for (const note of notes) {
    console.log(`- ${note}`)
  }
}

console.log('')
console.log('## Agent/model testing policy')
console.log('- Default PR gate should not call real models or live providers.')
console.log('- Cover agent behavior with mock CLI, request-shape assertions, transcript fixtures, and provider capability tests.')
console.log('- Run live-model smoke tests only in maintainer-controlled workflows with secrets, rate limits, and explicit labels.')
