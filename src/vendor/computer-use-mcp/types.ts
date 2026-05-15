import type {
  ComputerExecutor,
  InstalledApp,
  ScreenshotResult,
} from "./executor.js";

/** 去掉 base64 blob 后的 `ScreenshotResult`。
 *  host 会持久化这种形状，以便 cross-respawn 后 `scaleCoord` 仍能工作。 */
export type ScreenshotDims = Omit<ScreenshotResult, "base64">;

/** 结构与 claude-for-chrome-mcp/src/types.ts:1-7 保持一致。 */
export interface Logger {
  info: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
  silly: (message: string, ...args: unknown[]) => void;
}

/**
 * 单个 app 的权限等级。
 * 它会在授权时按类别硬编码决定；审批对话框会展示该等级，但用户目前不能修改。
 *
 *   - `"read"`：只能出现在截图中，不能交互（不能点、不能输）。
 *     浏览器通常落在这一档：模型可以读已打开页面，但任何导航或点击都必须走
 *     Claude-in-Chrome MCP。交易平台也在这一档。
 *   - `"click"`：可见，并允许普通左键点击与滚动；不允许输入/按键，
 *     也不允许右键、中键、带修饰键点击、拖拽等文本注入路径。
 *     终端和 IDE 一般在这一档：模型可以点 Run 按钮、滚动测试输出，
 *     但 `type("rm -rf /")` 会被阻止，右键粘贴和拖文本到终端也不行。
 *   - `"full"`：可见、可点击、可输入/按键/粘贴，其余应用都在这里。
 *
 * `runInputActionGates` 会通过 frontmost-app 检查执行该策略：
 * 键盘动作要求 `"full"`，鼠标动作要求 `"click"` 或更高。
 */
export type CuAppPermTier = "read" | "click" | "full";

/**
 * 表示用户在当前 session 中批准过的一个 app。
 * 这里仅支持 session 级作用域，没有 “once” 或 “forever” 这种范围；
 * CU 也不存在自然的“一次”单位，因为一个任务往往对应数百次点击。
 * 这与 `chromeAllowedDomains` 使用普通 `string[]`、不携带逐项 scope 的方式一致。
 */
export interface AppGrant {
  bundleId: string;
  displayName: string;
  /** Epoch 毫秒时间戳，用于设置页展示（例如“3 分钟前授予”）。 */
  grantedAt: number;
  /** Undefined 表示 `"full"`，用于兼容早期未持久化 tier 的旧授权记录。 */
  tier?: CuAppPermTier;
}

/** 与 app allowlist 正交的额外授权开关。 */
export interface CuGrantFlags {
  clipboardRead: boolean;
  clipboardWrite: boolean;
  /**
   * 为 false 时，`key` 工具会拒绝 `keyBlocklist.ts` 中列出的组合键
   * （如 cmd+q、cmd+tab、cmd+space、cmd+shift+q、ctrl+alt+delete）。
   * 其他按键序列不受影响。
   */
  systemKeyCombos: boolean;
}

export const DEFAULT_GRANT_FLAGS: CuGrantFlags = {
  clipboardRead: false,
  clipboardWrite: false,
  systemKeyCombos: false,
};

/**
 * host 通过 GrowthBook JSON 特性 `chicago_coordinate_mode` 选择坐标模式，
 * 并在构造 server 时写进工具参数说明里。模型只会看到其中一种约定，
 * 不会知道另一种模式的存在。`normalized_0_100` 可以完全绕开 Retina
 * scaleFactor 相关的一整类问题。
 */
export type CoordinateMode = "pixels" | "normalized_0_100";

/**
 * 针对微妙或高风险移植行为的独立 kill switch。
 * 由 host adapter 从 GrowthBook 读取，在 `toolCalls.ts` 中消费。
 */
export interface CuSubGates {
  /** 点击前的 9×9 精确字节级陈旧性校验。 */
  pixelValidation: boolean;
  /** 将 `type("foo\nbar")` 改走剪贴板，而不是逐键输入。 */
  clipboardPasteMultiline: boolean;
  /**
   * 以 60fps 做 ease-out-cubic 鼠标滑动，时长与距离成比例
   * （2000 px/sec，上限 0.5s）。每次点击最多增加约 0.5s 延迟；
   * 关闭后光标会直接瞬移。
   */
  mouseAnimation: boolean;
  /**
   * 动作前的预处理序列：先隐藏不在 allowlist 中的 app，再让我们自己失焦。
   * 关闭后，frontmost gate 会在正常场景下触发，模型可能直接卡住；
   * 这本质上是用于 A/B 测试旧有错误行为的开关。
   */
  hideBeforeAction: boolean;
  /**
   * 当当前选中的 display 上没有 allowlisted app 窗口时，
   * 在每次截图前自动重新解析目标 display。开启时 `handleScreenshot`
   * 走原子 Swift 路径；关闭时则固定使用 `selectedDisplayId`。
   */
  autoTargetDisplay: boolean;
  /**
   * 当前台是 tier-"click" 应用时，暂存并清空剪贴板。
   * 这样可以堵住“点击级”终端/IDE 通过 UI Paste 按钮绕过键盘限制的漏洞；
   * 当前台切换到非 "click" 应用或回合结束时再恢复。
   */
  clipboardGuard: boolean;
}

// ----------------------------------------------------------------------------
// 权限请求/响应（与 BridgePermissionRequest, types.ts:77-94 对齐）
// ----------------------------------------------------------------------------

/** 模型请求的每个 app 一项，已完成“名称 -> bundle ID”解析。 */
export interface ResolvedAppRequest {
  /** 模型原始请求的内容（如 "Slack"、"com.tinyspeck.slackmacgap"）。 */
  requestedName: string;
  /** 若能解析到 InstalledApp 就填这里，否则为 undefined（UI 中会灰显）。 */
  resolved?: InstalledApp;
  /** 与 shell 访问等价的 bundle ID 会触发 UI 警告，见 sentinelApps.ts。 */
  isSentinel: boolean;
  /** 若已在 allowlist 中，则跳过勾选框并立即返回到 `granted`。 */
  alreadyGranted: boolean;
  /** 该 app 的硬编码 tier（浏览器→"read"，终端→"click"，其他→"full"）。
   *  对话框只读展示它，renderer 会原样把它写入 AppGrant。 */
  proposedTier: CuAppPermTier;
}

/**
 * 传给 renderer 审批对话框的 payload。
 * 它复用现有的 `ToolPermissionRequest.input: unknown` 字段，
 * 因而不需要额外修改 IPC schema。
 */
export interface CuPermissionRequest {
  requestId: string;
  /** 模型给出的原因描述，会在审批 UI 中重点展示。 */
  reason: string;
  apps: ResolvedAppRequest[];
  /** 模型请求的 flags，用户可以独立于 app 列表进行开关。 */
  requestedFlags: Partial<CuGrantFlags>;
  /**
   * 用于 “On Windows, Claude can see all apps...” 这条脚注。
   * 值取自 `executor.capabilities.screenshotFiltering`，
   * 这样 renderer 就不需要自己理解平台差异。
   */
  screenshotFiltering: "native" | "none";
  /**
   * 仅在 TCC 权限尚未授予时出现。
   * 一旦存在，renderer 会显示 TCC 开关面板（Accessibility 与 Screen Recording 两项），
   * 而不是 app 列表。点击 “Request” 会触发系统弹窗；store 会在窗口重新聚焦时轮询状态，
   * 发现授权后自动切换开关。macOS 自己会提示用户在授予屏幕录制后重启，我们不会额外提示。
   */
  tccState?: {
    accessibility: boolean;
    screenRecording: boolean;
  };
  /**
   * 当前 CU display 上存在窗口、但不在本次请求 allowlist 内的 app。
   * Claude 第一次执行动作时会隐藏它们。
   * 该列表在 request_access 时计算，因此到用户真正点击 Allow 时可能略微过时；
   * 它只是预览而不是契约。为空时不传，方便 renderer 直接跳过该区块。
   */
  willHide?: Array<{ bundleId: string; displayName: string }>;
  /**
   * 请求发起时的 `chicagoAutoUnhide` 设置值。
   * renderer 会据此在 “操作完成后恢复” 与 “将被隐藏” 两套文案中做选择。
   * 若 `willHide` 不存在，这个字段也不会出现。
   */
  autoUnhideEnabled?: boolean;
}

/**
 * 用户点击 “Allow for this session” 后，renderer 会塞进 `updatedInput._cuGrants`
 * 的内容。它对应于 LocalAgentModeSessionManager.ts:2794 中 `_allowAllSites`
 * 哨兵的同类机制。
 */
export interface CuPermissionResponse {
  granted: AppGrant[];
  /** 用户取消勾选的 bundle ID，或根本未安装的 app。 */
  denied: Array<{ bundleId: string; reason: "user_denied" | "not_installed" }>;
  flags: CuGrantFlags;
  /**
   * 表示用户是否在“这一次”对话框中点了 Allow。
   * 该字段只会由 teach-mode handler 设置；普通 request_access 不需要它，
   * 因为那边由 session manager 的 `result.behavior` 决定是否合并。
   * 当所有请求的 app 都已提前授权时，Allow 与 Deny 都可能生成相同的
   * `{granted:[], denied:[]}` 结果，没有这个字段工具侧就无法区分。
   * Undefined 表示走旧路径或普通路径，不要用它做强制门控。
   */
  userConsented?: boolean;
}

// ----------------------------------------------------------------------------
// Host adapter（与 ClaudeForChromeContext, types.ts:33-62 对齐）
// ----------------------------------------------------------------------------

/**
 * 进程生命周期级别的单例依赖。
 * 所有不会随单次 tool call 改变的东西都放在这里，
 * 由 `apps/desktop/src/main/nest-only/chicago/hostAdapter.ts` 构建一次。
 * 这个 package 自身不直接引入 Electron，所有能力都由 host 注入。
 */
export interface ComputerUseHostAdapter {
  serverName: string;
  logger: Logger;
  executor: ComputerExecutor;

  /**
   * 检查 TCC 状态，也就是 macOS 上的 Accessibility 与 Screen Recording。
   * 这里只做纯检查，不弹窗、不重启。
   * 只要其中任一缺失，`request_access` 就会把状态透传给 renderer 以展示切换面板；
   * 其他工具则直接返回 tool error。
   */
  ensureOsPermissions(): Promise<
    { granted: boolean; accessibility?: boolean; screenRecording?: boolean }
  >;

  /** 设置页的总开关（`chicagoEnabled` app preference）。 */
  isDisabled(): boolean;

  /**
   * `chicagoAutoUnhide` 这一 app preference。
   * `buildAccessRequest` 会用它填充 `CuPermissionRequest.autoUnhideEnabled`，
   * 以便 renderer 只有在为 true 时才显示“稍后会恢复”的文案。
   */
  getAutoUnhideEnabled(): boolean;

  /**
   * 每次 tool call 都重新读取 sub-gates，
   * 这样 GrowthBook 的开关在 session 中途变化也能立即生效，无需重启。
   */
  getSubGates(): CuSubGates;

  /**
   * 为 PixelCompare 陈旧性校验提供 JPEG 解码、裁剪与原始像素字节能力。
   * 之所以通过注入方式提供，是为了让这个 package 保持 Electron-free。
   * host 通常会通过 `nativeImage.createFromBuffer(jpeg).crop(rect).toBitmap()` 实现。
   *
   * 若解码或裁剪失败，则返回 null；调用方会把它视为 `skipped`，
   * 点击仍继续执行，因为校验失败绝不能阻断动作本身。
   */
  cropRawPatch(
    jpegBase64: string,
    rect: { x: number; y: number; width: number; height: number },
  ): Buffer | null;
}

// ----------------------------------------------------------------------------
// Session context（供 bindSessionContext 使用的 getter / callback 集合）
// ----------------------------------------------------------------------------

/**
 * `bindSessionContext` 使用的每-session 状态绑定。
 * host 会为每个 session 构建一次它，其中 getter 负责从 session store 中读取最新值，
 * callback 负责写回。最终 dispatcher 会在每次调用时根据这些 getter 组装
 * `ComputerUseOverrides`。
 *
 * callback 必须在构造时就传好，因为 `bindSessionContext` 只会在 bind 时读取一次，
 * 不会在每次调用时重新抓取。
 *
 * lock hook 是异步的：`bindSessionContext` 会在进入 `handleToolCall` 前等待它们，
 * 然后在 overrides 中传入 `checkCuLock: undefined`，让 `handleToolCall` 内部的同步 Gate-3
 * 直接 no-op。带内存同步锁的 host 可以轻松包一层；跨进程锁的 host
 * （例如 CLI 的 O_EXCL 文件）则应直接调用真实的异步原语。
 */
export interface ComputerUseSessionContext {
  // ── Read state fresh per call ──────────────────────────────────────

  getAllowedApps(): readonly AppGrant[];
  getGrantFlags(): CuGrantFlags;
  /** 用户级自动拒绝列表（设置页）。空数组表示没有。 */
  getUserDeniedBundleIds(): readonly string[];
  getSelectedDisplayId(): number | undefined;
  getDisplayPinnedByModel?(): boolean;
  getDisplayResolvedForApps?(): string | undefined;
  getTeachModeActive?(): boolean;
  /** 当 `lastScreenshot` 缺失时，提供仅含尺寸的兜底信息（用于 cross-respawn）。
   *  `bindSessionContext` 会把它重建成 `{...dims, base64: ""}`，
   *  这样 scaleCoord 仍可工作，pixelCompare 也会正确跳过。 */
  getLastScreenshotDims?(): ScreenshotDims | undefined;

  // ── Write-back callbacks ───────────────────────────────────────────

  /** 显示审批对话框。host 负责路由到自己的 UI 并等待用户响应。
   *  如果工具调用在用户回答前就结束（如 MCP 超时），signal 会被中止，
   *  host 应在 abort 时关闭对话框。 */
  onPermissionRequest?(
    req: CuPermissionRequest,
    signal: AbortSignal,
  ): Promise<CuPermissionResponse>;
  /** teach-mode 下与 `onPermissionRequest` 对应的同类接口。 */
  onTeachPermissionRequest?(
    req: CuTeachPermissionRequest,
    signal: AbortSignal,
  ): Promise<CuPermissionResponse>;
  /** `bindSessionContext` 在把权限响应合并进 allowlist 后调用它。
   *  host 应负责持久化，以支持 resume 后继续生效。 */
  onAllowedAppsChanged?(apps: readonly AppGrant[], flags: CuGrantFlags): void;
  onAppsHidden?(bundleIds: string[]): void;
  /** 读取 session 中 clipboardGuard 暂存的文本。undefined 表示当前没有暂存。 */
  getClipboardStash?(): string | undefined;
  /** 写入 clipboardGuard 暂存文本；传 undefined 表示清空。 */
  onClipboardStashChanged?(stash: string | undefined): void;
  onResolvedDisplayUpdated?(displayId: number): void;
  onDisplayPinned?(displayId: number | undefined): void;
  onDisplayResolvedForApps?(sortedBundleIdsKey: string): void;
  /** 每次截图后调用，host 应负责持久化以便 respawn 后继续使用。 */
  onScreenshotCaptured?(dims: ScreenshotDims): void;
  onTeachModeActivated?(): void;
  onTeachStep?(req: TeachStepRequest): Promise<TeachStepResult>;
  onTeachWorking?(): void;

  // ── Lock (async) ───────────────────────────────────────────────────

  /** 任意时刻最多只有一个 session 能使用 CU。
   *  `bindSessionContext` 会在 dispatch 前等待它。Undefined 表示不做锁门控。 */
  checkCuLock?(): Promise<{ holder: string | undefined; isSelf: boolean }>;
  /** 获取锁。当 `checkCuLock` 返回 `holder: undefined` 且当前工具不允许延后时调用。
   *  host 可以在这里发出 enter-CU 信号。 */
  acquireCuLock?(): Promise<void>;
  /** host 自定义的“锁已被占用”错误文案。
   *  默认会使用 package 提供的通用消息；CLI host 会附带 holder 的 session ID 前缀。 */
  formatLockHeldMessage?(holder: string): string;

  /** 用户中止信号。会透传给 `ComputerUseOverrides.isAborted`，
   *  供 handleComputerBatch / handleType 在循环中途检查。 */
  isAborted?(): boolean;
}

// ----------------------------------------------------------------------------
// 每次调用的 overrides（与 PermissionOverrides, types.ts:97-102 对齐）
// ----------------------------------------------------------------------------

/**
 * 每次 tool call 时由 `bindSessionContext` 根据 `ComputerUseSessionContext`
 * 的 getter 重新构建，确保拿到的是最新值。
 * 这正是单例 MCP server 仍能承载每-session 状态的关键：状态存在 host 的 session store 中，
 * 而不是 server 实例本身。
 */
export interface ComputerUseOverrides {
  allowedApps: AppGrant[];
  grantFlags: CuGrantFlags;
  coordinateMode: CoordinateMode;

  /**
   * 用户配置的自动拒绝列表（设置 -> Desktop app -> Computer Use）。
   * 这里的 bundle ID 会在 request_access 进入审批对话框之前就被剔除，
   * 不论 tier 如何，用户都不会看到它们的审批项。
   * 若模型确实需要这些 app，响应会提示它去让用户在设置中移除 deny 项。
   *
   * 这是用户级配置，会跨重启持久化（每次从 appPreferences 读取，而不是 session state）。
   * 与仅在 session 内生效的 `allowedApps` 相对。
   * 空数组表示没有用户级拒绝项。
   */
  userDeniedBundleIds: readonly string[];

  /**
   * CU 当前操作的 display，会在每次调用时重新读取。
   * `scaleCoord` 使用的是 `lastScreenshot` 中快照下来的 `originX/Y`，
   * 因此 session 中途切换 display 只会影响“下一次” screenshot/prepare 调用。
   */
  selectedDisplayId?: number;

  /**
   * `request_access` 的工具处理器会调用并等待它。
   * serverDef.ts 里的包裹闭包会经由 `handleToolPermission` -> IPC -> renderer ChicagoApproval
   * 完成整条链路。它 resolve 后，wrapper 会先带副作用地更新
   * `InternalServerContext.cuAllowedApps`，然后才返回到这里。
   *
   * 如果 session 没有接入权限处理器（例如未来的 headless mode），
   * 这里就是 Undefined，`request_access` 会直接返回 tool error。
   */
  onPermissionRequest?: (req: CuPermissionRequest) => Promise<CuPermissionResponse>;

  /**
   * 供 pixel-validation 陈旧性校验使用。
   * 这是模型上一次截图结果，由 serverDef.ts 在每次 `screenshot` 工具调用后暂存。
   * 冷启动时为 Undefined，此时会跳过 pixel validation，点击照常继续。
   */
  lastScreenshot?: ScreenshotResult;

  /**
   * 每次 `prepareForAction` 后触发，参数是刚刚被隐藏的 bundle ID 列表。
   * serverDef.ts 里的 wrapper 会通过写透回调把这些值累计进
   * `Session.cuHiddenDuringTurn`。回合结束时（`sdkMessage.type === "result"`），
   * 如果启用了 `chicagoAutoUnhide`，集合中的 app 会被重新显示。
   * 无论设置如何，这个集合都会被清空，避免跨回合泄漏。
   *
   * 如果 session 没接入这类 tracker，这个字段就是 Undefined，
   * 那么 unhide 逻辑就不会发生。
   */
  onAppsHidden?: (bundleIds: string[]) => void;

  /**
   * 从 session state 中读取 clipboardGuard 暂存值。
   * `undefined` 表示当前没有暂存；`syncClipboardStash` 会在首次进入 click-tier 时暂存，
   * 恢复时再清掉。它与 `cuHiddenDuringTurn` 采用同样的 getter 模式，
   * 状态保存在 host 的 session 上，而不是这里的模块级变量。
   */
  getClipboardStash?: () => string | undefined;

  /**
   * 把 clipboardGuard 暂存值写回 session state；传 `undefined` 表示清空。
   * 它与 `onAppsHidden` 属于同类写透接口，wrapper 会把值落到
   * `Session.cuClipboardStash`。回合结束时 host 会直接读出并清空，
   * 再通过 Electron 的 `clipboard.writeText` 恢复。
   */
  onClipboardStashChanged?: (stash: string | undefined) => void;

  /**
   * 把 resolver 选中的 display 写回 session，
   * 这样 teach overlay 的定位以及后续非 resolver 调用都能继续使用同一块 display。
   * 当 `autoTargetDisplay` 原子路径下 `resolvePrepareCapture` 的结果
   * 与 `selectedDisplayId` 不同时，`handleScreenshot` 会触发它。
   * 这是 fire-and-forget 调用。
   */
  onResolvedDisplayUpdated?: (displayId: number) => void;

  /**
   * 当模型通过 `switch_display` 明确选择了某块 display 时置为 true。
   * 一旦如此，`handleScreenshot` 会传入 `autoResolve: false`，
   * 让 Swift resolver 直接尊重 `selectedDisplayId`，而不是再跑一遍共址/追踪链。
   * 否则，只要某个 allowlisted app 与 host 共用同一显示器，resolver 的 Step 2
   * 就可能覆盖掉 `selectedDisplayId`。
   */
  displayPinnedByModel?: boolean;

  /**
   * 把模型明确选中的 display 写回 session。
   * `displayId: undefined` 会同时清掉 `selectedDisplayId` 与 pin 状态，回到自动解析模式。
   * 它与 `onResolvedDisplayUpdated` 看似相似，但语义不同：一个是 resolver 选的，
   * 一个是模型主动选的。
   */
  onDisplayPinned?: (displayId: number | undefined) => void;

  /**
   * 最近一次自动解析 display 时所对应的 bundle ID 集合，
   * 采用排序后逗号拼接的字符串表示。
   * `handleScreenshot` 会把它与当前 allowlisted app 集合比较，只有在两者不同的时候
   * 才传 `autoResolve: true`，从而避免每次截图都重新抢 display；
   * 只有 app 集合变化后才会重新解析。
   */
  displayResolvedForApps?: string;

  /**
   * 记录当前 display 选择对应的是哪一组 app。
   * 当 resolver 选中 display 时，它会与 `onResolvedDisplayUpdated` 一起触发，
   * 这样下一次 screenshot 看到 app 集合未变时就会跳过 auto-resolve。
   */
  onDisplayResolvedForApps?: (sortedBundleIdsKey: string) => void;

  /**
   * 全局 CU 锁：任意时刻最多只有一个 session 能真正占用 CU。
   * `handleToolCall` 会在 kill switch/TCC 检查之后、dispatch 之前检查它；
   * 包括 `request_access` 在内的所有 CU 工具都会走这里。
   *
   * - `holder === undefined`：锁空闲，可以获取
   * - `isSelf === true`：当前 session 已持有，直接继续
   * - `holder !== undefined && !isSelf`：被其他 session 占用，返回 tool error
   *
   * callback 为 `undefined` 说明 host 没接入锁机制，并不意味着“被锁住”，
   * 而是直接跳过门控继续执行。
   *
   * 锁的释放由 host 自己负责（如 session idle/stop/archive 时），
   * 这个 package 本身不会主动释放。
   */
  checkCuLock?: () => { holder: string | undefined; isSelf: boolean };

  /**
   * 为当前 session 获取锁。
   * `handleToolCall` 每回合只会在“第一次” CU 工具调用时调用它，
   * 且前提是 `checkCuLock().holder` 为 undefined。
   * 如果锁已持有则 no-op；host 可以在这里发出 overlay 监听的事件。
   */
  acquireCuLock?: () => void;

  /**
   * 用户中止信号。
   * `handleComputerBatch` 和 `handleType` 的 grapheme 循环会在中途检查它，
   * 让进行中的 batch/type 在 overlay Stop 后尽快停下，而不是等整轮跑完。
   *
   * Undefined 表示永不中止；它采用和 `checkCuLock` 一样的 lazy getter 模式，
   * 每次检查都读取最新值。
   */
  isAborted?: () => boolean;

  // ── Teach mode ───────────────────────────────────────────────────────
  // 只有在 host 的 teachModeEnabled gate 打开时才会接线。
  // 下面五项若全部为 undefined，`request_teach_access` / `teach_step`
  // 就会返回 tool error，也就等价于 teach mode 未启用。

  /**
   * 与 `onPermissionRequest` 对应的 teach-mode 版本。
   * 同样会阻塞等待 renderer 对话框，但会路由到 ComputerUseTeachApproval.tsx，
   * 而不是普通的 ComputerUseApproval。
   * serverDef.ts 里的 wrapper 也会像 `onPermissionRequest` 一样，
   * 通过 `onCuPermissionUpdated` 把授权结果写回 session state。
   */
  onTeachPermissionRequest?: (
    req: CuTeachPermissionRequest,
  ) => Promise<CuPermissionResponse>;

  /**
   * 当用户批准 teach access 且至少有一个 app 被授权后，由 `handleRequestTeachAccess` 调用。
   * host 会把 `session.teachModeActive` 设为 true，并发出 `teachModeChanged`，
   * 让 teach controller 隐藏主窗口、显示全屏 overlay。
   * 回合结束时（`transitionTo("idle")`）host 会负责清理它，并同时释放 CU 锁。
   */
  onTeachModeActivated?: () => void;

  /**
   * `handleRequestAccess` 与 `handleRequestTeachAccess` 会读取它，
   * 在 teach mode 已激活时直接短路返回明确的 tool error。
   * teach mode 下主窗口是隐藏的，权限对话框会变成“不可见但阻塞”的状态，
   * 因此更合理的做法是先告诉模型退出 teach mode。
   * 之所以设计成 getter 而不是布尔字段，是因为 teach mode 状态保存在 session 上，
   * 而不是这个 per-call overrides 对象里。
   */
  getTeachModeActive?: () => boolean;

  /**
   * `handleTeachStep` 会把缩放后的 anchor 与文本传给它。
   * host 保存 resolver，发出 `teachStepRequested`，再由 teach controller
   * 把 payload 推给 overlay；用户阅读后点击 Next，经由 IPC 返回，
   * host 调用之前保存的 resolver，最终让这个 promise resolve。
   * 若用户点击 Exit 或当前回合被打断，则返回 `{action: "exit"}`，
   * `handleTeachStep` 会直接短路，不执行后续动作。
   *
   * 这和 `onPermissionRequest` 一样是阻塞 promise 模式，
   * 但 resolve 的来源是 teach overlay 自己的 preload，而不是主 renderer 的审批 UI。
   */
  onTeachStep?: (req: TeachStepRequest) => Promise<TeachStepResult>;

  /**
   * 在 `onTeachStep` 以 "next" resolve 后、真正 dispatch action 前立即调用。
   * host 会发出 `teachStepWorking`，让 overlay 切到加载态：Next 按钮消失，
   * Exit 保留，并展示 "Working..." 与旋转指示。
   * 下一次 `onTeachStep` 调用会再用新 tooltip 内容替换这个加载态。
   */
  onTeachWorking?: () => void;
}

// ----------------------------------------------------------------------------
// Teach mode（带 Next 按钮驱动动作执行的引导式 tooltip）
// ----------------------------------------------------------------------------

/**
 * host 推送给 teach overlay BrowserWindow 的 payload。
 * 它由 toolCalls.ts 中的 `handleTeachStep` 根据模型传入的 `teach_step` 参数构建。
 *
 * 这里的 `anchorLogical` 已经是经过 `scaleCoord` 之后的值，表示“整块显示器”坐标系下的
 * macOS 逻辑点（原点位于显示器左上角，包含菜单栏，因为 cuDisplayInfo 返回的是
 * CGDisplayBounds）。而 overlay 窗口实际定位在 `workArea.{x,y}` 上
 * （不包含菜单栏与 Dock），因此 teach/window.ts 中的 `updateTeachStep`
 * 会在 IPC 前减去 workArea offset，保证 HTML 的 CSS 坐标对得上。
 */
export interface TeachStepRequest {
  explanation: string;
  nextPreview: string;
  /** 整块显示器坐标系下的逻辑点。Undefined 时 overlay 会把 tooltip 居中并隐藏箭头。 */
  anchorLogical?: { x: number; y: number };
}

export type TeachStepResult = { action: "next" } | { action: "exit" };

/**
 * renderer 中 ComputerUseTeachApproval 对话框使用的 payload。
 * 和 `CuPermissionRequest` 一样，它也通过 `ToolPermissionRequest.input: unknown`
 * 进行传递。
 * 之所以单独定义成一个类型，而不是给 `CuPermissionRequest` 增加标记位，
 * 是为了让两个审批组件能独立做类型收窄，也让 teach 对话框可以自由删掉
 * 自己根本不渲染的字段（例如 teach mode 下没有 grant-flag 复选框）。
 */
export interface CuTeachPermissionRequest {
  requestId: string;
  /** 模型给出的原因，会显示在对话框标题中（“guide you through {reason}”）。 */
  reason: string;
  apps: ResolvedAppRequest[];
  screenshotFiltering: "native" | "none";
  /** 仅在 TCC 尚未授权时出现，语义与 `CuPermissionRequest.tccState` 相同。 */
  tccState?: {
    accessibility: boolean;
    screenRecording: boolean;
  };
  willHide?: Array<{ bundleId: string; displayName: string }>;
  /** 语义与 `CuPermissionRequest.autoUnhideEnabled` 相同。 */
  autoUnhideEnabled?: boolean;
}
