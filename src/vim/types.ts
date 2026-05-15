/**
 * Vim 模式状态机的类型定义。
 *
 * 这个文件描述了 vim 输入处理的完整状态机；这些类型本身就是文档，
 * 读懂它们就能理解系统如何在 INSERT/NORMAL 模式之间切换，
 * 以及命令解析过程中会进入哪些中间状态。
 */

// ============================================================================
// 核心类型
// ============================================================================

export type Operator = 'delete' | 'change' | 'yank'

export type FindType = 'f' | 'F' | 't' | 'T'

export type TextObjScope = 'inner' | 'around'

// ============================================================================
// 状态机类型
// ============================================================================

/**
 * 完整的 vim 状态。mode 决定当前要跟踪哪些数据。
 *
 * INSERT 模式：跟踪正在输入的文本（供 dot-repeat 使用）
 * NORMAL 模式：跟踪当前正在解析的命令（状态机）
 */
export type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; command: CommandState }

/**
 * NORMAL 模式下的命令状态机。
 *
 * 每个状态都精确描述自己当前在等待什么输入。
 * TypeScript 会保证 switch 分支处理是穷尽的。
 */
export type CommandState =
  | { type: 'idle' }
  | { type: 'count'; digits: string }
  | { type: 'operator'; op: Operator; count: number }
  | { type: 'operatorCount'; op: Operator; count: number; digits: string }
  | { type: 'operatorFind'; op: Operator; count: number; find: FindType }
  | {
      type: 'operatorTextObj'
      op: Operator
      count: number
      scope: TextObjScope
    }
  | { type: 'find'; find: FindType; count: number }
  | { type: 'g'; count: number }
  | { type: 'operatorG'; op: Operator; count: number }
  | { type: 'replace'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }

/**
 * 可跨命令保留的持久状态。
 * 这就是 vim 的“记忆”，用于重复命令和粘贴等行为。
 */
export type PersistentState = {
  lastChange: RecordedChange | null
  lastFind: { type: FindType; char: string } | null
  register: string
  registerIsLinewise: boolean
}

/**
 * 为 dot-repeat 记录的变更。
 * 它保存了重放某条命令所需的全部信息。
 */
export type RecordedChange =
  | { type: 'insert'; text: string }
  | {
      type: 'operator'
      op: Operator
      motion: string
      count: number
    }
  | {
      type: 'operatorTextObj'
      op: Operator
      objType: string
      scope: TextObjScope
      count: number
    }
  | {
      type: 'operatorFind'
      op: Operator
      find: FindType
      char: string
      count: number
    }
  | { type: 'replace'; char: string; count: number }
  | { type: 'x'; count: number }
  | { type: 'toggleCase'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }
  | { type: 'openLine'; direction: 'above' | 'below' }
  | { type: 'join'; count: number }

// ============================================================================
// 按键分组：使用具名常量，避免魔法字符串
// ============================================================================

export const OPERATORS = {
  d: 'delete',
  c: 'change',
  y: 'yank',
} as const satisfies Record<string, Operator>

export function isOperatorKey(key: string): key is keyof typeof OPERATORS {
  return key in OPERATORS
}

export const SIMPLE_MOTIONS = new Set([
  'h',
  'l',
  'j',
  'k', // Basic movement
  'w',
  'b',
  'e',
  'W',
  'B',
  'E', // Word motions
  '0',
  '^',
  '$', // Line positions
])

export const FIND_KEYS = new Set(['f', 'F', 't', 'T'])

export const TEXT_OBJ_SCOPES = {
  i: 'inner',
  a: 'around',
} as const satisfies Record<string, TextObjScope>

export function isTextObjScopeKey(
  key: string,
): key is keyof typeof TEXT_OBJ_SCOPES {
  return key in TEXT_OBJ_SCOPES
}

export const TEXT_OBJ_TYPES = new Set([
  'w',
  'W', // Word/WORD
  '"',
  "'",
  '`', // Quotes
  '(',
  ')',
  'b', // Parens
  '[',
  ']', // Brackets
  '{',
  '}',
  'B', // Braces
  '<',
  '>', // Angle brackets
])

export const MAX_VIM_COUNT = 10000

// ============================================================================
// 状态工厂函数
// ============================================================================

export function createInitialVimState(): VimState {
  return { mode: 'INSERT', insertedText: '' }
}

export function createInitialPersistentState(): PersistentState {
  return {
    lastChange: null,
    lastFind: null,
    register: '',
    registerIsLinewise: false,
  }
}
