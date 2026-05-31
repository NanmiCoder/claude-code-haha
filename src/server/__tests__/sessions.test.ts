/**
 * Unit tests for SessionService and Sessions API
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionService, sessionService } from '../services/sessionService.js'
import {
  getRepositoryContext,
  prepareSessionWorkspace,
} from '../services/repositoryLaunchService.js'
import { conversationService } from '../services/conversationService.js'
import { clearCommandsCache } from '../../commands.js'
import { parseJSONL } from '../../utils/json.js'
import { createSessionBranch } from '../../utils/sessionBranching.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { updateSessionSlashCommands } from '../ws/handler.js'

// ============================================================================
// Test helpers
// ============================================================================

let tmpDir: string
let service: SessionService

/** Create a temporary config dir and configure the service to use it. */
async function setupTmpConfigDir(): Promise<string> {
  tmpDir = path.join(os.tmpdir(), `claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  return tmpDir
}

async function cleanupTmpDir(): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
  delete process.env.CLAUDE_CONFIG_DIR
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
}

async function createCleanGitRepo(baseDir: string): Promise<string> {
  const workDir = path.join(
    baseDir,
    `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )

  await fs.mkdir(workDir, { recursive: true })
  git(workDir, 'init')
  git(workDir, 'config', 'user.email', 'sessions-api@example.com')
  git(workDir, 'config', 'user.name', 'Sessions API')
  git(workDir, 'checkout', '-b', 'main')
  await fs.writeFile(path.join(workDir, 'README.md'), 'main\n')
  git(workDir, 'add', 'README.md')
  git(workDir, 'commit', '-m', 'initial')
  git(workDir, 'checkout', '-b', 'feature/rail')
  await fs.writeFile(path.join(workDir, 'feature.txt'), 'feature\n')
  git(workDir, 'add', 'feature.txt')
  git(workDir, 'commit', '-m', 'feature')
  git(workDir, 'checkout', 'main')

  return workDir
}

/** Write a JSONL session file with given entries. */
async function writeSessionFile(
  projectDir: string,
  sessionId: string,
  entries: Record<string, unknown>[]
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

async function writeSubagentTranscriptFile(
  projectDir: string,
  sessionId: string,
  agentId: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir, sessionId, 'subagents')
  await fs.mkdir(dir, { recursive: true })
  const normalizedAgentId = agentId.startsWith('agent-') ? agentId : `agent-${agentId}`
  const filePath = path.join(dir, `${normalizedAgentId}.jsonl`)
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

async function writeSkill(
  rootDir: string,
  skillName: string,
  description: string,
): Promise<void> {
  const skillDir = path.join(rootDir, skillName)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    ['---', `description: ${description}`, '---', '', `# ${skillName}`].join('\n'),
    'utf-8',
  )
}

async function writeLegacySlashCommand(
  commandsDir: string,
  commandName: string,
  description: string,
): Promise<void> {
  await fs.mkdir(commandsDir, { recursive: true })
  await fs.writeFile(
    path.join(commandsDir, `${commandName}.md`),
    ['---', `description: ${description}`, 'argument-hint: <topic>', '---', '', `Run ${commandName}.`].join('\n'),
    'utf-8',
  )
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
}

async function createWorkspaceApiGitRepo(baseDir: string): Promise<string> {
  const workDir = path.join(
    baseDir,
    `workspace-api-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )

  await fs.mkdir(path.join(workDir, 'src'), { recursive: true })
  git(workDir, 'init')
  git(workDir, 'config', 'user.email', 'sessions-api@example.com')
  git(workDir, 'config', 'user.name', 'Sessions API')

  await fs.writeFile(path.join(workDir, 'tracked.txt'), 'before\n')
  await fs.writeFile(path.join(workDir, 'src', 'app.ts'), 'export const answer = 42\n')
  git(workDir, 'add', 'tracked.txt', 'src/app.ts')
  git(workDir, 'commit', '-m', 'initial')

  await fs.writeFile(path.join(workDir, 'tracked.txt'), 'before\nafter\n')

  return workDir
}

async function createCleanGitRepo(baseDir: string): Promise<string> {
  const workDir = path.join(
    baseDir,
    `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )

  await fs.mkdir(workDir, { recursive: true })
  git(workDir, 'init')
  git(workDir, 'config', 'user.email', 'sessions-api@example.com')
  git(workDir, 'config', 'user.name', 'Sessions API')
  git(workDir, 'checkout', '-b', 'main')
  await fs.writeFile(path.join(workDir, 'README.md'), 'main\n')
  git(workDir, 'add', 'README.md')
  git(workDir, 'commit', '-m', 'initial')
  git(workDir, 'checkout', '-b', 'feature/rail')
  await fs.writeFile(path.join(workDir, 'feature.txt'), 'feature\n')
  git(workDir, 'add', 'feature.txt')
  git(workDir, 'commit', '-m', 'feature')
  git(workDir, 'checkout', 'main')

  return workDir
}

// Sample entries matching real CLI format
function makeSnapshotEntry(): Record<string, unknown> {
  return {
    type: 'file-history-snapshot',
    messageId: crypto.randomUUID(),
    snapshot: {
      messageId: crypto.randomUUID(),
      trackedFileBackups: {},
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    isSnapshotUpdate: false,
  }
}

function makeFileHistorySnapshotEntry(
  snapshotMessageId: string,
  trackedFileBackups: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'file-history-snapshot',
    messageId: crypto.randomUUID(),
    snapshot: {
      messageId: snapshotMessageId,
      trackedFileBackups,
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    isSnapshotUpdate: false,
  }
}

function makeUserEntry(content: string, uuid?: string): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid: uuid || crypto.randomUUID(),
    timestamp: '2026-01-01T00:01:00.000Z',
    userType: 'external',
    cwd: '/tmp/test',
    sessionId: 'test-session',
  }
}

function makeAssistantEntry(content: string, parentUuid?: string): Record<string, unknown> {
  return {
    parentUuid: parentUuid || null,
    isSidechain: false,
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      id: `msg_${crypto.randomUUID().slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: content }],
    },
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:02:00.000Z',
  }
}

function makeAssistantToolUseEntry(
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  parentUuid?: string,
): Record<string, unknown> {
  return {
    parentUuid: parentUuid || null,
    isSidechain: false,
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      id: `msg_${crypto.randomUUID().slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      content: toolUses.map((toolUse) => ({
        type: 'tool_use',
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      })),
    },
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:02:00.000Z',
  }
}

function makeToolResultUserEntry(
  toolUseId: string,
  content: string,
  uuid?: string,
  parentUuid?: string,
  sessionId = 'test-session',
): Record<string, unknown> {
  return {
    parentUuid: parentUuid || null,
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
      }],
    },
    uuid: uuid || crypto.randomUUID(),
    timestamp: '2026-01-01T00:02:30.000Z',
    userType: 'external',
    cwd: '/tmp/test',
    sessionId,
  }
}

function makeMetaUserEntry(): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: '<local-command-caveat>internal</local-command-caveat>' },
    isMeta: true,
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:00:30.000Z',
  }
}

function makeSessionMetaEntry(workDir: string): Record<string, unknown> {
  return {
    type: 'session-meta',
    isMeta: true,
    workDir,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
}

function makeWorktreeStateEntry(
  sessionId: string,
  worktreePath: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'worktree-state',
    sessionId,
    worktreeSession: {
      originalCwd: '/tmp/source',
      worktreePath,
      worktreeName: 'desktop-main-12345678',
      worktreeBranch: 'worktree-desktop-main-12345678',
      originalBranch: 'main',
      sessionId,
      ...overrides,
    },
  }
}

function makeContentReplacementEntry(
  sessionId: string,
  replacements: Array<{ kind: 'tool-result'; toolUseId: string; replacement: string }>,
): Record<string, unknown> {
  return {
    type: 'content-replacement',
    sessionId,
    replacements,
  }
}

async function writeFileHistoryBackup(
  sessionId: string,
  backupFileName: string,
  content: string,
): Promise<void> {
  const dir = path.join(tmpDir, 'file-history', sessionId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, backupFileName), content, 'utf-8')
}

type ThreeTurnCheckpointFixture = {
  sessionId: string
  workDir: string
  stepFile: string
  createdFile: string
  firstUserId: string
  secondUserId: string
  thirdUserId: string
}

async function createThreeTurnCheckpointFixture(
  sessionId: string,
): Promise<ThreeTurnCheckpointFixture> {
  const workDir = path.join(tmpDir, `turn-checkpoints-${sessionId}`)
  const stepFile = path.join(workDir, 'src', 'step.js')
  const createdFile = path.join(workDir, 'notes', 'generated.txt')
  const firstUserId = crypto.randomUUID()
  const secondUserId = crypto.randomUUID()
  const thirdUserId = crypto.randomUUID()
  const backupBase = `${sessionId}-step@v1`
  const backupV1 = `${sessionId}-step@v2`
  const backupV2 = `${sessionId}-step@v3`

  await fs.mkdir(path.dirname(stepFile), { recursive: true })
  await fs.mkdir(path.dirname(createdFile), { recursive: true })
  await fs.writeFile(stepFile, "export const STEP = 'v3'\n", 'utf-8')
  await fs.writeFile(createdFile, 'generated third turn\n', 'utf-8')
  await writeFileHistoryBackup(sessionId, backupBase, "export const STEP = 'base'\n")
  await writeFileHistoryBackup(sessionId, backupV1, "export const STEP = 'v1'\n")
  await writeFileHistoryBackup(sessionId, backupV2, "export const STEP = 'v2'\n")

  await writeSessionFile('-tmp-api-turn-checkpoints', sessionId, [
    makeSessionMetaEntry(workDir),
    makeFileHistorySnapshotEntry(firstUserId, {
      'src/step.js': {
        backupFileName: backupBase,
        version: 1,
        backupTime: '2026-01-01T00:00:00.000Z',
      },
    }),
    {
      ...makeUserEntry('make v1', firstUserId),
      cwd: workDir,
      sessionId,
    },
    makeAssistantEntry('DONE v1', firstUserId),
    makeFileHistorySnapshotEntry(secondUserId, {
      'src/step.js': {
        backupFileName: backupV1,
        version: 2,
        backupTime: '2026-01-01T00:00:00.000Z',
      },
    }),
    {
      ...makeUserEntry('make v2', secondUserId),
      cwd: workDir,
      sessionId,
    },
    makeAssistantEntry('DONE v2', secondUserId),
    makeFileHistorySnapshotEntry(thirdUserId, {
      'src/step.js': {
        backupFileName: backupV2,
        version: 3,
        backupTime: '2026-01-01T00:00:00.000Z',
      },
      'notes/generated.txt': {
        backupFileName: null,
        version: 3,
        backupTime: '2026-01-01T00:00:00.000Z',
      },
    }),
    {
      ...makeUserEntry('make v3 and create file', thirdUserId),
      cwd: workDir,
      sessionId,
    },
    makeAssistantEntry('DONE v3', thirdUserId),
  ])

  return {
    sessionId,
    workDir,
    stepFile,
    createdFile,
    firstUserId,
    secondUserId,
    thirdUserId,
  }
}

// ============================================================================
// SessionService tests
// ============================================================================

describe('SessionService', () => {
  beforeEach(async () => {
    await setupTmpConfigDir()
    service = new SessionService()
    clearInstalledPluginsCache()
    clearPluginCache('sessions-api-test-setup')
    resetSettingsCache()
  })

  afterEach(async () => {
    clearCommandsCache()
    clearInstalledPluginsCache()
    clearPluginCache('session-service-test-teardown')
    resetSettingsCache()
    await cleanupTmpDir()
  })

  // --------------------------------------------------------------------------
  // listSessions
  // --------------------------------------------------------------------------

  it('should return empty list when no sessions exist', async () => {
    const result = await service.listSessions()
    expect(result.sessions).toEqual([])
    expect(result.total).toBe(0)
  })

  it('should list sessions from JSONL files', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-testproject', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Hello Claude'),
      makeAssistantEntry('Hi there!'),
    ])

    const result = await service.listSessions()
    expect(result.total).toBe(1)
    expect(result.sessions).toHaveLength(1)

    const session = result.sessions[0]!
    expect(session.id).toBe(sessionId)
    expect(session.title).toBe('Hello Claude')
    expect(session.messageCount).toBe(2) // 1 user + 1 assistant
    expect(session.projectPath).toBe('-tmp-testproject')
    expect(session.projectRoot).toBe('/tmp/test')
  })

  it('should expose the source project root for persisted worktree sessions', async () => {
    const sourceWorkDir = path.join(tmpDir, 'source-repo')
    const worktreePath = path.join(sourceWorkDir, '.claude', 'worktrees', 'desktop-main-12345678')
    await fs.mkdir(worktreePath, { recursive: true })
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile(sanitizePath(worktreePath), sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(worktreePath),
      makeWorktreeStateEntry(sessionId, worktreePath, {
        originalCwd: sourceWorkDir,
      }),
      makeUserEntry('Hello from worktree'),
    ])

    const result = await service.listSessions()

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      id: sessionId,
      projectPath: sanitizePath(worktreePath),
      projectRoot: await fs.realpath(sourceWorkDir),
      workDir: worktreePath,
    })
  })

  it('should paginate results with limit and offset', async () => {
    // Create 3 sessions
    for (let i = 0; i < 3; i++) {
      const id = `0000000${i}-bbbb-cccc-dddd-eeeeeeeeeeee`
      await writeSessionFile('-tmp-test', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Message ${i}`),
      ])
    }

    const page1 = await service.listSessions({ limit: 2, offset: 0 })
    expect(page1.total).toBe(3)
    expect(page1.sessions).toHaveLength(2)

    const page2 = await service.listSessions({ limit: 2, offset: 2 })
    expect(page2.total).toBe(3)
    expect(page2.sessions).toHaveLength(1)
  })

  it('should only scan the requested page when listing many sessions', async () => {
    for (let i = 0; i < 12; i++) {
      const id = `1000000${i.toString(16)}-bbbb-cccc-dddd-eeeeeeeeeeee`
      const filePath = await writeSessionFile('-tmp-many-sessions', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Message ${i}`),
      ])
      const mtime = new Date(Date.now() - i * 1000)
      await fs.utimes(filePath, mtime, mtime)
    }

    const serviceWithSpy = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
    }
    const originalScanSessionListSummary = serviceWithSpy.scanSessionListSummary.bind(service)
    let scanCount = 0
    serviceWithSpy.scanSessionListSummary = async (...args) => {
      scanCount += 1
      return originalScanSessionListSummary(...args)
    }

    const result = await service.listSessions({ limit: 3, offset: 0 })

    expect(result.total).toBe(12)
    expect(result.sessions).toHaveLength(3)
    expect(scanCount).toBe(3)
  })

  it('should reuse cached list metadata for repeated requests', async () => {
    for (let i = 0; i < 5; i++) {
      const id = `2000000${i.toString(16)}-bbbb-cccc-dddd-eeeeeeeeeeee`
      const filePath = await writeSessionFile('-tmp-cached-sessions', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Cached message ${i}`),
      ])
      const mtime = new Date(Date.now() - i * 1000)
      await fs.utimes(filePath, mtime, mtime)
    }

    const serviceWithSpy = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
    }
    const originalScanSessionListSummary = serviceWithSpy.scanSessionListSummary.bind(service)
    let scanCount = 0
    serviceWithSpy.scanSessionListSummary = async (...args) => {
      scanCount += 1
      return originalScanSessionListSummary(...args)
    }

    const first = await service.listSessions({ limit: 3, offset: 0 })
    const second = await service.listSessions({ limit: 3, offset: 0 })

    expect(first.sessions.map((session) => session.id)).toEqual(second.sessions.map((session) => session.id))
    expect(scanCount).toBe(3)
  })

  it('should invalidate cached list metadata after writes', async () => {
    const sessionId = '30000000-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-cache-invalidation', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Original title'),
    ])

    const first = await service.listSessions({ limit: 10, offset: 0 })
    expect(first.sessions[0]!.title).toBe('Original title')

    await service.renameSession(sessionId, 'Renamed title')
    const second = await service.listSessions({ limit: 10, offset: 0 })

    expect(second.sessions[0]!.title).toBe('Renamed title')
  })

  it('should filter sessions by project', async () => {
    const id1 = 'aaaaaaaa-1111-cccc-dddd-eeeeeeeeeeee'
    const id2 = 'aaaaaaaa-2222-cccc-dddd-eeeeeeeeeeee'

    await writeSessionFile('-project-a', id1, [makeSnapshotEntry(), makeUserEntry('In A')])
    await writeSessionFile('-project-b', id2, [makeSnapshotEntry(), makeUserEntry('In B')])

    const resultA = await service.listSessions({ project: '/project/a' })
    expect(resultA.total).toBe(1)
    expect(resultA.sessions[0]!.id).toBe(id1)
  })

  // --------------------------------------------------------------------------
  // getSession
  // --------------------------------------------------------------------------

  it('should return null for non-existent session', async () => {
    const result = await service.getSession('00000000-0000-0000-0000-000000000000')
    expect(result).toBeNull()
  })

  it('should return session detail with messages', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const userUuid = crypto.randomUUID()
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Tell me a joke', userUuid),
      makeAssistantEntry('Why did the chicken cross the road?', userUuid),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail).not.toBeNull()
    expect(detail!.id).toBe(sessionId)
    expect(detail!.title).toBe('Tell me a joke')
    expect(detail!.messages).toHaveLength(2)
    expect(detail!.messages[0]!.type).toBe('user')
    expect(detail!.messages[1]!.type).toBe('assistant')
  })

  it('should skip meta entries in messages', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeMetaUserEntry(),
      makeUserEntry('Real message'),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.messages).toHaveLength(1)
    expect(detail!.messages[0]!.content).toBe('Real message')
  })

  // --------------------------------------------------------------------------
  // getSessionMessages
  // --------------------------------------------------------------------------

  it('should throw for non-existent session messages', async () => {
    expect(
      service.getSessionMessages('00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow('Session not found')
  })

  it('should return messages only', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Hello'),
      makeAssistantEntry('World'),
    ])

    const messages = await service.getSessionMessages(sessionId)
    expect(messages).toHaveLength(2)
  })

  it('preserves structured toolUseResult metadata for AskUserQuestion answers', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'ask-1',
              content: 'User has answered your questions: "Pick one?"="A". You can now continue with the user\'s answers in mind.',
            },
          ],
        },
        toolUseResult: {
          questions: [{ question: 'Pick one?', options: [{ label: 'A' }] }],
          answers: { 'Pick one?': 'A' },
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      type: 'tool_result',
      toolUseResult: {
        answers: { 'Pick one?': 'A' },
      },
    })
  })

  it('should append subagent tool calls under their parent agent tool result', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-project'
    const agentId = 'abc123'

    await writeSessionFile(projectDir, sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Dispatch an agent'),
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'Agent:0',
              name: 'Agent',
              input: { description: 'Inspect alpha' },
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'Agent:0',
              content: [
                {
                  type: 'text',
                  text: `alpha summary\nagentId: ${agentId} (use SendMessage with to: '${agentId}' to continue this agent)\n<usage>total_tokens: 10\ntool_uses: 2\nduration_ms: 30</usage>`,
                },
              ],
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'Read:0',
              name: 'Read',
              input: { file_path: '/tmp/alpha.txt' },
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:04.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'Read:0',
              content: 'alpha body',
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:05.000Z',
      },
    ])

    const messages = await service.getSessionMessages(sessionId)
    const childToolUse = messages.find(
      (message) => message.type === 'tool_use' && message.parentToolUseId === 'Agent:0',
    )
    const childToolResult = messages.find(
      (message) => message.type === 'tool_result' && message.parentToolUseId === 'Agent:0',
    )

    expect(childToolUse?.content).toEqual([
      {
        type: 'tool_use',
        id: 'Agent:0/abc123/Read:0',
        name: 'Read',
        input: { file_path: '/tmp/alpha.txt' },
      },
    ])
    expect(childToolResult?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'Agent:0/abc123/Read:0',
        content: 'alpha body',
      },
    ])
  })

  it('should hide synthetic interruption, no-response, and command breadcrumb transcript entries', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('正常用户消息', crypto.randomUUID()),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'No response requested.' }],
          model: '<synthetic>',
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:03.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>',
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:04.000Z',
      },
      makeAssistantEntry('正常助手消息', crypto.randomUUID()),
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ type: 'user', content: '正常用户消息' })
    expect(messages[1]).toMatchObject({
      type: 'assistant',
      content: [{ type: 'text', text: '正常助手消息' }],
    })
  })

  it('should keep /goal local command transcript entries for desktop history restore', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        parentUuid: null,
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship persisted goal</command-args>',
        level: 'info',
        timestamp: '2026-01-01T00:00:01.000Z',
        uuid: 'goal-command',
      },
      {
        parentUuid: 'goal-command',
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout>Goal set: ship persisted goal</local-command-stdout>',
        level: 'info',
        timestamp: '2026-01-01T00:00:02.000Z',
        uuid: 'goal-output',
      },
      makeAssistantEntry('正常助手消息', crypto.randomUUID()),
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages).toMatchObject([
      {
        id: 'goal-command',
        type: 'system',
        content: expect.stringContaining('<command-name>/goal</command-name>'),
      },
      {
        id: 'goal-output',
        type: 'system',
        content: expect.stringContaining('Goal set: ship persisted goal'),
      },
      {
        type: 'assistant',
      },
    ])
  })

  it('should hide task-notification turns and their automatic responses from history', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const taskNotificationId = crypto.randomUUID()
    const taskAssistantId = crypto.randomUUID()
    const taskToolUseMessageId = crypto.randomUUID()
    const taskToolResultId = crypto.randomUUID()
    const taskAfterToolId = crypto.randomUUID()
    const realFollowUpId = crypto.randomUUID()
    const realAssistantId = crypto.randomUUID()

    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('创建一个项目', firstUserId),
        parentUuid: null,
      },
      {
        ...makeAssistantEntry('项目已经创建', firstUserId),
        uuid: firstAssistantId,
      },
      {
        ...makeUserEntry(
          '<task-notification>\n<task-id>bg-1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>',
          taskNotificationId,
        ),
        parentUuid: firstAssistantId,
      },
      {
        ...makeAssistantEntry('旧后台任务通知，无需处理', taskNotificationId),
        uuid: taskAssistantId,
      },
      {
        ...makeAssistantToolUseEntry([{
          id: 'toolu_restart',
          name: 'Bash',
          input: { command: 'npm run dev' },
        }], taskAssistantId),
        uuid: taskToolUseMessageId,
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_restart',
            content: 'server restarted',
          }],
        },
        uuid: taskToolResultId,
        parentUuid: taskToolUseMessageId,
        timestamp: '2026-01-01T00:03:00.000Z',
      },
      {
        ...makeAssistantEntry('后台任务触发的工具调用完成', taskToolResultId),
        uuid: taskAfterToolId,
      },
      {
        ...makeUserEntry('继续真实问题', realFollowUpId),
        parentUuid: taskAfterToolId,
      },
      {
        ...makeAssistantEntry('真实回答', realFollowUpId),
        uuid: realAssistantId,
      },
    ])

    const messages = await service.getSessionMessages(sessionId)
    const taskNotifications = await service.getSessionTaskNotifications(sessionId)

    expect(messages.map((message) => message.id)).toEqual([
      firstUserId,
      firstAssistantId,
      realFollowUpId,
      realAssistantId,
    ])
    expect(JSON.stringify(messages)).not.toContain('<task-notification>')
    expect(JSON.stringify(messages)).not.toContain('旧后台任务通知')
    expect(JSON.stringify(messages)).not.toContain('server restarted')
    expect(JSON.stringify(messages)).not.toContain('后台任务触发的工具调用完成')
    expect(taskNotifications).toEqual([
      {
        taskId: 'bg-1',
        toolUseId: 'toolu_bg',
        status: 'completed',
        summary: 'Background command completed',
        timestamp: '2026-01-01T00:01:00.000Z',
      },
    ])
  })

  it('should reconstruct parent agent tool linkage from parentUuid chains', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const userUuid = crypto.randomUUID()
    const agentAssistantUuid = crypto.randomUUID()
    const childAssistantUuid = crypto.randomUUID()

    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Inspect the codebase', userUuid),
      {
        parentUuid: userUuid,
        isSidechain: false,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Agent',
              id: 'agent-tool-1',
              input: { description: 'Inspect src/components' },
            },
          ],
        },
        uuid: agentAssistantUuid,
        timestamp: '2026-01-01T00:02:00.000Z',
      },
      {
        parentUuid: agentAssistantUuid,
        isSidechain: true,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              id: 'read-tool-1',
              input: { file_path: 'src/components/App.tsx' },
            },
          ],
        },
        uuid: childAssistantUuid,
        timestamp: '2026-01-01T00:02:30.000Z',
      },
      {
        parentUuid: childAssistantUuid,
        isSidechain: true,
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read-tool-1',
              content: 'ok',
              is_error: false,
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:03:00.000Z',
        userType: 'external',
        cwd: '/tmp/test',
        sessionId: 'test-session',
      },
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages[1]).toMatchObject({
      type: 'tool_use',
      parentToolUseId: undefined,
    })
    expect(messages[2]).toMatchObject({
      type: 'tool_use',
      parentToolUseId: 'agent-tool-1',
    })
    expect(messages[3]).toMatchObject({
      type: 'tool_result',
      parentToolUseId: 'agent-tool-1',
    })
  })

  it('should recover workDir from session-meta entries', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/from-meta'),
      makeUserEntry('Hello'),
    ])

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/from-meta')
  })

  it('should recover workDir from the latest session-meta entry', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/old-worktree'),
      makeUserEntry('Hello'),
      makeSessionMetaEntry('/tmp/latest-worktree'),
    ])

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/latest-worktree')
  })

  it('should prefer the newest duplicate session file when worktree metadata moves', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const sourceFile = await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/project'),
    ])
    const worktreeFile = await writeSessionFile('-tmp-project--claude-worktrees-desktop-main-12345678', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/project/.claude/worktrees/desktop-main-12345678'),
    ])

    const oldTime = new Date('2026-01-01T00:00:00.000Z')
    const newTime = new Date('2026-01-01T00:00:01.000Z')
    await fs.utimes(sourceFile, oldTime, oldTime)
    await fs.utimes(worktreeFile, newTime, newTime)

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/project/.claude/worktrees/desktop-main-12345678')
  })

  it('should recover CLI worktree state from transcript metadata', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project--claude-worktrees-desktop-main-12345678', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/project/.claude/worktrees/desktop-main-12345678'),
      makeWorktreeStateEntry(sessionId, '/tmp/project/.claude/worktrees/desktop-main-12345678', {
        originalCwd: '/tmp/project',
      }),
      makeUserEntry('Hello from CLI worktree'),
    ])

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo?.worktreeSession).toMatchObject({
      originalCwd: '/tmp/project',
      worktreePath: '/tmp/project/.claude/worktrees/desktop-main-12345678',
      worktreeName: 'desktop-main-12345678',
      worktreeBranch: 'worktree-desktop-main-12345678',
      originalBranch: 'main',
    })
  })

  it('should preserve repository metadata when replacing placeholder transcripts', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId, workDir: sessionWorkDir } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: true },
    )

    await service.clearSessionTranscript(sessionId, sessionWorkDir)
    const launchInfo = await service.getSessionLaunchInfo(sessionId)

    expect(launchInfo?.workDir).toBe(sessionWorkDir)
    expect(launchInfo?.repository).toMatchObject({
      requestedWorkDir: await fs.realpath(workDir),
      worktree: true,
      worktreePath: expect.stringContaining(path.join('.claude', 'worktrees', 'desktop-feature-rail-')),
    })
  })

  it('should persist session permission mode in launch metadata', async () => {
    const workDir = path.join(tmpDir, 'permission-workdir')
    await fs.mkdir(workDir, { recursive: true })
    const { sessionId } = await (service.createSession as unknown as (
      workDir?: string,
      repositoryOptions?: unknown,
      permissionMode?: string,
    ) => Promise<{ sessionId: string; workDir: string }>)(workDir, undefined, 'acceptEdits')

    let launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo?.permissionMode).toBe('acceptEdits')

    await (service.appendSessionMetadata as unknown as (
      sessionId: string,
      metadata: { workDir: string; permissionMode?: string },
    ) => Promise<void>)(sessionId, {
      workDir,
      permissionMode: 'plan',
    })

    launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo?.permissionMode).toBe('plan')
  })

  it('should remove stale placeholder files after native CLI worktree startup', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const sourceFile = await writeSessionFile('-tmp-source', sessionId, [
      makeSnapshotEntry(),
      { type: 'session-meta', isMeta: true, workDir: '/tmp/source', timestamp: '2026-01-01T00:00:00.000Z' },
      { type: 'session-meta', isMeta: true, workDir: '/tmp/source/.claude/worktrees/desktop-agent', timestamp: '2026-01-01T00:00:02.000Z' },
    ])
    const worktreeFile = await writeSessionFile('-tmp-source--claude-worktrees-desktop-agent', sessionId, [
      makeSnapshotEntry(),
      { type: 'session-meta', isMeta: true, workDir: '/tmp/source/.claude/worktrees/desktop-agent', timestamp: '2026-01-01T00:00:01.000Z' },
      makeUserEntry('Hello from worktree'),
    ])

    const removed = await service.deletePlaceholderSessionFiles(
      sessionId,
      '/tmp/source/.claude/worktrees/desktop-agent',
    )

    expect(removed).toBe(1)
    await expect(fs.access(sourceFile)).rejects.toThrow()
    await expect(fs.access(worktreeFile)).resolves.toBeNull()
  })

  it('should move repository metadata to the CLI worktree transcript before deleting placeholders', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId } = await service.createSession(
      workDir,
      { branch: 'main', worktree: true },
    )
    const initialLaunchInfo = await service.getSessionLaunchInfo(sessionId)
    const worktreePath = initialLaunchInfo?.repository?.worktreePath
    expect(worktreePath).toBeTruthy()

    const worktreeFile = await writeSessionFile(sanitizePath(worktreePath!), sessionId, [
      makeSnapshotEntry(),
      {
        type: 'system',
        subtype: 'init',
        cwd: worktreePath,
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      makeUserEntry('Hello from worktree'),
    ])

    await service.appendSessionMetadata(sessionId, {
      workDir: worktreePath!,
    })
    const removed = await service.deletePlaceholderSessionFiles(sessionId, worktreePath!)
    const launchInfo = await service.getSessionLaunchInfo(sessionId)

    expect(removed).toBe(1)
    await expect(fs.access(worktreeFile)).resolves.toBeNull()
    expect(launchInfo?.workDir).toBe(worktreePath)
    expect(launchInfo?.repository).toMatchObject({
      requestedWorkDir: await fs.realpath(workDir),
      branch: 'main',
      worktree: true,
      worktreePath,
      worktreeSlug: initialLaunchInfo?.repository?.worktreeSlug,
    })
  })

  it('should recover workDir from transcript cwd when session-meta is missing', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('Hello'),
        cwd: '/tmp/from-cwd',
      },
    ])

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/from-cwd')
  })

  // --------------------------------------------------------------------------
  // createSession
  // --------------------------------------------------------------------------

  it('should create a new session file', async () => {
    const workDir = path.join(tmpDir, 'workspace', 'my-project')
    await fs.mkdir(workDir, { recursive: true })
    const { sessionId } = await service.createSession(workDir)
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )

    // Verify the file was created
    const canonicalWorkDir = await fs.realpath(workDir)
    const sanitized = sanitizePath(canonicalWorkDir)
    const filePath = path.join(tmpDir, 'projects', sanitized, `${sessionId}.jsonl`)
    const stat = await fs.stat(filePath)
    expect(stat.isFile()).toBe(true)

    // Verify the file starts with the initial snapshot entry
    const content = await fs.readFile(filePath, 'utf-8')
    const entry = JSON.parse(content.trim().split('\n')[0]!)
    expect(entry.type).toBe('file-history-snapshot')
  })

  it('should defer isolated worktree creation until CLI startup', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId, workDir: sessionWorkDir } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: true },
    )

    expect(sessionWorkDir).toBe(await fs.realpath(workDir))
    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    expect(git(workDir, 'status', '--porcelain')).toBe('')

    const sanitized = sanitizePath(await fs.realpath(workDir))
    const filePath = path.join(tmpDir, 'projects', sanitized, `${sessionId}.jsonl`)
    const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n')
    const metadata = JSON.parse(lines[1]!)
    const plannedWorktreePath = metadata.repository.worktreePath as string
    expect(metadata.workDir).toBe(await fs.realpath(workDir))
    expect(metadata.repository).toMatchObject({
      requestedWorkDir: await fs.realpath(workDir),
      branch: 'feature/rail',
      worktree: true,
      baseRef: 'feature/rail',
      worktreePath: expect.stringContaining(path.join('.claude', 'worktrees', 'desktop-feature-rail-')),
      worktreeBranch: expect.stringContaining('worktree-desktop-feature-rail-'),
      worktreeSlug: expect.stringContaining('desktop-feature-rail-'),
    })
    await expect(fs.access(plannedWorktreePath)).rejects.toThrow()

    const context = await getRepositoryContext(workDir)
    expect(context.state).toBe('ok')
    expect(context.branches.map((branch) => branch.name)).not.toContain(
      path.basename(plannedWorktreePath).replace(/^desktop-/, 'worktree-desktop-'),
    )
    expect(context.branches.some((branch) => branch.name.startsWith('worktree-desktop-'))).toBe(false)
  })

  it('should defer direct branch switching until CLI startup when worktree isolation is disabled', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId, workDir: sessionWorkDir } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: false },
    )

    expect(sessionWorkDir).toBe(await fs.realpath(workDir))
    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')

    const sanitized = sanitizePath(await fs.realpath(workDir))
    const filePath = path.join(tmpDir, 'projects', sanitized, `${sessionId}.jsonl`)
    const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n')
    const metadata = JSON.parse(lines[1]!)
    expect(metadata.workDir).toBe(await fs.realpath(workDir))
    expect(metadata.repository).toMatchObject({
      requestedWorkDir: await fs.realpath(workDir),
      branch: 'feature/rail',
      worktree: false,
      baseRef: 'feature/rail',
    })
  })

  it('should not list hidden desktop worktree branches', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const existingWorktree = path.join(tmpDir, `desktop-hidden-${Date.now()}`)
    git(workDir, 'worktree', 'add', '-b', 'worktree-desktop-hidden', existingWorktree, 'feature/rail')

    expect(git(existingWorktree, 'branch', '--show-current')).toBe('worktree-desktop-hidden\n')

    const context = await getRepositoryContext(existingWorktree)
    expect(context.state).toBe('ok')
    expect(context.currentBranch).toBe('worktree-desktop-hidden')
    expect(context.branches.some((branch) => branch.name === context.currentBranch)).toBe(false)
    expect(context.branches.some((branch) => branch.name.startsWith('worktree-desktop-'))).toBe(false)
  })

  it('should keep stale worktree records when their paths cannot be resolved', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const staleWorktreeName = `stale-worktree-${Date.now()}`
    const staleWorktree = path.join(tmpDir, staleWorktreeName)
    git(workDir, 'worktree', 'add', '-b', 'stale-worktree', staleWorktree, 'feature/rail')
    await fs.rm(staleWorktree, { recursive: true, force: true })

    const context = await getRepositoryContext(workDir)
    const expectedPath = path.join(await fs.realpath(tmpDir), staleWorktreeName).normalize('NFC')
    expect(context.state).toBe('ok')
    expect(context.worktrees.some((worktree) => (
      worktree.path === expectedPath && worktree.branch === 'stale-worktree' && !worktree.current
    ))).toBe(true)
  })

  it('should let git carry compatible dirty changes during direct branch launch', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    await fs.writeFile(path.join(workDir, 'README.md'), 'main\nlocal-pricing-edit\n')

    const { sessionId } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: false },
    )

    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    expect(await fs.readFile(path.join(workDir, 'README.md'), 'utf-8'))
      .toContain('local-pricing-edit')
    const prepared = await prepareSessionWorkspace(
      workDir,
      { branch: 'feature/rail', worktree: false },
      sessionId,
    )

    expect(prepared.workDir).toBe(await fs.realpath(workDir))
    expect(git(workDir, 'branch', '--show-current')).toBe('feature/rail\n')
    expect(await fs.readFile(path.join(workDir, 'README.md'), 'utf-8'))
      .toContain('local-pricing-edit')
  })

  it('should plan isolated worktrees from dirty source checkouts without switching branches', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    await fs.writeFile(path.join(workDir, 'README.md'), 'main\nlocal-pricing-edit\n')

    const { sessionId } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: true },
    )
    const launchInfo = await service.getSessionLaunchInfo(sessionId)

    expect(launchInfo?.repository).toMatchObject({
      branch: 'feature/rail',
      worktree: true,
      baseRef: 'feature/rail',
    })
    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    expect(await fs.readFile(path.join(workDir, 'README.md'), 'utf-8'))
      .toContain('local-pricing-edit')
  })

  it('should defer checked-out direct branch launch validation until CLI startup', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const existingWorktree = path.join(tmpDir, `existing-feature-rail-${Date.now()}`)
    git(workDir, 'worktree', 'add', existingWorktree, 'feature/rail')

    const { sessionId } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: false },
    )

    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    await expect(prepareSessionWorkspace(
      workDir,
      { branch: 'feature/rail', worktree: false },
      sessionId,
    )).rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_CHECKED_OUT' })
  })

  it('should reject branch launch outside Git repositories with a stable error code', async () => {
    const workDir = path.join(tmpDir, `not-git-${Date.now()}`)
    await fs.mkdir(workDir, { recursive: true })

    await expect(service.createSession(
      workDir,
      { branch: 'main', worktree: false },
    )).rejects.toMatchObject({ code: 'REPOSITORY_NOT_GIT' })
  })

  it('should reject missing selected branches with a stable error code', async () => {
    const workDir = await createCleanGitRepo(tmpDir)

    await expect(service.createSession(
      workDir,
      { branch: 'missing/branch', worktree: true },
    )).rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_NOT_FOUND' })
  })

  it('should create a Windows-safe project directory name', async () => {
    if (process.platform !== 'win32') return

    const workDir = process.cwd()
    const { sessionId } = await service.createSession(workDir)
    const sanitized = sanitizePath(workDir)
    const projectDir = path.join(tmpDir, 'projects', sanitized)

    expect(sanitized.includes(':')).toBe(false)
    const stat = await fs.stat(path.join(projectDir, `${sessionId}.jsonl`))
    expect(stat.isFile()).toBe(true)
  })

  it('should default to the user home directory when workDir is missing', async () => {
    const { sessionId } = await service.createSession('')
    const filePath = path.join(
      tmpDir,
      'projects',
      sanitizePath(os.homedir()),
      `${sessionId}.jsonl`,
    )

    const stat = await fs.stat(filePath)
    expect(stat.isFile()).toBe(true)
  })

  it('should throw when workDir does not exist', async () => {
    expect(service.createSession('/tmp/definitely-missing-claude-code-haha')).rejects.toThrow(
      'Working directory does not exist'
    )
  })

  // --------------------------------------------------------------------------
  // deleteSession
  // --------------------------------------------------------------------------

  it('should delete an existing session', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const filePath = await writeSessionFile('-tmp-project', sessionId, [makeSnapshotEntry()])

    await service.deleteSession(sessionId)

    // File should no longer exist
    expect(fs.access(filePath)).rejects.toThrow()
  })

  it('should throw when deleting non-existent session', async () => {
    expect(
      service.deleteSession('00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow('Session not found')
  })

  // --------------------------------------------------------------------------
  // renameSession
  // --------------------------------------------------------------------------

  it('should rename a session by appending custom-title entry', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const filePath = await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Original message'),
    ])

    await service.renameSession(sessionId, 'My Custom Title')

    // Read the file and check the last entry
    const content = await fs.readFile(filePath, 'utf-8')
    const lines = content.trim().split('\n')
    const lastEntry = JSON.parse(lines[lines.length - 1]!)
    expect(lastEntry.type).toBe('custom-title')
    expect(lastEntry.customTitle).toBe('My Custom Title')

    // Verify the title is now returned in list
    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('My Custom Title')
  })

  it('should throw when renaming non-existent session', async () => {
    expect(
      service.renameSession('00000000-0000-0000-0000-000000000000', 'Title')
    ).rejects.toThrow('Session not found')
  })

  // --------------------------------------------------------------------------
  // Title extraction
  // --------------------------------------------------------------------------

  it('should use first user message as title when no custom title', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeMetaUserEntry(),
      makeUserEntry('This is my first real question'),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('This is my first real question')
  })

  it('should derive a clean title from slash command breadcrumb metadata', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry([
        '<command-message>frontend-design</command-message>',
        '<command-name>/frontend-design</command-name>',
        '<command-args>@website 重新设计首页</command-args>',
      ].join('\n')),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('/frontend-design @website 重新设计首页')
  })

  it('should keep a goal creation title instead of later goal status titles', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        parentUuid: null,
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship the actual objective</command-args>',
        level: 'info',
        timestamp: '2026-01-01T00:00:01.000Z',
        uuid: 'goal-command',
      },
      {
        type: 'ai-title',
        aiTitle: '/goal status',
        timestamp: '2026-01-01T00:02:00.000Z',
      },
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('/goal ship the actual objective')
  })

  it('should display stored AI titles without internal XML tags', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('fallback message'),
      {
        type: 'ai-title',
        aiTitle: [
          '<command-message>frontend-design</command-message>',
          '<command-name>/frontend-design</command-name>',
          '<command-args>@website</command-args>',
        ].join(' '),
        timestamp: '2026-01-01T00:02:00.000Z',
      },
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('/frontend-design @website')
  })

  it('should truncate long titles to 80 chars', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const longMessage = 'A'.repeat(120)
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry(longMessage),
    ])

    const detail = await service.getSession(sessionId)
    expect(detail!.title.length).toBe(83) // 80 + '...'
    expect(detail!.title.endsWith('...')).toBe(true)
  })

  it('should fall back to "Untitled Session" when no user message', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [makeSnapshotEntry()])

    const detail = await service.getSession(sessionId)
    expect(detail!.title).toBe('Untitled Session')
  })

  it('should detect placeholder launch info for desktop-created sessions', async () => {
    const workDir = await fs.realpath(os.tmpdir())
    const { sessionId } = await service.createSession(workDir)

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe(workDir)
    expect(launchInfo!.transcriptMessageCount).toBe(0)
    expect(launchInfo!.customTitle).toBeNull()
  })

  it('should detect resumable launch info for transcript sessions', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const userUuid = crypto.randomUUID()
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      { type: 'session-meta', isMeta: true, workDir: '/tmp/project', timestamp: '2026-01-01T00:00:00.000Z' },
      makeUserEntry('Hello again', userUuid),
      makeAssistantEntry('Welcome back', userUuid),
      { type: 'custom-title', customTitle: 'Saved chat', timestamp: '2026-01-01T00:03:00.000Z' },
    ])

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe('/tmp/project')
    expect(launchInfo!.transcriptMessageCount).toBe(2)
    expect(launchInfo!.customTitle).toBe('Saved chat')
  })

  it('should recover Windows drive paths from sanitized project dirs for old transcripts without metadata', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff'
    const userUuid = crypto.randomUUID()
    const userEntry = makeUserEntry('Resume this Windows session', userUuid)
    delete userEntry.cwd
    await writeSessionFile('g--AI-NTos-NT-deepseek-nano-core', sessionId, [
      makeSnapshotEntry(),
      userEntry,
      makeAssistantEntry('Welcome back', userUuid),
    ])

    const expectedWorkDir = 'g:\\AI\\NTos\\NT\\deepseek\\nano\\core'
    expect(await service.getSessionWorkDir(sessionId)).toBe(expectedWorkDir)

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe(expectedWorkDir)
    expect(launchInfo!.transcriptMessageCount).toBe(2)
  })

  it('createSessionBranch should preserve branch metadata, copied snapshots, and filtered replacements', async () => {
    const sessionId = 'branch-source-session'
    const workDir = path.join(tmpDir, 'branch-source')
    const worktreePath = path.join(workDir, '.claude', 'worktrees', 'desktop-main-12345678')
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const firstToolResultId = crypto.randomUUID()
    const laterUserId = crypto.randomUUID()
    const laterAssistantId = crypto.randomUUID()
    const repository = {
      branch: 'feature/rail',
      worktree: true,
      baseRef: 'feature/rail',
      repoRoot: workDir,
    }
    const sourceProjectDir = sanitizePath(workDir)
    const sourcePath = await writeSessionFile(sourceProjectDir, sessionId, [
      makeSessionMetaEntry(workDir),
      {
        type: 'session-meta',
        isMeta: true,
        workDir,
        repository,
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      makeWorktreeStateEntry(sessionId, worktreePath, {
        originalCwd: workDir,
      }),
      makeFileHistorySnapshotEntry(firstUserId, {
        'src/step.js': {
          backupFileName: 'branch-source-step@v1',
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('branch this conversation', firstUserId),
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantToolUseEntry([
          { id: 'tool-1', name: 'Read', input: { path: 'src/step.js' } },
        ], firstUserId),
        uuid: firstAssistantId,
        cwd: workDir,
        sessionId,
      },
      {
        ...makeToolResultUserEntry('tool-1', 'first tool result', firstToolResultId, firstAssistantId, sessionId),
        cwd: workDir,
      },
      makeContentReplacementEntry(sessionId, [
        { kind: 'tool-result', toolUseId: 'tool-1', replacement: 'preview-1' },
        { kind: 'tool-result', toolUseId: 'tool-2', replacement: 'preview-2' },
      ]),
      makeFileHistorySnapshotEntry(laterUserId, {
        'src/step.js': {
          backupFileName: 'branch-source-step@v2',
          version: 2,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('later prompt', laterUserId),
        parentUuid: firstToolResultId,
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantEntry('later reply', laterUserId),
        uuid: laterAssistantId,
        cwd: workDir,
        sessionId,
      },
    ])

    const sourceBefore = await fs.readFile(sourcePath, 'utf-8')

    const branch = await createSessionBranch({
      sourceSessionId: sessionId,
      sourceTranscriptPath: sourcePath,
      targetMessageId: firstToolResultId,
      title: 'Desktop branch',
      sourceWorkDir: workDir,
      sourceRepository: repository,
      sourceWorktreeSession: {
        originalCwd: workDir,
        worktreePath,
        worktreeName: 'desktop-main-12345678',
        worktreeBranch: 'worktree-desktop-main-12345678',
        originalBranch: 'main',
        sessionId,
      },
    })

    const branchMessages = await service.getSessionMessages(branch.sessionId)
    expect(branchMessages.map((message) => message.id)).toEqual([
      firstUserId,
      firstAssistantId,
      firstToolResultId,
    ])
    expect(branch.title).toBe('Desktop branch (Branch)')

    const launchInfo = await service.getSessionLaunchInfo(branch.sessionId)
    expect(launchInfo).toMatchObject({
      workDir,
      repository,
      worktreeSession: {
        originalCwd: workDir,
        worktreePath,
      },
    })

    const branchEntries = parseJSONL<Record<string, unknown>>(await fs.readFile(branch.forkPath))
    expect(branchEntries.some((entry) => (
      entry.type === 'content-replacement' &&
      entry.sessionId === branch.sessionId &&
      Array.isArray(entry.replacements) &&
      entry.replacements.length === 1 &&
      (entry.replacements[0] as { toolUseId?: string }).toolUseId === 'tool-1'
    ))).toBe(true)
    expect(branchEntries.some((entry) => (
      entry.type === 'file-history-snapshot' &&
      typeof (entry.snapshot as { messageId?: string } | undefined)?.messageId === 'string' &&
      (entry.snapshot as { messageId?: string }).messageId === firstUserId
    ))).toBe(true)
    expect(branchEntries.some((entry) => (
      entry.type === 'file-history-snapshot' &&
      typeof (entry.snapshot as { messageId?: string } | undefined)?.messageId === 'string' &&
      (entry.snapshot as { messageId?: string }).messageId === laterUserId
    ))).toBe(false)
    expect(branchEntries.some((entry) => (
      entry.type === 'custom-title' &&
      entry.customTitle === 'Desktop branch (Branch)'
    ))).toBe(true)
    expect(branchEntries.filter((entry) => (
      entry.type === 'user' ||
      entry.type === 'assistant'
    )).every((entry) => (
      entry.sessionId === branch.sessionId &&
      typeof (entry.forkedFrom as { sessionId?: string } | undefined)?.sessionId === 'string'
    ))).toBe(true)

    const sourceAfter = await fs.readFile(sourcePath, 'utf-8')
    expect(sourceAfter).toBe(sourceBefore)
  })
})

// ============================================================================
// Sessions API integration tests
// ============================================================================

describe('Sessions API', () => {
  let baseUrl: string
  let server: ReturnType<typeof Bun.serve> | null = null

  beforeEach(async () => {
    await setupTmpConfigDir()
    service = new SessionService()

    // Import and start a minimal test server
    const { handleSessionsApi } = await import('../api/sessions.js')
    const { handleConversationsApi } = await import('../api/conversations.js')

    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',

      async fetch(req) {
        const url = new URL(req.url)
        const segments = url.pathname.split('/').filter(Boolean)

        if (segments[0] === 'api' && segments[1] === 'sessions') {
          // Route chat sub-resource to conversations handler
          if (segments[3] === 'chat') {
            return handleConversationsApi(req, url, segments)
          }
          return handleSessionsApi(req, url, segments)
        }

        return new Response('Not Found', { status: 404 })
      },
    })
    baseUrl = `http://127.0.0.1:${server.port}`
  })

  afterEach(async () => {
    if (server) {
      server.stop(true)
      server = null
    }
    clearInstalledPluginsCache()
    clearPluginCache('sessions-api-test-teardown')
    resetSettingsCache()
    await cleanupTmpDir()
  })

  it('GET /api/sessions should return empty list', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { sessions: unknown[]; total: number }
    expect(body.sessions).toEqual([])
    expect(body.total).toBe(0)
  })

  it('POST /api/sessions should create a session', async () => {
    const workDir = await fs.mkdtemp(path.join(tmpDir, 'api-session-'))
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir }),
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as { sessionId: string }
    expect(body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('POST /api/sessions should create a session when workDir is omitted', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as { sessionId: string }
    expect(body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('GET /api/sessions/:id/inspection should report persisted permission mode for inactive sessions', async () => {
    const workDir = await fs.mkdtemp(path.join(tmpDir, 'api-session-permission-'))
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir, permissionMode: 'bypassPermissions' }),
    })
    expect(createRes.status).toBe(201)

    const { sessionId } = (await createRes.json()) as { sessionId: string }
    const inspectionRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=0`)
    expect(inspectionRes.status).toBe(200)

    const inspection = (await inspectionRes.json()) as {
      active: boolean
      status: { permissionMode?: string }
    }
    expect(inspection.active).toBe(false)
    expect(inspection.status.permissionMode).toBe('bypassPermissions')
  })

  it('GET /api/sessions/repository-context should return branch launch metadata', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const res = await fetch(
      `${baseUrl}/api/sessions/repository-context?workDir=${encodeURIComponent(workDir)}`,
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      state: string
      repoName: string
      currentBranch: string
      branches: Array<{ name: string; current: boolean; local: boolean }>
      worktrees: Array<{ path: string; branch: string | null; current: boolean }>
    }
    expect(body.state).toBe('ok')
    expect(body.repoName).toBe(path.basename(workDir))
    expect(body.currentBranch).toBe('main')
    expect(body.branches.some((branch) => branch.name === 'main' && branch.current)).toBe(true)
    expect(body.branches.some((branch) => branch.name === 'feature/rail' && branch.local)).toBe(true)
    const realWorkDir = await fs.realpath(workDir)
    expect(body.worktrees.some((worktree) => worktree.path === realWorkDir && worktree.current)).toBe(true)
  })

  it('GET /api/sessions/recent-projects should keep pending repository launches on the source project', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workDir,
        repository: { branch: 'feature/rail', worktree: true },
      }),
    })
    expect(createRes.status).toBe(201)

    const created = (await createRes.json()) as { workDir: string }
    const recentRes = await fetch(`${baseUrl}/api/sessions/recent-projects?limit=20`)
    expect(recentRes.status).toBe(200)

    const body = (await recentRes.json()) as {
      projects: Array<{ realPath: string; projectName: string; branch: string | null }>
    }
    const project = body.projects.find((candidate) => candidate.realPath === created.workDir)
    expect(project).toBeDefined()
    expect(project?.projectName).toBe(path.basename(workDir))
    expect(project?.branch).toBe('main')
    expect(project?.realPath).toBe(await fs.realpath(workDir))
  })

  it('GET /api/sessions/:id should return session detail', async () => {
    // Create a session file
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('API test message'),
      makeAssistantEntry('API test response'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { id: string; title: string; messages: unknown[] }
    expect(body.id).toBe(sessionId)
    expect(body.title).toBe('API test message')
    expect(body.messages).toHaveLength(2)
  })

  it('GET /api/sessions/:id should 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000`)
    expect(res.status).toBe(404)
  })

  it('GET /api/sessions/:id/messages should return messages', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Hello'),
      makeAssistantEntry('World'),
      makeUserEntry(
        '<task-notification>\n<task-id>bg-1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>failed</status>\n<summary>Background command failed &amp; stopped</summary>\n<result>Stack trace &amp; failed assertion</result>\n<output-file>C:\\Temp\\bg.output</output-file>\n</task-notification>',
        crypto.randomUUID(),
      ),
      makeAssistantEntry('internal task response'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      messages: unknown[]
      taskNotifications: unknown[]
    }
    expect(body.messages).toHaveLength(2)
    expect(JSON.stringify(body.messages)).not.toContain('<task-notification>')
    expect(body.taskNotifications).toEqual([
      {
        taskId: 'bg-1',
        toolUseId: 'toolu_bg',
        status: 'failed',
        summary: 'Background command failed & stopped',
        result: 'Stack trace & failed assertion',
        outputFile: 'C:\\Temp\\bg.output',
        timestamp: expect.any(String),
      },
    ])
  })

  it('GET /api/sessions/:id/git-info should prefer the active CLI workDir', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const activeWorktree = path.join(tmpDir, `active-feature-rail-${Date.now()}`)
    git(workDir, 'worktree', 'add', activeWorktree, 'feature/rail')
    const { sessionId } = await sessionService.createSession(workDir)
    const sessionsMap = (conversationService as any).sessions as Map<string, { workDir: string }>

    sessionsMap.set(sessionId, { workDir: activeWorktree })
    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git-info`)
      expect(res.status).toBe(200)

      const body = (await res.json()) as { branch: string | null; workDir: string }
      expect(body.workDir).toBe(activeWorktree)
      expect(body.branch).toBe('feature/rail')
    } finally {
      sessionsMap.delete(sessionId)
    }
  })

  it('GET /api/sessions/:id/git-info should keep the session launch branch stable', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId } = await sessionService.createSession(
      workDir,
      { branch: 'feature/rail', worktree: false },
    )
    const sessionsMap = (conversationService as any).sessions as Map<string, { workDir: string }>

    sessionsMap.set(sessionId, { workDir })
    git(workDir, 'switch', 'main')
    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git-info`)
      expect(res.status).toBe(200)

      const body = (await res.json()) as { branch: string | null; workDir: string }
      expect(body.workDir).toBe(workDir)
      expect(body.branch).toBe('feature/rail')
    } finally {
      sessionsMap.delete(sessionId)
    }
  })

  it('GET /api/sessions/:id/git-info should keep the visible launch branch while including isolated worktree identity', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId } = await sessionService.createSession(
      workDir,
      { branch: 'feature/rail', worktree: true },
    )
    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    const repository = launchInfo?.repository
    expect(repository?.worktreePath).toBeTruthy()
    expect(repository?.worktreeBranch).toBeTruthy()

    const activeWorktree = repository!.worktreePath!
    git(workDir, 'worktree', 'add', '-b', repository!.worktreeBranch!, activeWorktree, 'feature/rail')
    const sessionsMap = (conversationService as any).sessions as Map<string, { workDir: string }>

    sessionsMap.set(sessionId, { workDir: activeWorktree })
    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git-info`)
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        branch: string | null
        workDir: string
        worktree: {
          enabled: boolean
          path: string | null
          plannedPath: string | null
          sourceWorkDir: string | null
          slug: string | null
          branch: string | null
        } | null
      }
      expect(body.branch).toBe('feature/rail')
      expect(body.workDir).toBe(activeWorktree)
      expect(body.worktree).toEqual({
        enabled: true,
        path: activeWorktree,
        plannedPath: activeWorktree,
        sourceWorkDir: repository!.requestedWorkDir,
        slug: repository!.worktreeSlug,
        branch: repository!.worktreeBranch,
      })
    } finally {
      sessionsMap.delete(sessionId)
    }
  })

  it('GET /api/sessions/:id/git-info should use CLI worktree-state after reload', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const activeWorktree = path.join(workDir, '.claude', 'worktrees', 'desktop-main-12345678')
    git(workDir, 'worktree', 'add', '-b', 'worktree-desktop-main-12345678', activeWorktree, 'main')
    await writeSessionFile(sanitizePath(activeWorktree), sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(activeWorktree),
      makeWorktreeStateEntry(sessionId, activeWorktree, {
        originalCwd: await fs.realpath(workDir),
      }),
      makeUserEntry('Hello from persisted worktree state'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git-info`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      branch: string | null
      repoName: string | null
      workDir: string
      worktree: {
        enabled: boolean
        path: string | null
        plannedPath: string | null
        sourceWorkDir: string | null
        slug: string | null
        branch: string | null
      } | null
    }
    expect(body.branch).toBe('main')
    expect(body.workDir).toBe(activeWorktree)
    expect(body.worktree).toEqual({
      enabled: true,
      path: activeWorktree,
      plannedPath: activeWorktree,
      sourceWorkDir: await fs.realpath(workDir),
      slug: 'desktop-main-12345678',
      branch: 'worktree-desktop-main-12345678',
    })
  })

  it('GET /api/sessions/:id/git-info should prefer CLI worktree-state identity over desktop metadata', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const activeWorktree = path.join(workDir, '.claude', 'worktrees', 'desktop-main-12345678')
    git(workDir, 'worktree', 'add', '-b', 'worktree-desktop-main-12345678', activeWorktree, 'main')
    await writeSessionFile(sanitizePath(activeWorktree), sessionId, [
      makeSnapshotEntry(),
      {
        type: 'session-meta',
        isMeta: true,
        workDir: activeWorktree,
        repository: {
          requestedWorkDir: '/stale/source',
          repoRoot: '/stale/source',
          branch: 'main',
          worktree: true,
          baseRef: 'main',
          worktreePath: '/stale/source/.claude/worktrees/stale',
          worktreeBranch: 'worktree-stale',
          worktreeSlug: 'stale',
        },
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      makeWorktreeStateEntry(sessionId, activeWorktree, {
        originalCwd: await fs.realpath(workDir),
      }),
      makeUserEntry('Hello from persisted worktree state'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/git-info`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      branch: string | null
      worktree: {
        path: string | null
        plannedPath: string | null
        sourceWorkDir: string | null
        slug: string | null
        branch: string | null
      } | null
    }
    expect(body.branch).toBe('main')
    expect(body.worktree).toMatchObject({
      path: activeWorktree,
      plannedPath: activeWorktree,
      sourceWorkDir: await fs.realpath(workDir),
      slug: 'desktop-main-12345678',
      branch: 'worktree-desktop-main-12345678',
    })
  })

  it('DELETE /api/sessions/:id should delete the session', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [makeSnapshotEntry()])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    // Verify it's gone
    const res2 = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    expect(res2.status).toBe(404)
  })

  it('DELETE /api/sessions/:id should remove matching IM adapter session mappings', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const otherSessionId = 'ffffffff-1111-2222-3333-ffffffffffff'
    await writeSessionFile('-tmp-api-test', sessionId, [makeSnapshotEntry()])
    await fs.writeFile(
      path.join(tmpDir, 'adapter-sessions.json'),
      JSON.stringify({
        'wechat-chat': {
          sessionId,
          workDir: '/tmp/project-a',
          updatedAt: 1,
        },
        'wechat-chat-2': {
          sessionId,
          workDir: '/tmp/project-b',
          updatedAt: 2,
        },
        'other-chat': {
          sessionId: otherSessionId,
          workDir: '/tmp/project-c',
          updatedAt: 3,
        },
      }, null, 2),
      'utf-8',
    )

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    const persisted = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'adapter-sessions.json'), 'utf-8'),
    )
    expect(persisted['wechat-chat']).toBeUndefined()
    expect(persisted['wechat-chat-2']).toBeUndefined()
    expect(persisted['other-chat'].sessionId).toBe(otherSessionId)
  })

  it('DELETE /api/sessions/:id should roll back the deleted marker when file deletion fails', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [makeSnapshotEntry()])

    const originalDeleteSession = sessionService.deleteSession.bind(sessionService)
    sessionService.deleteSession = (async (targetSessionId: string) => {
      if (targetSessionId === sessionId) {
        throw new Error('simulated unlink failure')
      }
      return originalDeleteSession(targetSessionId)
    }) as typeof sessionService.deleteSession

    try {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' })
      expect(res.status).toBe(500)
      expect((conversationService as any).deletedSessions.has(sessionId)).toBe(false)

      const detailRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
      expect(detailRes.status).toBe(200)
    } finally {
      sessionService.deleteSession = originalDeleteSession as typeof sessionService.deleteSession
      conversationService.unmarkSessionDeleted(sessionId)
    }
  })

  it('POST /api/sessions/batch-delete should delete sessions and clean adapter mappings', async () => {
    const sessionIdA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const sessionIdB = 'ffffffff-1111-2222-3333-ffffffffffff'
    const otherSessionId = '99999999-1111-2222-3333-999999999999'
    await writeSessionFile('-tmp-api-test', sessionIdA, [makeSnapshotEntry()])
    await writeSessionFile('-tmp-api-test', sessionIdB, [makeSnapshotEntry()])
    await fs.writeFile(
      path.join(tmpDir, 'adapter-sessions.json'),
      JSON.stringify({
        'wechat-chat-a': {
          sessionId: sessionIdA,
          workDir: '/tmp/project-a',
          updatedAt: 1,
        },
        'wechat-chat-b': {
          sessionId: sessionIdB,
          workDir: '/tmp/project-b',
          updatedAt: 2,
        },
        'other-chat': {
          sessionId: otherSessionId,
          workDir: '/tmp/project-c',
          updatedAt: 3,
        },
      }, null, 2),
      'utf-8',
    )

    const res = await fetch(`${baseUrl}/api/sessions/batch-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionIds: [sessionIdA, sessionIdB] }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      successes: [sessionIdA, sessionIdB],
      failures: [],
    })

    expect((await fetch(`${baseUrl}/api/sessions/${sessionIdA}`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/api/sessions/${sessionIdB}`)).status).toBe(404)
    const persisted = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'adapter-sessions.json'), 'utf-8'),
    )
    expect(persisted['wechat-chat-a']).toBeUndefined()
    expect(persisted['wechat-chat-b']).toBeUndefined()
    expect(persisted['other-chat'].sessionId).toBe(otherSessionId)
  })

  it('POST /api/sessions/batch-delete should report partial failures and roll back failed delete markers', async () => {
    const successSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const failedSessionId = 'ffffffff-1111-2222-3333-ffffffffffff'
    await writeSessionFile('-tmp-api-test', successSessionId, [makeSnapshotEntry()])
    await writeSessionFile('-tmp-api-test', failedSessionId, [makeSnapshotEntry()])

    const originalDeleteSession = sessionService.deleteSession.bind(sessionService)
    sessionService.deleteSession = (async (targetSessionId: string) => {
      if (targetSessionId === failedSessionId) {
        throw new Error('simulated batch unlink failure')
      }
      return originalDeleteSession(targetSessionId)
    }) as typeof sessionService.deleteSession

    try {
      const res = await fetch(`${baseUrl}/api/sessions/batch-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: [successSessionId, failedSessionId] }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        ok: false,
        successes: [successSessionId],
        failures: [{
          sessionId: failedSessionId,
          message: 'simulated batch unlink failure',
        }],
      })
      expect((conversationService as any).deletedSessions.has(failedSessionId)).toBe(false)
      expect((await fetch(`${baseUrl}/api/sessions/${successSessionId}`)).status).toBe(404)
      expect((await fetch(`${baseUrl}/api/sessions/${failedSessionId}`)).status).toBe(200)
    } finally {
      sessionService.deleteSession = originalDeleteSession as typeof sessionService.deleteSession
      conversationService.unmarkSessionDeleted(successSessionId)
      conversationService.unmarkSessionDeleted(failedSessionId)
    }
  })

  it('PATCH /api/sessions/:id should rename the session', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Old title message'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Custom Title' }),
    })
    expect(res.status).toBe(200)

    // Verify new title
    const detailRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    const detail = (await detailRes.json()) as { title: string }
    expect(detail.title).toBe('New Custom Title')
  })

  it('GET /api/sessions/:id/slash-commands should include user and project skills before CLI init', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const workDir = path.join(tmpDir, 'workspace', 'app')

    await fs.mkdir(path.join(workDir, '.claude', 'skills'), { recursive: true })
    await fs.mkdir(path.join(tmpDir, 'skills'), { recursive: true })
    await writeSkill(path.join(tmpDir, 'skills'), 'user-skill', 'User skill description')
    await writeSkill(path.join(workDir, '.claude', 'skills'), 'project-skill', 'Project skill description')

    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(workDir),
    ])

    clearCommandsCache()

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      commands: Array<{ name: string; description: string }>
    }

    expect(body.commands).toContainEqual(
      expect.objectContaining({ name: 'user-skill', description: 'User skill description' }),
    )
    expect(body.commands).toContainEqual(
      expect.objectContaining({ name: 'project-skill', description: 'Project skill description' }),
    )
  })

  it('GET /api/sessions/:id/slash-commands should include legacy custom commands before CLI init', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef'
    const workDir = path.join(tmpDir, 'workspace', 'app')

    await writeLegacySlashCommand(
      path.join(tmpDir, 'commands'),
      'user-probe',
      'User custom slash command',
    )
    await writeLegacySlashCommand(
      path.join(workDir, '.claude', 'commands'),
      'project-probe',
      'Project custom slash command',
    )

    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(workDir),
    ])

    clearCommandsCache()

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      commands: Array<{ name: string; description: string; argumentHint?: string }>
    }

    expect(body.commands).toContainEqual(
      expect.objectContaining({
        name: 'user-probe',
        description: 'User custom slash command',
        argumentHint: '<topic>',
      }),
    )
    expect(body.commands).toContainEqual(
      expect.objectContaining({
        name: 'project-probe',
        description: 'Project custom slash command',
        argumentHint: '<topic>',
      }),
    )
  })

  it('GET /api/sessions/:id/slash-commands should preserve cached command argument hints when merging custom commands', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeef001'
    const workDir = path.join(tmpDir, 'workspace', 'app')

    await writeLegacySlashCommand(
      path.join(workDir, '.claude', 'commands'),
      'project-probe',
      'Project custom slash command',
    )

    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(workDir),
    ])

    updateSessionSlashCommands(
      sessionId,
      [{ name: 'builtin-probe', description: 'Cached CLI command', argumentHint: '<value>' }],
      { notifyClient: false },
    )
    clearCommandsCache()

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      commands: Array<{ name: string; description: string; argumentHint?: string }>
    }

    expect(body.commands).toContainEqual({
      name: 'builtin-probe',
      description: 'Cached CLI command',
      argumentHint: '<value>',
    })
    expect(body.commands).toContainEqual(
      expect.objectContaining({
        name: 'project-probe',
        description: 'Project custom slash command',
      }),
    )
  })

  it('GET /api/sessions/:id/slash-commands should include enabled plugin skills before CLI init', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff'
    const workDir = path.join(tmpDir, 'workspace', 'app')
    const marketplaceRoot = path.join(tmpDir, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'superpowers')
    const pluginsDir = path.join(tmpDir, 'plugins')
    const marketplaceFile = path.join(
      marketplaceRoot,
      '.claude-plugin',
      'marketplace.json',
    )

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })
    await fs.mkdir(workDir, { recursive: true })
    await writeSkill(
      path.join(pluginRoot, 'skills'),
      'brainstorming',
      'Superpowers brainstorming skill',
    )
    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'superpowers',
        version: '5.0.7',
        description: 'Core skills library',
      }),
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'claude-plugins-official',
        owner: { name: 'Test' },
        plugins: [
          {
            name: 'superpowers',
            source: './plugins/superpowers',
            version: '5.0.7',
          },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'claude-plugins-official': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        enabledPlugins: {
          'superpowers@claude-plugins-official': true,
        },
      }),
      'utf-8',
    )

    resetSettingsCache()
    clearPluginCache('sessions-api-plugin-skills')
    clearCommandsCache()
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(workDir),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      commands: Array<{ name: string; description: string }>
    }

    expect(body.commands).toContainEqual(
      expect.objectContaining({
        name: 'superpowers:brainstorming',
        description: 'Superpowers brainstorming skill',
      }),
    )
  })

  it('GET /api/sessions/:id/workspace/status|tree|file|diff should return workspace data', async () => {
    const workDir = await createWorkspaceApiGitRepo(tmpDir)
    const { sessionId } = await service.createSession(workDir)

    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/status`)
    expect(statusRes.status).toBe(200)
    const statusBody = await statusRes.json() as {
      state: string
      workDir: string
      changedFiles: Array<{ path: string; status: string }>
      isGitRepo: boolean
    }
    expect(statusBody.state).toBe('ok')
    expect(statusBody.workDir).toBe(await fs.realpath(workDir))
    expect(statusBody.isGitRepo).toBe(true)
    expect(statusBody.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tracked.txt', status: 'modified' }),
      ]),
    )

    const treeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/tree`)
    expect(treeRes.status).toBe(200)
    const treeBody = await treeRes.json() as {
      state: string
      path: string
      entries: Array<{ name: string; path: string; isDirectory: boolean }>
    }
    expect(treeBody).toMatchObject({
      state: 'ok',
      path: '',
    })
    expect(treeBody.entries).toEqual([
      { name: 'src', path: 'src', isDirectory: true, isSymlink: false },
      { name: 'tracked.txt', path: 'tracked.txt', isDirectory: false, isSymlink: false },
    ])

    const fileRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/file?path=${encodeURIComponent('src/app.ts')}`,
    )
    expect(fileRes.status).toBe(200)
    const fileBody = await fileRes.json() as {
      state: string
      path: string
      content?: string
      language: string
      size: number
    }
    expect(fileBody).toMatchObject({
      state: 'ok',
      path: 'src/app.ts',
      language: 'typescript',
      size: 25,
      content: 'export const answer = 42\n',
    })

    const diffRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/diff?path=${encodeURIComponent('tracked.txt')}`,
    )
    expect(diffRes.status).toBe(200)
    const diffBody = await diffRes.json() as {
      state: string
      path: string
      diff?: string
    }
    expect(diffBody.state).toBe('ok')
    expect(diffBody.path).toBe('tracked.txt')
    expect(diffBody.diff).toContain('tracked.txt')
  })

  it('GET /api/sessions/:id/workspace/* should surface transcript changes for a non-git tmp session', async () => {
    const sessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
    const workDir = await fs.mkdtemp(path.join(tmpDir, 'workspace-api-non-git-'))
    const srcDir = path.join(workDir, 'src')
    const notesDir = path.join(workDir, 'notes')
    const assetsDir = path.join(workDir, 'assets')

    await fs.mkdir(srcDir, { recursive: true })
    await fs.mkdir(notesDir, { recursive: true })
    await fs.mkdir(assetsDir, { recursive: true })
    await fs.writeFile(path.join(workDir, 'README.md'), '# Temporary project\n')
    await fs.writeFile(path.join(srcDir, 'app.ts'), 'export const answer = 2\n')
    await fs.writeFile(path.join(notesDir, 'todo.md'), '- ship workspace panel\n')
    await fs.writeFile(
      path.join(assetsDir, 'pixel.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64',
      ),
    )

    await writeSessionFile(sanitizePath(workDir), sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(workDir),
      makeUserEntry('Update this temporary project'),
      makeAssistantToolUseEntry([
        {
          id: 'toolu-edit-app',
          name: 'Edit',
          input: {
            file_path: path.join(workDir, 'src', 'app.ts'),
            old_string: 'export const answer = 1\n',
            new_string: 'export const answer = 2\n',
          },
        },
        {
          id: 'toolu-write-todo',
          name: 'Write',
          input: {
            file_path: path.join(workDir, 'notes', 'todo.md'),
            content: '- ship workspace panel\n',
          },
        },
      ]),
    ])

    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/status`)
    expect(statusRes.status).toBe(200)
    const statusBody = await statusRes.json() as {
      state: string
      workDir: string
      repoName: string | null
      branch: string | null
      isGitRepo: boolean
      changedFiles: Array<{
        path: string
        status: string
        additions: number
        deletions: number
      }>
    }
    expect(statusBody).toMatchObject({
      state: 'ok',
      workDir,
      repoName: path.basename(workDir),
      branch: null,
      isGitRepo: false,
    })
    expect(statusBody.changedFiles).toEqual([
      expect.objectContaining({
        path: 'notes/todo.md',
        status: 'added',
        additions: 1,
        deletions: 0,
      }),
      expect.objectContaining({
        path: 'src/app.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
      }),
    ])

    const treeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/tree`)
    expect(treeRes.status).toBe(200)
    const treeBody = await treeRes.json() as {
      state: string
      path: string
      entries: Array<{ name: string; path: string; isDirectory: boolean }>
    }
    expect(treeBody).toMatchObject({ state: 'ok', path: '' })
    expect(treeBody.entries).toEqual([
      { name: 'assets', path: 'assets', isDirectory: true, isSymlink: false },
      { name: 'notes', path: 'notes', isDirectory: true, isSymlink: false },
      { name: 'src', path: 'src', isDirectory: true, isSymlink: false },
      { name: 'README.md', path: 'README.md', isDirectory: false, isSymlink: false },
    ])

    const srcTreeRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/tree?path=${encodeURIComponent('src')}`,
    )
    expect(srcTreeRes.status).toBe(200)
    expect(await srcTreeRes.json()).toMatchObject({
      state: 'ok',
      path: 'src',
      entries: [{ name: 'app.ts', path: 'src/app.ts', isDirectory: false, isSymlink: false }],
    })

    const fileRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/file?path=${encodeURIComponent('src/app.ts')}`,
    )
    expect(fileRes.status).toBe(200)
    expect(await fileRes.json()).toMatchObject({
      state: 'ok',
      path: 'src/app.ts',
      previewType: 'text',
      language: 'typescript',
      content: 'export const answer = 2\n',
    })

    const imageRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/file?path=${encodeURIComponent('assets/pixel.png')}`,
    )
    expect(imageRes.status).toBe(200)
    const imageBody = await imageRes.json() as {
      state: string
      path: string
      previewType: string
      mimeType: string
      dataUrl: string
    }
    expect(imageBody).toMatchObject({
      state: 'ok',
      path: 'assets/pixel.png',
      previewType: 'image',
      mimeType: 'image/png',
    })
    expect(imageBody.dataUrl).toStartWith('data:image/png;base64,')

    const appDiffRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/diff?path=${encodeURIComponent('src/app.ts')}`,
    )
    expect(appDiffRes.status).toBe(200)
    const appDiffBody = await appDiffRes.json() as { state: string; path: string; diff?: string }
    expect(appDiffBody).toMatchObject({ state: 'ok', path: 'src/app.ts' })
    expect(appDiffBody.diff).toContain('diff --session a/src/app.ts b/src/app.ts')
    expect(appDiffBody.diff).toContain('-export const answer = 1')
    expect(appDiffBody.diff).toContain('+export const answer = 2')

    const todoDiffRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/diff?path=${encodeURIComponent('notes/todo.md')}`,
    )
    expect(todoDiffRes.status).toBe(200)
    const todoDiffBody = await todoDiffRes.json() as { state: string; path: string; diff?: string }
    expect(todoDiffBody).toMatchObject({ state: 'ok', path: 'notes/todo.md' })
    expect(todoDiffBody.diff).toContain('--- /dev/null')
    expect(todoDiffBody.diff).toContain('+++ b/notes/todo.md')
    expect(todoDiffBody.diff).toContain('+- ship workspace panel')
  })

  it('GET /api/sessions/:id/workspace/* should surface file-history changes for a non-git generated subdirectory', async () => {
    const sessionId = crypto.randomUUID()
    const workDir = path.join(tmpDir, 'workspace-file-history-generated')
    const generatedFile = path.join(workDir, 'aacc', 'src', 'App.tsx')
    const userId = crypto.randomUUID()

    await fs.mkdir(path.dirname(generatedFile), { recursive: true })
    await fs.writeFile(
      generatedFile,
      'export default function App() { return <main>Tetris</main> }\n',
      'utf-8',
    )

    await writeSessionFile(sanitizePath(workDir), sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'aacc/src/App.tsx': {
          backupFileName: null,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('create aacc project', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', userId),
      makeUserEntry(
        '<task-notification>\n<task-id>bg-1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>',
        crypto.randomUUID(),
      ),
      makeAssistantEntry('Background task completed again, no action needed'),
    ])

    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/status`)
    expect(statusRes.status).toBe(200)
    const statusBody = await statusRes.json() as {
      state: string
      workDir: string
      isGitRepo: boolean
      changedFiles: Array<{
        path: string
        status: string
        additions: number
        deletions: number
      }>
    }
    expect(statusBody).toMatchObject({
      state: 'ok',
      workDir,
      isGitRepo: false,
    })
    expect(statusBody.changedFiles).toEqual([
      expect.objectContaining({
        path: 'aacc/src/App.tsx',
        status: 'added',
        additions: 1,
        deletions: 0,
      }),
    ])

    const diffRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/diff?path=${encodeURIComponent('aacc/src/App.tsx')}`,
    )
    expect(diffRes.status).toBe(200)
    const diffBody = await diffRes.json() as {
      state: string
      path: string
      diff: string
    }
    expect(diffBody).toMatchObject({
      state: 'ok',
      path: 'aacc/src/App.tsx',
    })
    expect(diffBody.diff).toContain('diff --session /dev/null b/aacc/src/App.tsx')
    expect(diffBody.diff).toContain('+export default function App() { return <main>Tetris</main> }')

    const checkpointsRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(checkpointsRes.status).toBe(200)
    const checkpointsBody = await checkpointsRes.json() as {
      checkpoints: Array<{
        target: {
          targetUserMessageId: string
          userMessageIndex: number
          userMessageCount: number
        }
        code: {
          filesChanged: string[]
        }
      }>
    }
    expect(checkpointsBody.checkpoints).toHaveLength(1)
    expect(checkpointsBody.checkpoints[0]?.target).toMatchObject({
      targetUserMessageId: userId,
      userMessageIndex: 0,
      userMessageCount: 1,
    })
    expect(checkpointsBody.checkpoints[0]?.code.filesChanged).toEqual([generatedFile])
  })

  it('GET /api/sessions/:id/workspace/file and diff should require a path query', async () => {
    const workDir = await createWorkspaceApiGitRepo(tmpDir)
    const { sessionId } = await service.createSession(workDir)

    for (const route of ['file', 'diff']) {
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/${route}`)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({
        error: 'BAD_REQUEST',
      })
    }
  })

  it('GET /api/sessions/:id/workspace/file and tree should reject traversal with 403', async () => {
    const workDir = await createWorkspaceApiGitRepo(tmpDir)
    const { sessionId } = await service.createSession(workDir)

    for (const route of ['file', 'tree']) {
      const res = await fetch(
        `${baseUrl}/api/sessions/${sessionId}/workspace/${route}?path=${encodeURIComponent('../outside.txt')}`,
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({
        error: 'FORBIDDEN',
      })
    }
  })

  it('GET /api/sessions/:id/workspace/diff should reject traversal with 403', async () => {
    const workDir = await createWorkspaceApiGitRepo(tmpDir)
    const { sessionId } = await service.createSession(workDir)

    const res = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/workspace/diff?path=${encodeURIComponent('../outside.txt')}`,
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      error: 'FORBIDDEN',
    })
  })

  it('GET /api/sessions/:id/workspace/status should 404 for unknown sessions', async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000/workspace/status`,
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: 'NOT_FOUND',
    })
  })

  it('non-GET workspace routes should return 405', async () => {
    const workDir = await createWorkspaceApiGitRepo(tmpDir)
    const { sessionId } = await service.createSession(workDir)

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/workspace/status`, {
      method: 'POST',
    })

    expect(res.status).toBe(405)
    expect(await res.json()).toMatchObject({
      error: 'METHOD_NOT_ALLOWED',
    })
  })

  it('POST /api/sessions/:id/branch should create a branched session up to the target message', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const workDir = path.join(tmpDir, 'branch-api-workdir')
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const secondAssistantId = crypto.randomUUID()

    await writeSessionFile(sanitizePath(workDir), sessionId, [
      {
        type: 'session-meta',
        isMeta: true,
        workDir,
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        ...makeUserEntry('first prompt', firstUserId),
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantEntry('first reply', firstUserId),
        uuid: firstAssistantId,
        cwd: workDir,
        sessionId,
      },
      {
        ...makeUserEntry('second prompt', secondUserId),
        parentUuid: firstAssistantId,
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantEntry('second reply', secondUserId),
        uuid: secondAssistantId,
        cwd: workDir,
        sessionId,
      },
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetMessageId: firstAssistantId,
        title: 'API branch',
      }),
    })
    expect(res.status).toBe(201)

    const body = await res.json() as {
      sessionId: string
      title: string
      workDir: string
      sourceSessionId: string
      targetMessageId: string
    }
    expect(body).toMatchObject({
      title: 'API branch (Branch)',
      workDir,
      sourceSessionId: sessionId,
      targetMessageId: firstAssistantId,
    })

    const branchMessages = await service.getSessionMessages(body.sessionId)
    expect(branchMessages.map((message) => message.id)).toEqual([
      firstUserId,
      firstAssistantId,
    ])
  })

  it('POST /api/sessions/:id/branch should reject sidechain targets', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222'
    const rootUserId = crypto.randomUUID()
    const rootAssistantId = crypto.randomUUID()
    const sidechainId = crypto.randomUUID()

    await writeSessionFile('-tmp-api-branch-sidechain', sessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('root prompt', rootUserId),
        sessionId,
      },
      {
        ...makeAssistantEntry('root reply', rootUserId),
        uuid: rootAssistantId,
        sessionId,
      },
      {
        ...makeUserEntry('side question', sidechainId),
        parentUuid: rootAssistantId,
        isSidechain: true,
        sessionId,
      },
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetMessageId: sidechainId }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: 'BAD_REQUEST',
    })
  })

  it('POST /api/sessions/:id/branch should validate request bodies and missing sessions', async () => {
    const methodNotAllowedRes = await fetch(`${baseUrl}/api/sessions/33333333-3333-4333-8333-333333333333/branch`)
    expect(methodNotAllowedRes.status).toBe(405)

    const missingTargetRes = await fetch(`${baseUrl}/api/sessions/branch-missing-target/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(missingTargetRes.status).toBe(400)

    const invalidJsonRes = await fetch(`${baseUrl}/api/sessions/branch-invalid-json/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    })
    expect(invalidJsonRes.status).toBe(400)

    const invalidTitleRes = await fetch(`${baseUrl}/api/sessions/44444444-4444-4444-8444-444444444444/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetMessageId: 'message-1', title: 123 }),
    })
    expect(invalidTitleRes.status).toBe(400)

    const missingSessionRes = await fetch(`${baseUrl}/api/sessions/00000000-0000-0000-0000-000000000000/branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetMessageId: 'missing-target' }),
    })
    expect(missingSessionRes.status).toBe(404)
  })

  it('POST /api/sessions/:id/rewind should preview and trim the active conversation chain', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const secondAssistantId = crypto.randomUUID()

    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      {
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: 'first prompt' },
        uuid: firstUserId,
        timestamp: '2026-01-01T00:01:00.000Z',
        userType: 'external',
        cwd: '/tmp/test',
        sessionId,
      },
      {
        parentUuid: firstUserId,
        isSidechain: false,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'first reply' }],
        },
        uuid: firstAssistantId,
        timestamp: '2026-01-01T00:02:00.000Z',
      },
      {
        parentUuid: firstAssistantId,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: 'second prompt' },
        uuid: secondUserId,
        timestamp: '2026-01-01T00:03:00.000Z',
        userType: 'external',
        cwd: '/tmp/test',
        sessionId,
      },
      {
        parentUuid: secondUserId,
        isSidechain: false,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'second reply' }],
        },
        uuid: secondAssistantId,
        timestamp: '2026-01-01T00:04:00.000Z',
      },
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)

    const previewBody = await previewRes.json() as {
      conversation: { messagesRemoved: number }
      code: { available: boolean }
    }
    expect(previewBody.conversation.messagesRemoved).toBe(2)
    expect(previewBody.code.available).toBe(false)

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1 }),
    })
    expect(executeRes.status).toBe(200)

    const executeBody = await executeRes.json() as {
      conversation: { messagesRemoved: number; removedMessageIds: string[] }
    }
    expect(executeBody.conversation.messagesRemoved).toBe(2)
    expect(executeBody.conversation.removedMessageIds).toEqual([
      secondUserId,
      secondAssistantId,
    ])

    const remainingMessages = await service.getSessionMessages(sessionId)
    expect(remainingMessages.map((message) => message.id)).toEqual([
      firstUserId,
      firstAssistantId,
    ])
  })

  it('trimSessionMessagesFrom should remove orphan transcript entries beyond the rewind point', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const secondAssistantId = crypto.randomUUID()

    const filePath = await writeSessionFile('-tmp-api-rewind-orphans', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/project-with-hyphen'),
      {
        ...makeUserEntry('first prompt', firstUserId),
        sessionId,
      },
      {
        ...makeAssistantEntry('first reply', firstUserId),
        uuid: firstAssistantId,
      },
      {
        ...makeUserEntry('second prompt', secondUserId),
        parentUuid: firstAssistantId,
        sessionId,
      },
      {
        ...makeAssistantEntry('second reply', secondUserId),
        uuid: secondAssistantId,
      },
      {
        ...makeAssistantEntry('late stale reply', secondUserId),
        uuid: crypto.randomUUID(),
      },
    ])

    const result = await service.trimSessionMessagesFrom(sessionId, firstUserId)
    expect(result.removedMessageIds).toContain(firstUserId)
    expect(result.removedMessageIds).toContain(secondUserId)

    const raw = await fs.readFile(filePath, 'utf-8')
    expect(raw).toContain('"type":"session-meta"')
    expect(raw).not.toContain('late stale reply')
    expect(await service.getSessionMessages(sessionId)).toEqual([])

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe('/tmp/project-with-hyphen')
    expect(launchInfo!.transcriptMessageCount).toBe(0)
  })

  it('POST /api/sessions/:id/rewind should target the selected message id instead of a shifted visible index', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff'
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const hiddenUserId = crypto.randomUUID()
    const targetUserId = crypto.randomUUID()
    const targetAssistantId = crypto.randomUUID()

    await writeSessionFile('-tmp-api-rewind-id-target', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('first prompt', firstUserId),
      {
        ...makeAssistantEntry('first reply', firstUserId),
        uuid: firstAssistantId,
      },
      makeUserEntry(
        '<teammate-message teammate_id="reviewer">internal status that the main chat hides</teammate-message>',
        hiddenUserId,
      ),
      makeUserEntry('second visible prompt', targetUserId),
      {
        ...makeAssistantEntry('second reply', targetUserId),
        uuid: targetAssistantId,
      },
    ])

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userMessageIndex: 1,
        targetUserMessageId: targetUserId,
        expectedContent: 'second visible prompt',
      }),
    })
    expect(executeRes.status).toBe(200)

    const executeBody = await executeRes.json() as {
      target: { targetUserMessageId: string; userMessageIndex: number }
      conversation: { messagesRemoved: number; removedMessageIds: string[] }
    }
    expect(executeBody.target.targetUserMessageId).toBe(targetUserId)
    expect(executeBody.target.userMessageIndex).toBe(2)
    expect(executeBody.conversation.messagesRemoved).toBe(2)
    expect(executeBody.conversation.removedMessageIds).toEqual([
      targetUserId,
      targetAssistantId,
    ])

    const remainingMessages = await service.getSessionMessages(sessionId)
    expect(remainingMessages.map((message) => message.id)).toEqual([
      firstUserId,
      firstAssistantId,
      hiddenUserId,
    ])
  })

  it('POST /api/sessions/:id/rewind should reject an index fallback when the selected prompt no longer matches', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-000000000000'
    const firstUserId = crypto.randomUUID()
    const hiddenUserId = crypto.randomUUID()
    const targetUserId = crypto.randomUUID()

    await writeSessionFile('-tmp-api-rewind-index-guard', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('first prompt', firstUserId),
      makeUserEntry(
        '<teammate-message teammate_id="reviewer">internal status that the main chat hides</teammate-message>',
        hiddenUserId,
      ),
      makeUserEntry('second visible prompt', targetUserId),
    ])

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userMessageIndex: 1,
        expectedContent: 'second visible prompt',
      }),
    })
    expect(executeRes.status).toBe(400)

    const body = await executeRes.json() as { message: string }
    expect(body.message).toContain('does not match the selected prompt')

    const remainingMessages = await service.getSessionMessages(sessionId)
    expect(remainingMessages.map((message) => message.id)).toEqual([
      firstUserId,
      hiddenUserId,
      targetUserId,
    ])
  })

  it('POST /api/sessions/:id/rewind should restore a single edited file', async () => {
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
    const workDir = path.join(tmpDir, 'single-file-fixture')
    const targetFile = path.join(workDir, 'src', 'app.js')
    const userId = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    const backupName = 'single-file@v1'

    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.writeFile(
      targetFile,
      "export const ORIGINAL_VALUE = 'after-rewind'\n",
      'utf-8',
    )
    await writeFileHistoryBackup(
      sessionId,
      backupName,
      "export const ORIGINAL_VALUE = 'before-rewind'\n",
    )

    await writeSessionFile('-tmp-api-single-file', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src/app.js': {
          backupFileName: backupName,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('edit app.js', userId),
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantEntry('DONE', userId),
        uuid: assistantId,
      },
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)
    const preview = await previewRes.json() as {
      code: { available: boolean; filesChanged: string[] }
    }
    expect(preview.code.available).toBe(true)
    expect(preview.code.filesChanged).toEqual([targetFile])

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0 }),
    })
    expect(executeRes.status).toBe(200)
    expect(await fs.readFile(targetFile, 'utf-8')).toBe(
      "export const ORIGINAL_VALUE = 'before-rewind'\n",
    )

    const remainingMessages = await service.getSessionMessages(sessionId)
    expect(remainingMessages).toHaveLength(0)
  })

  it('POST /api/sessions/:id/rewind should resolve checkpoint paths from the target prompt cwd', async () => {
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-ffffffffffff'
    const parentDir = path.join(tmpDir, 'nested-cwd-parent')
    const workDir = path.join(parentDir, 'testbb')
    const targetFile = path.join(workDir, 'vite.config.js')
    const userId = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    const laterUserId = crypto.randomUUID()
    const backupName = 'nested-cwd@v1'

    await fs.mkdir(workDir, { recursive: true })
    await fs.writeFile(targetFile, "export default 'after'\n", 'utf-8')
    await writeFileHistoryBackup(sessionId, backupName, "export default 'before'\n")

    await writeSessionFile(sanitizePath(parentDir), sessionId, [
      makeFileHistorySnapshotEntry(userId, {
        'testbb/vite.config.js': {
          backupFileName: backupName,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('create a nested project', userId),
        cwd: parentDir,
        sessionId,
      },
      {
        ...makeAssistantEntry('DONE', userId),
        uuid: assistantId,
      },
      {
        ...makeUserEntry('latest tool result after cd', laterUserId),
        cwd: workDir,
        sessionId,
      },
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)
    const preview = await previewRes.json() as {
      code: { available: boolean; filesChanged: string[] }
    }
    expect(preview.code.available).toBe(true)
    expect(preview.code.filesChanged).toEqual([targetFile])

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0 }),
    })
    expect(executeRes.status).toBe(200)
    expect(await fs.readFile(targetFile, 'utf-8')).toBe("export default 'before'\n")
  })

  it('POST /api/sessions/:id/rewind should restore multiple files and remove created files', async () => {
    const sessionId = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee'
    const workDir = path.join(tmpDir, 'multi-file-fixture')
    const appFile = path.join(workDir, 'src', 'app.js')
    const readmeFile = path.join(workDir, 'README.md')
    const createdFile = path.join(workDir, 'notes', 'generated.txt')
    const userId = crypto.randomUUID()
    const backupApp = 'multi-app@v1'
    const backupReadme = 'multi-readme@v1'

    await fs.mkdir(path.dirname(appFile), { recursive: true })
    await fs.mkdir(path.dirname(createdFile), { recursive: true })
    await fs.writeFile(appFile, "export const VALUE = 'edited'\n", 'utf-8')
    await fs.writeFile(readmeFile, '# changed\n', 'utf-8')
    await fs.writeFile(createdFile, 'new file\n', 'utf-8')
    await writeFileHistoryBackup(sessionId, backupApp, "export const VALUE = 'original'\n")
    await writeFileHistoryBackup(sessionId, backupReadme, '# original\n')

    await writeSessionFile('-tmp-api-multi-file', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(userId, {
        'src/app.js': {
          backupFileName: backupApp,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'README.md': {
          backupFileName: backupReadme,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'notes/generated.txt': {
          backupFileName: null,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('edit multiple files', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', userId),
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)
    const preview = await previewRes.json() as {
      code: { available: boolean; filesChanged: string[] }
    }
    expect(preview.code.available).toBe(true)
    expect(preview.code.filesChanged.sort()).toEqual([
      appFile,
      createdFile,
      readmeFile,
    ].sort())

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0 }),
    })
    expect(executeRes.status).toBe(200)

    expect(await fs.readFile(appFile, 'utf-8')).toBe("export const VALUE = 'original'\n")
    expect(await fs.readFile(readmeFile, 'utf-8')).toBe('# original\n')
    await expect(fs.stat(createdFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('POST /api/sessions/:id/rewind should restore the previous version when rewinding the second edit of the same file', async () => {
    const sessionId = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee'
    const workDir = path.join(tmpDir, 'same-file-two-turns')
    const targetFile = path.join(workDir, 'src', 'app.js')
    const firstUserId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const backupV1 = 'same-file@v1'
    const backupV2 = 'same-file@v2'

    await fs.mkdir(path.dirname(targetFile), { recursive: true })
    await fs.writeFile(targetFile, "export const STEP = 'v2'\n", 'utf-8')
    await writeFileHistoryBackup(sessionId, backupV1, "export const STEP = 'base'\n")
    await writeFileHistoryBackup(sessionId, backupV2, "export const STEP = 'v1'\n")

    await writeSessionFile('-tmp-api-two-turns', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(firstUserId, {
        'src/app.js': {
          backupFileName: backupV1,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('make v1', firstUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', firstUserId),
      makeFileHistorySnapshotEntry(secondUserId, {
        'src/app.js': {
          backupFileName: backupV2,
          version: 2,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('make v2', secondUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', secondUserId),
    ])

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1 }),
    })
    expect(executeRes.status).toBe(200)
    expect(await fs.readFile(targetFile, 'utf-8')).toBe("export const STEP = 'v1'\n")

    const remainingMessages = await service.getSessionMessages(sessionId)
    expect(remainingMessages.map((message) => message.id)).toHaveLength(2)
    expect(remainingMessages[0]?.id).toBe(firstUserId)
  })

  it('POST /api/sessions/:id/rewind should keep first-turn file state when undoing only the latest turn', async () => {
    const sessionId = 'dddddddd-bbbb-cccc-dddd-ffffffffffff'
    const workDir = path.join(tmpDir, 'two-turns-separate-files')
    const firstTurnFile = path.join(workDir, 'src', 'first.js')
    const secondTurnFile = path.join(workDir, 'src', 'second.js')
    const firstUserId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const firstBaseBackup = 'separate-first@v1'
    const firstAfterTurnBackup = 'separate-first@v2'
    const secondBaseBackup = 'separate-second@v1'

    await fs.mkdir(path.dirname(firstTurnFile), { recursive: true })
    await fs.writeFile(firstTurnFile, "export const FIRST = 'v1'\n", 'utf-8')
    await fs.writeFile(secondTurnFile, "export const SECOND = 'v2'\n", 'utf-8')
    await writeFileHistoryBackup(sessionId, firstBaseBackup, "export const FIRST = 'base'\n")
    await writeFileHistoryBackup(sessionId, firstAfterTurnBackup, "export const FIRST = 'v1'\n")
    await writeFileHistoryBackup(sessionId, secondBaseBackup, "export const SECOND = 'base'\n")

    await writeSessionFile('-tmp-api-two-turns-separate-files', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(firstUserId, {
        'src/first.js': {
          backupFileName: firstBaseBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('make first file v1', firstUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE first', firstUserId),
      makeFileHistorySnapshotEntry(secondUserId, {
        'src/first.js': {
          backupFileName: firstAfterTurnBackup,
          version: 2,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'src/second.js': {
          backupFileName: secondBaseBackup,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('make second file v2', secondUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE second', secondUserId),
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)
    const preview = await previewRes.json() as {
      code: { available: boolean; filesChanged: string[] }
    }
    expect(preview.code.available).toBe(true)
    expect(preview.code.filesChanged).toEqual([secondTurnFile])

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1 }),
    })
    expect(executeRes.status).toBe(200)

    expect(await fs.readFile(firstTurnFile, 'utf-8')).toBe("export const FIRST = 'v1'\n")
    expect(await fs.readFile(secondTurnFile, 'utf-8')).toBe("export const SECOND = 'base'\n")

    const remainingMessages = await service.getSessionMessages(sessionId)
    expect(remainingMessages).toHaveLength(2)
    expect(remainingMessages[0]?.id).toBe(firstUserId)
  })

  it('POST /api/sessions/:id/rewind should include files created after the first turn', async () => {
    const sessionId = 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee'
    const workDir = path.join(tmpDir, 'created-on-second-turn')
    const firstFile = path.join(workDir, 'src', 'step.js')
    const createdFile = path.join(workDir, 'notes', 'generated.txt')
    const firstUserId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const backupV1 = 'second-created-step@v1'
    const backupV2 = 'second-created-step@v2'

    await fs.mkdir(path.dirname(firstFile), { recursive: true })
    await fs.mkdir(path.dirname(createdFile), { recursive: true })
    await fs.writeFile(firstFile, "export const STEP = 'v2'\n", 'utf-8')
    await fs.writeFile(createdFile, 'generated\n', 'utf-8')
    await writeFileHistoryBackup(sessionId, backupV1, "export const STEP = 'base'\n")
    await writeFileHistoryBackup(sessionId, backupV2, "export const STEP = 'v1'\n")

    await writeSessionFile('-tmp-api-second-turn-created', sessionId, [
      makeSessionMetaEntry(workDir),
      makeFileHistorySnapshotEntry(firstUserId, {
        'src/step.js': {
          backupFileName: backupV1,
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('make v1', firstUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', firstUserId),
      makeFileHistorySnapshotEntry(secondUserId, {
        'src/step.js': {
          backupFileName: backupV2,
          version: 2,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
        'notes/generated.txt': {
          backupFileName: null,
          version: 2,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('make v2 and create file', secondUserId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantEntry('DONE', secondUserId),
    ])

    const previewRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1, dryRun: true }),
    })
    expect(previewRes.status).toBe(200)
    const preview = await previewRes.json() as {
      code: { available: boolean; filesChanged: string[]; insertions: number }
    }
    expect(preview.code.filesChanged.sort()).toEqual([
      createdFile,
      firstFile,
    ].sort())
    expect(preview.code.insertions).toBe(2)

    const executeRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1 }),
    })
    expect(executeRes.status).toBe(200)
    expect(await fs.readFile(firstFile, 'utf-8')).toBe("export const STEP = 'v1'\n")
    await expect(fs.stat(createdFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('GET /api/sessions/:id/turn-checkpoints should list completed turn previews with turn-bound diff stats', async () => {
    const fixture = await createThreeTurnCheckpointFixture(
      '99999999-bbbb-cccc-dddd-eeeeeeeeeeee',
    )

    const res = await fetch(`${baseUrl}/api/sessions/${fixture.sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)

    const body = await res.json() as {
      checkpoints: Array<{
        target: {
          targetUserMessageId: string
          userMessageIndex: number
          userMessageCount: number
        }
        conversation: { messagesRemoved: number }
        code: {
          available: boolean
          filesChanged: string[]
          insertions: number
          deletions: number
        }
        workDir: string
      }>
    }

    expect(body.checkpoints).toHaveLength(3)
    expect(body.checkpoints).toEqual([
      {
        target: {
          targetUserMessageId: fixture.firstUserId,
          userMessageIndex: 0,
          userMessageCount: 3,
        },
        conversation: { messagesRemoved: 6 },
        code: {
          available: true,
          filesChanged: [fixture.stepFile],
          insertions: 1,
          deletions: 1,
        },
        workDir: fixture.workDir,
      },
      {
        target: {
          targetUserMessageId: fixture.secondUserId,
          userMessageIndex: 1,
          userMessageCount: 3,
        },
        conversation: { messagesRemoved: 4 },
        code: {
          available: true,
          filesChanged: [fixture.stepFile],
          insertions: 1,
          deletions: 1,
        },
        workDir: fixture.workDir,
      },
      {
        target: {
          targetUserMessageId: fixture.thirdUserId,
          userMessageIndex: 2,
          userMessageCount: 3,
        },
        conversation: { messagesRemoved: 2 },
        code: {
          available: true,
          filesChanged: [fixture.stepFile, fixture.createdFile],
          insertions: 2,
          deletions: 1,
        },
        workDir: fixture.workDir,
      },
    ])
  })

  it('GET /api/sessions/:id/turn-checkpoints/diff should return target-bound checkpoint diffs', async () => {
    const fixture = await createThreeTurnCheckpointFixture(
      '99999999-bbbb-cccc-dddd-ffffffffffff',
    )

    const secondTurnRes = await fetch(
      `${baseUrl}/api/sessions/${fixture.sessionId}/turn-checkpoints/diff?targetUserMessageId=${fixture.secondUserId}&path=src/step.js`,
    )
    expect(secondTurnRes.status).toBe(200)
    const secondTurnBody = await secondTurnRes.json() as {
      state: string
      path: string
      diff?: string
      target: { targetUserMessageId: string }
    }
    expect(secondTurnBody.target.targetUserMessageId).toBe(fixture.secondUserId)
    expect(secondTurnBody.state).toBe('ok')
    expect(secondTurnBody.path).toBe('src/step.js')
    expect(secondTurnBody.diff).toContain("export const STEP = 'v2'")
    expect(secondTurnBody.diff).toContain("export const STEP = 'v1'")
    expect(secondTurnBody.diff).not.toContain("export const STEP = 'v3'")

    const thirdTurnRes = await fetch(
      `${baseUrl}/api/sessions/${fixture.sessionId}/turn-checkpoints/diff?targetUserMessageId=${fixture.thirdUserId}&path=src/step.js`,
    )
    expect(thirdTurnRes.status).toBe(200)
    const thirdTurnBody = await thirdTurnRes.json() as {
      state: string
      diff?: string
      target: { targetUserMessageId: string }
    }
    expect(thirdTurnBody.target.targetUserMessageId).toBe(fixture.thirdUserId)
    expect(thirdTurnBody.state).toBe('ok')
    expect(thirdTurnBody.diff).toContain("export const STEP = 'v3'")
    expect(thirdTurnBody.diff).toContain("export const STEP = 'v2'")
    expect(thirdTurnBody.diff).not.toContain("export const STEP = 'v1'")

    const createdFileRes = await fetch(
      `${baseUrl}/api/sessions/${fixture.sessionId}/turn-checkpoints/diff?targetUserMessageId=${fixture.thirdUserId}&path=notes/generated.txt`,
    )
    expect(createdFileRes.status).toBe(200)
    const createdFileBody = await createdFileRes.json() as {
      state: string
      diff?: string
    }
    expect(createdFileBody.state).toBe('ok')
    expect(createdFileBody.diff).toContain('generated third turn')
    expect(createdFileBody.diff).toContain('/dev/null')
  })

  it('GET /api/sessions/:id/turn-checkpoints should fall back to transcript tool changes when file snapshots are missing', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000001'
    const workDir = path.join(tmpDir, 'transcript-only-session')
    const userId = crypto.randomUUID()
    await fs.mkdir(path.join(workDir, 'todo-app', 'src'), { recursive: true })

    await writeSessionFile('-tmp-transcript-only-session', sessionId, [
      makeSessionMetaEntry(workDir),
      {
        ...makeUserEntry('build a todo app', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([
        {
          id: 'Write:1',
          name: 'Write',
          input: {
            file_path: path.join(workDir, 'todo-app', 'src', 'App.tsx'),
            content: 'export function App() {\n  return <main>Todo</main>\n}\n',
          },
        },
        {
          id: 'Write:2',
          name: 'Write',
          input: {
            file_path: 'todo-app/vite.config.ts',
            content: 'import { defineConfig } from "vite"\nexport default defineConfig({})\n',
          },
        },
      ], userId),
      makeAssistantEntry('Todo app created', userId),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{
        target: { targetUserMessageId: string }
        code: {
          available: boolean
          filesChanged: string[]
          insertions: number
          deletions: number
        }
        workDir: string
      }>
    }

    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]!.target.targetUserMessageId).toBe(userId)
    expect(body.checkpoints[0]!.workDir).toBe(workDir)
    expect(body.checkpoints[0]!.code.available).toBe(true)
    expect(body.checkpoints[0]!.code.filesChanged.sort()).toEqual([
      path.join(workDir, 'todo-app', 'src', 'App.tsx'),
      path.join(workDir, 'todo-app', 'vite.config.ts'),
    ].sort())
    expect(body.checkpoints[0]!.code.insertions).toBe(5)
    expect(body.checkpoints[0]!.code.deletions).toBe(0)
  })

  it('GET /api/sessions/:id/turn-checkpoints/diff should return transcript tool diffs when file snapshots are missing', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000002'
    const workDir = path.join(tmpDir, 'transcript-only-diff-session')
    const userId = crypto.randomUUID()

    await writeSessionFile('-tmp-transcript-only-diff-session', sessionId, [
      makeSessionMetaEntry(workDir),
      {
        ...makeUserEntry('edit config', userId),
        cwd: workDir,
        sessionId,
      },
      makeAssistantToolUseEntry([
        {
          id: 'Edit:1',
          name: 'Edit',
          input: {
            file_path: path.join(workDir, 'todo-app', 'vite.config.ts'),
            old_string: 'plugins: [react()]',
            new_string: 'plugins: [react(), tailwindcss()]',
          },
        },
      ], userId),
      makeAssistantEntry('Config updated', userId),
    ])

    const res = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/turn-checkpoints/diff?targetUserMessageId=${userId}&path=${encodeURIComponent('todo-app/vite.config.ts')}`,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as {
      state: string
      path: string
      diff?: string
      target: { targetUserMessageId: string }
    }

    expect(body.target.targetUserMessageId).toBe(userId)
    expect(body.state).toBe('ok')
    expect(body.path).toBe('todo-app/vite.config.ts')
    expect(body.diff).toContain('diff --session a/todo-app/vite.config.ts b/todo-app/vite.config.ts')
    expect(body.diff).toContain('-plugins: [react()]')
    expect(body.diff).toContain('+plugins: [react(), tailwindcss()]')
  })

  it('GET /api/sessions/:id/turn-checkpoints should include subagent transcript file changes for the parent turn', async () => {
    const sessionId = '99999999-bbbb-cccc-dddd-000000000003'
    const workDir = path.join(tmpDir, 'transcript-subagent-session')
    const firstUserId = crypto.randomUUID()
    const secondUserId = crypto.randomUUID()
    const agentMessageId = crypto.randomUUID()
    await fs.mkdir(path.join(workDir, 'todo-app', 'src'), { recursive: true })

    await writeSessionFile('-tmp-transcript-subagent-session', sessionId, [
      makeSessionMetaEntry(workDir),
      {
        ...makeUserEntry('build a todo app', firstUserId),
        cwd: workDir,
        sessionId,
      },
      {
        parentUuid: firstUserId,
        isSidechain: false,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'Agent:todo',
            name: 'Agent',
            input: { description: 'Create todo app files' },
          }],
        },
        uuid: agentMessageId,
        timestamp: '2026-01-01T00:02:00.000Z',
      },
      {
        ...makeUserEntry('now explain it', secondUserId),
        parentUuid: agentMessageId,
        cwd: workDir,
        sessionId,
      },
      {
        parentUuid: agentMessageId,
        isSidechain: true,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'Write:child',
            name: 'Write',
            input: {
              file_path: path.join(workDir, 'todo-app', 'src', 'Board.tsx'),
              content: 'export function Board() {\n  return null\n}\n',
            },
          }],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:03:00.000Z',
      },
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/turn-checkpoints`)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      checkpoints: Array<{
        target: { targetUserMessageId: string }
        code: { filesChanged: string[]; insertions: number; deletions: number }
      }>
    }

    expect(body.checkpoints).toHaveLength(1)
    expect(body.checkpoints[0]!.target.targetUserMessageId).toBe(firstUserId)
    expect(body.checkpoints[0]!.code.filesChanged).toEqual([
      path.join(workDir, 'todo-app', 'src', 'Board.tsx'),
    ])
    expect(body.checkpoints[0]!.code.insertions).toBe(3)
    expect(body.checkpoints[0]!.code.deletions).toBe(0)
  })

  it('POST /api/sessions/:id/rewind should restore the base state when rewinding the first turn of a three-turn file history', async () => {
    const fixture = await createThreeTurnCheckpointFixture(
      'aaaaaaaa-1111-2222-3333-444444444444',
    )

    const executeRes = await fetch(`${baseUrl}/api/sessions/${fixture.sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 0 }),
    })
    expect(executeRes.status).toBe(200)

    expect(await fs.readFile(fixture.stepFile, 'utf-8')).toBe("export const STEP = 'base'\n")
    await expect(fs.stat(fixture.createdFile)).rejects.toMatchObject({ code: 'ENOENT' })

    const remainingMessages = await service.getSessionMessages(fixture.sessionId)
    expect(remainingMessages).toHaveLength(0)
  })

  it('POST /api/sessions/:id/rewind should keep the first turn and remove later file changes when rewinding the second turn of a three-turn history', async () => {
    const fixture = await createThreeTurnCheckpointFixture(
      'aaaaaaaa-5555-6666-7777-888888888888',
    )

    const executeRes = await fetch(`${baseUrl}/api/sessions/${fixture.sessionId}/rewind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessageIndex: 1 }),
    })
    expect(executeRes.status).toBe(200)

    expect(await fs.readFile(fixture.stepFile, 'utf-8')).toBe("export const STEP = 'v1'\n")
    await expect(fs.stat(fixture.createdFile)).rejects.toMatchObject({ code: 'ENOENT' })

    const remainingMessages = await service.getSessionMessages(fixture.sessionId)
    expect(remainingMessages).toHaveLength(2)
    expect(remainingMessages[0]?.id).toBe(fixture.firstUserId)
    expect(remainingMessages[1]?.type).toBe('assistant')
  })

  // --------------------------------------------------------------------------
  // Conversations API via /api/sessions/:id/chat
  // --------------------------------------------------------------------------

  it('GET /api/sessions/:id/chat/status should return idle by default', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat/status`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { state: string }
    expect(body.state).toBe('idle')
  })

  it('POST /api/sessions/:id/chat should queue a message', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-api-test', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Previous'),
    ])

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'New question' }),
    })
    expect(res.status).toBe(202)

    const body = (await res.json()) as { messageId: string; status: string }
    expect(body.status).toBe('queued')
    expect(body.messageId).toBeTruthy()
  })

  it('POST /api/sessions/:id/chat/stop should reset state to idle', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat/stop`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)

    // Verify state is idle
    const statusRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/chat/status`)
    const status = (await statusRes.json()) as { state: string }
    expect(status.state).toBe('idle')
  })
})
