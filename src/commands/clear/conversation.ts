/**
 * Conversation clearing utility.
 * This module has heavier dependencies and should be lazy-loaded when possible.
 */
import { feature } from 'bun:bundle'
import { randomUUID, type UUID } from 'crypto'
import {
  getLastMainRequestId,
  getOriginalCwd,
  getSessionId,
  regenerateSessionId,
} from '../../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { AppState } from '../../state/AppState.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import {
  isLocalAgentTask,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { createEmptyAttributionState } from '../../utils/commitAttribution.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import {
  executeSessionEndHooks,
  getSessionEndHookTimeoutMs,
} from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import { clearAllPlanSlugs } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import {
  clearSessionMetadata,
  getAgentTranscriptPath,
  resetSessionFilePointer,
  saveWorktreeState,
} from '../../utils/sessionStorage.js'
import {
  evictTaskOutput,
  initTaskOutputAsSymlink,
} from '../../utils/task/diskOutput.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'
import { clearSessionCaches } from './caches.js'

export async function clearConversation({
  setMessages,
  readFileState,
  discoveredSkillNames,
  loadedNestedMemoryPaths,
  getAppState,
  setAppState,
  setConversationId,
}: {
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  readFileState: FileStateCache
  discoveredSkillNames?: Set<string>
  loadedNestedMemoryPaths?: Set<string>
  getAppState?: () => AppState
  setAppState?: (f: (prev: AppState) => AppState) => void
  setConversationId?: (id: UUID) => void
}): Promise<void> {
  // 在清理前执行 SessionEnd hooks（受
  // CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS 限制，默认 1.5s）
  const sessionEndTimeoutMs = getSessionEndHookTimeoutMs()
  await executeSessionEndHooks('clear', {
    getAppState,
    setAppState,
    signal: AbortSignal.timeout(sessionEndTimeoutMs),
    timeoutMs: sessionEndTimeoutMs,
  })

  // 告知 inference，这个会话的 cache 可以被驱逐。
  const lastRequestId = getLastMainRequestId()
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope:
        'conversation_clear' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 预先计算需要保留的 tasks，使它们的按 agent 划分的状态能在
  // 下方清理 cache 后继续保留。除非 task 明确设置
  // isBackgrounded === false，否则都会被保留。主会话任务（Ctrl+B）也会保留，
  // 因为它们写入隔离的按任务 transcript，并在 agent
  // context 下运行，因此跨 session ID 重建也是安全的。参见
  // LocalMainSessionTask.ts 的 startBackgroundSession。
  const preservedAgentIds = new Set<string>()
  const preservedLocalAgents: LocalAgentTaskState[] = []
  const shouldKillTask = (task: AppState['tasks'][string]): boolean =>
    'isBackgrounded' in task && task.isBackgrounded === false
  if (getAppState) {
    for (const task of Object.values(getAppState().tasks)) {
      if (shouldKillTask(task)) continue
      if (isLocalAgentTask(task)) {
        preservedAgentIds.add(task.agentId)
        preservedLocalAgents.push(task)
      } else if (isInProcessTeammateTask(task)) {
        preservedAgentIds.add(task.identity.agentId)
      }
    }
  }

  setMessages(() => [])

  // 清除 context-blocked 标记，使 proactive ticks 在 /clear 后恢复
  if (feature('PROACTIVE') || feature('KAIROS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { setContextBlocked } = require('../../proactive/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    setContextBlocked(false)
  }

  // 通过更新 conversationId 强制 logo 重新渲染
  if (setConversationId) {
    setConversationId(randomUUID())
  }

  // 清理所有与 session 相关的缓存。对于被保留的后台
  // tasks，其按 agent 划分的状态（invoked skills、待处理权限回调、dump 状态、cache-break
  // 跟踪）会被保留，以便这些 agents 继续工作。
  clearSessionCaches(preservedAgentIds)

  setCwd(getOriginalCwd())
  readFileState.clear()
  discoveredSkillNames?.clear()
  loadedNestedMemoryPaths?.clear()

  // 清理 App State 中需要清空的项
  if (setAppState) {
    setAppState(prev => {
      // 使用上面同样的谓词拆分 tasks：
      // 杀掉并移除前台 tasks，保留其他所有。
      const nextTasks: AppState['tasks'] = {}
      for (const [taskId, task] of Object.entries(prev.tasks)) {
        if (!shouldKillTask(task)) {
          nextTasks[taskId] = task
          continue
        }
        // 前台 task：终止并从 state 中移除
        try {
          if (task.status === 'running') {
            if (isLocalShellTask(task)) {
              task.shellCommand?.kill()
              task.shellCommand?.cleanup()
              if (task.cleanupTimeoutId) {
                clearTimeout(task.cleanupTimeoutId)
              }
            }
            if ('abortController' in task) {
              task.abortController?.abort()
            }
            if ('unregisterCleanup' in task) {
              task.unregisterCleanup?.()
            }
          }
        } catch (error) {
          logError(error)
        }
        void evictTaskOutput(taskId)
      }

      return {
        ...prev,
        tasks: nextTasks,
        attribution: createEmptyAttributionState(),
        // 清理 standalone agent context（名称/颜色由 /rename、/color 设置）
        // 以免新 session 显示旧 session 的身份标识
        standaloneAgentContext: undefined,
        fileHistory: {
          snapshots: [],
          trackedFiles: new Set(),
          snapshotSequence: 0,
        },
        // 将 MCP state 重置为默认值，以触发重新初始化。
        // 保留 pluginReconnectKey，避免 /clear 变成无操作
        // （它只会被 /reload-plugins 增加）。
        mcp: {
          clients: [],
          tools: [],
          commands: [],
          resources: {},
          pluginReconnectKey: prev.mcp.pluginReconnectKey,
        },
      }
    })
  }

  // 清理 plan slug 缓存，使 /clear 后使用新的 plan 文件
  clearAllPlanSlugs()

  // 清理缓存的 session 元数据（title、tag、agent 名称/颜色）
  // 以免新 session 继承上一个 session 的身份信息
  clearSessionMetadata()

  // 生成新的 session ID 以提供全新状态
  // 将旧 session 设为 parent，用于 analytics lineage 跟踪
  regenerateSessionId({ setCurrentAsParent: true })
  // 更新环境变量，使 subprocess 使用新的 session ID
  if (process.env.USER_TYPE === 'ant' && process.env.CLAUDE_CODE_SESSION_ID) {
    process.env.CLAUDE_CODE_SESSION_ID = getSessionId()
  }
  await resetSessionFilePointer()

  // 被保留的 local_agent tasks 在启动时，其 TaskOutput symlink 就绑定到了
  // 旧 session ID，但 /clear 之后的 transcript 写入会落到
  // 新的 session 目录（appendEntry 会重新读取 getSessionId()）。需要重新指向
  // 这些 symlinks，让 TaskOutput 读取实时文件，而不是清理前冻结的
  // 快照。只重新指向仍在运行的 tasks，已结束的 tasks 不会再写入，
  // 否则重指向会把原本有效的 symlink 替换成悬空链接。
  // 主会话 tasks 使用相同的按 agent 路径（它们通过
  // recordSidechainTranscript 写到 getAgentTranscriptPath），因此无需特殊处理。
  for (const task of preservedLocalAgents) {
    if (task.status !== 'running') continue
    void initTaskOutputAsSymlink(
      task.id,
      getAgentTranscriptPath(asAgentId(task.agentId)),
    )
  }

  // 在 clear 之后重新持久化 mode 和 worktree 状态，这样后续 --resume
  // 才知道新的清理后 session 处于什么状态。clearSessionMetadata
  // 已把这两者从缓存中擦掉，但进程仍然运行在相同的 mode
  // 以及（如果适用）相同的 worktree 目录中。
  if (feature('COORDINATOR_MODE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { saveMode } = require('../../utils/sessionStorage.js')
    const {
      isCoordinatorMode,
    } = require('../../coordinator/coordinatorMode.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    saveMode(isCoordinatorMode() ? 'coordinator' : 'normal')
  }
  const worktreeSession = getCurrentWorktreeSession()
  if (worktreeSession) {
    saveWorktreeState(worktreeSession)
  }

  // 清理后执行 SessionStart hooks
  const hookMessages = await processSessionStartHooks('clear')

  // 用 hook 结果更新 messages
  if (hookMessages.length > 0) {
    setMessages(() => hookMessages)
  }
}
