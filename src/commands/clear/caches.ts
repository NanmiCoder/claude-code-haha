/**
 * Session cache clearing utilities.
 * This module is imported at startup by main.tsx, so keep imports minimal.
 */
import { feature } from 'bun:bundle'
import {
  clearInvokedSkills,
  setLastEmittedDate,
} from '../../bootstrap/state.js'
import { clearCommandsCache } from '../../commands.js'
import { getSessionStartDate } from '../../constants/common.js'
import {
  getGitStatus,
  getSystemContext,
  getUserContext,
  setSystemPromptInjection,
} from '../../context.js'
import { clearFileSuggestionCaches } from '../../hooks/fileSuggestions.js'
import { clearAllPendingCallbacks } from '../../hooks/useSwarmPermissionPoller.js'
import { clearAllDumpState } from '../../services/api/dumpPrompts.js'
import { resetPromptCacheBreakDetection } from '../../services/api/promptCacheBreakDetection.js'
import { clearAllSessions } from '../../services/api/sessionIngress.js'
import { runPostCompactCleanup } from '../../services/compact/postCompactCleanup.js'
import { resetAllLSPDiagnosticState } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { clearTrackedMagicDocs } from '../../services/MagicDocs/magicDocs.js'
import { clearDynamicSkills } from '../../skills/loadSkillsDir.js'
import { resetSentSkillNames } from '../../utils/attachments.js'
import { clearCommandPrefixCaches } from '../../utils/bash/commands.js'
import { resetGetMemoryFilesCache } from '../../utils/claudemd.js'
import { clearRepositoryCaches } from '../../utils/detectRepository.js'
import { clearResolveGitDirCache } from '../../utils/git/gitFilesystem.js'
import { clearStoredImagePaths } from '../../utils/imageStore.js'
import { clearSessionEnvVars } from '../../utils/sessionEnvVars.js'

/**
 * Clear all session-related caches.
 * Call this when resuming a session to ensure fresh file/skill discovery.
 * This is a subset of what clearConversation does - it only clears caches
 * without affecting messages, session ID, or triggering hooks.
 *
 * @param preservedAgentIds - Agent IDs whose per-agent state should survive
 *   the clear (e.g., background tasks preserved across /clear). When non-empty,
 *   agentId-keyed state (invoked skills) is selectively cleared and requestId-keyed
 *   state (pending permission callbacks, dump state, cache-break tracking) is left
 *   intact since it cannot be safely scoped to the main session.
 */
export function clearSessionCaches(
  preservedAgentIds: ReadonlySet<string> = new Set(),
): void {
  const hasPreserved = preservedAgentIds.size > 0
  // 清理上下文缓存
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
  getGitStatus.cache.clear?.()
  getSessionStartDate.cache.clear?.()
  // 清理文件建议缓存（用于 @ 提及）
  clearFileSuggestionCaches()

  // 清理 commands/skills 缓存
  clearCommandsCache()

  // 清理 prompt cache break 检测状态
  if (!hasPreserved) resetPromptCacheBreakDetection()

  // 清理 system prompt 注入（cache breaker）
  setSystemPromptInjection(null)

  // 清理上次发出的日期，让下一轮重新检测
  setLastEmittedDate(null)

  // 运行压缩后的清理逻辑（清理 system prompt 区段、microcompact 跟踪、
  // classifier approvals、speculative checks，以及对主线程 compact 来说，
  // load_reason 为 'compact' 的 memory files 缓存）。
  runPostCompactCleanup()
  // 重置已发送的 skill 名称，使 /clear 后重新发送 skill 列表。
  // runPostCompactCleanup 有意不重置这里（compact 后重新注入约耗费
  // 4K tokens），但 /clear 会完全清空消息，因此 model 需要再次看到完整列表。
  resetSentSkillNames()
  // 用 'session_start' 覆盖 memory cache 重置原因：clearSessionCaches 会从
  // /clear 和 --resume/--continue 调用，而这些都不是 compaction 事件。否则，
  // 下一次 getMemoryFiles() 调用时，InstructionsLoaded hook 会以
  // load_reason 'compact' 而不是 'session_start' 触发。
  resetGetMemoryFilesCache('session_start')

  // 清理已存储图片路径缓存
  clearStoredImagePaths()

  // 清理所有 session ingress 缓存（lastUuidMap、sequentialAppendBySession）
  clearAllSessions()
  // 清理 swarm 权限待处理回调
  if (!hasPreserved) clearAllPendingCallbacks()

  // 清理 tungsten 会话使用跟踪
  if (process.env.USER_TYPE === 'ant') {
    void import('../../tools/TungstenTool/TungstenTool.js').then(
      ({ clearSessionsWithTungstenUsage, resetInitializationState }) => {
        clearSessionsWithTungstenUsage()
        resetInitializationState()
      },
    )
  }
  // 清理 attribution 缓存（文件内容缓存、待处理 bash 状态）
  // 使用动态导入，以保留 COMMIT_ATTRIBUTION feature flag 的 dead code elimination 效果
  if (feature('COMMIT_ATTRIBUTION')) {
    void import('../../utils/attributionHooks.js').then(
      ({ clearAttributionCaches }) => clearAttributionCaches(),
    )
  }
  // 清理仓库检测缓存
  clearRepositoryCaches()
  // 清理 bash 命令前缀缓存（Haiku 提取的前缀）
  clearCommandPrefixCaches()
  // 清理 dump prompts 状态
  if (!hasPreserved) clearAllDumpState()
  // 清理已调用 skills 缓存（每项都持有完整 skill 文件内容）
  clearInvokedSkills(preservedAgentIds)
  // 清理 git 目录解析缓存
  clearResolveGitDirCache()
  // 清理动态 skills（从 skill 目录加载）
  clearDynamicSkills()
  // 清理 LSP 诊断跟踪状态
  resetAllLSPDiagnosticState()
  // 清理已跟踪的 magic docs
  clearTrackedMagicDocs()
  // 清理会话环境变量
  clearSessionEnvVars()
  // 清理 WebFetch URL 缓存（最多 50MB 的页面内容缓存）
  void import('../../tools/WebFetchTool/utils.js').then(
    ({ clearWebFetchCache }) => clearWebFetchCache(),
  )
  // 清理 ToolSearch 描述缓存（完整 tool prompts，50 个 MCP tools 约 500KB）
  void import('../../tools/ToolSearchTool/ToolSearchTool.js').then(
    ({ clearToolSearchDescriptionCache }) => clearToolSearchDescriptionCache(),
  )
  // 清理 agent 定义缓存（通过 EnterWorktreeTool 按 cwd 累积）
  void import('../../tools/AgentTool/loadAgentsDir.js').then(
    ({ clearAgentDefinitionsCache }) => clearAgentDefinitionsCache(),
  )
  // 清理 SkillTool prompt 缓存（按项目根目录累积）
  void import('../../tools/SkillTool/prompt.js').then(({ clearPromptCache }) =>
    clearPromptCache(),
  )
}
