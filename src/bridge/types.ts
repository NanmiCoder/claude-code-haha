/** 每个 session 的默认超时时间（24 小时）。 */
export const DEFAULT_SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** 可复用的登录指引，会附加到 bridge 鉴权错误后。 */
export const BRIDGE_LOGIN_INSTRUCTION =
  'Remote Control is only available with claude.ai subscriptions. Please use `/login` to sign in with your claude.ai account.'

/** 在未鉴权情况下运行 `claude remote-control` 时打印的完整错误。 */
export const BRIDGE_LOGIN_ERROR =
  'Error: You must be logged in to use Remote Control.\n\n' +
  BRIDGE_LOGIN_INSTRUCTION

/** 用户断开 Remote Control 时显示（通过 /remote-control 或 ultraplan launch）。 */
export const REMOTE_CONTROL_DISCONNECTED_MSG = 'Remote Control disconnected.'

// --- environments API 的协议类型 ---

export type WorkData = {
  type: 'session' | 'healthcheck'
  id: string
}

export type WorkResponse = {
  id: string
  type: 'work'
  environment_id: string
  state: string
  data: WorkData
  secret: string // base64url-encoded JSON
  created_at: string
}

export type WorkSecret = {
  version: number
  session_ingress_token: string
  api_base_url: string
  sources: Array<{
    type: string
    git_info?: { type: string; repo: string; ref?: string; token?: string }
  }>
  auth: Array<{ type: string; token: string }>
  claude_code_args?: Record<string, string> | null
  mcp_config?: unknown | null
  environment_variables?: Record<string, string> | null
  /**
   * 由服务端驱动的 CCR v2 选择器。当 session 通过 v2 compat 层
   * （ccr_v2_compat_enabled）创建时，由 prepare_work_secret() 设置。
   * 与 BYOC runner 在 environment-runner/sessionExecutor.ts 中读取的是同一个字段。
   */
  use_code_sessions?: boolean
}

export type SessionDoneStatus = 'completed' | 'failed' | 'interrupted'

export type SessionActivityType = 'tool_start' | 'text' | 'result' | 'error'

export type SessionActivity = {
  type: SessionActivityType
  summary: string // e.g. "Editing src/foo.ts", "Reading package.json"
  timestamp: number
}

/**
 * `claude remote-control` 如何选择 session 工作目录。
 * - `single-session`：一个 session 使用 cwd，结束时 bridge 一并销毁
 * - `worktree`：持久服务端，每个 session 都有独立 git worktree
 * - `same-dir`：持久服务端，所有 session 共用 cwd（可能相互覆盖）
 */
export type SpawnMode = 'single-session' | 'worktree' | 'same-dir'

/**
 * 当前代码库会产出的已知 worker_type 值。它们会在 environment 注册时作为
 * `metadata.worker_type` 发送，以便 claude.ai 按来源过滤 session picker
 * （例如 assistant 标签页只显示 assistant workers）。后端将它视为不透明字符串，
 * desktop cowork 会发送 `"cowork"`，它并不在这个联合类型中。
 * REPL 代码使用这个更窄的类型来保证自身穷尽性；线上的字段仍接受任意字符串。
 */
export type BridgeWorkerType = 'claude_code' | 'claude_code_assistant'

export type BridgeConfig = {
  dir: string
  machineName: string
  branch: string
  gitRepoUrl: string | null
  maxSessions: number
  spawnMode: SpawnMode
  verbose: boolean
  sandbox: boolean
  /** 由客户端生成、用于标识该 bridge 实例的 UUID。 */
  bridgeId: string
  /**
   * 作为 metadata.worker_type 发送，供 Web 客户端按来源过滤。
   * 后端将其视为不透明值，可以是任意字符串，而不只是 BridgeWorkerType。
   */
  workerType: string
  /** 客户端生成的 UUID，用于幂等环境注册。 */
  environmentId: string
  /**
   * 用于重新注册时复用的、由后端签发的 environment_id。设置后，后端会把
   * 这次注册视为连接回已有 environment，而不是创建新的一个。用于
   * `claude remote-control --session-id` 的 resume 场景。必须是后端格式的 ID，
   * 客户端 UUID 会被 400 拒绝。
   */
  reuseEnvironmentId?: string
  /** bridge 当前连接的 API base URL（用于轮询）。 */
  apiBaseUrl: string
  /** 用于 WebSocket 连接的 session ingress base URL（本地时可能不同于 apiBaseUrl）。 */
  sessionIngressUrl: string
  /** 通过 --debug-file 传入的调试文件路径。 */
  debugFile?: string
  /** 每个 session 的超时时间（毫秒）。超时的 session 会被杀掉。 */
  sessionTimeoutMs?: number
}

// --- 依赖接口（便于测试） ---

/**
 * 发回 session 的 control_response 事件（例如权限决策）。
 * 按 SDK 协议，`subtype` 为 `'success'`；内部的 `response` 则携带权限决策负载
 * （例如 `{ behavior: 'allow' }`）。
 */
export type PermissionResponseEvent = {
  type: 'control_response'
  response: {
    subtype: 'success'
    request_id: string
    response: Record<string, unknown>
  }
}

export type BridgeApiClient = {
  registerBridgeEnvironment(config: BridgeConfig): Promise<{
    environment_id: string
    environment_secret: string
  }>
  pollForWork(
    environmentId: string,
    environmentSecret: string,
    signal?: AbortSignal,
    reclaimOlderThanMs?: number,
  ): Promise<WorkResponse | null>
  acknowledgeWork(
    environmentId: string,
    workId: string,
    sessionToken: string,
  ): Promise<void>
  /** 通过 environments API 停止一个 work item。 */
  stopWork(environmentId: string, workId: string, force: boolean): Promise<void>
  /** 在优雅关闭时注销/删除 bridge environment。 */
  deregisterEnvironment(environmentId: string): Promise<void>
  /** 通过 session events API 向 session 发送权限响应（control_response）。 */
  sendPermissionResponseEvent(
    sessionId: string,
    event: PermissionResponseEvent,
    sessionToken: string,
  ): Promise<void>
  /** 归档 session，使其不再在服务端显示为活跃。 */
  archiveSession(sessionId: string): Promise<void>
  /**
   * 强制停止陈旧的 worker 实例，并在某个 environment 上重新排队一个 session。
   * 用于在原 bridge 已死亡后，通过 `--session-id` 恢复 session。
   */
  reconnectSession(environmentId: string, sessionId: string): Promise<void>
  /**
   * 为活跃 work item 发送轻量 heartbeat，以延长其 lease。
   * 使用的是 SessionIngressAuth（JWT，无 DB 命中），而不是 EnvironmentSecretAuth。
   * 返回服务端携带 lease 状态的响应。
   */
  heartbeatWork(
    environmentId: string,
    workId: string,
    sessionToken: string,
  ): Promise<{ lease_extended: boolean; state: string }>
}

export type SessionHandle = {
  sessionId: string
  done: Promise<SessionDoneStatus>
  kill(): void
  forceKill(): void
  activities: SessionActivity[] // 最近活动的环形缓冲区（约最近 10 条）
  currentActivity: SessionActivity | null // 最新活动
  accessToken: string // 供 API 调用使用的 session_ingress_token
  lastStderr: string[] // 最近 stderr 行的环形缓冲区
  writeStdin(data: string): void // 直接写入子进程 stdin
  /** 更新运行中 session 的 access token（例如在 token 刷新后）。 */
  updateAccessToken(token: string): void
}

export type SessionSpawnOpts = {
  sessionId: string
  sdkUrl: string
  accessToken: string
  /** 为 true 时，使用 CCR v2 环境变量启动子进程（SSE transport + CCRClient）。 */
  useCcrV2?: boolean
  /** 当 useCcrV2 为 true 时必填。通过 POST /worker/register 获得。 */
  workerEpoch?: number
  /**
   * 当在子进程 stdout 上看到第一条真实用户消息文本时触发一次
   * （通过 --replay-user-messages）。这让调用方可以在还没有 title 时派生
   * session title。tool-result 和 synthetic user message 会被跳过。
   */
  onFirstUserMessage?: (text: string) => void
}

export type SessionSpawner = {
  spawn(opts: SessionSpawnOpts, dir: string): SessionHandle
}

export type BridgeLogger = {
  printBanner(config: BridgeConfig, environmentId: string): void
  logSessionStart(sessionId: string, prompt: string): void
  logSessionComplete(sessionId: string, durationMs: number): void
  logSessionFailed(sessionId: string, error: string): void
  logStatus(message: string): void
  logVerbose(message: string): void
  logError(message: string): void
  /** 在连接错误恢复后记录重连成功事件。 */
  logReconnected(disconnectedMs: number): void
  /** 显示带 repo/branch 信息和 shimmer 动画的空闲状态。 */
  updateIdleStatus(): void
  /** 在实时显示中展示重连状态。 */
  updateReconnectingStatus(delayStr: string, elapsedStr: string): void
  updateSessionStatus(
    sessionId: string,
    elapsed: string,
    activity: SessionActivity,
    trail: string[],
  ): void
  clearStatus(): void
  /** 设置状态行展示的仓库信息。 */
  setRepoInfo(repoName: string, branch: string): void
  /** 设置显示在状态行上方的 debug log glob（ant 用户）。 */
  setDebugLogPath(path: string): void
  /** session 启动时切换到 "Attached" 状态。 */
  setAttached(sessionId: string): void
  /** 在实时显示中展示失败状态。 */
  updateFailedStatus(error: string): void
  /** 切换 QR code 可见性。 */
  toggleQr(): void
  /** 更新 "<n> of <m> sessions" 指示器和 spawn mode 提示。 */
  updateSessionCount(active: number, max: number, mode: SpawnMode): void
  /** 更新 session-count 行中显示的 spawn mode。传入 null 表示隐藏（single-session 或 toggle 不可用）。 */
  setSpawnModeDisplay(mode: 'same-dir' | 'worktree' | null): void
  /** 为多 session 展示注册一个新 session（在 spawn 成功后调用）。 */
  addSession(sessionId: string, url: string): void
  /** 更新多 session 列表中每个 session 的活动摘要（正在运行的 tool）。 */
  updateSessionActivity(sessionId: string, activity: SessionActivity): void
  /**
   * 设置 session 的显示标题。在多 session 模式下，会更新项目符号列表中的条目；
   * 在单 session 模式下，也会在主状态行展示该标题。
   * 该操作会触发一次渲染（已对 reconnecting/failed 状态做保护）。
   */
  setSessionTitle(sessionId: string, title: string): void
  /** session 结束时，从多 session 展示中移除它。 */
  removeSession(sessionId: string): void
  /** 强制重新渲染状态展示（用于多 session 活动刷新）。 */
  refreshDisplay(): void
}
