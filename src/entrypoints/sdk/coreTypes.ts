// SDK Core Types：供 SDK consumers 和 SDK builders 共同使用的通用可序列化类型。
//
// 类型由 coreSchemas.ts 中的 Zod schemas 生成。
// 如需修改类型：
// 1. 编辑 coreSchemas.ts 中的 Zod schemas
// 2. 运行：bun scripts/generate-sdk-types.ts
//
// runtime 校验可使用 coreSchemas.ts 中的 schemas，但它们不是
// public API 的一部分。

// 为 SDK consumers re-export sandbox types
export type {
  SandboxFilesystemConfig,
  SandboxIgnoreViolations,
  SandboxNetworkConfig,
  SandboxSettings,
} from '../sandboxTypes.js'
// Re-export 所有生成的 types
export * from './coreTypes.generated.js'

// Re-export 无法用 Zod schemas 表达的 utility types
export type { NonNullableUsage } from './sdkUtilityTypes.js'

// 供 runtime 使用的 const 数组
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const

export const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const
