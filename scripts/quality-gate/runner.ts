import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { baselineCases } from './baseline/cases'
import { executeBaselineCase } from './baseline/execute'
import { lanesForMode } from './modes'
import { writeReport } from './reporter'
import type { LaneDefinition, LaneResult, QualityGateOptions, QualityGateReport } from './types'

type LaneExecutor = (lane: LaneDefinition, options: QualityGateOptions) => Promise<LaneResult>

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function output(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    return null
  }
  return (stdout || stderr).trim()
}

async function gitInfo(rootDir: string) {
  const sha = await output(['git', 'rev-parse', '--short', 'HEAD'], rootDir)
  const status = await output(['git', 'status', '--short'], rootDir)
  return {
    sha,
    dirty: Boolean(status),
  }
}

async function runCommandLane(lane: LaneDefinition, options: QualityGateOptions): Promise<LaneResult> {
  const started = Date.now()
  const command = lane.command ?? []

  if (options.dryRun) {
    return {
      id: lane.id,
      title: lane.title,
      status: 'skipped',
      command,
      durationMs: Date.now() - started,
      skipReason: 'dry run',
    }
  }

  const proc = Bun.spawn(command, {
    cwd: options.rootDir,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited

  return {
    id: lane.id,
    title: lane.title,
    status: exitCode === 0 ? 'passed' : 'failed',
    command,
    durationMs: Date.now() - started,
    exitCode,
  }
}

async function runBaselineCaseLane(lane: LaneDefinition, options: QualityGateOptions): Promise<LaneResult> {
  const started = Date.now()

  if (!options.allowLive) {
    return {
      id: lane.id,
      title: lane.title,
      status: 'skipped',
      durationMs: Date.now() - started,
      skipReason: 'live baseline cases require --allow-live',
    }
  }

  const caseId = lane.baselineCaseId ?? lane.id.replace(/^baseline:/, '').split(':')[0]
  const testCase = baselineCases.find((candidate) => candidate.id === caseId)
  if (!testCase) {
    return {
      id: lane.id,
      title: lane.title,
      status: 'failed',
      durationMs: Date.now() - started,
      error: `Unknown baseline case: ${caseId}`,
    }
  }

  const artifactRoot = options.runOutputDir ?? join(options.rootDir, 'artifacts', 'quality-runs', options.runId ?? 'current')
  return executeBaselineCase(
    testCase,
    options.rootDir,
    join(artifactRoot, 'cases', lane.id.replace(/[^a-zA-Z0-9._-]+/g, '-')),
    lane.baselineTarget,
  )
}

async function runLane(lane: LaneDefinition, options: QualityGateOptions): Promise<LaneResult> {
  if (lane.kind === 'baseline-case') {
    return runBaselineCaseLane(lane, options)
  }
  return runCommandLane(lane, options)
}

function summarize(results: LaneResult[]) {
  return {
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
  }
}

export async function runQualityGate(options: QualityGateOptions) {
  return runQualityGateLanes(options, lanesForMode(options.mode, options.baselineTargets))
}

export async function runQualityGateLanes(
  options: QualityGateOptions,
  lanes: LaneDefinition[],
  executeLane: LaneExecutor = runLane,
) {
  const runId = options.runId ?? nowId()
  const startedAt = new Date().toISOString()
  const artifactsRoot = options.artifactsDir ?? join(options.rootDir, 'artifacts', 'quality-runs')
  const outputDir = join(artifactsRoot, runId)
  mkdirSync(outputDir, { recursive: true })

  const runOptions = { ...options, runId, runOutputDir: outputDir }
  const results: LaneResult[] = []
  for (const lane of lanes) {
    const result = await executeLane(lane, runOptions)
    results.push(result)
  }

  const report: QualityGateReport = {
    schemaVersion: 1,
    runId,
    mode: options.mode,
    dryRun: options.dryRun,
    allowLive: options.allowLive,
    startedAt,
    finishedAt: new Date().toISOString(),
    rootDir: options.rootDir,
    git: await gitInfo(options.rootDir),
    results,
    summary: summarize(results),
  }

  writeReport(report, outputDir)
  return { report, outputDir }
}
