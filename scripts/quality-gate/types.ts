export type QualityGateMode = 'pr' | 'baseline' | 'release'

export type LaneKind = 'command' | 'baseline-case'

export type LaneDefinition = {
  id: string
  title: string
  description: string
  kind: LaneKind
  command?: string[]
  baselineCaseId?: string
  baselineTarget?: BaselineTarget
  requiredForModes: QualityGateMode[]
  live?: boolean
}

export type BaselineCase = {
  id: string
  title: string
  description: string
  fixture: string
  prompt: string
  mode: 'ui' | 'websocket'
  requiredCapabilities: Array<'model' | 'file-edit' | 'shell' | 'permission' | 'browser'>
  timeoutMs: number
  verify: {
    commands: string[][]
    requiredFiles?: string[]
    expectedFiles?: string[]
    forbiddenFiles?: string[]
    transcriptAssertions?: string[]
  }
}

export type BaselineTarget = {
  providerId: string | null
  modelId: string
  label: string
}

export type LaneStatus = 'passed' | 'failed' | 'skipped'

export type LaneResult = {
  id: string
  title: string
  status: LaneStatus
  command?: string[]
  durationMs: number
  exitCode?: number
  skipReason?: string
  error?: string
  artifactDir?: string
}

export type QualityGateOptions = {
  mode: QualityGateMode
  dryRun: boolean
  allowLive: boolean
  baselineTargets: BaselineTarget[]
  rootDir: string
  artifactsDir?: string
  runOutputDir?: string
  runId?: string
}

export type QualityGateReport = {
  schemaVersion: 1
  runId: string
  mode: QualityGateMode
  dryRun: boolean
  allowLive: boolean
  startedAt: string
  finishedAt: string
  rootDir: string
  git: {
    sha: string | null
    dirty: boolean
  }
  results: LaneResult[]
  summary: {
    passed: number
    failed: number
    skipped: number
  }
}
