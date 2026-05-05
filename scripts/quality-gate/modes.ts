import { baselineCases } from './baseline/cases'
import type { BaselineTarget, LaneDefinition, QualityGateMode } from './types'

export function lanesForMode(mode: QualityGateMode, baselineTargets: BaselineTarget[] = []): LaneDefinition[] {
  const lanes: LaneDefinition[] = [
    {
      id: 'impact-report',
      title: 'Impact report',
      description: 'Summarize changed areas, required local checks, and risk notes.',
      kind: 'command',
      command: ['bun', 'run', 'check:impact'],
      requiredForModes: ['pr', 'baseline', 'release'],
    },
    {
      id: 'pr-checks',
      title: 'Path-aware PR checks',
      description: 'Run the existing local PR gate with stable path-aware checks.',
      kind: 'command',
      command: ['bun', 'run', 'check:pr'],
      requiredForModes: ['pr', 'release'],
    },
    {
      id: 'baseline-catalog',
      title: 'Baseline case catalog validation',
      description: 'Validate real Coding Agent baseline case definitions and fixture metadata.',
      kind: 'command',
      command: ['bun', 'test', 'scripts/quality-gate/baseline/cases.test.ts'],
      requiredForModes: ['baseline', 'release'],
    },
  ]

  const targets = baselineTargets.length > 0
    ? baselineTargets
    : [{ providerId: null, modelId: 'current', label: 'current-runtime' }]

  for (const testCase of baselineCases) {
    for (const target of targets) {
      const targetSlug = target.label.replace(/[^a-zA-Z0-9._-]+/g, '-')
      lanes.push({
        id: `baseline:${testCase.id}:${targetSlug}`,
        title: `${testCase.title} (${target.label})`,
        description: testCase.description,
        kind: 'baseline-case',
        baselineCaseId: testCase.id,
        baselineTarget: target,
        requiredForModes: ['baseline', 'release'],
        live: true,
      })
    }
  }

  return lanes.filter((lane) => lane.requiredForModes.includes(mode))
}
