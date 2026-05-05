import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lanesForMode } from './modes'
import { renderMarkdownReport } from './reporter'
import { runQualityGate, runQualityGateLanes } from './runner'
import type { LaneDefinition, QualityGateReport } from './types'

describe('quality gate modes', () => {
  test('pr mode includes existing path-aware PR checks', () => {
    const lanes = lanesForMode('pr').map((lane) => lane.id)
    expect(lanes).toContain('impact-report')
    expect(lanes).toContain('pr-checks')
    expect(lanes.some((lane) => lane.startsWith('baseline:'))).toBe(false)
  })

  test('baseline mode includes live baseline cases but not native checks', () => {
    const lanes = lanesForMode('baseline').map((lane) => lane.id)
    expect(lanes).toContain('baseline-catalog')
    expect(lanes).toContain('baseline:failing-unit:current-runtime')
    expect(lanes).toContain('baseline:multi-file-api:current-runtime')
    expect(lanes).not.toContain('native-checks')
  })

  test('release mode composes PR and baseline lanes', () => {
    const lanes = lanesForMode('release').map((lane) => lane.id)
    expect(lanes).toContain('pr-checks')
    expect(lanes).toContain('baseline:failing-unit:current-runtime')
    expect(lanes).not.toContain('native-checks')
  })

  test('baseline mode expands cases across explicit provider/model targets', () => {
    const lanes = lanesForMode('baseline', [
      { providerId: 'provider-a', modelId: 'model-a', label: 'provider-a-model-a' },
      { providerId: 'provider-b', modelId: 'model-b', label: 'provider-b-model-b' },
    ]).map((lane) => lane.id)

    expect(lanes).toContain('baseline:failing-unit:provider-a-model-a')
    expect(lanes).toContain('baseline:failing-unit:provider-b-model-b')
    expect(lanes).toContain('baseline:multi-file-api:provider-a-model-a')
    expect(lanes).toContain('baseline:multi-file-api:provider-b-model-b')
  })
})

describe('runQualityGate', () => {
  test('writes dry-run reports without executing expensive commands', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'quality-gate-test-'))
    try {
      const { report, outputDir } = await runQualityGate({
        mode: 'baseline',
        dryRun: true,
        allowLive: false,
        baselineTargets: [],
        rootDir: process.cwd(),
        artifactsDir,
        runId: 'dry-run-test',
      })

      expect(report.mode).toBe('baseline')
      expect(report.summary.failed).toBe(0)
      expect(report.summary.skipped).toBeGreaterThan(0)
      expect(readFileSync(join(outputDir, 'report.json'), 'utf8')).toContain('"mode": "baseline"')
      expect(readFileSync(join(outputDir, 'report.md'), 'utf8')).toContain('# Quality Gate Report')
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true })
    }
  })

  test('continues through later lanes after a failure so reports show full impact', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'quality-gate-test-'))
    const lanes: LaneDefinition[] = [
      {
        id: 'first-lane',
        title: 'First lane',
        description: 'Fails intentionally',
        kind: 'command',
        command: ['false'],
        requiredForModes: ['pr'],
      },
      {
        id: 'second-lane',
        title: 'Second lane',
        description: 'Still runs',
        kind: 'command',
        command: ['true'],
        requiredForModes: ['pr'],
      },
    ]

    try {
      const { report } = await runQualityGateLanes({
        mode: 'pr',
        dryRun: false,
        allowLive: false,
        baselineTargets: [],
        rootDir: process.cwd(),
        artifactsDir,
        runId: 'continue-after-failure-test',
      }, lanes, async (lane) => ({
        id: lane.id,
        title: lane.title,
        status: lane.id === 'first-lane' ? 'failed' : 'passed',
        command: lane.command,
        durationMs: 1,
        exitCode: lane.id === 'first-lane' ? 1 : 0,
      }))

      expect(report.results.map((result) => result.id)).toEqual(['first-lane', 'second-lane'])
      expect(report.summary).toEqual({
        passed: 1,
        failed: 1,
        skipped: 0,
      })
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true })
    }
  })
})

describe('renderMarkdownReport', () => {
  test('renders command, skip reason, and summary', () => {
    const report: QualityGateReport = {
      schemaVersion: 1,
      runId: 'example',
      mode: 'pr',
      dryRun: true,
      allowLive: false,
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:00:01.000Z',
      rootDir: process.cwd(),
      git: {
        sha: 'abc123',
        dirty: true,
      },
      results: [
        {
          id: 'impact-report',
          title: 'Impact report',
          status: 'skipped',
          command: ['bun', 'run', 'check:impact'],
          durationMs: 1,
          skipReason: 'dry run',
        },
      ],
      summary: {
        passed: 0,
        failed: 0,
        skipped: 1,
      },
    }

    const markdown = renderMarkdownReport(report)
    expect(markdown).toContain('Skipped: 1')
    expect(markdown).toContain('`bun run check:impact`')
    expect(markdown).toContain('dry run')
  })
})
