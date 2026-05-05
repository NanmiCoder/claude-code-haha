#!/usr/bin/env bun

import { evaluateChangePolicy } from './change-policy'

async function run(cmd: string[], options: { optional?: boolean } = {}) {
  console.log(`\n$ ${cmd.join(' ')}`)
  const proc = Bun.spawn(cmd, {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited

  if (code !== 0 && !options.optional) {
    process.exit(code)
  }

  return code
}

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

async function changedFiles() {
  const explicit = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
  if (explicit.length > 0) {
    return explicit
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

const files = await changedFiles()
const labels = process.env.PR_LABELS?.split(',').map((label) => label.trim()).filter(Boolean) ?? []
if (process.env.ALLOW_CLI_CORE_CHANGE === '1' && !labels.includes('allow-cli-core-change')) {
  labels.push('allow-cli-core-change')
}

const result = evaluateChangePolicy(files, labels)

console.log('PR local check plan')
console.log(`  Files: ${files.length}`)
console.log(`  Areas: ${result.areas.length ? result.areas.join(', ') : 'none'}`)

if (result.blockingReason) {
  console.error(`\nBlocked: ${result.blockingReason}`)
  console.error('Set ALLOW_CLI_CORE_CHANGE=1 only after maintainer approval.')
  process.exit(1)
}

await run(['bun', 'run', 'check:policy'])

if (result.checks.server) {
  await run(['bun', 'run', 'check:server'])
}

if (result.checks.adapters) {
  await run(['bun', 'run', 'check:adapters'])
}

if (result.checks.docs) {
  await run(['bun', 'run', 'check:docs'])
}

console.log('\nPR local checks completed.')
