/**
 * ConversationService — CLI subprocess manager
 *
 * Each desktop session owns one CLI subprocess. The subprocess talks back to
 * the desktop server over the SDK WebSocket bridge, while the desktop UI talks
 * to the server over its own client WebSocket.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProviderService } from './providerService.js'
import {
  OPENAI_CODEX_OAUTH_FILE_ENV_KEY,
  OPENAI_OAUTH_PROVIDER_ENV_KEY,
} from './openaiOfficialProvider.js'
import { sessionService } from './sessionService.js'
import { diagnosticsService } from './diagnosticsService.js'
import {
  isMaterializedWorktreeLaunch,
  prepareSessionWorkspace,
  shouldCreateWorktreeForSessionLaunch,
  type PreparedSessionWorkspace,
} from './repositoryLaunchService.js'
import {
  buildClaudeCliArgs,
  resolveClaudeCliLauncher,
} from '../../utils/desktopBundledCli.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { sanitizePath } from '../../utils/path.js'
import { getProcessEnvWithTerminalShellEnvironment } from '../../utils/terminalShellEnvironment.js'
import { attributionHeaderEnvForModel } from './attributionHeaderPolicy.js'
import { buildNetworkEnvironment, loadNetworkSettings } from './networkSettings.js'

const MAX_CAPTURED_PROCESS_LINES = 80
const MAX_CAPTURED_SDK_MESSAGES = 40
const MAX_CAPTURED_SDK_SUMMARY = 20
const CONTROL_READY_POLL_MS = 50
const AUTO_MEMORY_DIRNAME = 'memory'

type AttachmentRef = {
  type: 'file' | 'image'
  name?: string
  path?: string
  data?: string
  mimeType?: string
  isDirectory?: boolean
}

type SessionProcess = {
  proc: ReturnType<typeof Bun.spawn>
  outputCallbacks: Array<(msg: any) => void>
  workDir: string
  permissionMode: string
  sdkToken: string
  sdkSocket: { send(data: string): void } | null
  pendingOutbound: string[]
  startupPending: boolean
  startupExitCode: number | null
  stdoutLines: string[]
  stderrLines: string[]
  outputDrain: Promise<void>
  sdkMessages: any[]
  initMessage: any | null
  pendingPermissionRequests: Map<
    string,
    {
      toolName: string
      toolUseId?: string
      description?: string
      input: Record<string, unknown>
      permissionSuggestions?: unknown[]
    }
  >
}

export type PendingPermissionRequest = {
  requestId: string
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  description?: string
}

type SessionStartOptions = {
  permissionMode?: string
  model?: string
  effort?: string
  thinking?: 'enabled' | 'adaptive' | 'disabled'
  providerId?: string | null
}

export class ConversationStartupError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'WORKDIR_INVALID'
      | 'CLI_AUTH_REQUIRED'
      | 'CLI_SESSION_CONFLICT'
      | 'CLI_START_FAILED'
      | 'CLI_SPAWN_FAILED'
      | 'SESSION_DELETED',
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ConversationStartupError'
  }
}

export class ConversationService {
  private sessions = new Map<string, SessionProcess>()
  private deletedSessions = new Set<string>()
  private deletedSessionTimestamps = new Map<string, number>()
  private static readonly DELETED_SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
  private providerService = new ProviderService()

  private buildSessionCliArgs(
    sessionId: string,
    sdkUrl: string,
    shouldResume: boolean,
    options?: SessionStartOptions,
    repository?: PreparedSessionWorkspace['repository'],
  ): string[] {
    const dangerousMode = process.env.CLAUDE_DANGEROUS_MODE === '1'
    const worktreeArgs =
      !shouldResume && repository?.worktree
        ? [
            '--worktree',
            repository.worktreeSlug || repository.worktreeBranch || repository.branch,
            '--worktree-base-ref',
            repository.baseRef,
          ]
        : []

    return this.resolveCliArgs([
      '--print',
      '--verbose',
      '--sdk-url',
      sdkUrl,
      '--enable-auth-status',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      // Desktop chat depends on partial assistant deltas; without this the
      // server only sees the completed assistant message at turn end.
      '--include-partial-messages',
      ...(shouldResume ? ['--resume', sessionId] : ['--session-id', sessionId]),
      ...worktreeArgs,
      '--replay-user-messages',
      ...this.getRuntimeArgs(options),
      ...this.getPermissionArgs(options?.permissionMode, dangerousMode),
    ])
  }

  async startSession(
    sessionId: string,
    workDir: string,
    sdkUrl: string,
    options?: SessionStartOptions,
  ): Promise<void> {
    if (this.deletedSessions.has(sessionId)) {
      throw new ConversationStartupError(
        `Session was deleted before startup completed: ${sessionId}`,
        'SESSION_DELETED',
      )
    }
    if (this.sessions.has(sessionId)) return

    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    const shouldResume = !!launchInfo && launchInfo.transcriptMessageCount > 0
    const shouldReplacePlaceholder =
      !!launchInfo && launchInfo.transcriptMessageCount === 0
    const shouldCreateWorktree =
      !!launchInfo && shouldCreateWorktreeForSessionLaunch(launchInfo)
    const hasMaterializedWorktree =
      !!launchInfo && isMaterializedWorktreeLaunch(launchInfo)

    if (this.deletedSessions.has(sessionId)) {
      throw new ConversationStartupError(
        `Session was deleted before startup completed: ${sessionId}`,
        'SESSION_DELETED',
      )
    }

    if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
      throw new ConversationStartupError(
        `Working directory does not exist or is not a directory: ${workDir}`,
        'WORKDIR_INVALID',
      )
    }

    if (shouldReplacePlaceholder) {
      await sessionService.clearSessionTranscript(sessionId, workDir)
    }

    let launchWorkDir = workDir
    let launchRepository = launchInfo?.repository
    if (shouldCreateWorktree && launchRepository?.worktree) {
      launchWorkDir = launchRepository.requestedWorkDir || launchRepository.repoRoot || workDir
    } else if (!shouldResume && launchRepository && !hasMaterializedWorktree) {
      const preparedWorkspace = await prepareSessionWorkspace(
        workDir,
        {
          branch: launchRepository.branch,
          worktree: false,
        },
        sessionId,
      )
      launchWorkDir = preparedWorkspace.workDir
      launchRepository = preparedWorkspace.repository
    }

    if (!shouldCreateWorktree && launchRepository?.worktree) {
      launchRepository = {
        ...launchRepository,
        worktree: false,
      }
    }

    if (!fs.existsSync(launchWorkDir) || !fs.statSync(launchWorkDir).isDirectory()) {
      throw new ConversationStartupError(
        `Working directory does not exist or is not a directory: ${launchWorkDir}`,
        'WORKDIR_INVALID',
      )
    }

    const args = this.buildSessionCliArgs(
      sessionId,
      sdkUrl,
      shouldResume,
      options,
      launchRepository,
    )

    console.log(
      `[ConversationService] Starting CLI for ${sessionId}, cwd: ${launchWorkDir} (process.cwd()=${process.cwd()}, CALLER_DIR will be pinned to workDir)`,
    )

    // IMPORTANT (Bug#5): 必须覆盖子进程继承的 CALLER_DIR / PWD。
    // preload.ts 顶层读 process.env.CALLER_DIR 并调用 process.chdir(CALLER_DIR)。
    // 在 bundled 桌面端里，server sidecar 被 Tauri 从 cwd=/ 启动，claude-sidecar.ts
    // 在 server/cli 模式入口把 CALLER_DIR 默认设成 process.cwd()（即 '/'），
    // 随后这个 env 被完整继承到 Bun.spawn 的 CLI 子进程；即使这里显式传了
    // cwd: workDir，CLI 子进程里 preload.ts 还是会 chdir('/')，结果把
    // STATE.cwd / "Primary working directory" 打回根目录，IM 会话里 AI 感知的
    // 工作目录就变成 `/`。把 CALLER_DIR / PWD 显式覆盖成 workDir，preload.ts
    // chdir 后落到正确目录。
    //
    const childEnv = await this.buildChildEnv(launchWorkDir, sdkUrl, options)

    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(args, {
        cwd: launchWorkDir,
        env: childEnv,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch (spawnErr) {
      void diagnosticsService.recordEvent({
        type: 'cli_spawn_failed',
        severity: 'error',
        sessionId,
        summary: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
        details: {
          workDir,
          permissionMode: options?.permissionMode || 'default',
          providerId: options?.providerId ?? null,
          model: options?.model ?? null,
          error: spawnErr,
        },
      })
      throw new ConversationStartupError(
        `Failed to spawn CLI in ${launchWorkDir}: ${
          spawnErr instanceof Error ? spawnErr.message : String(spawnErr)
        }`,
        'CLI_SPAWN_FAILED',
      )
    }

    const session: SessionProcess = {
      proc,
      outputCallbacks: [],
      workDir: launchWorkDir,
      permissionMode: options?.permissionMode || 'default',
      sdkToken: this.getSdkTokenFromUrl(sdkUrl),
      sdkSocket: null,
      pendingOutbound: [],
      startupPending: true,
      startupExitCode: null,
      stdoutLines: [],
      stderrLines: [],
      outputDrain: Promise.resolve(),
      sdkMessages: [],
      initMessage: null,
      pendingPermissionRequests: new Map(),
    }
    this.sessions.set(sessionId, session)

    session.outputDrain = Promise.all([
      this.readProcessOutputStream(sessionId, proc.stdout, 'stdout'),
      this.readProcessOutputStream(sessionId, proc.stderr, 'stderr'),
    ]).then(() => undefined)

    proc.exited.then((code) => {
      void this.handleProcessExit(sessionId, proc, code)
    })

    const STARTUP_GRACE_MS = 3000
    const earlyExitCode = await Promise.race([
      proc.exited,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), STARTUP_GRACE_MS),
      ),
    ])

    const startupExitCode = earlyExitCode ?? session.startupExitCode
    if (startupExitCode !== null) {
      await this.waitForProcessOutputDrain(session)
      const startupError = this.buildStartupError(sessionId, startupExitCode)
      this.sessions.delete(sessionId)

      if (this.clearStaleLock(sessionId)) {
        console.log(
          `[ConversationService] Removed stale lock for ${sessionId}, retrying...`,
        )
        return this.startSession(sessionId, workDir, sdkUrl, options)
      }

      console.error(
        `[ConversationService] CLI exited with code ${startupExitCode} for ${sessionId}: ${startupError.message}`,
      )
      void diagnosticsService.recordEvent({
        type: 'cli_start_failed',
        severity: 'error',
        sessionId,
        summary: startupError.message,
        details: {
          code: startupError.code,
          exitCode: startupExitCode,
          retryable: startupError.retryable,
          workDir: launchWorkDir,
          permissionMode: options?.permissionMode || 'default',
          providerId: options?.providerId ?? null,
          model: options?.model ?? null,
          capturedOutput: this.buildCapturedProcessOutputDetail(session),
          sdkMessages: this.summarizeSdkMessages(session.sdkMessages),
        },
      })
      throw startupError
    }

    session.startupPending = false

    if (shouldReplacePlaceholder || !launchInfo) {
      await sessionService.appendSessionMetadata(sessionId, {
        workDir: launchWorkDir,
        customTitle: launchInfo?.customTitle ?? null,
        repository: launchRepository,
      })
    }

    console.log(`[ConversationService] CLI started successfully for ${sessionId}`)
  }

  onOutput(sessionId: string, callback: (msg: any) => void): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.outputCallbacks.push(callback)
    }
  }

  clearOutputCallbacks(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.outputCallbacks = []
    }
  }

  removeOutputCallback(sessionId: string, callback: (msg: any) => void): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.outputCallbacks = session.outputCallbacks.filter((entry) => entry !== callback)
  }

  getRecentSdkMessages(sessionId: string): any[] {
    return [...(this.sessions.get(sessionId)?.sdkMessages ?? [])]
  }

  getSessionInitMessage(sessionId: string): any | null {
    return this.sessions.get(sessionId)?.initMessage ?? null
  }

  sendMessage(
    sessionId: string,
    content: string,
    attachments?: AttachmentRef[],
  ): boolean {
    return this.sendSdkMessage(sessionId, {
      type: 'user',
      message: {
        role: 'user',
        content: this.buildUserContent(content, sessionId, attachments),
      },
      parent_tool_use_id: null,
      session_id: '',
    })
  }

  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    rule?: string,
    updatedInput?: Record<string, unknown>,
  ): boolean {
    const session = this.sessions.get(sessionId)
    const pendingRequest = session?.pendingPermissionRequests.get(requestId)
    if (session) {
      session.pendingPermissionRequests.delete(requestId)
    }

    return this.sendSdkMessage(sessionId, {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allowed
          ? {
              behavior: 'allow',
              updatedInput: updatedInput ?? {},
              ...(rule === 'always' && pendingRequest
                ? {
                    updatedPermissions: [
                      ...normalizeSessionPermissionUpdates(
                        pendingRequest.permissionSuggestions,
                        pendingRequest.toolName,
                      ),
                    ],
                  }
                : {}),
            }
          : { behavior: 'deny', message: 'User denied via UI' },
      },
    })
  }

  setPermissionMode(sessionId: string, mode: string): boolean {
    return this.sendSdkMessage(sessionId, {
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: {
        subtype: 'set_permission_mode',
        mode,
      },
    })
  }

  setMaxThinkingTokens(sessionId: string, maxThinkingTokens: number | null): boolean {
    return this.sendSdkMessage(sessionId, {
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: {
        subtype: 'set_max_thinking_tokens',
        max_thinking_tokens: maxThinkingTokens,
      },
    })
  }

  setMaxThinkingTokensForActiveSessions(maxThinkingTokens: number | null): number {
    let sent = 0
    for (const sessionId of this.getActiveSessions()) {
      if (this.setMaxThinkingTokens(sessionId, maxThinkingTokens)) {
        sent += 1
      }
    }
    return sent
  }

  sendInterrupt(sessionId: string): boolean {
    return this.sendSdkMessage(sessionId, {
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: { subtype: 'interrupt' },
    })
  }

  private isControlChannelReady(session: SessionProcess): boolean {
    return Boolean(session.sdkSocket)
  }

  private async waitForControlChannelReady(
    sessionId: string,
    timeoutMs: number,
  ): Promise<void> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      const session = this.sessions.get(sessionId)
      if (!session) {
        throw new Error('CLI session is not running')
      }
      if (this.isControlChannelReady(session)) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, CONTROL_READY_POLL_MS))
    }

    throw new Error('Timed out waiting for CLI control channel to become ready')
  }

  async requestControl(
    sessionId: string,
    request: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    if (!this.sessions.has(sessionId)) {
      return Promise.reject(new Error('CLI session is not running'))
    }

    const startedAt = Date.now()
    await this.waitForControlChannelReady(sessionId, timeoutMs)
    const responseTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeOutputCallback(sessionId, handleOutput)
        reject(new Error(`Timed out waiting for ${String(request.subtype ?? 'control')} response`))
      }, responseTimeoutMs)

      const finish = (fn: () => void) => {
        clearTimeout(timeout)
        this.removeOutputCallback(sessionId, handleOutput)
        fn()
      }

      const handleOutput = (msg: any) => {
        if (
          msg?.type !== 'control_response' ||
          msg.response?.request_id !== requestId
        ) {
          return
        }

        if (msg.response.subtype === 'error') {
          finish(() => reject(new Error(String(msg.response.error || 'Control request failed'))))
          return
        }

        finish(() => resolve(
          msg.response.response && typeof msg.response.response === 'object'
            ? msg.response.response as Record<string, unknown>
            : {},
        ))
      }

      this.onOutput(sessionId, handleOutput)
      const sent = this.sendSdkMessage(sessionId, {
        type: 'control_request',
        request_id: requestId,
        request,
      })
      if (!sent) {
        finish(() => reject(new Error('CLI session is not running')))
      }
    })
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  getSessionWorkDir(sessionId: string): string {
    const session = this.sessions.get(sessionId)
    return session?.workDir || ''
  }

  updateSessionWorkDir(sessionId: string, workDir: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || !workDir.trim()) return
    session.workDir = workDir
  }

  getSessionPermissionMode(sessionId: string): string {
    const session = this.sessions.get(sessionId)
    return session?.permissionMode || 'default'
  }

  getPendingPermissionRequests(sessionId: string): PendingPermissionRequest[] {
    const session = this.sessions.get(sessionId)
    if (!session) return []

    return Array.from(session.pendingPermissionRequests.entries()).map(([requestId, request]) => ({
      requestId,
      toolName: request.toolName,
      ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
      input: request.input,
      ...(request.description ? { description: request.description } : {}),
    }))
  }

  authorizeSdkConnection(
    sessionId: string,
    token: string | null | undefined,
  ): boolean {
    const session = this.sessions.get(sessionId)
    return Boolean(session && token && token === session.sdkToken)
  }

  attachSdkConnection(
    sessionId: string,
    socket: { send(data: string): void },
  ): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    session.sdkSocket = socket
    while (session.pendingOutbound.length > 0) {
      const line = session.pendingOutbound.shift()
      if (line) {
        socket.send(line)
      }
    }
    return true
  }

  detachSdkConnection(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.sdkSocket = null
    }
  }

  handleSdkPayload(sessionId: string, rawPayload: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const lines = rawPayload
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    for (const line of lines) {
      try {
        const msg = JSON.parse(line)
        session.sdkMessages.push(msg)
        if (session.sdkMessages.length > MAX_CAPTURED_SDK_MESSAGES) {
          session.sdkMessages.splice(0, session.sdkMessages.length - MAX_CAPTURED_SDK_MESSAGES)
        }
        const sdkError = this.extractSdkErrorEvent(msg)
        if (sdkError) {
          void diagnosticsService.recordEvent({
            type: sdkError.type,
            severity: 'error',
            sessionId,
            summary: sdkError.summary,
            details: sdkError.details,
          })
        }
        if (msg?.type === 'system' && msg.subtype === 'init') {
          session.initMessage = msg
        }
        if (
          msg?.type === 'control_request' &&
          msg.request?.subtype === 'can_use_tool' &&
          typeof msg.request_id === 'string'
        ) {
          session.pendingPermissionRequests.set(msg.request_id, {
            toolName:
              typeof msg.request.tool_name === 'string'
                ? msg.request.tool_name
                : 'Unknown',
            toolUseId:
              typeof msg.request.tool_use_id === 'string' && msg.request.tool_use_id.trim()
                ? msg.request.tool_use_id
                : undefined,
            input:
              msg.request.input && typeof msg.request.input === 'object'
                ? (msg.request.input as Record<string, unknown>)
                : {},
            description:
              typeof msg.request.description === 'string' && msg.request.description.trim()
                ? msg.request.description
                : undefined,
            permissionSuggestions: Array.isArray(msg.request.permission_suggestions)
              ? msg.request.permission_suggestions
              : undefined,
          })
        }
        if (
          (msg?.type === 'control_cancel_request' || msg?.type === 'control_response') &&
          typeof msg.request_id === 'string'
        ) {
          session.pendingPermissionRequests.delete(msg.request_id)
        }
        if (
          msg?.type === 'control_response' &&
          typeof msg.response?.request_id === 'string'
        ) {
          session.pendingPermissionRequests.delete(msg.response.request_id)
        }
        for (const cb of session.outputCallbacks) {
          cb(msg)
        }
      } catch {
        console.warn(
          `[ConversationService] Ignoring malformed SDK payload for ${sessionId}`,
        )
      }
    }
  }

  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.proc.kill()
      this.sessions.delete(sessionId)
    }
  }

  async stopSessionAndWait(sessionId: string, timeoutMs = 2_000): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.sessions.delete(sessionId)
    session.proc.kill()

    await Promise.race([
      session.proc.exited.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
    await this.waitForProcessOutputDrain(session, timeoutMs)
  }

  markSessionDeleted(sessionId: string): void {
    this.deletedSessions.add(sessionId)
    this.deletedSessionTimestamps.set(sessionId, Date.now())
    this.stopSession(sessionId)
    this.pruneOldDeletedSessions()
  }

  markSessionsDeleted(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.markSessionDeleted(sessionId)
    }
  }

  unmarkSessionDeleted(sessionId: string): void {
    this.deletedSessions.delete(sessionId)
    this.deletedSessionTimestamps.delete(sessionId)
  }

  unmarkSessionsDeleted(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.unmarkSessionDeleted(sessionId)
    }
  }

  private pruneOldDeletedSessions(): void {
    const now = Date.now()
    for (const [id, ts] of this.deletedSessionTimestamps) {
      if (now - ts > ConversationService.DELETED_SESSION_TTL_MS) {
        this.deletedSessions.delete(id)
        this.deletedSessionTimestamps.delete(id)
      }
    }
  }

  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys())
  }

  isSessionActive(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  private async readProcessOutputStream(
    sessionId: string,
    stream: ReadableStream | null | undefined,
    streamName: 'stdout' | 'stderr',
  ): Promise<void> {
    if (!stream) return

    const reader = stream.getReader()
    const decoder = new TextDecoder()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        if (!text.trim()) continue

        const session = this.sessions.get(sessionId)
        if (session) {
          for (const line of text
            .split('\n')
            .map((entry) => entry.trim())
            .filter(Boolean)) {
            const lines =
              streamName === 'stderr' ? session.stderrLines : session.stdoutLines
            lines.push(this.redactProcessOutput(line))
            if (lines.length > MAX_CAPTURED_PROCESS_LINES) {
              lines.splice(0, lines.length - MAX_CAPTURED_PROCESS_LINES)
            }
          }
        }

        const logLine = this.redactProcessOutput(text.trim())
        if (streamName === 'stderr') {
          console.error(`[CLI:${sessionId}:stderr] ${logLine}`)
        } else {
          console.log(`[CLI:${sessionId}:stdout] ${logLine}`)
        }
      }
    } catch {
      // Process output read failures should not kill the session.
    }
  }

  private async waitForProcessOutputDrain(
    session: SessionProcess,
    timeoutMs = 250,
  ): Promise<void> {
    const outputDrain = session.outputDrain ?? Promise.resolve()
    await Promise.race([
      outputDrain.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }

  private sendSdkMessage(
    sessionId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    const line = JSON.stringify(payload) + '\n'
    if (session.sdkSocket) {
      session.sdkSocket.send(line)
    } else {
      session.pendingOutbound.push(line)
    }
    return true
  }

  private async handleProcessExit(
    sessionId: string,
    proc: SessionProcess['proc'],
    code: number,
  ): Promise<void> {
    console.log(
      `[ConversationService] CLI process for ${sessionId} exited with code ${code}`,
    )

    const activeSession = this.sessions.get(sessionId)
    if (activeSession?.proc === proc) {
      if (activeSession.startupPending) {
        activeSession.startupExitCode = code
        return
      }
      await this.waitForProcessOutputDrain(activeSession)
      const exitError = this.buildRuntimeExitMessage(sessionId, code)
      void diagnosticsService.recordEvent({
        type: 'cli_runtime_exit',
        severity: 'error',
        sessionId,
        summary: exitError,
        details: {
          exitCode: code,
          workDir: activeSession.workDir,
          permissionMode: activeSession.permissionMode,
          capturedOutput: this.buildCapturedProcessOutputDetail(activeSession),
          sdkMessages: this.summarizeSdkMessages(activeSession.sdkMessages),
        },
      })
      for (const cb of activeSession.outputCallbacks) {
        cb({
          type: 'result',
          subtype: 'error',
          is_error: true,
          result: exitError,
          usage: { input_tokens: 0, output_tokens: 0 },
          session_id: sessionId,
        })
      }
      this.sessions.delete(sessionId)
    }
  }

  private getPermissionArgs(
    mode: string | undefined,
    dangerousMode: boolean,
  ): string[] {
    if (dangerousMode) {
      return ['--dangerously-skip-permissions']
    }

    const resolvedMode = mode || 'default'
    if (resolvedMode === 'bypassPermissions') {
      return ['--dangerously-skip-permissions']
    }

    const args = ['--permission-mode', resolvedMode]
    return args
  }

  private getRuntimeArgs(options: SessionStartOptions | undefined): string[] {
    const args: string[] = []

    if (options?.model) {
      args.push('--model', options.model)
    }

    if (options?.effort) {
      args.push('--effort', options.effort)
    }

    if (options?.thinking) {
      args.push('--thinking', options.thinking)
    }

    return args
  }

  private async buildChildEnv(
    workDir: string,
    sdkUrl?: string,
    options?: SessionStartOptions,
  ): Promise<Record<string, string>> {
    // Provider isolation: when Desktop has its own provider config/index,
    // strip inherited provider env vars so the child CLI reads fresh values
    // from ~/.claude/cc-haha/settings.json instead of stale process.env.
    //
    // If the user never configured a Desktop provider and only launched the
    // app/server with ANTHROPIC_* env vars, keep those env vars so Windows
    // dev-mode and env-only setups can still authenticate successfully.
    const PROVIDER_ENV_KEYS = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
      'CC_HAHA_SEND_DISABLED_THINKING',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      'CLAUDE_CODE_ATTRIBUTION_HEADER',
      'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS',
      OPENAI_OAUTH_PROVIDER_ENV_KEY,
      OPENAI_CODEX_OAUTH_FILE_ENV_KEY,
    ] as const

    const cleanEnv = await getProcessEnvWithTerminalShellEnvironment()
    delete cleanEnv.CLAUDE_CODE_OAUTH_TOKEN
    if (this.shouldStripInheritedProviderEnv(options?.providerId)) {
      for (const key of PROVIDER_ENV_KEYS) {
        delete cleanEnv[key]
      }
    }

    let desktopServerUrl: string | undefined
    if (sdkUrl) {
      try {
        const parsed = new URL(sdkUrl)
        desktopServerUrl = `http://${parsed.host}`
      } catch {
        desktopServerUrl = undefined
      }
    }

    const explicitProviderEnv =
      typeof options?.providerId === 'string'
        ? await this.providerService.getProviderRuntimeEnv(options.providerId)
        : null
    const networkEnv = buildNetworkEnvironment(await loadNetworkSettings())
    if (explicitProviderEnv && options?.model?.trim()) {
      explicitProviderEnv.ANTHROPIC_MODEL = options.model.trim()
    }
    const attributionHeaderEnv = attributionHeaderEnvForModel(
      options?.model?.trim() ||
        explicitProviderEnv?.ANTHROPIC_MODEL ||
        cleanEnv.ANTHROPIC_MODEL,
    )

    const cliDiagnosticsPath = diagnosticsService.getCliDiagnosticsPath()
    try {
      fs.mkdirSync(path.dirname(cliDiagnosticsPath), { recursive: true })
    } catch {
      // Diagnostics must never block session startup.
    }

    return {
      ...cleanEnv,
      CLAUDE_CODE_ENABLE_TASKS: '1',
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
      CLAUDE_CODE_DIAGNOSTICS_FILE: cliDiagnosticsPath,
      CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: this.resolveDesktopAutoMemoryPath(workDir),
      CALLER_DIR: workDir,
      PWD: workDir,
      ...(sdkUrl
        ? { CC_HAHA_COMPUTER_USE_HOST_BUNDLE_ID: 'com.claude-code-haha.desktop' }
        : {}),
      ...(desktopServerUrl
        ? { CC_HAHA_DESKTOP_SERVER_URL: desktopServerUrl }
        : {}),
      ...(sdkUrl
        ? {
            CC_HAHA_DESKTOP_AWAIT_MCP: '1',
            CC_HAHA_DESKTOP_AWAIT_MCP_TIMEOUT_MS: '5000',
          }
        : {}),
      // Tell the CLI entrypoint to skip project .env loading. Provider env
      // should come from Desktop-managed config or inherited launch env, not
      // be reintroduced from the repo's .env file.
      CC_HAHA_SKIP_DOTENV: '1',
      ...(explicitProviderEnv
        ? { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' }
        : {}),
      // "官方" 模式 (cc-haha/settings.json 没 provider env) 下,把 CLI 标记为
      // managed-OAuth,让它忽略外部 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
      // 残留、只走用户 /login 的 OAuth token。自定义 provider 模式绝不能设,
      // 否则 CLI 会忽略 provider 的 AUTH_TOKEN、错误地走 OAuth 打到第三方
      // endpoint。详见 src/utils/auth.ts isManagedOAuthContext()。
      ...(explicitProviderEnv ?? {}),
      ...networkEnv,
      ...(this.shouldMarkManagedOAuth(options?.providerId)
        ? await this.buildOfficialOAuthEnv()
        : {}),
      ...attributionHeaderEnv,
    }
  }

  private resolveDesktopAutoMemoryPath(workDir: string): string {
    const memoryProjectRoot = fs.existsSync(workDir)
      ? findCanonicalGitRoot(workDir) ?? workDir
      : workDir
    return (
      path.join(
        getClaudeConfigHomeDir(),
        'projects',
        sanitizePath(memoryProjectRoot),
        AUTO_MEMORY_DIRNAME,
      ) + path.sep
    ).normalize('NFC')
  }

  /**
   * 官方模式下构造 CLI 子进程的 auth env:
   * - CLAUDE_CODE_ENTRYPOINT=claude-desktop 让 CLI 忽略外部残留 ANTHROPIC_* env
   * - 如果 haha 自管的 oauth.json 里有可用 token,注入 CLAUDE_CODE_OAUTH_TOKEN
   *   让 CLI 直接拿 env 里的 token,不碰 Keychain,绕开 macOS ACL 静默拒绝
   *   (这是 DMG 安装 .app 后 403 "Request not allowed" 的唯一根治方案)
   */
  private async buildOfficialOAuthEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    }
    try {
      // deferred import: avoids instantiating the OAuth singleton on every
      // ConversationService construction — only loaded when official mode hits.
      const { hahaOAuthService } = await import('./hahaOAuthService.js')
      const token = await hahaOAuthService.ensureFreshAccessToken()
      if (token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = token
      }
    } catch (err) {
      console.error(
        '[conversationService] ensureFreshAccessToken failed:',
        err instanceof Error ? err.message : err,
      )
    }
    return env
  }

  private shouldStripInheritedProviderEnv(providerId?: string | null): boolean {
    if (providerId !== undefined) {
      return true
    }

    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const ccHahaDir = path.join(configDir, 'cc-haha')
    const providersIndexPath = path.join(ccHahaDir, 'providers.json')
    const settingsPath = path.join(ccHahaDir, 'settings.json')

    if (fs.existsSync(providersIndexPath)) {
      return true
    }

    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8')
      const parsed = JSON.parse(raw) as { env?: Record<string, string> }
      const env = parsed.env ?? {}
      return [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
        'CC_HAHA_SEND_DISABLED_THINKING',
        'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
        'CLAUDE_CODE_ATTRIBUTION_HEADER',
        'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS',
        OPENAI_OAUTH_PROVIDER_ENV_KEY,
        OPENAI_CODEX_OAUTH_FILE_ENV_KEY,
      ].some((key) => typeof env[key] === 'string' && env[key]!.trim().length > 0)
    } catch {
      return false
    }
  }

  /**
   * 只有当用户处于"官方"模式(没有激活任何自定义 provider)时,才把 CLI 标记为
   * managed-OAuth。激活自定义 provider 时 settings.json 里有 ANTHROPIC_AUTH_TOKEN;
   * 这种情况下 CLI 必须按 token 路径走第三方 endpoint,不能被 managed 规则
   * 强制切 OAuth。
   *
   * 默认 (读不到 settings.json) 按"官方"处理 — 即使用户从未用过 cc-haha
   * provider 管理,也希望官方 OAuth 能正常工作。
   */
  private shouldMarkManagedOAuth(providerId?: string | null): boolean {
    if (providerId === null) {
      return true
    }
    if (typeof providerId === 'string') {
      return false
    }

    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const settingsPath = path.join(configDir, 'cc-haha', 'settings.json')
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8')
      const parsed = JSON.parse(raw) as { env?: Record<string, string> }
      const env = parsed.env ?? {}
      if (env[OPENAI_OAUTH_PROVIDER_ENV_KEY] === '1') {
        return false
      }
      const hasProviderEnv = [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
      ].some(
        (key) =>
          typeof env[key] === 'string' && env[key]!.trim().length > 0,
      )
      return !hasProviderEnv
    } catch {
      return true
    }
  }

  private resolveCliArgs(baseArgs: string[]): string[] {
    const launcher = resolveClaudeCliLauncher({
      cliPath: process.env.CLAUDE_CLI_PATH,
      execPath: process.execPath,
    })

    if (!launcher) {
      if (process.platform === 'win32') {
        return [
          process.execPath,
          '--preload',
          path.resolve(import.meta.dir, '../../../preload.ts'),
          path.resolve(import.meta.dir, '../../entrypoints/cli.tsx'),
          ...baseArgs,
        ]
      }
      return [path.resolve(import.meta.dir, '../../../bin/claude-haha'), ...baseArgs]
    }

    return buildClaudeCliArgs(launcher, baseArgs, process.env.CLAUDE_APP_ROOT)
  }

  private clearStaleLock(sessionId: string): boolean {
    const lockDir = path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
      '.lock',
    )
    const lockFile = path.join(lockDir, sessionId)
    if (!fs.existsSync(lockFile)) {
      return false
    }

    try {
      fs.unlinkSync(lockFile)
      return true
    } catch {
      return false
    }
  }

  private buildStartupError(
    sessionId: string,
    exitCode: number,
  ): ConversationStartupError {
    const session = this.sessions.get(sessionId)
    const capturedOutput = this.buildCapturedProcessOutputDetail(session)
    const recentMessages = session?.sdkMessages ?? []
    const resultMessage = [...recentMessages]
      .reverse()
      .find((msg) => msg?.type === 'result' && msg.is_error)
    const assistantApiError = [...recentMessages]
      .reverse()
      .find((msg) => this.isAssistantApiErrorMessage(msg))
    const authStatus = [...recentMessages]
      .reverse()
      .find((msg) => msg?.type === 'auth_status')
    const detail =
      this.extractStartupDetail(resultMessage) ||
      this.extractAssistantApiErrorDetail(assistantApiError) ||
      this.extractStartupDetail(authStatus) ||
      capturedOutput

    if (
      /(not logged in|run \/login|sign in again|login required|unauthenticated|logged_out)/i.test(
        detail,
      )
    ) {
      return new ConversationStartupError(
        'Desktop chat could not start because Claude CLI is not authenticated. Run `./bin/claude-haha /login` or provide valid API credentials, then retry.',
        'CLI_AUTH_REQUIRED',
      )
    }

    if (/session id .*already in use/i.test(detail)) {
      return new ConversationStartupError(
        `Session ${sessionId} is already in use by another CLI process or transcript.`,
        'CLI_SESSION_CONFLICT',
        true,
      )
    }

    const normalizedDetail = detail.trim()
    return new ConversationStartupError(
      normalizedDetail
        ? `CLI exited during startup (code ${exitCode}): ${normalizedDetail}`
        : `CLI exited during startup with code ${exitCode}; no CLI stderr/stdout or SDK error payload was captured before exit.`,
      'CLI_START_FAILED',
      true,
    )
  }

  private buildRuntimeExitMessage(sessionId: string, exitCode: number): string {
    const session = this.sessions.get(sessionId)
    const capturedOutput = this.buildCapturedProcessOutputDetail(session)
    const recentMessages = session?.sdkMessages ?? []
    const resultMessage = [...recentMessages]
      .reverse()
      .find((msg) => msg?.type === 'result' && msg.is_error)
    const assistantApiError = [...recentMessages]
      .reverse()
      .find((msg) => this.isAssistantApiErrorMessage(msg))
    const authStatus = [...recentMessages]
      .reverse()
      .find((msg) => msg?.type === 'auth_status')
    const detail =
      this.extractStartupDetail(resultMessage) ||
      this.extractAssistantApiErrorDetail(assistantApiError) ||
      this.extractStartupDetail(authStatus) ||
      capturedOutput

    return detail
      ? `CLI process exited unexpectedly (code ${exitCode}): ${detail}`
      : `CLI process exited unexpectedly with code ${exitCode}; no CLI stderr/stdout or SDK error payload was captured before exit.`
  }

  private buildCapturedProcessOutputDetail(
    session: SessionProcess | undefined,
  ): string {
    if (!session) return ''

    const stderrText = (session.stderrLines ?? []).join('\n').trim()
    const stdoutText = (session.stdoutLines ?? []).join('\n').trim()

    if (stderrText && stdoutText) {
      return `stderr:\n${stderrText}\nstdout:\n${stdoutText}`
    }

    return stderrText || stdoutText
  }

  private redactProcessOutput(line: string): string {
    return line
      .replace(/(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
  }

  private extractStartupDetail(message: any): string {
    if (!message) return ''

    if (typeof message.result === 'string') return message.result
    if (typeof message.status === 'string') return message.status
    if (typeof message.message === 'string') return message.message

    if (Array.isArray(message?.errors)) {
      return message.errors
        .filter((value: unknown): value is string => typeof value === 'string')
        .join('\n')
    }

    return ''
  }

  private isAssistantApiErrorMessage(message: any): boolean {
    return (
      message?.type === 'assistant' &&
      (message.isApiErrorMessage === true || typeof message.error === 'string')
    )
  }

  private extractAssistantApiErrorDetail(message: any): string {
    if (!this.isAssistantApiErrorMessage(message)) return ''

    const text = this.extractAssistantText(message)
    const error = typeof message.error === 'string' ? message.error : ''
    if (text && error) return `${error}: ${text}`
    return text || error
  }

  private extractAssistantText(message: any): string {
    const content = message?.message?.content
    if (!Array.isArray(content)) return ''
    const textBlock = content.find(
      (block: unknown): block is { type: string; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    return textBlock?.text || ''
  }

  private extractSdkErrorEvent(message: any): {
    type: string
    summary: string
    details: Record<string, unknown>
  } | null {
    if (this.isAssistantApiErrorMessage(message)) {
      const summary = this.redactProcessOutput(
        this.extractAssistantApiErrorDetail(message) || 'Assistant API error',
      )
      return {
        type: 'sdk_api_error',
        summary,
        details: {
          sdkType: message.type,
          error: typeof message.error === 'string' ? message.error : undefined,
          isApiErrorMessage: message.isApiErrorMessage === true,
          messageText: this.extractAssistantText(message)
            ? this.redactProcessOutput(this.extractAssistantText(message))
            : undefined,
          errorDetails:
            typeof message.errorDetails === 'string'
              ? this.redactProcessOutput(message.errorDetails)
              : undefined,
        },
      }
    }

    if (message?.type === 'result' && message.is_error) {
      const summary = this.redactProcessOutput(
        this.extractStartupDetail(message) || 'SDK result error',
      )
      return {
        type: 'sdk_result_error',
        summary,
        details: {
          sdkType: message.type,
          subtype: message.subtype,
          isError: true,
          result:
            typeof message.result === 'string'
              ? this.redactProcessOutput(message.result)
              : undefined,
          status:
            typeof message.status === 'string'
              ? this.redactProcessOutput(message.status)
              : undefined,
          usage: message.usage,
        },
      }
    }

    return null
  }

  private summarizeSdkMessages(messages: any[]): unknown[] {
    return messages.slice(-MAX_CAPTURED_SDK_SUMMARY).map((message) => {
      if (!message || typeof message !== 'object') {
        return message
      }
      const content = Array.isArray(message.message?.content)
        ? message.message.content.map((block: unknown) => {
            if (!block || typeof block !== 'object') return block
            const typedBlock = block as Record<string, unknown>
            return {
              type: typedBlock.type,
              text:
                typeof typedBlock.text === 'string'
                  ? this.redactProcessOutput(typedBlock.text)
                  : undefined,
            }
          })
        : undefined
      return {
        type: message.type,
        subtype: message.subtype,
        is_error: message.is_error,
        status: typeof message.status === 'string' ? message.status : undefined,
        result: typeof message.result === 'string' ? this.redactProcessOutput(message.result) : undefined,
        error: typeof message.error === 'string' ? this.redactProcessOutput(message.error) : undefined,
        errorDetails:
          typeof message.errorDetails === 'string'
            ? this.redactProcessOutput(message.errorDetails)
            : undefined,
        message: typeof message.message === 'string' ? this.redactProcessOutput(message.message) : undefined,
        content,
      }
    })
  }

  private buildUserContent(
    content: string,
    sessionId: string,
    attachments?: AttachmentRef[],
  ): Array<Record<string, unknown>> {
    const prefix = this.materializeAttachments(sessionId, attachments)
    const trimmed = content.trim()
    const text = prefix
      ? `${prefix}${trimmed || 'Please analyze the attached files.'}`.trim()
      : trimmed

    return [{ type: 'text', text }]
  }

  private materializeAttachments(
    sessionId: string,
    attachments?: AttachmentRef[],
  ): string {
    if (!attachments || attachments.length === 0) {
      return ''
    }

    const uploadDir = path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
      'uploads',
      sessionId,
    )
    fs.mkdirSync(uploadDir, { recursive: true })

    const savedPaths: string[] = []
    for (const attachment of attachments) {
      if (attachment.path) {
        savedPaths.push(attachment.path)
        continue
      }

      if (!attachment.data) continue

      const payload = this.parseAttachmentData(attachment.data)
      if (!payload) continue

      const ext = this.getAttachmentExtension(attachment)
      const fileName = this.sanitizeAttachmentName(attachment.name, attachment.type, ext)
      const outPath = path.join(uploadDir, `${crypto.randomUUID()}-${fileName}`)
      fs.writeFileSync(outPath, payload)
      savedPaths.push(outPath)
    }

    if (savedPaths.length === 0) {
      return ''
    }

    return savedPaths.map((filePath) => `@"${filePath}"`).join(' ') + ' '
  }

  private parseAttachmentData(data: string): Buffer | null {
    const match = data.match(/^data:.*?;base64,(.*)$/)
    const encoded = match ? match[1] : data

    try {
      return Buffer.from(encoded, 'base64')
    } catch {
      return null
    }
  }

  private getAttachmentExtension(attachment: AttachmentRef): string {
    const byName = attachment.name?.match(/\.([a-z0-9]+)$/i)?.[1]
    if (byName) return byName

    const byMime = attachment.mimeType?.split('/')[1]?.split('+')[0]
    if (byMime) return byMime

    return attachment.type === 'image' ? 'png' : 'bin'
  }

  private sanitizeAttachmentName(
    name: string | undefined,
    type: AttachmentRef['type'],
    ext: string,
  ): string {
    const fallback = `${type}-attachment.${ext}`
    const normalized = (name || fallback).replace(/[^a-zA-Z0-9._-]/g, '_')
    return normalized || fallback
  }

  private getSdkTokenFromUrl(sdkUrl: string): string {
    const url = new URL(sdkUrl)
    return url.searchParams.get('token') || ''
  }
}

function normalizeSessionPermissionUpdates(
  suggestions: unknown[] | undefined,
  toolName: string,
) {
  if (Array.isArray(suggestions) && suggestions.length > 0) {
    return suggestions.map((suggestion) => {
      if (!suggestion || typeof suggestion !== 'object') {
        return suggestion
      }
      return {
        ...suggestion,
        destination: 'session',
      }
    })
  }

  return [
    {
      type: 'addRules',
      rules: [{ toolName }],
      behavior: 'allow',
      destination: 'session',
    },
  ]
}

export const conversationService = new ConversationService()
