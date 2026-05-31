#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { loadQuarantineManifest, quarantinedPathSet } from './quarantine'

type CoverageMetric = {
  total: number
  covered: number
  pct: number
}

type CoverageSummary = {
  lines: CoverageMetric
  functions: CoverageMetric
  branches: CoverageMetric
  statements: CoverageMetric
}

type CoverageScope = {
  id: string
  title: string
  includePrefixes: string[]
  excludePrefixes?: string[]
  excludeSuffixes?: string[]
}

type SuiteCoverage = {
  id: string
  title: string
  status: 'passed' | 'failed'
  command: string[]
  durationMs: number
  summary?: CoverageSummary
  logPath: string
  error?: string
}

type CoverageThresholds = {
  schemaVersion: 1
  minimums: Record<string, Partial<Record<keyof CoverageSummary, number>>>
  targets?: Record<string, Partial<Record<keyof CoverageSummary, number>>>
  changedLines?: {
    minimumPercent: number
  }
  ratchet?: {
    baselinePath: string
    allowedDropPercent: number
  }
}

type BaselineFile = {
  schemaVersion: 1
  generatedAt?: string
  suites: Record<string, CoverageSummary>
}

type CoverageReport = {
  schemaVersion: 1
  runId: string
  startedAt: string
  finishedAt: string
  outputDir: string
  baselineRef?: string
  suites: SuiteCoverage[]
  changedLines?: ChangedLineCoverage
  targetGaps: string[]
  failures: string[]
}

type LcovRecord = {
  file: string
  linesTotal: number
  linesCovered: number
  functionsTotal: number
  functionsCovered: number
  branchesTotal: number
  branchesCovered: number
  lineHits: Map<number, number>
}

type FileLineCoverage = {
  suiteId: string
  executableLines: Set<number>
  coveredLines: Set<number>
}

type ChangedLineCoverage = {
  minimumPercent: number
  covered: number
  total: number
  pct: number
  files: Array<{
    file: string
    suiteId: string
    covered: number
    total: number
    pct: number
    reason?: string
  }>
  failures: string[]
}

const ROOT_DIR = process.cwd()
const DEFAULT_THRESHOLDS_PATH = join(ROOT_DIR, 'scripts', 'quality-gate', 'coverage-thresholds.json')

const ROOT_COVERAGE_SCOPES: CoverageScope[] = [
  {
    id: 'server-api',
    title: 'Server/API',
    includePrefixes: ['src/server/'],
    excludeSuffixes: ['.test.ts', '.test.tsx'],
  },
  {
    id: 'agent-tools',
    title: 'Agent tools',
    includePrefixes: ['src/tools/'],
    excludeSuffixes: ['.test.ts', '.test.tsx'],
  },
  {
    id: 'agent-utils',
    title: 'Agent utils',
    includePrefixes: ['src/utils/'],
    excludeSuffixes: ['.test.ts', '.test.tsx'],
  },
]

const ADAPTERS_SCOPE: CoverageScope = {
  id: 'adapters',
  title: 'IM adapters',
  includePrefixes: ['adapters/'],
  excludePrefixes: ['adapters/node_modules/'],
  excludeSuffixes: ['.test.ts', '.test.tsx', '.d.ts'],
}

const DESKTOP_SCOPE: CoverageScope = {
  id: 'desktop',
  title: 'Desktop React',
  includePrefixes: ['desktop/src/'],
  excludePrefixes: [
    'desktop/src/mocks/',
    'desktop/src/types/',
  ],
  excludeSuffixes: ['.test.ts', '.test.tsx', '.d.ts', 'vite-env.d.ts', '.css'],
}

const CHANGED_LINE_SCOPES = [
  ...ROOT_COVERAGE_SCOPES,
  ADAPTERS_SCOPE,
  DESKTOP_SCOPE,
]

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string | boolean>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      args.set(arg, next)
      index += 1
    } else {
      args.set(arg, true)
    }
  }
  return args
}

function pct(covered: number, total: number) {
  return total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2))
}

function metric(covered: number, total: number): CoverageMetric {
  return { covered, total, pct: pct(covered, total) }
}

function normalize(path: string, rootDir = ROOT_DIR) {
  return relative(rootDir, path).split(sep).join('/')
}

function normalizeCoveragePath(path: string, rootDir = ROOT_DIR) {
  const normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('/')) {
    return relative(rootDir, normalized).split(sep).join('/')
  }
  return normalized.replace(/^\.\//, '')
}

export function prefixRelativeLcovSourcePaths(content: string, prefix: string) {
  const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return content.replace(/^SF:(.+)$/gm, (line, sourcePath: string) => {
    const normalizedSourcePath = String(sourcePath).replace(/\\/g, '/').replace(/^\.\//, '')
    if (
      normalizedSourcePath.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalizedSourcePath) ||
      normalizedSourcePath.startsWith(`${normalizedPrefix}/`)
    ) {
      return line
    }
    return `SF:${normalizedPrefix}/${normalizedSourcePath}`
  })
}

function matchesScope(file: string, scope: CoverageScope) {
  const normalized = file.replace(/\\/g, '/')
  if (!scope.includePrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return false
  }
  if (scope.excludePrefixes?.some((prefix) => normalized.startsWith(prefix))) {
    return false
  }
  if (scope.excludeSuffixes?.some((suffix) => normalized.endsWith(suffix))) {
    return false
  }
  return true
}

function walkTestFiles(path: string, files: string[], excluded: Set<string>, rootDir = ROOT_DIR) {
  const stat = statSync(path)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      walkTestFiles(join(path, entry), files, excluded, rootDir)
    }
    return
  }
  if (!stat.isFile()) return

  const normalized = normalize(path, rootDir)
  if (normalized.endsWith('.test.ts') && !excluded.has(normalized)) {
    files.push(normalized)
  }
}

function collectServerTestFiles(rootDir = ROOT_DIR) {
  const excluded = quarantinedPathSet(loadQuarantineManifest(undefined, { enforceReviewDate: true }))
  const files: string[] = []
  for (const root of ['src/server', 'src/tools', 'src/utils']) {
    walkTestFiles(join(rootDir, root), files, excluded, rootDir)
  }
  return files.sort()
}

function parseLcovRecords(content: string, options: {
  rootDir?: string
  scope?: CoverageScope
} = {}) {
  const records: LcovRecord[] = []
  let current: LcovRecord | null = null

  function flush() {
    if (!current) return
    if (!options.scope || matchesScope(current.file, options.scope)) {
      records.push(current)
    }
    current = null
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === 'end_of_record') {
      flush()
      continue
    }
    if (line.startsWith('SF:')) {
      flush()
      current = {
        file: normalizeCoveragePath(line.slice(3), options.rootDir),
        linesTotal: 0,
        linesCovered: 0,
        functionsTotal: 0,
        functionsCovered: 0,
        branchesTotal: 0,
        branchesCovered: 0,
        lineHits: new Map(),
      }
      continue
    }
    if (!current) continue
    if (line.startsWith('LF:')) current.linesTotal += Number(line.slice(3)) || 0
    if (line.startsWith('LH:')) current.linesCovered += Number(line.slice(3)) || 0
    if (line.startsWith('FNF:')) current.functionsTotal += Number(line.slice(4)) || 0
    if (line.startsWith('FNH:')) current.functionsCovered += Number(line.slice(4)) || 0
    if (line.startsWith('BRF:')) current.branchesTotal += Number(line.slice(4)) || 0
    if (line.startsWith('BRH:')) current.branchesCovered += Number(line.slice(4)) || 0
    if (line.startsWith('DA:')) {
      const [lineNumber, hits] = line.slice(3).split(',')
      const parsedLine = Number(lineNumber)
      if (Number.isFinite(parsedLine)) {
        current.lineHits.set(parsedLine, Number(hits) || 0)
      }
    }
  }

  flush()
  return records
}

function summarizeLcovRecords(records: LcovRecord[]): CoverageSummary {
  let linesTotal = 0
  let linesCovered = 0
  let functionsTotal = 0
  let functionsCovered = 0
  let branchesTotal = 0
  let branchesCovered = 0

  for (const record of records) {
    linesTotal += record.linesTotal
    linesCovered += record.linesCovered
    functionsTotal += record.functionsTotal
    functionsCovered += record.functionsCovered
    branchesTotal += record.branchesTotal
    branchesCovered += record.branchesCovered
  }

  return {
    lines: metric(linesCovered, linesTotal),
    functions: metric(functionsCovered, functionsTotal),
    branches: metric(branchesCovered, branchesTotal),
    statements: metric(linesCovered, linesTotal),
  }
}

export function parseLcov(content: string, options: {
  rootDir?: string
  scope?: CoverageScope
} = {}): CoverageSummary {
  return summarizeLcovRecords(parseLcovRecords(content, options))
}

function lcovLineCoverage(content: string, suiteId: string, scope: CoverageScope, rootDir = ROOT_DIR) {
  const coverage = new Map<string, FileLineCoverage>()
  for (const record of parseLcovRecords(content, { rootDir, scope })) {
    const executableLines = new Set<number>()
    const coveredLines = new Set<number>()
    for (const [line, hits] of record.lineHits) {
      executableLines.add(line)
      if (hits > 0) {
        coveredLines.add(line)
      }
    }
    coverage.set(record.file, { suiteId, executableLines, coveredLines })
  }
  return coverage
}

function parseVitestSummary(path: string): CoverageSummary {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    total: Record<string, { total: number; covered: number; pct: number }>
  }
  const total = raw.total
  return {
    lines: metric(total.lines.covered, total.lines.total),
    functions: metric(total.functions.covered, total.functions.total),
    branches: metric(total.branches.covered, total.branches.total),
    statements: metric(total.statements.covered, total.statements.total),
  }
}

async function runCommand(command: string[], cwd: string, logPath: string) {
  const started = Date.now()
  const proc = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  mkdirSync(dirname(logPath), { recursive: true })
  writeFileSync(logPath, `$ ${command.join(' ')}\n${stdout}${stderr}`)
  return { exitCode, durationMs: Date.now() - started }
}

async function runSuite(
  id: string,
  title: string,
  command: string[],
  cwd: string,
  suiteDir: string,
  readSummary: () => CoverageSummary,
): Promise<SuiteCoverage> {
  mkdirSync(suiteDir, { recursive: true })
  const logPath = join(suiteDir, 'coverage.log')
  const result = await runCommand(command, cwd, logPath)

  // 即使部分测试失败退出码非 0，覆盖率数据通常也已写入 — 尝试读取
  try {
    return {
      id,
      title,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      command,
      durationMs: result.durationMs,
      logPath,
      summary: readSummary(),
      ...(result.exitCode !== 0 ? { error: `coverage command exited with ${result.exitCode}` } : {}),
    }
  } catch (error) {
    return {
      id,
      title,
      status: 'failed',
      command,
      durationMs: result.durationMs,
      logPath,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function loadThresholds(path = DEFAULT_THRESHOLDS_PATH): CoverageThresholds {
  if (!existsSync(path)) {
    return { schemaVersion: 1, minimums: {} }
  }
  return JSON.parse(readFileSync(path, 'utf8')) as CoverageThresholds
}

function readGitFile(rootDir: string, ref: string, filePath: string) {
  const gitPath = filePath.startsWith('/')
    ? relative(rootDir, filePath).split(sep).join('/')
    : filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const proc = Bun.spawnSync(['git', 'show', `${ref}:${gitPath}`], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    return null
  }
  return new TextDecoder().decode(proc.stdout)
}

export function parseChangedLinesFromDiff(diff: string) {
  const changed = new Map<string, Set<number>>()
  let currentFile: string | null = null
  let nextLine = 0

  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith('+++ ')) {
      const file = rawLine.slice(4).trim()
      currentFile = file === '/dev/null' ? null : file.replace(/^b\//, '')
      continue
    }

    const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      nextLine = Number(hunk[1])
      continue
    }

    if (!currentFile || nextLine === 0) continue
    if (rawLine.startsWith('+++')) continue
    if (rawLine.startsWith('+')) {
      let lines = changed.get(currentFile)
      if (!lines) {
        lines = new Set()
        changed.set(currentFile, lines)
      }
      lines.add(nextLine)
      nextLine += 1
      continue
    }
    if (rawLine.startsWith('-')) continue
    if (rawLine.length > 0) {
      nextLine += 1
    }
  }

  return changed
}

function gitOutput(rootDir: string, args: string[]) {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) return null
  return new TextDecoder().decode(proc.stdout)
}

function collectChangedLines(rootDir: string, baseRef?: string) {
  const explicitBase = baseRef?.trim()
  if (explicitBase) {
    const diff = gitOutput(rootDir, ['diff', '--unified=0', '--no-ext-diff', `${explicitBase}...HEAD`, '--'])
    return diff ? parseChangedLinesFromDiff(diff) : new Map<string, Set<number>>()
  }

  const dirty = gitOutput(rootDir, ['diff', '--name-only', '--'])
  if (dirty?.trim()) {
    const diff = gitOutput(rootDir, ['diff', '--unified=0', '--no-ext-diff', 'HEAD', '--'])
    return diff ? parseChangedLinesFromDiff(diff) : new Map<string, Set<number>>()
  }

  const branch = gitOutput(rootDir, ['branch', '--show-current'])?.trim()
  const hasOriginMain = gitOutput(rootDir, ['rev-parse', '--verify', 'origin/main'])
  if (branch && branch !== 'main' && hasOriginMain) {
    const diff = gitOutput(rootDir, ['diff', '--unified=0', '--no-ext-diff', 'origin/main...HEAD', '--'])
    return diff ? parseChangedLinesFromDiff(diff) : new Map<string, Set<number>>()
  }

  return new Map<string, Set<number>>()
}

export function evaluateChangedLineCoverage(
  changedLines: Map<string, Set<number>>,
  coverageByFile: Map<string, FileLineCoverage>,
  scopes: CoverageScope[],
  minimumPercent: number,
): ChangedLineCoverage {
  const files: ChangedLineCoverage['files'] = []
  let total = 0
  let covered = 0

  for (const [file, lines] of [...changedLines.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const scope = scopes.find((candidate) => matchesScope(file, candidate))
    if (!scope) continue

    const fileCoverage = coverageByFile.get(file)
    if (!fileCoverage) {
      const lineCount = lines.size
      total += lineCount
      files.push({
        file,
        suiteId: scope.id,
        covered: 0,
        total: lineCount,
        pct: 0,
        reason: 'no coverage data for changed source file',
      })
      continue
    }

    const executableChangedLines = [...lines].filter((line) => fileCoverage.executableLines.has(line))
    if (executableChangedLines.length === 0) continue
    const fileCovered = executableChangedLines.filter((line) => fileCoverage.coveredLines.has(line)).length
    total += executableChangedLines.length
    covered += fileCovered
    files.push({
      file,
      suiteId: fileCoverage.suiteId,
      covered: fileCovered,
      total: executableChangedLines.length,
      pct: pct(fileCovered, executableChangedLines.length),
    })
  }

  const coverage = pct(covered, total)
  const failures = total > 0 && coverage + Number.EPSILON < minimumPercent
    ? [`changed-lines: coverage ${coverage}% is below minimum ${minimumPercent}%`]
    : []

  return {
    minimumPercent,
    covered,
    total,
    pct: coverage,
    files,
    failures,
  }
}

function loadBaseline(path: string, rootDir = ROOT_DIR, baselineRef?: string): BaselineFile | null {
  if (baselineRef) {
    const raw = readGitFile(rootDir, baselineRef, path)
    return raw ? JSON.parse(raw) as BaselineFile : null
  }

  const resolved = path.startsWith('/') ? path : join(rootDir, path)
  if (!existsSync(resolved)) return null
  return JSON.parse(readFileSync(resolved, 'utf8')) as BaselineFile
}

export function evaluateThresholds(
  suites: SuiteCoverage[],
  thresholds: CoverageThresholds,
  rootDir = ROOT_DIR,
  baselineRef?: string,
) {
  const failures: string[] = []
  const baseline = thresholds.ratchet?.baselinePath
    ? loadBaseline(thresholds.ratchet.baselinePath, rootDir, baselineRef)
    : null
  const allowedDrop = thresholds.ratchet?.allowedDropPercent ?? 0

  for (const suite of suites) {
    if (!suite.summary) {
      failures.push(`${suite.id}: ${suite.error ?? 'coverage suite failed (no summary)'}`)
      continue
    }

    const minimums = thresholds.minimums[suite.id] ?? {}
    for (const [metricName, minimum] of Object.entries(minimums)) {
      const actual = suite.summary[metricName as keyof CoverageSummary].pct
      if (actual + Number.EPSILON < minimum) {
        failures.push(`${suite.id}: ${metricName} coverage ${actual}% is below minimum ${minimum}%`)
      }
    }

    const baselineSummary = baseline?.suites[suite.id]
    if (!baselineSummary) continue
    for (const metricName of ['lines', 'functions', 'branches', 'statements'] as const) {
      const actual = suite.summary[metricName].pct
      const expected = baselineSummary[metricName].pct - allowedDrop
      if (actual + Number.EPSILON < expected) {
        failures.push(`${suite.id}: ${metricName} coverage ${actual}% dropped below baseline ${baselineSummary[metricName].pct}%`)
      }
    }
  }

  return failures
}

function evaluateTargetGaps(suites: SuiteCoverage[], thresholds: CoverageThresholds) {
  const gaps: string[] = []
  for (const suite of suites) {
    if (suite.status !== 'passed' || !suite.summary) continue
    const targets = thresholds.targets?.[suite.id] ?? {}
    for (const [metricName, target] of Object.entries(targets)) {
      const actual = suite.summary[metricName as keyof CoverageSummary].pct
      if (actual + Number.EPSILON < target) {
        gaps.push(`${suite.id}: ${metricName} coverage ${actual}% is below target ${target}%`)
      }
    }
  }
  return gaps
}

function renderReport(report: CoverageReport) {
  const lines = [
    '# Coverage Report',
    '',
    `- Run: ${report.runId}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Output: ${report.outputDir}`,
    ...(report.baselineRef ? [`- Baseline ref: ${report.baselineRef}`] : []),
    '',
    '| Suite | Status | Lines | Functions | Branches | Statements |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  ]

  for (const suite of report.suites) {
    const summary = suite.summary
    lines.push(`| ${[
      suite.title,
      suite.status,
      summary ? `${summary.lines.pct}%` : '-',
      summary ? `${summary.functions.pct}%` : '-',
      summary ? `${summary.branches.pct}%` : '-',
      summary ? `${summary.statements.pct}%` : '-',
    ].join(' | ')} |`)
  }

  lines.push('', '## Changed Lines', '')
  if (!report.changedLines) {
    lines.push('- not evaluated')
  } else if (report.changedLines.total === 0) {
    lines.push(`- No changed executable production lines matched the coverage scopes. Minimum: ${report.changedLines.minimumPercent}%`)
  } else {
    lines.push(
      `- Coverage: ${report.changedLines.pct}% (${report.changedLines.covered}/${report.changedLines.total})`,
      `- Minimum: ${report.changedLines.minimumPercent}%`,
      '',
      '| File | Suite | Lines | Reason |',
      '| --- | --- | ---: | --- |',
    )
    for (const file of report.changedLines.files) {
      lines.push(`| ${file.file} | ${file.suiteId} | ${file.pct}% (${file.covered}/${file.total}) | ${file.reason ?? '-'} |`)
    }
  }

  lines.push('', '## Target Gaps', '')
  if (report.targetGaps.length === 0) {
    lines.push('- none')
  } else {
    for (const gap of report.targetGaps) {
      lines.push(`- ${gap}`)
    }
  }

  lines.push('', '## Failures', '')
  if (report.failures.length === 0) {
    lines.push('- none')
  } else {
    for (const failure of report.failures) {
      lines.push(`- ${failure}`)
    }
  }

  return lines.join('\n') + '\n'
}

export async function runCoverageGate(options: {
  rootDir?: string
  artifactsDir?: string
  runId?: string
  thresholdsPath?: string
  baselineRef?: string
  changedBaseRef?: string
} = {}) {
  const rootDir = options.rootDir ?? ROOT_DIR
  const runId = options.runId ?? nowId()
  const outputDir = join(options.artifactsDir ?? join(rootDir, 'artifacts', 'coverage'), runId)
  const startedAt = new Date().toISOString()
  const baselineRef = options.baselineRef ?? process.env.COVERAGE_BASE_REF
  mkdirSync(outputDir, { recursive: true })

  const serverFiles = collectServerTestFiles(rootDir)
  const suites: SuiteCoverage[] = []
  const coverageByFile = new Map<string, FileLineCoverage>()

  const rootCommand = ['bun', 'test', '--timeout=20000', '--coverage', '--coverage-reporter=lcov', '--coverage-reporter=text', '--coverage-dir', join(outputDir, 'root-server'), ...serverFiles]
  const rootLogPath = join(outputDir, 'root-server', 'coverage.log')
  mkdirSync(join(outputDir, 'root-server'), { recursive: true })
  const rootResult = await runCommand(rootCommand, rootDir, rootLogPath)
  const rootLcovPath = join(outputDir, 'root-server', 'lcov.info')
  const rootLcov = existsSync(rootLcovPath)
    ? readFileSync(rootLcovPath, 'utf8')
    : ''
  for (const scope of ROOT_COVERAGE_SCOPES) {
    const summary = rootLcov ? parseLcov(rootLcov, { rootDir, scope }) : undefined
    suites.push({
      id: scope.id,
      title: scope.title,
      status: rootResult.exitCode === 0 ? 'passed' : 'failed',
      command: rootCommand,
      durationMs: rootResult.durationMs,
      logPath: rootLogPath,
      ...(summary ? { summary } : {}),
      ...(rootResult.exitCode !== 0 ? { error: `coverage command exited with ${rootResult.exitCode}` } : {}),
    })
    if (rootLcov) {
      for (const [file, coverage] of lcovLineCoverage(rootLcov, scope.id, scope, rootDir)) {
        coverageByFile.set(file, coverage)
      }
    }
  }

  const adapters = await runSuite(
    'adapters',
    'IM adapters',
    ['bun', 'test', '--coverage', '--coverage-reporter=lcov', '--coverage-reporter=text', '--coverage-dir', join(outputDir, 'adapters')],
    join(rootDir, 'adapters'),
    join(outputDir, 'adapters'),
    () => parseLcov(readFileSync(join(outputDir, 'adapters', 'lcov.info'), 'utf8')),
  )
  suites.push(adapters)
  const adaptersLcovPath = join(outputDir, 'adapters', 'lcov.info')
  if (adapters.status === 'passed' && existsSync(adaptersLcovPath)) {
    const adaptersLcov = prefixRelativeLcovSourcePaths(readFileSync(adaptersLcovPath, 'utf8'), 'adapters')
    for (const [file, coverage] of lcovLineCoverage(adaptersLcov, 'adapters', ADAPTERS_SCOPE, rootDir)) {
      coverageByFile.set(file, coverage)
    }
  }

  const desktop = await runSuite(
    'desktop',
    'Desktop React',
    [
      'bun',
      'run',
      'test',
      '--',
      '--run',
      '--coverage',
      '--coverage.reporter=json-summary',
      '--coverage.reporter=lcov',
      '--coverage.reportOnFailure',
      `--coverage.reportsDirectory=${join(outputDir, 'desktop')}`,
      '--testTimeout=20000',
    ],
    join(rootDir, 'desktop'),
    join(outputDir, 'desktop'),
    () => parseVitestSummary(join(outputDir, 'desktop', 'coverage-summary.json')),
  )
  suites.push(desktop)
  const desktopLcovPath = join(outputDir, 'desktop', 'lcov.info')
  if (existsSync(desktopLcovPath)) {
    const desktopLcov = prefixRelativeLcovSourcePaths(readFileSync(desktopLcovPath, 'utf8'), 'desktop')
    for (const [file, coverage] of lcovLineCoverage(desktopLcov, 'desktop', DESKTOP_SCOPE, rootDir)) {
      coverageByFile.set(file, coverage)
    }
  }

  const thresholds = loadThresholds(options.thresholdsPath ?? join(rootDir, 'scripts', 'quality-gate', 'coverage-thresholds.json'))
  const failures = evaluateThresholds(suites, thresholds, rootDir, baselineRef)
  const changedLineMinimum = thresholds.changedLines?.minimumPercent
  const changedLines = typeof changedLineMinimum === 'number'
    ? evaluateChangedLineCoverage(
      collectChangedLines(rootDir, options.changedBaseRef ?? process.env.COVERAGE_BASE_REF),
      coverageByFile,
      CHANGED_LINE_SCOPES,
      changedLineMinimum,
    )
    : undefined
  if (changedLines) {
    failures.push(...changedLines.failures)
  }
  const targetGaps = evaluateTargetGaps(suites, thresholds)
  const report: CoverageReport = {
    schemaVersion: 1,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    outputDir,
    ...(baselineRef ? { baselineRef } : {}),
    suites,
    ...(changedLines ? { changedLines } : {}),
    targetGaps,
    failures,
  }

  writeFileSync(join(outputDir, 'coverage-report.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(join(outputDir, 'coverage-report.md'), renderReport(report))
  return report
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  const report = await runCoverageGate({
    artifactsDir: typeof args.get('--artifacts-dir') === 'string' ? String(args.get('--artifacts-dir')) : undefined,
    runId: typeof args.get('--run-id') === 'string' ? String(args.get('--run-id')) : undefined,
    thresholdsPath: typeof args.get('--thresholds') === 'string' ? String(args.get('--thresholds')) : undefined,
    baselineRef: typeof args.get('--baseline-ref') === 'string' ? String(args.get('--baseline-ref')) : undefined,
    changedBaseRef: typeof args.get('--changed-base') === 'string' ? String(args.get('--changed-base')) : undefined,
  })
  console.log(`Coverage report: ${report.outputDir}/coverage-report.md`)
  console.log(`Summary: passed=${report.suites.filter((suite) => suite.status === 'passed').length} failed=${report.failures.length}`)
  if (report.failures.length > 0) {
    process.exit(1)
  }
}
