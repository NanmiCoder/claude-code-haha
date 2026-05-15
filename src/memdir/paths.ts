import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { isAbsolute, join, normalize, sep } from 'path'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
} from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  getClaudeConfigHomeDir,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../utils/envUtils.js'
import { findCanonicalGitRoot } from '../utils/git.js'
import { sanitizePath } from '../utils/path.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 是否启用 auto-memory 功能（memdir、agent memory、past session search）。
 * 默认启用。优先级链如下（先定义者生效）：
 *   1. CLAUDE_CODE_DISABLE_AUTO_MEMORY 环境变量（1/true → OFF，0/false → ON）
 *   2. CLAUDE_CODE_SIMPLE (--bare) → OFF
 *   3. 无持久化存储的 CCR → OFF（没有 CLAUDE_CODE_REMOTE_MEMORY_DIR）
 *   4. settings.json 中的 autoMemoryEnabled（支持项目级 opt-out）
 *   5. 默认：enabled
 */
export function isAutoMemoryEnabled(): boolean {
  const envVal = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  if (isEnvTruthy(envVal)) {
    return false
  }
  if (isEnvDefinedFalsy(envVal)) {
    return true
  }
  // --bare / SIMPLE：prompts.ts 已通过 SIMPLE 的早返回从
  // system prompt 中移除 memory section；这个开关会挡住另一半
  //（extractMemories 的 turn-end fork、autoDream、/remember、/dream、team sync）。
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return false
  }
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    !process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  ) {
    return false
  }
  const settings = getInitialSettings()
  if (settings.autoMemoryEnabled !== undefined) {
    return settings.autoMemoryEnabled
  }
  return true
}

/**
 * 本次会话是否会运行 extract-memories 后台 agent。
 *
 * 无论这个开关如何，主 agent 的 prompt 都始终带有完整的保存说明——
 * 当主 agent 写入 memories 时，后台 agent 会跳过那段范围
 *（extractMemories.ts 中的 hasMemoryWritesSince）；而当主 agent 没写时，
 * 后台 agent 会补上遗漏的内容。
 *
 * 调用方也必须用 feature('EXTRACT_MEMORIES') 做额外 gating——这项检查不能
 * 放到这个 helper 里，因为 feature() 只有在直接用在 `if` 条件中时才会触发
 * tree-shaking。
 */
export function isExtractModeActive(): boolean {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_passport_quail', false)) {
    return false
  }
  return (
    !getIsNonInteractiveSession() ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_thimble', false)
  )
}

/**
 * 返回持久 memory 存储的基础目录。
 * 解析顺序：
 *   1. CLAUDE_CODE_REMOTE_MEMORY_DIR 环境变量（显式 override，由 CCR 设置）
 *   2. ~/.claude（默认配置目录）
 */
export function getMemoryBaseDir(): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  }
  return getClaudeConfigHomeDir()
}

const AUTO_MEM_DIRNAME = 'memory'
const AUTO_MEM_ENTRYPOINT_NAME = 'MEMORY.md'

/**
 * 规范化并校验候选的 auto-memory 目录路径。
 *
 * SECURITY：拒绝那些作为读取 allowlist 根目录会有风险，或 normalize()
 * 仍无法完全解析的路径：
 * - 相对路径（!isAbsolute）："../foo" —— 会被解释为相对当前工作目录
 * - 根/近根路径（length < 3）：strip 后 "/" → ""；"/a" 也过短
 * - Windows 盘符根目录（C: 正则）：strip 后 "C:\" → "C:"
 * - UNC 路径（\\server\share）：网络路径——信任边界不透明
 * - 空字节：经过 normalize() 仍会保留，可能在系统调用中截断路径
 *
 * 返回带且仅带一个尾部分隔符的规范化路径；
 * 如果路径未设置、为空或被拒绝，则返回 undefined。
 */
function validateMemoryPath(
  raw: string | undefined,
  expandTilde: boolean,
): string | undefined {
  if (!raw) {
    return undefined
  }
  let candidate = raw
  // settings.json 中的路径支持 ~/ 展开（更方便用户）。环境变量覆盖不支持这一点
  //（它由 Cowork/SDK 以编程方式设置，本应始终传入绝对路径）。单独的 "~"、
  // "~/"、"~/.", "~/.." 等不会展开——否则会让 isAutoMemPath() 匹配整个
  // $HOME 或其父目录（与 "/" 或 "C:\" 同类风险）。
  if (
    expandTilde &&
    (candidate.startsWith('~/') || candidate.startsWith('~\\'))
  ) {
    const rest = candidate.slice(2)
    // 拒绝会展开为 $HOME 或祖先目录的平凡剩余部分。
    // normalize('') = '.', normalize('.') = '.', normalize('foo/..') = '.',
    // normalize('..') = '..', normalize('foo/../..') = '..'
    const restNorm = normalize(rest || '.')
    if (restNorm === '.' || restNorm === '..') {
      return undefined
    }
    candidate = join(homedir(), rest)
  }
  // normalize() 可能保留尾部分隔符；先剥离再补回一个，
  // 以匹配 getAutoMemPath() 的尾部分隔符约定
  const normalized = normalize(candidate).replace(/[/\\]+$/, '')
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('//') ||
    normalized.includes('\0')
  ) {
    return undefined
  }
  return (normalized + sep).normalize('NFC')
}

/**
 * 通过环境变量对完整 auto-memory 目录路径进行直接覆盖。
 * 设置后，getAutoMemPath()/getAutoMemEntrypoint() 会直接返回此路径，
 * 而不是计算 `{base}/projects/{sanitized-cwd}/memory/`。
 *
 * Cowork 用它把 memory 重定向到一个 space-scoped 挂载点；否则每次会话的 cwd
 *（其中包含 VM 进程名）都会为每个会话生成不同的 project-key。
 */
function getAutoMemPathOverride(): string | undefined {
  return validateMemoryPath(
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE,
    false,
  )
}

/**
 * settings.json 中对完整 auto-memory 目录路径的覆盖。
 * 为了方便用户，支持 ~/ 展开。
 *
 * SECURITY：刻意排除了 projectSettings（提交到仓库中的 .claude/settings.json）——
 * 否则恶意仓库可以把 autoMemoryDirectory 设为 "~/.ssh"，并借助 filesystem.ts
 * 中的写入 carve-out 静默获得对敏感目录的写访问（在 isAutoMemPath() 命中且
 * hasAutoMemPathOverride() 为 false 时触发）。这遵循了
 * hasSkipDangerousModePermissionPrompt() 等相同模式。
 */
function getAutoMemPathSetting(): string | undefined {
  const dir =
    getSettingsForSource('policySettings')?.autoMemoryDirectory ??
    getSettingsForSource('flagSettings')?.autoMemoryDirectory ??
    getSettingsForSource('localSettings')?.autoMemoryDirectory ??
    getSettingsForSource('userSettings')?.autoMemoryDirectory
  return validateMemoryPath(dir, true)
}

/**
 * 检查 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 是否被设置为有效的 override。
 * 将此作为信号，表示 SDK 调用方已显式选择加入 auto-memory 机制——
 * 例如据此决定当自定义 system prompt 替换默认值时，是否仍注入 memory prompt。
 */
export function hasAutoMemPathOverride(): boolean {
  return getAutoMemPathOverride() !== undefined
}

/**
 * 如果能拿到 canonical git repo root 就返回它，否则回退到稳定的 project root。
 * 使用 findCanonicalGitRoot 可让同一仓库的所有 worktree 共享一个
 * auto-memory 目录（anthropics/claude-code#24382）。
 */
function getAutoMemBase(): string {
  return findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()
}

/**
 * 返回 auto-memory 目录路径。
 *
 * 解析顺序：
 *   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 环境变量（完整路径 override，由 Cowork 使用）
 *   2. settings.json 中的 autoMemoryDirectory（仅信任来源：policy/local/user）
 *   3. <memoryBase>/projects/<sanitized-git-root>/memory/
 *      其中 memoryBase 由 getMemoryBaseDir() 解析
 *
 * 已做 memoize：render-path 调用方（collapseReadSearchGroups → isAutoManagedMemoryFile）
 * 会在 Messages 每次重新渲染、每条工具使用消息上触发；每次 miss 都要付出
 * getSettingsForSource × 4 → parseSettingsFile（realpathSync + readFileSync）的代价。
 * 以 projectRoot 作为键，因此测试里如果中途修改它的 mock 会重新计算；
 * 生产环境中的 env vars / settings.json / CLAUDE_CONFIG_DIR 在会话内稳定，
 * 并由每个测试的 cache.clear 覆盖。
 */
export const getAutoMemPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
    if (override) {
      return override
    }
    const projectsDir = join(getMemoryBaseDir(), 'projects')
    return (
      join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep
    ).normalize('NFC')
  },
  () => getProjectRoot(),
)

/**
 * 返回给定日期的每日日志文件路径（默认为今天）。
 * 形态：<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md
 *
 * assistant mode（feature('KAIROS')）会使用它：agent 不再维护实时索引的
 * MEMORY.md，而是在工作过程中把内容追加到按日期命名的日志文件里。
 * 之后会有单独的夜间 /dream 技能把这些日志提炼成 topic files + MEMORY.md。
 */
export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const yyyy = date.getFullYear().toString()
  const mm = (date.getMonth() + 1).toString().padStart(2, '0')
  const dd = date.getDate().toString().padStart(2, '0')
  return join(getAutoMemPath(), 'logs', yyyy, mm, `${yyyy}-${mm}-${dd}.md`)
}

/**
 * 返回 auto-memory 入口文件（auto-memory 目录中的 MEMORY.md）。
 * 解析顺序与 getAutoMemPath() 相同。
 */
export function getAutoMemEntrypoint(): string {
  return join(getAutoMemPath(), AUTO_MEM_ENTRYPOINT_NAME)
}

/**
 * 检查一个绝对路径是否位于 auto-memory 目录内。
 *
 * 当设置了 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 时，这里会拿它与环境变量指定的
 * override 目录做匹配。注意：在这种情况下，这里返回 true 并不意味着有写权限——
 * filesystem.ts 中的写入 carve-out 受 !hasAutoMemPathOverride() 控制
 *（它的存在是为了绕过 DANGEROUS_DIRECTORIES）。
 *
 * settings.json 中的 autoMemoryDirectory 则会获得写入 carve-out：这是来自可信
 * settings 源的用户显式选择（projectSettings 被排除——见 getAutoMemPathSetting），
 * 并且 hasAutoMemPathOverride() 对它仍然是 false。
 */
export function isAutoMemPath(absolutePath: string): boolean {
  // SECURITY：做 Normalize 以防通过 .. 片段绕过路径穿越防护
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getAutoMemPath())
}
