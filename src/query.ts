// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { FallbackTriggeredError } from './services/api/withRetry.js'
import {
  calculateTokenWarningState,
  isAutoCompactEnabled,
  type AutoCompactTrackingState,
} from './services/compact/autoCompact.js'
import { buildPostCompactMessages } from './services/compact/compact.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as typeof import('./services/compact/reactiveCompact.js'))
  : null
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { ImageSizeError } from './utils/imageValidation.js'
import { ImageResizeError } from './utils/imageResizer.js'
import { findToolByName, type ToolUseContext } from './Tool.js'
import { asSystemPrompt, type SystemPrompt } from './utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  ToolUseSummaryMessage,
  UserMessage,
  TombstoneMessage,
} from './types/message.js'
import { logError } from './utils/log.js'
import {
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  isPromptTooLongMessage,
} from './services/api/errors.js'
import { logAntError, logForDebugging } from './utils/debug.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createAssistantAPIErrorMessage,
  getMessagesAfterCompactBoundary,
  createToolUseSummaryMessage,
  createMicrocompactBoundaryMessage,
  stripSignatureBlocks,
} from './utils/messages.js'
import { generateToolUseSummary } from './services/toolUseSummary/toolUseSummaryGenerator.js'
import { prependUserContext, appendSystemContext } from './utils/api.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from './utils/attachments.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const skillPrefetch = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('./services/skillSearch/prefetch.js') as typeof import('./services/skillSearch/prefetch.js'))
  : null
const jobClassifier = feature('TEMPLATES')
  ? (require('./jobs/classifier.js') as typeof import('./jobs/classifier.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  remove as removeFromQueue,
  getCommandsByMaxPriority,
  isSlashCommand,
} from './utils/messageQueueManager.js'
import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import {
  getRuntimeMainLoopModel,
  renderModelName,
} from './utils/model/model.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from './utils/tokens.js'
import { ESCALATED_MAX_TOKENS } from './utils/context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from './services/analytics/growthbook.js'
import { SLEEP_TOOL_NAME } from './tools/SleepTool/prompt.js'
import { executePostSamplingHooks } from './utils/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from './utils/hooks.js'
import type { QuerySource } from './constants/querySource.js'
import { createDumpPromptsFetch } from './services/api/dumpPrompts.js'
import { StreamingToolExecutor } from './services/tools/StreamingToolExecutor.js'
import { queryCheckpoint } from './utils/queryProfiler.js'
import { runTools } from './services/tools/toolOrchestration.js'
import { applyToolResultBudget } from './utils/toolResultStorage.js'
import { recordContentReplacement } from './utils/sessionStorage.js'
import { handleStopHooks } from './query/stopHooks.js'
import { buildQueryConfig } from './query/config.js'
import { productionDeps, type QueryDeps } from './query/deps.js'
import type { Terminal, Continue } from './query/transitions.js'
import { feature } from 'bun:bundle'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
} from './bootstrap/state.js'
import { createBudgetTracker, checkTokenBudget } from './query/tokenBudget.js'
import { count } from './utils/array.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const taskSummaryModule = feature('BG_SESSIONS')
  ? (require('./utils/taskSummary.js') as typeof import('./utils/taskSummary.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const assistantMessage of assistantMessages) {
    // 从这条 assistant 消息中提取所有 tool_use block
    const toolUseBlocks = assistantMessage.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]

    // 为每个 tool use 发出一条中断消息
    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: errorMessage,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: errorMessage,
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
  }
}

/**
 * thinking 的规则既漫长又玄妙。它们要求足够长时间的思考与深度冥想，
 * 才能让一位巫师真正想明白。
 *
 * 规则如下：
 * 1. 含有 thinking 或 redacted_thinking block 的消息，必须属于一个 max_thinking_length > 0 的 query
 * 2. thinking block 不能成为一个 block 中的最后一条消息
 * 3. thinking block 必须在整个 assistant 轨迹期间被保留（一个单独 turn；如果该 turn 含有 tool_use block，则还包括其后的 tool_result 以及再后面的 assistant 消息）
 *
 * 年轻的巫师啊，务必要牢记这些规则。因为它们是 thinking 的规则，
 * 而 thinking 的规则，就是宇宙的规则。若你不遵守这些规则，
 * 你将被罚上一整天的调试与抓头发。
 */
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

/**
 * 这是不是一条 max_output_tokens 错误消息？如果是，streaming loop 应先
 * 对 SDK 调用方暂时隐藏它，直到我们确认 recovery loop 是否还能继续。
 * 过早 yield 会把中间态错误泄露给 SDK 调用方（例如 cowork/desktop），
 * 而它们通常会在看到任意 `error` 字段后立刻终止会话——此时 recovery loop
 * 还在继续跑，但已经没有任何人会再接收结果了。
 *
 * 与 reactiveCompact.isWithheldPromptTooLong 保持一致。
 */
function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  // API task_budget（output_config.task_budget，beta task-budgets-2026-03-13）。
  // 它不同于 tokenBudget +500k 的自动续跑特性。`total` 是整个 agentic turn
  // 的预算；`remaining` 则在每次迭代中根据累计 API usage 计算得出。
  // 详见 claude.ts 中的 configureTaskBudgetParams。
  taskBudget?: { total: number }
  deps?: QueryDeps
}

// -- query loop 状态

// 在 loop 各次迭代之间传递的可变状态
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  // 上一次迭代为何继续。首次迭代时为 undefined。
  // 让测试无需检查消息内容，也能断言 recovery 路径是否触发。
  transition: Continue | undefined
}

export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // 只有在 queryLoop 正常返回时才会走到这里。throw 时会跳过
  //（error 会沿着 yield* 传播），.return() 时也会跳过
  //（Return completion 会关闭两个 generator）。这样在 turn 失败时，
  // 就能得到与 print.ts 中 drainCommandQueue 相同的“started 了但未 completed”的非对称信号。
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}

async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // 不可变参数——在 query loop 期间绝不会被重新赋值。
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params
  const deps = params.deps ?? productionDeps()

  // 跨迭代的可变状态。loop 体会在每次迭代开始时解构它，
  // 这样读取时可直接使用裸名（`messages`、`toolUseContext`）。
  // 各个 continue 位置只需写 `state = { ... }`，而不是拆成 9 次独立赋值。
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }
  const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

  // 跨 compaction boundary 跟踪 task_budget.remaining。在第一次 compact
  // 触发前它为 undefined——当上下文尚未被压缩时，server 能看到完整历史，
  // 会自行从 {total} 开始倒数（见 api/api/sampling/prompt/renderer.py:292）。
  // compact 之后，server 只能看到 summary，会低估已花费额度；remaining 用来告知它
  // 那个在压缩前最终窗口中、现已被摘要折叠掉的部分。该值会跨多次 compact 累加：
  // 每次都减去该次 compact 触发点对应的最终上下文。它是 loop-local 变量
  //（而非 State 字段），这样就不用改动 7 个 continue 位置。
  let taskBudgetRemaining: number | undefined = undefined

  // 在入口处一次性快照不可变的 env/statsig/session 状态。
  // 具体包含哪些内容，以及为何有意排除 feature() gate，见 QueryConfig。
  const config = buildQueryConfig()

  // 每个 user turn 只触发一次——prompt 在 loop 各次迭代间不变，
  // 因此若按迭代触发，就会向 sideQuery 重复问同一个问题 N 次。
  // consume 点只轮询 settledAt（绝不阻塞）。`using` 会在 generator 的所有退出路径上
  // 自动 dispose——有关 dispose/telemetry 语义见 MemoryPrefetch。
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 在每次迭代开头解构 state。只有 toolUseContext 会在单次迭代内部被重新赋值
    //（queryTracking、messages 更新）；其余字段在 continue 站点之间都只读。
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
    } = state

    // Skill discovery 预取——按迭代进行（内部使用 findWritePivot guard，
    // 在非写入迭代上会尽早返回）。discovery 会与 model 流式输出和 tool 执行并行，
    // 并在 post-tools 阶段与 memory prefetch 的 consume 一起 await。
    // 它替代了原先位于 getAttachmentMessages 内部、会阻塞的 assistant_turn 路径
    //（线上 97% 的调用其实什么都没找到）。turn-0 的 user-input discovery
    // 仍然会在 userInputAttachments 中阻塞——因为那是唯一没有先前工作可供隐藏延迟的信号。
    const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
      null,
      messages,
      toolUseContext,
    )

    yield { type: 'stream_request_start' }

    queryCheckpoint('query_fn_entry')

    // 记录 query 开始时间，供 headless 延迟追踪使用（subagent 跳过）
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    // 初始化或递增 query chain tracking
    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    const queryChainIdForAnalytics =
      queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

    let tracking = autoCompactTracking

    // 针对聚合后的 tool result 大小执行逐消息预算限制。它发生在
    // microcompact 之前——cached MC 纯粹按 tool_use_id 工作（从不检查 content），
    // 因此内容替换对它是不可见的，二者可以干净地组合。若 contentReplacementState
    // 为 undefined（功能关闭），这里就是 no-op。
    // 只对那些会在 resume 时回读记录的 querySource 做持久化：agentId 会路由到
    // sidechain 文件（AgentTool resume）或 session 文件（/resume）。
    // 临时性的 runForkedAgent 调用方（agent_summary 等）不会持久化。
    const persistReplacements =
      querySource.startsWith('agent:') ||
      querySource.startsWith('repl_main_thread')
    messagesForQuery = await applyToolResultBudget(
      messagesForQuery,
      toolUseContext.contentReplacementState,
      persistReplacements
        ? records =>
            void recordContentReplacement(
              records,
              toolUseContext.agentId,
            ).catch(logError)
        : undefined,
      new Set(
        toolUseContext.options.tools
          .filter(t => !Number.isFinite(t.maxResultSizeChars))
          .map(t => t.name),
      ),
    )

    // 在 microcompact 之前应用 snip（两者都可能运行——并不是互斥关系）。
    // snipTokensFreed 会透传给 autocompact，这样它的阈值判断才能反映出
    // snip 真正移除了多少内容；单靠 tokenCountWithEstimation 看不见这部分
    //（它读取的是受保护尾部 assistant 的 usage，而那部分在 snip 后保持不变）。
    let snipTokensFreed = 0
    if (feature('HISTORY_SNIP')) {
      queryCheckpoint('query_snip_start')
      const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
      messagesForQuery = snipResult.messages
      snipTokensFreed = snipResult.tokensFreed
      if (snipResult.boundaryMessage) {
        yield snipResult.boundaryMessage
      }
      queryCheckpoint('query_snip_end')
    }

    // 在 autocompact 之前应用 microcompact
    queryCheckpoint('query_microcompact_start')
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
    messagesForQuery = microcompactResult.messages
    // 对 cached microcompact（缓存编辑）而言，把 boundary message 延后到
    // API 响应之后再发出，这样才能使用真实的 cache_deleted_input_tokens。
    // 通过 feature() 进行门控，确保该字符串会从外部构建中被消除。
    const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
      ? microcompactResult.compactionInfo?.pendingCacheEdits
      : undefined
    queryCheckpoint('query_microcompact_end')

    // 投影出 collapsed context 视图，并在必要时提交更多 collapse。
    // 它必须运行在 autocompact 之前，这样如果 collapse 已经把我们压到
    // autocompact 阈值之下，autocompact 就会变成 no-op，我们便能保留粒度更细的
    // 上下文，而不是退化成单一 summary。
    //
    // 这里不会 yield 任何内容——collapsed view 是对 REPL 完整历史在读取时做的投影。
    // summary message 存在于 collapse store 中，而不是 REPL 数组。这正是
    // collapse 能跨 turn 持久存在的原因：projectView() 会在每次进入时重放 commit log。
    // 在单个 turn 内，这个视图会通过 continue 位置上的 state.messages 向前流动
    //（query.ts:1192），而下一次 projectView() 会成为 no-op，因为那些已归档消息
    // 已经不再出现在其输入中了。
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
        messagesForQuery,
        toolUseContext,
        querySource,
      )
      messagesForQuery = collapseResult.messages
    }

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    queryCheckpoint('query_autocompact_start')
    const { compactionResult, consecutiveFailures } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      querySource,
      tracking,
      snipTokensFreed,
    )
    queryCheckpoint('query_autocompact_end')

    if (compactionResult) {
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult

      logEvent('tengu_auto_compact_succeeded', {
        originalMessageCount: messages.length,
        compactedMessageCount:
          compactionResult.summaryMessages.length +
          compactionResult.attachments.length +
          compactionResult.hookResults.length,
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionInputTokens: compactionUsage?.input_tokens,
        compactionOutputTokens: compactionUsage?.output_tokens,
        compactionCacheReadTokens:
          compactionUsage?.cache_read_input_tokens ?? 0,
        compactionCacheCreationTokens:
          compactionUsage?.cache_creation_input_tokens ?? 0,
        compactionTotalTokens: compactionUsage
          ? compactionUsage.input_tokens +
            (compactionUsage.cache_creation_input_tokens ?? 0) +
            (compactionUsage.cache_read_input_tokens ?? 0) +
            compactionUsage.output_tokens
          : 0,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // task_budget：在下面用 postCompactMessages 替换 messagesForQuery 之前，
      // 先捕获压缩前的最终上下文窗口。iterations[-1] 才是权威的最终窗口
      //（服务器端 tool loop 之后的结果）；见 #304930。
      if (params.taskBudget) {
        const preCompactContext =
          finalContextTokensFromLastResponse(messagesForQuery)
        taskBudgetRemaining = Math.max(
          0,
          (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
        )
      }

      // 每次 compact 后都重置，这样 turnCounter/turnId 反映的是最近一次 compact。
      // recompactionInfo（autoCompact.ts:190）在调用前就已捕获旧的
      // turnsSincePreviousCompact/previousCompactTurnId，因此这里重置不会丢失那些信息。
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }

      const postCompactMessages = buildPostCompactMessages(compactionResult)

      for (const message of postCompactMessages) {
        yield message
      }

      // 在当前 query 调用中继续执行，但改用压缩后的消息
      messagesForQuery = postCompactMessages
    } else if (consecutiveFailures !== undefined) {
      // Autocompact 失败——传播失败次数，让熔断器能在下一次迭代时停止继续重试。
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    // TODO：初始化阶段没必要设置 toolUseContext.messages，因为这里会更新它
    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    const assistantMessages: AssistantMessage[] = []
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    // @see https://docs.claude.com/en/docs/build-with-claude/tool-use
    // 注意：stop_reason === 'tool_use' 并不可靠——它并不总会被正确设置。
    // 只要流式过程中收到 tool_use block，就设置该标志——这是唯一的
    // loop-exit 信号。如果 streaming 结束后它仍为 false，那就说明这一轮结束了
    //（除非还要走 stop-hook 重试）。
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    queryCheckpoint('query_setup_start')
    const useStreamingToolExecution = config.gates.streamingToolExecution
    let streamingToolExecutor = useStreamingToolExecution
      ? new StreamingToolExecutor(
          toolUseContext.options.tools,
          canUseTool,
          toolUseContext,
        )
      : null

    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: toolUseContext.options.mainLoopModel,
      exceeds200kTokens:
        permissionMode === 'plan' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })

    queryCheckpoint('query_setup_end')

    // 每个 query session 只创建一次 fetch wrapper，以避免内存滞留。
    // 每次调用 createDumpPromptsFetch 都会创建一个捕获 request body 的闭包。
    // 只创建一次意味着只会保留最新的 request body（约 700KB），
    // 而不是保留该 session 的所有请求体（长 session 可达约 500MB）。
    // 注意：在一次 query() 调用期间，agentId 实际上可视为常量——它只会在
    // query 之间发生变化（例如 /clear 命令或 session resume）。
    const dumpPromptsFetch = config.gates.isAnt
      ? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
      : undefined

    // 如果已经触及硬阻塞上限，则直接阻塞（仅在 auto-compact 关闭时适用）。
    // 这样可以保留出空间，让用户仍能手动运行 /compact。
    // 如果 compaction 刚刚发生，则跳过这项检查——compact 结果已经被验证处于阈值之下，
    // 而 tokenCountWithEstimation 会从保留下来的消息里读取陈旧的 input_tokens，
    // 这些值反映的是压缩前的上下文大小。
    // snip 也有同样的陈旧性问题：要减去 snipTokensFreed（否则会在某个窗口里误判阻塞：
    // snip 明明已把我们压到 autocompact 阈值以下，但陈旧 usage 仍高于 blocking limit——
    // 在这个 PR 之前这个窗口并不存在，因为 autocompact 总会基于陈旧计数触发）。
    // 对 compact/session_memory query 也要跳过——这些是继承完整对话的 forked agent，
    // 如果在这里被阻塞会直接死锁（compact agent 的职责本来就是减少 token 数）。
    // 当 reactive compact 启用且允许自动压缩时也要跳过——预先拦截产生的 synthetic error
    // 会在 API 调用前就返回，reactive compact 根本看不到一个 prompt-too-long 可以响应。
    // 这里放宽为 walrus 逻辑，是为了让 RC 能在 proactive 失败时作为 fallback。
    //
    // context-collapse 也同样要跳过：它的 recoverFromOverflow 会在真正的 API 413
    // 上清空 staged collapse，然后继续走到 reactiveCompact。若此处用 synthetic
    // preempt 提前返回，API 调用根本不会发生，两条恢复路径都会被饿死。
    // isAutoCompactEnabled() 这个合取项保留了用户“显式不要任何自动动作”的配置——
    // 如果他们设置了 DISABLE_AUTO_COMPACT，就仍然会拿到这个 preempt。
    let collapseOwnsIt = false
    if (feature('CONTEXT_COLLAPSE')) {
      collapseOwnsIt =
        (contextCollapse?.isContextCollapseEnabled() ?? false) &&
        isAutoCompactEnabled()
    }
    // 每个 turn 只提升一次 media-recovery gate。withhold（stream loop 内）与
    // recovery（之后）必须保持一致；CACHED_MAY_BE_STALE 可能在 5-30 秒的流式期间翻转，
    // 如果出现“withhold 但不 recover”，消息就会被吞掉。PTL 不做这种 hoist，
    // 因为它的 withhold 不受 gate 控制——它早于这个实验就存在，并且已是控制组基线。
    const mediaRecoveryEnabled =
      reactiveCompact?.isReactiveCompactEnabled() ?? false
    if (
      !compactionResult &&
      querySource !== 'compact' &&
      querySource !== 'session_memory' &&
      !(
        reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()
      ) &&
      !collapseOwnsIt
    ) {
      const { isAtBlockingLimit } = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
        toolUseContext.options.mainLoopModel,
      )
      if (isAtBlockingLimit) {
        yield createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        })
        return { reason: 'blocking_limit' }
      }
    }

    let attemptWithFallback = true

    queryCheckpoint('query_api_loop_start')
    try {
      while (attemptWithFallback) {
        attemptWithFallback = false
        try {
          let streamingFallbackOccured = false
          queryCheckpoint('query_api_streaming_start')
          for await (const message of deps.callModel({
            messages: prependUserContext(messagesForQuery, userContext),
            systemPrompt: fullSystemPrompt,
            thinkingConfig: toolUseContext.options.thinkingConfig,
            tools: toolUseContext.options.tools,
            signal: toolUseContext.abortController.signal,
            options: {
              async getToolPermissionContext() {
                const appState = toolUseContext.getAppState()
                return appState.toolPermissionContext
              },
              model: currentModel,
              ...(config.gates.fastModeEnabled && {
                fastMode: appState.fastMode,
              }),
              toolChoice: undefined,
              isNonInteractiveSession:
                toolUseContext.options.isNonInteractiveSession,
              fallbackModel,
              onStreamingFallback: () => {
                streamingFallbackOccured = true
              },
              querySource,
              agents: toolUseContext.options.agentDefinitions.activeAgents,
              allowedAgentTypes:
                toolUseContext.options.agentDefinitions.allowedAgentTypes,
              hasAppendSystemPrompt:
                !!toolUseContext.options.appendSystemPrompt,
              maxOutputTokensOverride,
              fetchOverride: dumpPromptsFetch,
              mcpTools: appState.mcp.tools,
              hasPendingMcpServers: appState.mcp.clients.some(
                c => c.type === 'pending',
              ),
              queryTracking,
              effortValue: appState.effortValue,
              advisorModel: appState.advisorModel,
              skipCacheWrite,
              agentId: toolUseContext.agentId,
              addNotification: toolUseContext.addNotification,
              ...(params.taskBudget && {
                taskBudget: {
                  total: params.taskBudget.total,
                  ...(taskBudgetRemaining !== undefined && {
                    remaining: taskBudgetRemaining,
                  }),
                },
              }),
            },
          })) {
            // 我们不会使用第一次尝试中的 tool_calls。
            // 当然也可以，但那样就不得不合并具有不同 id 的 assistant 消息，
            // 并且会把整套 tool_results 重复一遍。
            if (streamingFallbackOccured) {
              // 为孤儿消息 yield tombstone，这样它们就会从 UI 和 transcript 中移除。
              // 这些部分消息（尤其是 thinking block）带有无效签名，
              // 会触发 "thinking blocks cannot be modified" 这类 API 错误。
              for (const msg of assistantMessages) {
                yield { type: 'tombstone' as const, message: msg }
              }
              logEvent('tengu_orphaned_messages_tombstoned', {
                orphanedMessageCount: assistantMessages.length,
                queryChainId: queryChainIdForAnalytics,
                queryDepth: queryTracking.depth,
              })

              assistantMessages.length = 0
              toolResults.length = 0
              toolUseBlocks.length = 0
              needsFollowUp = false

              // 丢弃失败的流式尝试中尚未处理的结果，并创建一个全新的 executor。
              // 这样可以防止携带旧 tool_use_id 的孤儿 tool_result 在 fallback 响应到达后被错误 yield。
              if (streamingToolExecutor) {
                streamingToolExecutor.discard()
                streamingToolExecutor = new StreamingToolExecutor(
                  toolUseContext.options.tools,
                  canUseTool,
                  toolUseContext,
                )
              }
            }
            // 在 yield 前先对克隆消息中的 tool_use 输入做回填，
            // 这样 SDK 流输出和 transcript 序列化都能看到 legacy/derived 字段。
            // 原始 `message` 本身保持不动，供下面的 assistantMessages.push 使用——
            // 它还会回流给 API，若对其做修改，会因为字节不一致而破坏 prompt cache。
            let yieldMessage: typeof message = message
            if (message.type === 'assistant') {
              let clonedContent: typeof message.message.content | undefined
              for (let i = 0; i < message.message.content.length; i++) {
                const block = message.message.content[i]!
                if (
                  block.type === 'tool_use' &&
                  typeof block.input === 'object' &&
                  block.input !== null
                ) {
                  const tool = findToolByName(
                    toolUseContext.options.tools,
                    block.name,
                  )
                  if (tool?.backfillObservableInput) {
                    const originalInput = block.input as Record<string, unknown>
                    const inputCopy = { ...originalInput }
                    tool.backfillObservableInput(inputCopy)
                    // 只有当 backfill 新增了字段时才 yield 克隆体；若只是覆盖已有字段
                    //（例如 file tool 展开 file_path），则跳过。覆盖会改变序列化后的
                    // transcript，并在 resume 时破坏 VCR fixture 哈希；而 SDK stream
                    // 并不需要这些覆盖结果——hooks 会通过 toolExecution.ts 另行拿到展开路径。
                    const addedFields = Object.keys(inputCopy).some(
                      k => !(k in originalInput),
                    )
                    if (addedFields) {
                      clonedContent ??= [...message.message.content]
                      clonedContent[i] = { ...block, input: inputCopy }
                    }
                  }
                }
              }
              if (clonedContent) {
                yieldMessage = {
                  ...message,
                  message: { ...message.message, content: clonedContent },
                }
              }
            }
            // 对可恢复错误（prompt-too-long、max-output-tokens）先暂缓输出，
            // 直到我们确认恢复流程（collapse drain / reactive compact /
            // truncation retry）是否能够成功。它们仍会被 push 到 assistantMessages，
            // 这样下方的恢复检查才能找到它们。任一子系统执行 withhold 都足够——
            // 它们彼此独立，因此关掉一个不会破坏另一个的恢复路径。
            //
            // feature() 只能工作在 if/ternary 条件中（受 bun:bundle 的
            // tree-shaking 约束），因此 collapse 检查采用嵌套，而非组合表达式。
            let withheld = false
            if (feature('CONTEXT_COLLAPSE')) {
              if (
                contextCollapse?.isWithheldPromptTooLong(
                  message,
                  isPromptTooLongMessage,
                  querySource,
                )
              ) {
                withheld = true
              }
            }
            if (reactiveCompact?.isWithheldPromptTooLong(message)) {
              withheld = true
            }
            if (
              mediaRecoveryEnabled &&
              reactiveCompact?.isWithheldMediaSizeError(message)
            ) {
              withheld = true
            }
            if (isWithheldMaxOutputTokens(message)) {
              withheld = true
            }
            if (!withheld) {
              yield yieldMessage
            }
            if (message.type === 'assistant') {
              assistantMessages.push(message)

              const msgToolUseBlocks = message.message.content.filter(
                content => content.type === 'tool_use',
              ) as ToolUseBlock[]
              if (msgToolUseBlocks.length > 0) {
                toolUseBlocks.push(...msgToolUseBlocks)
                needsFollowUp = true
              }

              if (
                streamingToolExecutor &&
                !toolUseContext.abortController.signal.aborted
              ) {
                for (const toolBlock of msgToolUseBlocks) {
                  streamingToolExecutor.addTool(toolBlock, message)
                }
              }
            }

            if (
              streamingToolExecutor &&
              !toolUseContext.abortController.signal.aborted
            ) {
              for (const result of streamingToolExecutor.getCompletedResults()) {
                if (result.message) {
                  yield result.message
                  toolResults.push(
                    ...normalizeMessagesForAPI(
                      [result.message],
                      toolUseContext.options.tools,
                    ).filter(_ => _.type === 'user'),
                  )
                }
              }
            }
          }
          queryCheckpoint('query_api_streaming_end')

          // 延后 yield 的 microcompact boundary message 会使用 API 实际上报的
          // token 删除数，而不是客户端侧估算值。整个代码块都受 feature() 门控，
          // 确保相关排除字符串会从外部构建中被消除。
          if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
            const lastAssistant = assistantMessages.at(-1)
            // 这个 API 字段在跨请求时是累积且粘滞的，因此要减去本次请求前捕获的 baseline 才能得到增量。
            const usage = lastAssistant?.message.usage
            const cumulativeDeleted = usage
              ? ((usage as unknown as Record<string, number>)
                  .cache_deleted_input_tokens ?? 0)
              : 0
            const deletedTokens = Math.max(
              0,
              cumulativeDeleted - pendingCacheEdits.baselineCacheDeletedTokens,
            )
            if (deletedTokens > 0) {
              yield createMicrocompactBoundaryMessage(
                pendingCacheEdits.trigger,
                0,
                deletedTokens,
                pendingCacheEdits.deletedToolIds,
                [],
              )
            }
          }
        } catch (innerError) {
          if (innerError instanceof FallbackTriggeredError && fallbackModel) {
            // 触发了 fallback：切换模型并重试
            currentModel = fallbackModel
            attemptWithFallback = true

            // 由于要重试整个请求，先清空 assistant 消息
            yield* yieldMissingToolResultBlocks(
              assistantMessages,
              'Model fallback triggered',
            )
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            // 丢弃失败尝试里未完成的结果，并创建一个新的 executor。
            // 这样可避免携带旧 tool_use_id 的孤儿 tool_result 泄漏到重试流程中。
            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            // 用新模型更新 tool use context
            toolUseContext.options.mainLoopModel = fallbackModel

            // Thinking 签名与模型绑定：把受保护的 thinking block
            //（例如 capybara）重放给一个不受保护的 fallback 模型（例如 opus）会触发 400。
            // 因此在重试前先剥离，让 fallback 模型拿到干净的历史。
            if (process.env.USER_TYPE === 'ant') {
              messagesForQuery = stripSignatureBlocks(messagesForQuery)
            }

            // 记录 fallback 事件
            logEvent('tengu_model_fallback_triggered', {
              original_model:
                innerError.originalModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              entrypoint:
                'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              queryChainId: queryChainIdForAnalytics,
              queryDepth: queryTracking.depth,
            })

            // Yield 一条关于 fallback 的 system message——使用 'warning' 级别，
            // 这样用户无需开启 verbose mode 也能看到通知
            yield createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            )

            continue
          }
          throw innerError
        }
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logEvent('tengu_query_error', {
        assistantMessages: assistantMessages.length,
        toolUses: assistantMessages.flatMap(_ =>
          _.message.content.filter(content => content.type === 'tool_use'),
        ).length,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // 使用更友好的消息来处理图片尺寸/缩放错误
      if (
        error instanceof ImageSizeError ||
        error instanceof ImageResizeError
      ) {
        yield createAssistantAPIErrorMessage({
          content: error.message,
        })
        return { reason: 'image_error' }
      }

      // 一般来说 queryModelWithStreaming 不应直接 throw 错误，而应将其作为
      // synthetic assistant message yield 出去。但如果因为 bug 真的抛错，
      // 我们可能会进入一种状态：tool_use block 已经发出了，但在发出 tool_result 前就停止了。
      yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

      // 直接暴露真实错误，而不是误导性的 "[Request interrupted
      // by user]"——这条路径代表模型/运行时失败，而不是用户动作。
      // SDK 消费方此前会在例如 Node 18 缺失 Array.prototype.with() 时看到幽灵中断，
      // 从而掩盖真实原因。
      yield createAssistantAPIErrorMessage({
        content: errorMessage,
      })

      // 为了帮助排查 bug，对 ants 进行更显眼的日志记录
      logAntError('Query error', error)
      return { reason: 'model_error', error }
    }

    // 在模型响应完成后执行 post-sampling hooks
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    // 发生流式中断时，必须先处理它，再做其他事。
    // 当使用 streamingToolExecutor 时，我们必须消费 getRemainingResults()，
    // 这样 executor 才能为排队中/执行中的工具生成 synthetic tool_result block。
    // 否则，tool_use block 就会缺少与之对应的 tool_result block。
    if (toolUseContext.abortController.signal.aborted) {
      if (streamingToolExecutor) {
        // 消费剩余结果——executor 会在 executeTool() 中检查 abort signal，
        // 从而为已中断的工具生成 synthetic tool_result
        for await (const update of streamingToolExecutor.getRemainingResults()) {
          if (update.message) {
            yield update.message
          }
        }
      } else {
        yield* yieldMissingToolResultBlocks(
          assistantMessages,
          'Interrupted by user',
        )
      }
      // chicago MCP：中断时自动取消隐藏并释放锁。清理逻辑与 stopHooks.ts 中
      // 自然回合结束路径一致。仅主线程执行——关于 subagent 释放 main 锁的原因，
      // 见 stopHooks.ts。
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // 失败时静默处理——这是 dogfooding 清理逻辑，不属于关键路径
        }
      }

      // 对 submit-interrupt 不发送中断消息——后续排队的 user 消息已经提供了足够上下文。
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: false,
        })
      }
      return { reason: 'aborted_streaming' }
    }

    // yield 上一个 turn 的 tool use summary——haiku（约 1s）会在模型流式阶段（5-30s）内解析完成
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield summary
      }
    }

    if (!needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      // Prompt-too-long 恢复：streaming loop 已经把该错误暂时隐藏了
      //（见上方 withheldByCollapse / withheldByReactive）。先尝试 collapse drain
      //（成本低，还能保留细粒度上下文），再尝试 reactive compact（完整 summary）。
      // 每一步只尝试一次——若重试后仍是 413，则交由下一阶段处理，或直接把错误暴露出来。
      const isWithheld413 =
        lastMessage?.type === 'assistant' &&
        lastMessage.isApiErrorMessage &&
        isPromptTooLongMessage(lastMessage)
      // media 大小拒绝（image/PDF/多图）可通过 reactive compact 的 strip-retry 恢复。
      // 与 PTL 不同，media 错误不会走 collapse drain——因为 collapse 不会剥离图片。
      // mediaRecoveryEnabled 是在进入 stream loop 前就提升出来的 gate
      //（值必须与 withholding 检查保持一致——否则一条被隐藏的消息就会丢失）。
      // 如果超大的 media 落在 preserved tail 中，那么压缩后的下一轮仍会再次触发 media 错误；
      // hasAttemptedReactiveCompact 则用于防止进入螺旋重试，并让错误最终浮出水面。
      const isWithheldMedia =
        mediaRecoveryEnabled &&
        reactiveCompact?.isWithheldMediaSizeError(lastMessage)
      if (isWithheld413) {
        // 第一步：先排空所有 staged context collapse。它依赖“前一个 transition
        // 不是 collapse_drain_retry”这一门控——如果已经 drain 过，且重试仍然 413，
        // 就继续落到 reactive compact。
        if (
          feature('CONTEXT_COLLAPSE') &&
          contextCollapse &&
          state.transition?.reason !== 'collapse_drain_retry'
        ) {
          const drained = contextCollapse.recoverFromOverflow(
            messagesForQuery,
            querySource,
          )
          if (drained.committed > 0) {
            const next: State = {
              messages: drained.messages,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              maxOutputTokensOverride: undefined,
              pendingToolUseSummary: undefined,
              stopHookActive: undefined,
              turnCount,
              transition: {
                reason: 'collapse_drain_retry',
                committed: drained.committed,
              },
            }
            state = next
            continue
          }
        }
      }
      if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
        const compacted = await reactiveCompact.tryReactiveCompact({
          hasAttempted: hasAttemptedReactiveCompact,
          querySource,
          aborted: toolUseContext.abortController.signal.aborted,
          messages: messagesForQuery,
          cacheSafeParams: {
            systemPrompt,
            userContext,
            systemContext,
            toolUseContext,
            forkContextMessages: messagesForQuery,
          },
        })

        if (compacted) {
          // task_budget：与上方 proactive 路径使用相同的 carryover 逻辑。
          // 此时 messagesForQuery 仍然持有压缩前的数组（也就是那次 413 失败尝试的输入）。
          if (params.taskBudget) {
            const preCompactContext =
              finalContextTokensFromLastResponse(messagesForQuery)
            taskBudgetRemaining = Math.max(
              0,
              (taskBudgetRemaining ?? params.taskBudget.total) -
                preCompactContext,
            )
          }

          const postCompactMessages = buildPostCompactMessages(compacted)
          for (const msg of postCompactMessages) {
            yield msg
          }
          const next: State = {
            messages: postCompactMessages,
            toolUseContext,
            autoCompactTracking: undefined,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact: true,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'reactive_compact_retry' },
          }
          state = next
          continue
        }

        // 无法恢复——将之前 withheld 的错误直接暴露并退出。不要继续落到 stop hooks：
        // 模型从未产出过有效响应，hooks 没有任何有意义的内容可评估。
        // 在 prompt-too-long 上继续跑 stop hooks 会形成死亡螺旋：
        // error -> hook blocking -> retry -> error -> …（因为 hook 每轮都会再注入更多 token）。
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
      } else if (feature('CONTEXT_COLLAPSE') && isWithheld413) {
        // reactiveCompact 被编译裁掉了，但 contextCollapse 做了 withhold，
        // 且又无法恢复（staged 队列为空或已失效）。直接暴露。依然采用同样的
        // 提前返回逻辑——不要继续进入 stop hooks。
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'prompt_too_long' }
      }

      // 检查 max_output_tokens，并注入恢复消息。该错误此前已在上方 stream 中被暂时隐藏；
      // 只有在恢复手段耗尽时，才真正把它暴露出来。
      if (isWithheldMaxOutputTokens(lastMessage)) {
        // 升级式重试：如果当前使用的是受限的 8k 默认值且撞上了上限，
        // 就用 64k 对同一个请求直接重试——不插入 meta message，也不走多轮恢复流程。
        // 这在每个 turn 中最多只触发一次（由 override 检查守护），如果 64k 也撞上上限，
        // 才继续落到多轮恢复。
        // 3P 默认值为 false（尚未在 Bedrock/Vertex 上验证）
        const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_otk_slot_v1',
          false,
        )
        if (
          capEnabled &&
          maxOutputTokensOverride === undefined &&
          !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
        ) {
          logEvent('tengu_max_tokens_escalate', {
            escalatedTo: ESCALATED_MAX_TOKENS,
          })
          const next: State = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          state = next
          continue
        }

        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          const recoveryMessage = createUserMessage({
            content:
              `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
              `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
            isMeta: true,
          })

          const next: State = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              recoveryMessage,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: maxOutputTokensRecoveryCount + 1,
            },
          }
          state = next
          continue
        }

        // 恢复手段耗尽——此时再把之前隐藏的错误真正暴露出来。
        yield lastMessage
      }

      // 当最后一条消息是 API 错误（限流、prompt-too-long、鉴权失败等）时，
      // 跳过 stop hooks。模型根本没有产出真正响应——继续用 hooks 去评估它
      // 会制造死亡螺旋：error -> hook blocking -> retry -> error -> …
      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'completed' }
      }

      const stopHookResult = yield* handleStopHooks(
        messagesForQuery,
        assistantMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        stopHookActive,
      )

      if (stopHookResult.preventContinuation) {
        return { reason: 'stop_hook_prevented' }
      }

      if (stopHookResult.blockingErrors.length > 0) {
        const next: State = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          // 保留 reactive compact guard——如果 compact 已经运行过，且仍然无法从
          // prompt-too-long 中恢复，那么在 stop-hook blocking error 之后再重试，
          // 只会得到相同结果。这里若重置为 false，就会触发无限循环：
          // compact -> 仍然过长 -> error -> stop hook blocking -> compact -> …，
          // 最终烧掉成千上万次 API 调用。
          hasAttemptedReactiveCompact,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          transition: { reason: 'stop_hook_blocking' },
        }
        state = next
        continue
      }

      if (feature('TOKEN_BUDGET')) {
        const decision = checkTokenBudget(
          budgetTracker!,
          toolUseContext.agentId,
          getCurrentTurnTokenBudget(),
          getTurnOutputTokens(),
        )

        if (decision.action === 'continue') {
          incrementBudgetContinuationCount()
          logForDebugging(
            `Token budget continuation #${decision.continuationCount}: ${decision.pct}% (${decision.turnTokens.toLocaleString()} / ${decision.budget.toLocaleString()})`,
          )
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              createUserMessage({
                content: decision.nudgeMessage,
                isMeta: true,
              }),
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'token_budget_continuation' },
          }
          continue
        }

        if (decision.completionEvent) {
          if (decision.completionEvent.diminishingReturns) {
            logForDebugging(
              `Token budget early stop: diminishing returns at ${decision.completionEvent.pct}%`,
            )
          }
          logEvent('tengu_token_budget_completed', {
            ...decision.completionEvent,
            queryChainId: queryChainIdForAnalytics,
            queryDepth: queryTracking.depth,
          })
        }
      }

      return { reason: 'completed' }
    }

    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    queryCheckpoint('query_tool_execution_start')


    if (streamingToolExecutor) {
      logEvent('tengu_streaming_tool_execution_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    } else {
      logEvent('tengu_streaming_tool_execution_not_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message

        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }
    queryCheckpoint('query_tool_execution_end')

    // 在一批工具执行完成后生成 tool use summary——传递给下一次递归调用
    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId // subagent 不会出现在 mobile UI 中——跳过 Haiku 调用
    ) {
      // 提取最后一个 assistant 文本块，作为上下文
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        const textBlocks = lastAssistantMessage.message.content.filter(
          block => block.type === 'text',
        )
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      // 收集用于生成 summary 的工具信息
      const toolUseIds = toolUseBlocks.map(block => block.id)
      const toolInfoForSummary = toolUseBlocks.map(block => {
        // 找到对应的 tool result
        const toolResult = toolResults.find(
          result =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              content =>
                content.type === 'tool_result' &&
                content.tool_use_id === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' &&
          Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (c): c is ToolResultBlockParam =>
                  c.type === 'tool_result' && c.tool_use_id === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output:
            resultContent && 'content' in resultContent
              ? resultContent.content
              : null,
        }
      })

      // 异步发起 summary 生成，不阻塞下一次 API 调用
      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
        .catch(() => null)
    }

    // 在 tool 调用过程中被中止了
    if (toolUseContext.abortController.signal.aborted) {
      // chicago MCP: auto-unhide + lock release when aborted mid-tool-call.
      // This is the most likely Ctrl+C path for CU (e.g. slow screenshot).
      // Main thread only — see stopHooks.ts for the subagent rationale.
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // 失败时静默处理——这是 dogfooding 清理逻辑，不属于关键路径
        }
      }
      // 对 submit-interrupt 跳过中断消息——后续排队的 user 消息已提供足够上下文。
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: true,
        })
      }
      // 中止返回前先检查 maxTurns
      const nextTurnCountOnAbort = turnCount + 1
      if (maxTurns && nextTurnCountOnAbort > maxTurns) {
        yield createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCountOnAbort,
        })
      }
      return { reason: 'aborted_tools' }
    }

    // 如果某个 hook 指示要阻止继续，就在这里停止
    if (shouldPreventContinuation) {
      return { reason: 'hook_stopped' }
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
      logEvent('tengu_post_autocompact_turn', {
        turnId:
          tracking.turnId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        turnCounter: tracking.turnCounter,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // 这一步必须放在 tool 调用之后做，因为如果把 tool_result 消息与普通 user 消息交错发送，API 会报错。

    // 埋点：在 attachment 注入前记录消息数量
    logEvent('tengu_query_before_attachments', {
      messagesForQueryCount: messagesForQuery.length,
      assistantMessagesCount: assistantMessages.length,
      toolResultsCount: toolResults.length,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 在处理 attachment 前先获取排队命令的快照。
    // 它们会作为 attachment 发给 Claude，让 Claude 能在当前 turn 中直接回应。
    //
    // 排空待处理通知。LocalShellTask 完成事件属于 'next'
    //（当 MONITOR_TOOL 开启时），无需 Sleep 即可被排空。其他任务类型
    //（agent/workflow/framework）仍默认走 'later'——由 Sleep flush 覆盖。
    // 如果未来所有任务类型都改为 'next'，这一分支就可以删除。
    //
    // Slash command 不参与 mid-turn drain——它们必须在回合结束后通过
    // processSlashCommand（借助 useQueueProcessor）处理，而不是作为文本发送给模型。
    // Bash 模式命令已在 getQueuedCommandAttachments 中通过 INLINE_NOTIFICATION_MODES 被排除。
    //
    // Agent 作用域：队列是一个进程级全局单例，由 coordinator 与所有进程内 subagent 共享。
    // 每个 loop 只排空发给自己的项目——主线程处理 agentId===undefined，subagent 只处理自己的 agentId。
    // 用户 prompt（mode:'prompt'）仍只会发往主线程；subagent 永远不会看到 prompt 流。
    // eslint-disable-next-line custom-rules/require-tool-match-name -- ToolUseBlock.name has no aliases
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const isMainThread =
      querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
    const queuedCommandsSnapshot = getCommandsByMaxPriority(
      sleepRan ? 'later' : 'next',
    ).filter(cmd => {
      if (isSlashCommand(cmd)) return false
      if (isMainThread) return cmd.agentId === undefined
      // Subagent 只排空发给自己的 task-notification——绝不会消费用户 prompt，
      // 即使有人给 prompt 强行打上了 agentId 也不行。
      return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
    })

    for await (const attachment of getAttachmentMessages(
      null,
      updatedToolUseContext,
      null,
      queuedCommandsSnapshot,
      [...messagesForQuery, ...assistantMessages, ...toolResults],
      querySource,
    )) {
      yield attachment
      toolResults.push(attachment)
    }

    // Memory prefetch 的 consume：仅在它已 settle 且此前未被消费过时进行。
    // 若尚未 settle，则直接跳过（零等待），下次迭代再试——在当前 turn 结束前，
    // 它会随着 loop 迭代次数获得同样多的机会。readFileState（会跨迭代累计）
    // 会过滤掉那些模型已经 Read/Wrote/Edited 过的 memory——包括更早迭代中的，
    // 这是单次迭代的 toolUseBlocks 数组捕捉不到的。
    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield msg
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
    }

    // 注入预取好的 skill discovery。collectSkillDiscoveryPrefetch 会产出
    // hidden_by_main_turn——当预取在此之前已经完成时，该值为 true
    //（在 AKI@250ms / Haiku@573ms 相对 2-30s 的 turn 时长下，命中率应 >98%）。
    if (skillPrefetch && pendingSkillPrefetch) {
      const skillAttachments =
        await skillPrefetch.collectSkillDiscoveryPrefetch(pendingSkillPrefetch)
      for (const att of skillAttachments) {
        const msg = createAttachmentMessage(att)
        yield msg
        toolResults.push(msg)
      }
    }

    // 只移除那些真正被作为 attachment 消费掉的命令。
    // Prompt 与 task-notification 命令已在上方被转换为 attachment。
    const consumedCommands = queuedCommandsSnapshot.filter(
      cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
    )
    if (consumedCommands.length > 0) {
      for (const cmd of consumedCommands) {
        if (cmd.uuid) {
          consumedCommandUuids.push(cmd.uuid)
          notifyCommandLifecycle(cmd.uuid, 'started')
        }
      }
      removeFromQueue(consumedCommands)
    }

    // 埋点：在 file change attachment 注入后进行记录
    const fileChangeAttachmentCount = count(
      toolResults,
      tr =>
        tr.type === 'attachment' && tr.attachment.type === 'edited_text_file',
    )

    logEvent('tengu_query_after_attachments', {
      totalToolResultsCount: toolResults.length,
      fileChangeAttachmentCount,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 在 turn 之间刷新 tools，让新连接上的 MCP server 能立刻可用
    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    // 每当我们拿到 tool result 且即将递归时，就意味着进入下一个 turn
    const nextTurnCount = turnCount + 1

    // 为 `claude ps` 定期生成 task summary——它会在 turn 中途触发，
    // 这样长时间运行的 agent 也能持续刷新“自己正在做什么”。
    // 唯一门控是 !agentId，因此所有顶层对话（REPL、SDK、HFI、remote）
    // 都会生成 summary；subagent/fork 则不会。
    if (feature('BG_SESSIONS')) {
      if (
        !toolUseContext.agentId &&
        taskSummaryModule!.shouldGenerateTaskSummary()
      ) {
        taskSummaryModule!.maybeGenerateTaskSummary({
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
          forkContextMessages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...toolResults,
          ],
        })
      }
    }

    // 检查是否达到 max turns 上限
    if (maxTurns && nextTurnCount > maxTurns) {
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns,
        turnCount: nextTurnCount,
      })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    queryCheckpoint('query_recursive_call')
    const next: State = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
    }
    state = next
  } // while (true)
}
