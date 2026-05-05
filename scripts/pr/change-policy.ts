#!/usr/bin/env bun

import { existsSync, readFileSync, appendFileSync } from 'node:fs'

export type ChangeArea =
  | 'server'
  | 'adapters'
  | 'docs'
  | 'release'
  | 'cli-core'

export type ChangePolicyResult = {
  files: string[]
  labels: string[]
  areas: ChangeArea[]
  areaLabels: string[]
  blocked: boolean
  blockingReason: string | null
  cliCoreFiles: string[]
  checks: {
    server: boolean
    adapters: boolean
    docs: boolean
  }
}

const ALLOW_CLI_CORE_LABEL = 'allow-cli-core-change'

const areaLabels: Record<ChangeArea, string> = {
  server: 'area:server',
  adapters: 'area:adapters',
  docs: 'area:docs',
  release: 'area:release',
  'cli-core': 'area:cli-core',
}

const cliCorePrefixes = [
  'bin/',
  'src/entrypoints/',
  'src/screens/',
  'src/components/',
  'src/commands/',
  'src/tools/',
  'src/utils/',
]

const docsExactPaths = new Set([
  'README.md',
  'README.en.md',
  'package.json',
  'package-lock.json',
  '.github/workflows/deploy-docs.yml',
])

const releaseExactPaths = new Set([
  '.github/workflows/pr-quality.yml',
  '.github/workflows/pr-triage.yml',
  'scripts/pr/change-policy.ts',
  'scripts/pr/change-policy.test.ts',
  'scripts/pr/check-pr.ts',
  'scripts/pr/run-server-tests.ts',
])

function normalizePath(path: string) {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

function startsWithAny(path: string, prefixes: string[]) {
  return prefixes.some((prefix) => path.startsWith(prefix))
}

function isCliCorePath(path: string) {
  return startsWithAny(path, cliCorePrefixes)
}

function areasForPath(path: string): ChangeArea[] {
  const areas = new Set<ChangeArea>()

  if (path.startsWith('src/server/')) {
    areas.add('server')
  }

  if (path.startsWith('adapters/')) {
    areas.add('adapters')
  }

  if (
    path.startsWith('docs/') ||
    path.startsWith('release-notes/') ||
    docsExactPaths.has(path)
  ) {
    areas.add('docs')
  }

  if (releaseExactPaths.has(path)) {
    areas.add('release')
  }

  if (isCliCorePath(path)) {
    areas.add('cli-core')
  }

  return [...areas]
}

export function evaluateChangePolicy(
  inputFiles: string[],
  inputLabels: string[] = [],
): ChangePolicyResult {
  const files = [...new Set(inputFiles.map(normalizePath).filter(Boolean))].sort()
  const labels = [...new Set(inputLabels.map((label) => label.trim()).filter(Boolean))].sort()
  const areas = new Set<ChangeArea>()

  for (const file of files) {
    for (const area of areasForPath(file)) {
      areas.add(area)
    }
  }

  const cliCoreFiles = files.filter(isCliCorePath)
  const hasCliCoreChange = cliCoreFiles.length > 0
  const hasCliCoreOverride = labels.includes(ALLOW_CLI_CORE_LABEL)
  const blocked = hasCliCoreChange && !hasCliCoreOverride

  const touchesDocs = files.some((file) => (
    file.startsWith('docs/') ||
    file.startsWith('release-notes/') ||
    docsExactPaths.has(file)
  ))

  const orderedAreas = [...areas].sort()

  return {
    files,
    labels,
    areas: orderedAreas,
    areaLabels: orderedAreas.map((area) => areaLabels[area]),
    blocked,
    blockingReason: blocked
      ? `CLI core changes require the ${ALLOW_CLI_CORE_LABEL} label and maintainer approval.`
      : null,
    cliCoreFiles,
    checks: {
      server: areas.has('server') || files.some((file) => file.startsWith('src/tools/') || file.startsWith('src/utils/')),
      adapters: areas.has('adapters'),
      docs: touchesDocs,
    },
  }
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      continue
    }

    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      args.set(arg, next)
      index += 1
    } else {
      args.set(arg, 'true')
    }
  }

  return args
}

function readListFile(path: string) {
  if (!existsSync(path)) {
    throw new Error(`Missing file: ${path}`)
  }

  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function formatSummary(result: ChangePolicyResult) {
  const lines = [
    'PR change policy',
    `  Areas: ${result.areas.length ? result.areas.join(', ') : 'none'}`,
    `  Labels: ${result.labels.length ? result.labels.join(', ') : 'none'}`,
    `  Checks: server=${result.checks.server}, adapters=${result.checks.adapters}, docs=${result.checks.docs}`,
  ]

  if (result.cliCoreFiles.length > 0) {
    lines.push('  CLI core files:')
    for (const file of result.cliCoreFiles) {
      lines.push(`    - ${file}`)
    }
  }

  if (result.blockingReason) {
    lines.push(`  Blocked: ${result.blockingReason}`)
  }

  return lines.join('\n')
}

function writeGithubOutputs(result: ChangePolicyResult) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) {
    return
  }

  const outputs = {
    areas: result.areas.join(','),
    area_labels: result.areaLabels.join(','),
    blocked: String(result.blocked),
    server_checks: String(result.checks.server),
    adapter_checks: String(result.checks.adapters),
    docs_checks: String(result.checks.docs),
  }

  appendFileSync(
    outputPath,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
  )
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  const filesPath = args.get('--files')
  const labelsPath = args.get('--labels-file')
  const labelsArg = args.get('--labels')

  if (!filesPath) {
    console.error('Usage: bun run scripts/pr/change-policy.ts --files <changed-files.txt> [--labels-file <labels.txt>]')
    process.exit(2)
  }

  const files = readListFile(filesPath)
  const labels = labelsPath
    ? readListFile(labelsPath)
    : labelsArg?.split(',').map((label) => label.trim()).filter(Boolean) ?? []

  const result = evaluateChangePolicy(files, labels)
  console.log(formatSummary(result))
  writeGithubOutputs(result)

  if (result.blocked) {
    process.exit(1)
  }
}
