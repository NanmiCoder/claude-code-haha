import { feature } from 'bun:bundle'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'
import type { PendingClassifierCheck } from '../../types/permissions.js'
import { count } from '../../utils/array.js'
import {
  checkSemantics,
  nodeTypeId,
  type ParseForSecurityResult,
  parseForSecurityFromAst,
  type Redirect,
  type SimpleCommand,
} from '../../utils/bash/ast.js'
import {
  type CommandPrefixResult,
  extractOutputRedirections,
  getCommandSubcommandPrefix,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import { parseCommandRaw } from '../../utils/bash/parser.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { AbortError } from '../../utils/errors.js'
import type {
  ClassifierBehavior,
  ClassifierResult,
} from '../../utils/permissions/bashClassifier.js'
import {
  classifyBashCommand,
  getBashPromptAllowDescriptions,
  getBashPromptAskDescriptions,
  getBashPromptDenyDescriptions,
  isClassifierPermissionsEnabled,
} from '../../utils/permissions/bashClassifier.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from '../../utils/permissions/PermissionResult.js'
import type {
  PermissionRule,
  PermissionRuleValue,
} from '../../utils/permissions/PermissionRule.js'
import { extractRules } from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js'
import {
  createPermissionRequestMessage,
  getRuleByContentsForToolName,
} from '../../utils/permissions/permissions.js'
import {
  parsePermissionRule,
  type ShellPermissionRule,
  matchWildcardPattern as sharedMatchWildcardPattern,
  permissionRuleExtractPrefix as sharedPermissionRuleExtractPrefix,
  suggestionForExactCommand as sharedSuggestionForExactCommand,
  suggestionForPrefix as sharedSuggestionForPrefix,
} from '../../utils/permissions/shellRuleMatching.js'
import { getPlatform } from '../../utils/platform.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js'
import type { BashToolInput } from './BashTool.js'
import { checkCommandOperatorPermissions } from './bashCommandHelpers.js'
import {
  bashCommandIsSafeAsync_DEPRECATED,
  stripSafeHeredocSubstitutions,
} from './bashSecurity.js'
import { checkPermissionMode } from './modeValidation.js'
import { checkPathConstraints } from './pathValidation.js'
import { checkReadOnlyConstraints } from './readOnlyValidation.js'
import { checkSedConstraints } from './sedValidation.js'
import { shouldUseSandbox } from './shouldUseSandbox.js'
import { BASH_TOOL_NAME } from './toolName.js'

      // 拒绝规则优先级最高，命中后立即返回。
// bashToolHasPermission 已经非常接近这个上限。`import { X as Y }` 这种别名导入
// 写法会被计入预算；一旦把复杂度推过阈值，Bun 就无法再证明
// feature('BASH_CLASSIFIER') 是常量，并会悄悄把相关三元表达式求成 `false`，
// 导致所有 pendingClassifierCheck spread 都被裁掉。因此别名要改成顶层 const
// 重新绑定。（另见下方对 checkSemanticsDeny 的注释。）
const bashCommandIsSafeAsync = bashCommandIsSafeAsync_DEPRECATED
const splitCommand = splitCommand_DEPRECATED
const BashTool = { name: BASH_TOOL_NAME } as const

// 环境变量赋值前缀（VAR=value）。供三个 while 循环共享，
// 用于在提取命令名之前跳过安全的环境变量。
const ENV_VAR_ASSIGN_RE = /^[A-Za-z_]\w*=/

// CC-643：对于复杂的复合命令，splitCommand_DEPRECATED 可能生成一个非常大的
// 子命令数组（可能存在指数级膨胀；#21405 的 ReDoS 修复可能并不完整）。
// 随后每个子命令都要跑 tree-sitter 解析、约 20 个 validator 以及 logEvent
// （见 bashSecurity.ts），在 metadata 被缓存后，最终形成的微任务链会饿死事件循环，
// 导致 REPL 以 100% CPU 卡死；strace 显示 /proc/self/stat 以约 127Hz 被读取，
// 却没有 epoll_wait。这里把上限设为 50 已经很宽松，正常用户命令不会拆出这么多段。
// 超过这个上限就回退到 `ask`（安全默认值，因为我们无法证明它安全，只能请求确认）。
export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50

// GH#11380：为复合命令限制“按子命令建议规则”的数量。
// 超过这个数量后，界面里的 “Yes, and don't ask again for X, Y, Z…”
// 也会退化成 “similar commands”，而且一次提示里保存 10 条以上规则通常更像噪音
// 而不是明确意图。把这么多写命令串在一个 && 列表中的用户本来也很少；
// 他们完全可以先批准一次，再手动补规则。
export const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5

/**
 * [ANT-ONLY] 记录 classifier 的评估结果，供后续分析使用。
 * 这有助于我们理解哪些 classifier 规则被命中了，以及 classifier
 * 是如何对命令做出判定的。
 */
function logClassifierResultForAnts(
  command: string,
  behavior: ClassifierBehavior,
  descriptions: string[],
  result: ClassifierResult,
): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  logEvent('tengu_internal_bash_classifier_result', {
    behavior:
      behavior as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    descriptions: jsonStringify(
      descriptions,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    matches: result.matches,
    matchedDescription: (result.matchedDescription ??
      '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    confidence:
      result.confidence as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    reason:
      result.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 注意：这里的 command 含有代码/文件路径，但这是 ANT-ONLY 场景，因此可接受。
    command:
      command as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * 从原始命令字符串中提取稳定的命令前缀（command + subcommand）。
 * 只有当开头的 env var 赋值出现在 SAFE_ENV_VARS（ant 用户还包括
 * ANT_ONLY_SAFE_ENV_VARS）中时，才会跳过这些前缀。如果遇到不安全的 env var，
 * 就返回 null（从而回退到 exact match）；如果第二个 token 看起来不像子命令
 * （例如不是小写字母数字形式的 "commit"、"run"），也会返回 null。
 *
 * 示例：
 *   'git commit -m "fix typo"' → 'git commit'
 *   'NODE_ENV=prod npm run build' → 'npm run'（NODE_ENV 属于安全变量）
 *   'MY_VAR=val npm run build' → null（MY_VAR 不属于安全变量）
 *   'ls -la' → null（是 flag，不是子命令）
 *   'cat file.txt' → null（是文件名，不是子命令）
 *   'chmod 755 file' → null（是数字参数，不是子命令）
 */
export function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  // 跳过开头的环境变量赋值（VAR=value），但前提是它们位于 SAFE_ENV_VARS
  // 中（ant 用户还包括 ANT_ONLY_SAFE_ENV_VARS）。如果遇到不安全的环境变量，
  // 就返回 null，回退到 exact match。这样可以避免生成类似 Bash(npm run:*)
  // 这种永远不可能在 allow 规则检查时命中的前缀规则，因为 stripSafeWrappers
  // 只会剥离安全变量。
  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe =
      process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }

  const remaining = tokens.slice(i)
  if (remaining.length < 2) return null
  const subcmd = remaining[1]!
  // 第二个 token 必须长得像子命令（例如 "commit"、"run"、"compose"），
  // 不能是 flag（-rf）、文件名（file.txt）、路径（/tmp）、URL 或数字（755）。
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(subcmd)) return null
  return remaining.slice(0, 2).join(' ')
}

// 像 `bash:*`、`sh:*` 这样的裸前缀建议会通过 `-c` 放行任意代码。
// `env:*`、`sudo:*` 这类包装命令前缀建议也会带来同样问题：
// `env` 不在 SAFE_WRAPPER_PATTERNS 中，因此 `env bash -c "evil"` 不会被
// stripSafeWrappers 处理掉，并会在前缀规则匹配器中命中 startsWith("env ")。
// 这里的 shell 列表与 src/utils/shell/prefix.ts 中保护旧 Haiku extractor 的
// DANGEROUS_SHELL_PREFIXES 保持一致。
const BARE_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'powershell',
  'pwsh',
  // 会把其参数直接当成真实命令执行的包装命令。
  'env',
  'xargs',
  // 安全性说明：checkSemantics（ast.ts）会先剥掉这些包装命令，再检查内部命令。
  // 如果建议用户添加 `Bash(nice:*)`，它几乎等价于 `Bash(*)`。用户一旦保存它，
  // 后续 `nice rm -rf /` 在语义检查阶段就会被放过，而 deny/cd+git gate 看到的
  // 却还是 `nice`（在本次修复前，下面的 SAFE_WRAPPER_PATTERNS 也不会剥掉裸 `nice`）。
  // 因此这些前缀绝不能被建议出来。
  'nice',
  'stdbuf',
  'nohup',
  'timeout',
  'time',
  // 提权相关：如果从 `sudo -u foo ...` 建议出 sudo:*，将会自动批准后续任意 sudo 调用。
  'sudo',
  'doas',
  'pkexec',
])

/**
 * 仅供 UI 使用的回退逻辑：当 getSimpleCommandPrefix 无法提取前缀时，
 * 只提取第一个单词。在 external build 中 TREE_SITTER_BASH 是关闭的，
 * 因此 BashPermissionRequest 里的异步 tree-sitter 精修根本不会触发；
 * 没有这层回退时，管道和复合命令（例如 `python3 file.py 2>&1 | tail -20`）
 * 会原样掉进可编辑输入框中。
 *
 * 这里故意不被 suggestionForExactCommand 使用：后端建议出的 `Bash(rm:*)`
 * 作为自动生成规则过于宽泛，但作为可编辑的起始值却符合用户预期
 * （见 Slack C07VBSHV7EV/p1772670433193449）。
 *
 * 它复用了与 getSimpleCommandPrefix 相同的 SAFE_ENV_VARS 门控逻辑。
 * 否则像 `Bash(python3:*)` 这样的规则，在检查阶段永远无法匹配
 * `RUN=/path python3 ...`，因为 stripSafeWrappers 不会剥掉 RUN。
 */
export function getFirstWordPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)

  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe =
      process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }

  const cmd = tokens[i]
  if (!cmd) return null
  // 这里采用与 getSimpleCommandPrefix 中子命令正则相同的形状检查：
  // 拒绝路径（./script.sh、/usr/bin/python）、flag、数字和文件名。
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(cmd)) return null
  if (BARE_SHELL_PREFIXES.has(cmd)) return null
  return cmd
}

function suggestionForExactCommand(command: string): PermissionUpdate[] {
  // 带 heredoc 的命令包含会随每次调用变化的多行内容，
  // 因而 exact match 规则基本没有复用价值（下次几乎不可能再命中）。
  // 这里改为提取 heredoc 操作符之前的稳定前缀，并给出 prefix 规则建议。
  const heredocPrefix = extractPrefixBeforeHeredoc(command)
  if (heredocPrefix) {
    return sharedSuggestionForPrefix(BashTool.name, heredocPrefix)
  }

  // 没有 heredoc 的多行命令，同样不适合作为 exact match 规则。
  // 如果把完整多行文本保存下来，可能会产生中间夹着 `:*` 的模式，
  // 这既会导致权限校验失败，也会污染 settings 文件。
  // 因此这里改用首行生成 prefix 规则。
  if (command.includes('\n')) {
    const firstLine = command.split('\n')[0]!.trim()
    if (firstLine) {
      return sharedSuggestionForPrefix(BashTool.name, firstLine)
    }
  }

  // 对单行命令，提取一个双词前缀，用于生成更可复用的规则。
  // 否则保存下来的 exact-match 规则在参数稍有变化时就永远无法再次命中。
  const prefix = getSimpleCommandPrefix(command)
  if (prefix) {
    return sharedSuggestionForPrefix(BashTool.name, prefix)
  }

  return sharedSuggestionForExactCommand(BashTool.name, command)
}

/**
 * 如果命令中包含 heredoc（<<），提取其前面的命令前缀。
 * 返回 heredoc 操作符之前的首个单词或词组，作为稳定前缀；
 * 若命令不包含 heredoc，则返回 null。
 *
 * 例如：
 *   'git commit -m "$(cat <<\'EOF\'\n...\nEOF\n)"' → 'git commit'
 *   'cat <<EOF\nhello\nEOF' → 'cat'
 *   'echo hello' → null（没有 heredoc）
 */
function extractPrefixBeforeHeredoc(command: string): string | null {
  if (!command.includes('<<')) return null

  const idx = command.indexOf('<<')
  if (idx <= 0) return null

  const before = command.substring(0, idx).trim()
  if (!before) return null

  const prefix = getSimpleCommandPrefix(before)
  if (prefix) return prefix

  // 兜底逻辑：跳过安全的环境变量赋值，然后最多取 2 个 token。
  // 这样既能保留 flag token（例如 "python3 -c" 仍保持为 "python3 -c"，
  // 而不是只剩下 "python3"），也能跳过像 "NODE_ENV=test" 这样的安全环境变量前缀。
  // 一旦遇到非安全环境变量，就返回 null，避免生成那些永远无法再次命中的 prefix 规则
  // （理由与 getSimpleCommandPrefix 相同）。
  const tokens = before.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    const isAntOnlySafe =
      process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
    if (!SAFE_ENV_VARS.has(varName) && !isAntOnlySafe) {
      return null
    }
    i++
  }
  if (i >= tokens.length) return null
  return tokens.slice(i, i + 2).join(' ') || null
}

function suggestionForPrefix(prefix: string): PermissionUpdate[] {
  return sharedSuggestionForPrefix(BashTool.name, prefix)
}

/**
 * 从旧版 :* 语法中提取前缀（例如 "npm:*" -> "npm"）。
 * 具体实现委托给共享模块。
 */
export const permissionRuleExtractPrefix = sharedPermissionRuleExtractPrefix

/**
 * 用 wildcard 模式匹配命令（对 Bash 来说区分大小写）。
 * 具体实现委托给共享模块。
 */
export function matchWildcardPattern(
  pattern: string,
  command: string,
): boolean {
  return sharedMatchWildcardPattern(pattern, command)
}

/**
 * 把 permission rule 解析成结构化规则对象。
 * 具体实现委托给共享模块。
 */
export const bashPermissionRule: (
  permissionRule: string,
) => ShellPermissionRule = parsePermissionRule

/**
 * 可安全从命令中剥离的环境变量白名单。
 * 这些变量本身不能执行代码，也不能触发库加载。
 *
 * 安全性：以下变量绝不能加入白名单：
 * - PATH、LD_PRELOAD、LD_LIBRARY_PATH、DYLD_*（执行路径/库加载）
 * - PYTHONPATH、NODE_PATH、CLASSPATH、RUBYLIB（模块加载）
 * - GOFLAGS、RUSTFLAGS、NODE_OPTIONS（可能携带代码执行参数）
 * - HOME、TMPDIR、SHELL、BASH_ENV（影响系统行为）
 */
const SAFE_ENV_VARS = new Set([
  // Go：仅构建期/运行期设置。
  'GOEXPERIMENT', // 实验特性
  'GOOS', // 目标操作系统
  'GOARCH', // 目标架构
  'CGO_ENABLED', // 启用/禁用 CGO
  'GO111MODULE', // module 模式

  // Rust：仅日志/调试设置。
  'RUST_BACKTRACE', // backtrace 详细程度
  'RUST_LOG', // 日志过滤器

  // Node：仅环境名（绝不是 NODE_OPTIONS!）。
  'NODE_ENV',

  // Python：仅行为开关（绝不是 PYTHONPATH!）。
  'PYTHONUNBUFFERED', // 禁用缓冲
  'PYTHONDONTWRITEBYTECODE', // 不生成 .pyc 文件

  // Pytest：测试配置。
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD', // 禁止自动加载插件
  'PYTEST_DEBUG', // 调试输出

  // API 密钥与认证。
  'ANTHROPIC_API_KEY', // API 认证

  // 区域设置与字符编码。
  'LANG', // 默认区域设置
  'LANGUAGE', // 语言偏好列表
  'LC_ALL', // 覆盖所有区域设置
  'LC_CTYPE', // 字符分类
  'LC_TIME', // 时间格式
  'CHARSET', // 字符集偏好

  // 终端与显示。
  'TERM', // 终端类型
  'COLORTERM', // 彩色终端标识
  'NO_COLOR', // 禁用彩色输出（通用标准）
  'FORCE_COLOR', // 强制开启彩色输出
  'TZ', // 时区

  // 各类工具的颜色配置。
  'LS_COLORS', // ls 的颜色配置（GNU）
  'LSCOLORS', // ls 的颜色配置（BSD/macOS）
  'GREP_COLOR', // grep 命中颜色（已弃用）
  'GREP_COLORS', // grep 配色方案
  'GCC_COLORS', // GCC 诊断颜色

  // 显示格式。
  'TIME_STYLE', // ls 的时间显示格式
  'BLOCK_SIZE', // du/df 的块大小
  'BLOCKSIZE', // 另一种块大小设置
])

/**
 * 仅供 ANT 内部使用、且可安全从命令中剥离的环境变量。
 * 只有当 USER_TYPE === 'ant' 时才会启用。
 *
 * 安全性：这些环境变量会在 permission-rule 匹配之前就被剥掉，
 * 这意味着 `DOCKER_HOST=tcp://evil.com docker ps` 在剥离后仍会命中
 * `Bash(docker ps:*)` 这样的规则。这个能力是刻意限定为 ANT-ONLY 的
 * （见 line ~380 的门控），绝不能面向外部用户发布。
 * DOCKER_HOST 会改写 Docker daemon 的目标端点；把它剥掉，相当于通过隐藏网络端点
 * 来绕过基于前缀的权限限制。KUBECONFIG 同理，它决定 kubectl 实际连到哪个集群。
 * 这些剥离规则只是为了给接受该风险的内部高阶用户提供便利。
 *
 * 该集合基于过去 30 天 tengu_internal_bash_tool_use_permission_request 事件分析得出。
 */
const ANT_ONLY_SAFE_ENV_VARS = new Set([
  // Kubernetes 与容器配置（只是配置文件指针，不是执行入口）。
  'KUBECONFIG', // kubectl 配置文件路径，决定 kubectl 连接哪个集群
  'DOCKER_HOST', // Docker daemon socket/端点，决定 docker 连接哪个 daemon

  // 云厂商项目/Profile 选择（只是名称/标识符）。
  'AWS_PROFILE', // AWS profile 名称选择
  'CLOUDSDK_CORE_PROJECT', // GCP project ID
  'CLUSTER', // 通用集群名称

  // Anthropic 内部集群选择（只是名称或标识符）。
  'COO_CLUSTER', // coo 集群名
  'COO_CLUSTER_NAME', // coo 集群名（另一种写法）
  'COO_NAMESPACE', // coo namespace
  'COO_LAUNCH_YAML_DRY_RUN', // dry run 模式

  // 功能开关（仅布尔/字符串型标记）。
  'SKIP_NODE_VERSION_CHECK', // 跳过版本检查
  'EXPECTTEST_ACCEPT', // 接受测试期望值
  'CI', // CI 环境标识
  'GIT_LFS_SKIP_SMUDGE', // 跳过 LFS 下载

  // GPU/设备选择（只是设备 ID）。
  'CUDA_VISIBLE_DEVICES', // GPU 设备选择
  'JAX_PLATFORMS', // JAX 平台选择

  // 显示/终端设置。
  'COLUMNS', // 终端宽度
  'TMUX', // TMUX socket 信息

  // 测试/调试配置。
  'POSTGRESQL_VERSION', // Postgres 版本字符串
  'FIRESTORE_EMULATOR_HOST', // 模拟器 host:port
  'HARNESS_QUIET', // 静默模式开关
  'TEST_CROSSCHECK_LISTS_MATCH_UPDATE', // 测试更新开关
  'DBT_PER_DEVELOPER_ENVIRONMENTS', // DBT 配置
  'STATSIG_FORD_DB_CHECKS', // statsig DB 检查开关

  // 构建配置。
  'ANT_ENVIRONMENT', // Anthropic 环境名
  'ANT_SERVICE', // Anthropic 服务名
  'MONOREPO_ROOT_DIR', // monorepo 根路径

  // 版本选择器。
  'PYENV_VERSION', // Python 版本选择

  // 凭据（已批准的子集，不改变数据外传风险）。
  'PGPASSWORD', // Postgres 密码
  'GH_TOKEN', // GitHub token
  'GROWTHBOOK_API_KEY', // 自托管 growthbook
])

/**
 * 从命令中剥离整行注释。
 * 这主要处理 Claude 在 bash 命令里附带注释的情况，例如：
 *   "# 检查日志目录\nls /home/user/logs"
 * 最终应被剥成："ls /home/user/logs"
 *
 * 这里只会删除“整行都是注释”的行，
 * 不会删除命令同一行末尾的行内注释。
 */
function stripCommentLines(command: string): string {
  const lines = command.split('\n')
  const nonCommentLines = lines.filter(line => {
    const trimmed = line.trim()
    // 保留非空且不以 # 开头的行。
    return trimmed !== '' && !trimmed.startsWith('#')
  })

  // 如果所有行都是注释或空行，就返回原始命令。
  if (nonCommentLines.length === 0) {
    return command
  }

  return nonCommentLines.join('\n')
}

export function stripSafeWrappers(command: string): string {
  // 安全性：这里必须使用 [ \t]+，不能用 \s+。
  // 因为 \s 会匹配 bash 中作为命令分隔符的 \n/\r。
  // 如果跨换行匹配，就可能把一行的 wrapper 剥掉，却把下一行的另一条命令留给 bash 执行。
  //
  // 安全性：`(?:--[ \t]+)?` 会顺带消费 wrapper 自己的 `--`，
  // 这样 `nohup -- rm -- -/../foo` 才会被剥成 `rm -- -/../foo`，
  // 而不是 `-- rm ...`。否则 baseCmd 会变成未知的 `--`，从而跳过路径校验。
  const SAFE_WRAPPER_PATTERNS = [
    // timeout：枚举 GNU 长参数。包含无值参数（--foreground、
    // --preserve-status、--verbose），以及同时支持 =fused 和空格分隔的带值参数
    // （--kill-after=5、--kill-after 5、--signal=TERM、--signal TERM）。
    // 短参数包括 -v（无值）以及 -k/-s（支持独立值与 fused 值）。
    // 安全性：flag 值必须走 allowlist [A-Za-z0-9_.+-]
    // （例如 TERM/KILL/9、5/5s/10.5）。过去使用 [^ \t]+ 时会把
    // $ ( ) ` | ; & 也一起匹配进来，导致 `timeout -k$(id) 10 ls` 被剥成 `ls`，
    // 命中 Bash(ls:*)，而 bash 实际会在 timeout 执行前的分词阶段先展开 $(id)。
    // 与此对照，下方的 ENV_VAR_PATTERN 本来就是 allowlist 方案。
    /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
    /^time[ \t]+(?:--[ \t]+)?/,
    // 安全性：这里必须与 checkSemantics 的 wrapper-strip 逻辑（ast.ts
    // ~:1990-2080）以及 stripWrappersFromArgv（pathValidation.ts ~:1260）保持同步。
    // 之前这个模式要求必须出现 `-n N`，但 checkSemantics 已经支持裸 `nice`
    // 和旧式 `-N`。这种不对称会导致：语义检查能看到被包装后的真实命令，
    // 但 deny-rule 匹配和 cd+git gate 看到的仍是 wrapper 名字。
    // 于是 `nice rm -rf /` 在 Bash(rm:*) deny 下会从 deny 降级成 ask；
    // `cd evil && nice git status` 还会绕过 bare-repo RCE gate。
    // PR #21503 修了 stripWrappersFromArgv，但这里当时漏掉了。
    // 现在会匹配：`nice cmd`、`nice -n N cmd`、`nice -N cmd`，
    // 也就是 checkSemantics 会剥掉的全部形式。
    /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
    // stdbuf：这里只处理 fused 的短参数（-o0、-eL）。checkSemantics 支持更多形式
    // （如空格分隔、长参数 --output=MODE），但这些情况上层会以 fail-closed 方式处理，
    // 因此这里不做过度剥离是安全的。主要需求是支持 `stdbuf -o0 cmd`。
    /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
    /^nohup[ \t]+(?:--[ \t]+)?/,
  ] as const

  // 环境变量匹配模式：
  // ^([A-Za-z_][A-Za-z0-9_]*)  - 变量名（标准标识符）
  // =                           - 等号
  // ([A-Za-z0-9_./:-]+)         - 值：仅允许字母数字与安全标点
  // [ \t]+                      - 值后必须跟水平空白
  //
  // 安全性：这里只匹配未加引号且只包含安全字符的值（不允许 $()、`、$var、;|&）。
  //
  // 安全性：尾随空白必须是 [ \t]+（仅水平空白），绝不能用 \s+。
  // 因为 \s 会匹配 \n/\r。如果 reconstructCommand 在 `TZ=UTC` 和 `echo` 中间
  // 生成了一个未加引号的换行，那么 \s+ 会跨过去并剥掉 `TZ=UTC<NL>`，
  // 最终留下 `echo curl evil.com` 去命中 Bash(echo:*)。
  // 但对 bash 而言，这个换行本来就是命令分隔符。这里与 needsQuoting 修复一起构成纵深防御。
  const ENV_VAR_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/

  let stripped = command
  let previousStripped = ''

  // 第一阶段：只剥离前导 env var 和整行注释。
  // 在 bash 里，命令前面的 env var 赋值（VAR=val cmd）是真正的 shell 层赋值，
  // 因此为了权限匹配而把它们剥掉是安全的。
  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    const envVarMatch = stripped.match(ENV_VAR_PATTERN)
    if (envVarMatch) {
      const varName = envVarMatch[1]!
      const isAntOnlySafe =
        process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
      if (SAFE_ENV_VARS.has(varName) || isAntOnlySafe) {
        stripped = stripped.replace(ENV_VAR_PATTERN, '')
      }
    }
  }

  // 第二阶段：只剥离包装命令和整行注释，绝不能剥环境变量。
  // 包装命令（timeout、time、nice、nohup）会通过 execvp 执行其参数，
  // 因此包装命令之后的 VAR=val 会被当成“要执行的命令”，而不是环境变量赋值。
  // 如果在这里把 env var 也剥掉，就会导致“解析器看到的内容”与“实际执行的内容”不一致。
  // (HackerOne #3543050)
  previousStripped = ''
  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    for (const pattern of SAFE_WRAPPER_PATTERNS) {
      stripped = stripped.replace(pattern, '')
    }
  }

  return stripped.trim()
}

// 安全性：timeout 的 flag 值必须走 allowlist（例如 TERM/KILL/9、5/5s/10.5）。
// 这里会拒绝过去 [^ \t]+ 也能误匹配到的 $ ( ) ` | ; & 与换行。
// `timeout -k$(id) 10 ls` 这种情况绝不能被剥离。
const TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

/**
 * 解析 timeout 的 GNU 参数（长参数 + 短参数，支持 fused 与空格分隔），
 * 并返回 DURATION token 在 argv 中的索引；如果参数无法解析，则返回 -1。
 * 覆盖范围包括：--foreground/--preserve-status/--verbose（无值），
 * --kill-after/--signal（带值，支持 =fused 和空格分隔），以及 -v（无值）、
 * -k/-s（带值，支持 fused 与空格分隔）。
 *
 * 之所以从 stripWrappersFromArgv 中抽出来，是为了让 bashToolHasPermission
 * 不要超过 Bun 的 feature() DCE 复杂度阈值。把它内联回去会破坏
 * classifier 测试里 feature('BASH_CLASSIFIER') 的求值。
 */
function skipTimeoutFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    const next = a[i + 1]
    if (
      arg === '--foreground' ||
      arg === '--preserve-status' ||
      arg === '--verbose'
    )
      i++
    else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (
      (arg === '--kill-after' || arg === '--signal') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (arg === '--') {
      i++
      break
    } // 选项结束标记。
    else if (arg.startsWith('--')) return -1
    else if (arg === '-v') i++
    else if (
      (arg === '-k' || arg === '-s') &&
      next &&
      TIMEOUT_FLAG_VALUE_RE.test(next)
    )
      i += 2
    else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) i++
    else if (arg.startsWith('-')) return -1
    else break
  }
  return i
}

/**
 * stripSafeWrappers 的 argv 级对应实现。
 * 它会从 AST 派生出的 argv 中剥掉同样的包装命令
 * （timeout、time、nice、nohup）。环境变量已经单独分离到
 * SimpleCommand.envVars，因此这里不再做环境变量剥离。
 *
 * 必须与上方的 SAFE_WRAPPER_PATTERNS 保持同步。
 * 如果那边新增了 wrapper，这里也必须同步添加。
 */
export function stripWrappersFromArgv(argv: string[]): string[] {
  // 安全性：这里要消费 wrapper 选项后的可选 `--`，与 wrapper 的真实行为保持一致。
  // 否则 `['nohup','--','rm','--','-/../foo']` 会把 `--` 当成 baseCmd，
  // 从而跳过路径校验。见 SAFE_WRAPPER_PATTERNS 处的说明。
  let a = argv
  for (;;) {
    if (a[0] === 'time' || a[0] === 'nohup') {
      a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'timeout') {
      const i = skipTimeoutFlags(a)
      if (i < 0 || !a[i] || !/^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) return a
      a = a.slice(i + 1)
    } else if (
      a[0] === 'nice' &&
      a[1] === '-n' &&
      a[2] &&
      /^-?\d+$/.test(a[2])
    ) {
      a = a.slice(a[3] === '--' ? 4 : 3)
    } else {
      return a
    }
  }
}

/**
 * 会让“另一套二进制”执行起来的环境变量（注入或解析劫持）。
 * 这里只是启发式规则，export-&& 这种形式仍能绕过；
 * 而 excludedCommands 本身也不是安全边界。
 */
export const BINARY_HIJACK_VARS = /^(LD_|DYLD_|PATH$)/

/**
 * 从命令中剥离所有前导环境变量前缀，而不管变量名是否在 safe-list 中。
 *
 * 该逻辑用于 deny/ask 规则匹配：当用户拒绝 `claude` 或 `rm` 时，
 * 即便命令前面加了任意 env var（如 `FOO=bar claude`），也应继续被拦截。
 * stripSafeWrappers 中的 safe-list 限制对 allow 规则是正确的
 * （可防止 `DOCKER_HOST=evil docker ps` 自动命中 `Bash(docker ps:*)`），
 * 但 deny 规则必须更难绕过。
 *
 * 它也用于 sandbox.excludedCommands 匹配（安全边界仍然是 permission prompt，
 * 不是 excludedCommands 本身），此时会把 BINARY_HIJACK_VARS 当作阻止列表使用。
 *
 * 安全性：这里使用的 value 模式比 stripSafeWrappers 更宽。
 * 它只排除了真正具有 shell 注入意义的字符（$、反引号、;、|、&、括号、
 * 重定向符、引号、反斜杠）以及空白。像 =、+、@、~、, 这类字符在未加引号的
 * 环境变量赋值位置里是无害的，必须允许匹配，否则很容易出现
 * `FOO=a=b denied_command` 这类平凡绕过。
 *
 * @param blocklist - 可选正则，会对每个变量名做测试；一旦命中，
 *   该变量不会被剥离，并且剥离过程会在此停止。deny 规则下应省略；
 *   excludedCommands 场景下传入 BINARY_HIJACK_VARS。
 */
export function stripAllLeadingEnvVars(
  command: string,
  blocklist?: RegExp,
): string {
  // deny 规则剥离使用的 value 模式更宽。它能处理：
  //
  // - 标准赋值（FOO=bar）、追加（FOO+=bar）、数组（FOO[0]=bar）
  // - 单引号值：'[^'\n\r]*'，在 bash 中这会完全抑制展开
  // - 带反斜杠转义的双引号值："(?:\\.|[^"$`\\\n\r])*"
  //   在 bash 的双引号中，只有 \$、\`、\"、\\ 和 \newline 具备特殊含义。
  //   其他 \x 序列是无害的，因此这里允许双引号内部的 \\.
  //   同时仍排除裸 $ 和 `，以阻止展开。
  // - 未加引号的值：排除 shell 元字符，但允许反斜杠转义
  // - 拼接片段：如 FOO='x'y"z"，bash 会把相邻片段拼接起来
  //
  // 安全性：尾随空白必须是 [ \t]+（仅水平空白），绝不能用 \s+。
  //
  // 外层的 * 每次只匹配一个原子单元：完整的带引号字符串、反斜杠转义对，
  // 或单个未加引号的安全字符。
  // 内层双引号分支 (?:...|...)* 由闭合的 " 限定边界，
  // 因此不会与外层 * 发生灾难性回溯耦合。
  //
  // 注意：这里会把 $ 从未加引号/双引号 value 类中排除，以拦截
  // $(cmd)、${var}、$((expr)) 这类危险形式。
  // 这也意味着 FOO=$VAR 不会被剥离；如果专门支持 $VAR 匹配，会引入 ReDoS 风险
  // （CodeQL #671），而这类 $VAR 绕过当前优先级较低。
  const ENV_VAR_PATTERN =
    /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\\\'"])*[ \t]+/

  let stripped = command
  let previousStripped = ''

  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    const m = stripped.match(ENV_VAR_PATTERN)
    if (!m) continue
    if (blocklist?.test(m[1]!)) break
    stripped = stripped.slice(m[0].length)
  }

  return stripped.trim()
}

function filterRulesByContentsMatchingInput(
  input: BashToolInput,
  rules: Map<string, PermissionRule>,
  matchMode: 'exact' | 'prefix',
  {
    stripAllEnvVars = false,
    skipCompoundCheck = false,
  }: { stripAllEnvVars?: boolean; skipCompoundCheck?: boolean } = {},
): PermissionRule[] {
  const command = input.command.trim()

  // 为权限匹配先剥离输出重定向。
  // 这样 Bash(python:*) 这类规则才能命中 "python script.py > output.txt"。
  // 重定向目标的安全校验会在 checkPathConstraints 中单独处理。
  const commandWithoutRedirections =
    extractOutputRedirections(command).commandWithoutRedirections

  // 对 exact 匹配，同时尝试原始命令（保留引号）和去掉重定向后的版本
  // （这样不带重定向的规则也能命中）。
  // 对 prefix 匹配，则只使用去掉重定向后的版本。
  const commandsForMatching =
    matchMode === 'exact'
      ? [command, commandWithoutRedirections]
      : [commandWithoutRedirections]

  // 为匹配过程剥掉安全包装命令（timeout、time、nice、nohup）和环境变量。
  // 这样 Bash(npm install:*) 之类的规则才能命中
  // "timeout 10 npm install foo" 或 "GOOS=linux go build"。
  const commandsToTry = commandsForMatching.flatMap(cmd => {
    const strippedCommand = stripSafeWrappers(cmd)
    return strippedCommand !== cmd ? [cmd, strippedCommand] : [cmd]
  })

  // 安全性：对 deny/ask 规则，还要额外尝试“剥掉所有前导环境变量前缀”后的匹配结果。
  // 这可以防止 `FOO=bar denied_command` 这种绕过，即便 FOO 不在 safe-list 中。
  // stripSafeWrappers 中的 safe-list 限制是为了 allow 规则而刻意设计的
  // （见 HackerOne #3543050），但 deny 规则必须更难被规避。
  // 一条被拒绝的命令，无论前面加多少环境变量前缀，都应继续被拒绝。
  //
  // 这里会对所有候选命令反复交替应用两种剥离操作，直到不再产生新候选
  // （也就是达到 fixed-point）。这能覆盖交错模式，例如
  // `nohup FOO=bar timeout 5 claude`：
  //   1. stripSafeWrappers 先剥掉 `nohup` → `FOO=bar timeout 5 claude`
  //   2. stripAllLeadingEnvVars 再剥掉 `FOO=bar` → `timeout 5 claude`
  //   3. stripSafeWrappers 再剥掉 `timeout 5` → `claude`（命中 deny）
  //
  // 如果不做迭代，单次组合就会漏掉这类多层交错场景。
  if (stripAllEnvVars) {
    const seen = new Set(commandsToTry)
    let startIdx = 0

    // 一直迭代，直到不再生成新的候选命令（fixed-point）。
    while (startIdx < commandsToTry.length) {
      const endIdx = commandsToTry.length
      for (let i = startIdx; i < endIdx; i++) {
        const cmd = commandsToTry[i]
        if (!cmd) {
          continue
        }
        // 尝试剥离环境变量。
        const envStripped = stripAllLeadingEnvVars(cmd)
        if (!seen.has(envStripped)) {
          commandsToTry.push(envStripped)
          seen.add(envStripped)
        }
        // 尝试剥离安全包装命令。
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          commandsToTry.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }
  }

  // 预先计算每个候选命令是否属于复合命令，避免在规则过滤循环里重复解析。
  // 否则 splitCommand 的调用量会按 rules.length × commandsToTry.length 增长。
  // 这个复合命令检查只作用于 'prefix' 模式下的 prefix/wildcard 匹配，
  // 而且只对 allow 规则生效。
  // 安全性：deny/ask 规则必须能命中复合命令，否则只要把被拒绝命令包进复合表达式里就能绕过。
  const isCompoundCommand = new Map<string, boolean>()
  if (matchMode === 'prefix' && !skipCompoundCheck) {
    for (const cmd of commandsToTry) {
      if (!isCompoundCommand.has(cmd)) {
        isCompoundCommand.set(cmd, splitCommand(cmd).length > 1)
      }
    }
  }

  return Array.from(rules.entries())
    .filter(([ruleContent]) => {
      const bashRule = bashPermissionRule(ruleContent)

      return commandsToTry.some(cmdToMatch => {
        switch (bashRule.type) {
          case 'exact':
            return bashRule.command === cmdToMatch
          case 'prefix':
            switch (matchMode) {
              // 在 'exact' 模式下，只有命令与 prefix rule 完全一致时才返回 true。
              case 'exact':
                return bashRule.prefix === cmdToMatch
              case 'prefix': {
                // 安全性：prefix rule 绝不能命中复合命令。
                // 例如 Bash(cd:*) 不应命中 "cd /path && python3 evil.py"。
                // 正常流程里命令在到这里之前就会先被拆分，但 shell 转义仍可能绕过第一轮 splitCommand，
                // 例如：cd src\&\& python3 hello.py → splitCommand → ["cd src&& python3 hello.py"]。
                // 这会让它看起来像一条以 "cd " 开头的单命令。
                // 这里再次拆分候选命令，就是为了兜住这种情况。
                if (isCompoundCommand.get(cmdToMatch)) {
                  return false
                }
                // 保证单词边界：prefix 后面必须是空格或字符串结束。
                // 这样可以防止 "ls:*" 错误命中 "lsof" 或 "lsattr"。
                if (cmdToMatch === bashRule.prefix) {
                  return true
                }
                if (cmdToMatch.startsWith(bashRule.prefix + ' ')) {
                  return true
                }
                // 还要匹配“裸 xargs + <prefix>”这种形式。
                // 这样 Bash(grep:*) 才能命中 "xargs grep pattern"，
                // Bash(rm:*) 这样的 deny 规则也才能拦住 "xargs rm file"。
                // 这里天然保留了单词边界："xargs -n1 grep" 并不以
                // "xargs grep " 开头，因此带 flag 的 xargs 调用不会被误匹配。
                const xargsPrefix = 'xargs ' + bashRule.prefix
                if (cmdToMatch === xargsPrefix) {
                  return true
                }
                return cmdToMatch.startsWith(xargsPrefix + ' ')
              }
            }
            break
          case 'wildcard':
            // 安全修复：在 exact 匹配模式下，wildcard 绝不能参与匹配，
            // 因为此时我们面对的是未经拆分的完整命令。
            // 如果直接在未解析命令上跑 wildcard，像 "foo *" 这种规则就会错误命中
            // "foo arg && curl evil.com"，因为 .* 会把操作符也吃进去。
            // wildcard 只能在命令被拆成独立子命令之后使用。
            if (matchMode === 'exact') {
              return false
            }
            // 安全性：与 prefix rule 一样，在 prefix 模式下也不能让 wildcard 命中复合命令。
            // 例如 Bash(cd *) 不应命中 "cd /path && python3 evil.py"，
            // 即便 "cd *" 从字面模式上看似乎能匹配。
            if (isCompoundCommand.get(cmdToMatch)) {
              return false
            }
            // 在 prefix 模式下（即已经拆分为子命令后），wildcard 匹配子命令才是安全的。
            return matchWildcardPattern(bashRule.pattern, cmdToMatch)
        }
      })
    })
    .map(([, rule]) => rule)
}

function matchingRulesForInput(
  input: BashToolInput,
  toolPermissionContext: ToolPermissionContext,
  matchMode: 'exact' | 'prefix',
  { skipCompoundCheck = false }: { skipCompoundCheck?: boolean } = {},
) {
  const denyRuleByContents = getRuleByContentsForToolName(
    toolPermissionContext,
    BASH_TOOL_NAME,
    'deny',
  )
  // 安全性：deny/ask 规则会使用更激进的 env var 剥离策略，
  // 这样 `FOO=bar denied_command` 仍然会命中针对 `denied_command` 的 deny 规则。
  const matchingDenyRules = filterRulesByContentsMatchingInput(
    input,
    denyRuleByContents,
    matchMode,
    { stripAllEnvVars: true, skipCompoundCheck: true },
  )

  const askRuleByContents = getRuleByContentsForToolName(
    toolPermissionContext,
    BASH_TOOL_NAME,
    'ask',
  )
  const matchingAskRules = filterRulesByContentsMatchingInput(
    input,
    askRuleByContents,
    matchMode,
    { stripAllEnvVars: true, skipCompoundCheck: true },
  )

  const allowRuleByContents = getRuleByContentsForToolName(
    toolPermissionContext,
    BASH_TOOL_NAME,
    'allow',
  )
  const matchingAllowRules = filterRulesByContentsMatchingInput(
    input,
    allowRuleByContents,
    matchMode,
    { skipCompoundCheck },
  )

  return {
    matchingDenyRules,
    matchingAskRules,
    matchingAllowRules,
  }
}

/**
 * 检查该子命令是否与某条 permission rule 完全精确匹配。
 */
export const bashToolCheckExactMatchPermission = (
  input: BashToolInput,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult => {
  const command = input.command.trim()
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'exact')

  // 1. 如果 exact command 被 deny，则直接拒绝。
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2. 如果 exact command 命中了 ask 规则，则请求确认。
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 3. 如果 exact command 命中了 allow 规则，则直接允许。
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: matchingAllowRules[0],
      },
    }
  }

  // 4. 否则走 passthrough。
  const decisionReason = {
    type: 'other' as const,
    reason: 'This command requires approval',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    // 给用户建议一条 exact match 规则。
    // 后续可能会在 `checkCommandAndSuggestRules()` 中被 prefix 规则建议覆盖。
    suggestions: suggestionForExactCommand(command),
  }
}

export const bashToolCheckPermission = (
  input: BashToolInput,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  astCommand?: SimpleCommand,
): PermissionResult => {
  const command = input.command.trim()

  // 1. 先检查 exact match 规则。
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )

  // 1a. 如果 exact command 已有 deny/ask 规则，则直接返回。
  if (
    exactMatchResult.behavior === 'deny' ||
    exactMatchResult.behavior === 'ask'
  ) {
    return exactMatchResult
  }

  // 2. 查找所有匹配规则（prefix 或 exact）。
  // 安全修复：必须先检查 Bash 的 deny/ask 规则，再检查路径约束，
  // 以防止通过项目目录外的绝对路径完成绕过（HackerOne 报告）。
  // 如果已经走过 AST 解析，那么当前子命令本身已经是原子的，
  // 此时要跳过旧的 splitCommand 复检逻辑，因为它会把词中的 # 误判成复合命令。
  const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
    matchingRulesForInput(input, toolPermissionContext, 'prefix', {
      skipCompoundCheck: astCommand !== undefined,
    })

  // 2a. 如果命中 deny 规则，则直接拒绝。
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 2b. 如果命中 ask 规则，则请求确认。
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }

  // 3. 检查路径约束。
  // 这一步放在 deny/ask 规则之后执行，这样显式规则可以优先覆盖。
  // 安全性：如果当前子命令已有 AST 派生的 argv，就把它直接传下去，
  // 让 checkPathConstraints 直接使用，而不是再交给 shell-quote 重新解析。
  // 因为 shell-quote 存在“单引号中的反斜杠”缺陷，可能让 parseCommandArguments
  // 返回 []，并悄悄跳过路径校验。
  const pathResult = checkPathConstraints(
    input,
    getCwd(),
    toolPermissionContext,
    compoundCommandHasCd,
    astCommand?.redirects,
    astCommand ? [astCommand] : undefined,
  )
  if (pathResult.behavior !== 'passthrough') {
    return pathResult
  }

  // 4. 如果命令命中了 exact allow 规则，就直接允许。
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // 5. 如果命令命中了 allow 规则，也直接允许。
  if (matchingAllowRules[0] !== undefined) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: matchingAllowRules[0],
      },
    }
  }

  // 5b. 检查 sed 约束（在 mode auto-allow 生效前先拦截危险的 sed 操作）。
  const sedConstraintResult = checkSedConstraints(input, toolPermissionContext)
  if (sedConstraintResult.behavior !== 'passthrough') {
    return sedConstraintResult
  }

  // 6. 检查 mode 特定的权限处理逻辑。
  const modeResult = checkPermissionMode(input, toolPermissionContext)
  if (modeResult.behavior !== 'passthrough') {
    return modeResult
  }

  // 7. 检查只读规则。
  if (
    checkReadOnlyConstraints(
      input,
      compoundCommandHasCd ?? commandHasAnyCd(input.command),
    ).behavior === 'allow'
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Read-only command is allowed',
      },
    }
  }

  // 8. 没有任何规则命中，因此返回 passthrough，后续会触发权限提示。
  const decisionReason = {
    type: 'other' as const,
    reason: 'This command requires approval',
  }
  return {
    behavior: 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    // 给用户建议一条 exact match 规则。
    // 这条建议后续可能会在 `checkCommandAndSuggestRules()` 中被 prefix 规则建议覆盖。
    suggestions: suggestionForExactCommand(command),
  }
}

/**
 * 处理单个子命令，并应用 prefix 检查与规则建议。
 */
export async function checkCommandAndSuggestRules(
  input: BashToolInput,
  toolPermissionContext: ToolPermissionContext,
  commandPrefixResult: CommandPrefixResult | null | undefined,
  compoundCommandHasCd?: boolean,
  astParseSucceeded?: boolean,
): Promise<PermissionResult> {
  // 1. 先检查 exact match 规则。
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )
  if (exactMatchResult.behavior !== 'passthrough') {
    return exactMatchResult
  }

  // 2. 检查命令前缀。
  const permissionResult = bashToolCheckPermission(
    input,
    toolPermissionContext,
    compoundCommandHasCd,
  )
  // 2a. 如果命令被显式 deny/ask，则直接返回。
  if (
    permissionResult.behavior === 'deny' ||
    permissionResult.behavior === 'ask'
  ) {
    return permissionResult
  }

  // 3. 如果检测到命令注入风险，则请求权限确认。
  // 若 AST 解析已经成功，则跳过这步，因为 tree-sitter 已确认不存在隐藏替换
  // 或结构性花招；此时旧的正则型 validator（反斜杠转义操作符等）
  // 只会徒增误报。
  if (
    !astParseSucceeded &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    const safetyResult = await bashCommandIsSafeAsync(input.command)

    if (safetyResult.behavior !== 'passthrough') {
      const decisionReason: PermissionDecisionReason = {
        type: 'other' as const,
        reason:
          safetyResult.behavior === 'ask' && safetyResult.message
            ? safetyResult.message
            : 'This command contains patterns that could pose security risks and requires approval',
      }

      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
        decisionReason,
        suggestions: [], // 不要建议保存一条潜在危险命令。
      }
    }
  }

  // 4. 如果命令已经被允许，则直接返回 allow 结果。
  if (permissionResult.behavior === 'allow') {
    return permissionResult
  }

  // 5. 若能提取 prefix，则建议 prefix 规则；否则建议 exact command 规则。
  const suggestedUpdates = commandPrefixResult?.commandPrefix
    ? suggestionForPrefix(commandPrefixResult.commandPrefix)
    : suggestionForExactCommand(input.command)

  return {
    ...permissionResult,
    suggestions: suggestedUpdates,
  }
}

/**
 * 检查命令在启用 sandbox 时是否应被自动允许。
 * 如果存在必须尊重的显式 deny/ask 规则，会尽早返回。
 *
 * 注意：这个函数只应在同时启用了 sandboxing 和 auto-allow 时调用。
 *
 * @param input - bash tool 输入
 * @param toolPermissionContext - 权限上下文
 * @returns PermissionResult，其中：
 *   - 存在显式规则（exact 或 prefix）时返回 deny/ask
 *   - 没有显式规则时返回 allow（由 sandbox auto-allow 生效）
 *   - 在 auto-allow 模式下理论上不应出现 passthrough
 */
function checkSandboxAutoAllow(
  input: BashToolInput,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const command = input.command.trim()

  // 检查整条命令上是否存在显式 deny/ask 规则（exact + prefix）。
  const { matchingDenyRules, matchingAskRules } = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
  )

  // 如果整条命令存在显式 deny 规则，则立即返回。
  if (matchingDenyRules[0] !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
      decisionReason: {
        type: 'rule',
        rule: matchingDenyRules[0],
      },
    }
  }

  // 安全性：对复合命令，必须逐个子命令检查 deny/ask 规则。
  // 像 Bash(rm:*) 这样的 prefix rule 无法直接命中整个复合命令
  // （例如 "echo hello && rm -rf /" 并不是以 "rm" 开头），
  // 因此必须逐个子命令单独检查。
  // 重要：对子命令的 deny 检查必须先于“整条命令的 ask 返回”。
  // 否则如果某个 wildcard ask 规则先命中了整条命令（例如 Bash(*echo*)），
  // 就会在子命令上的 prefix deny 规则（例如 Bash(rm:*)）检查之前先返回 `ask`，
  // 把本应 deny 的结果降级成 ask。
  const subcommands = splitCommand(command)
  if (subcommands.length > 1) {
    let firstAskRule: PermissionRule | undefined
    for (const sub of subcommands) {
      const subResult = matchingRulesForInput(
        { command: sub },
        toolPermissionContext,
        'prefix',
      )
      // 拒绝规则优先级最高，立即返回。
      if (subResult.matchingDenyRules[0] !== undefined) {
        return {
          behavior: 'deny',
          message: `Permission to use ${BashTool.name} with command ${command} has been denied.`,
          decisionReason: {
            type: 'rule',
            rule: subResult.matchingDenyRules[0],
          },
        }
      }
      // 先缓存第一条 ask 命中结果，但此时不要立刻返回。
      // 因为需要先确保所有子命令都不存在 deny。
      firstAskRule ??= subResult.matchingAskRules[0]
    }
    if (firstAskRule) {
      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(BashTool.name),
        decisionReason: {
          type: 'rule',
          rule: firstAskRule,
        },
      }
    }
  }

  // 在所有 deny 来源都排除后，再检查整条命令上的 ask。
  if (matchingAskRules[0] !== undefined) {
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name),
      decisionReason: {
        type: 'rule',
        rule: matchingAskRules[0],
      },
    }
  }
  // 没有显式规则时，就配合 sandbox 自动允许。

  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: {
      type: 'other',
      reason: 'Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)',
    },
  }
}

/**
 * 过滤掉形如 `cd ${cwd}` 的前缀子命令，同时保持 astCommands 对齐。
 * 之所以抽成独立函数，是为了避免 bashToolHasPermission 超过 Bun 的
 * feature() DCE 复杂度阈值；如果把它内联，会导致大约 10 个 classifier 测试中
 * pendingClassifierCheck 的附着逻辑失效。
 */
function filterCdCwdSubcommands(
  rawSubcommands: string[],
  astCommands: SimpleCommand[] | undefined,
  cwd: string,
  cwdMingw: string,
): { subcommands: string[]; astCommandsByIdx: (SimpleCommand | undefined)[] } {
  const subcommands: string[] = []
  const astCommandsByIdx: (SimpleCommand | undefined)[] = []
  for (let i = 0; i < rawSubcommands.length; i++) {
    const cmd = rawSubcommands[i]!
    if (cmd === `cd ${cwd}` || cmd === `cd ${cwdMingw}`) continue
    subcommands.push(cmd)
    astCommandsByIdx.push(astCommands?.[i])
  }
  return { subcommands, astCommandsByIdx }
}

/**
 * 为 AST too-complex 与 checkSemantics 路径提供“早退出”的 deny 强制逻辑。
 * 如果 exact-match 结果不是 passthrough（deny/ask/allow），就直接返回；
 * 否则再检查 prefix/wildcard deny 规则。
 * 如果两者都未命中，则返回 null，表示调用方应继续落到 ask 流程。
 * 之所以抽出来，同样是为了避免 bashToolHasPermission 超过 Bun 的
 * feature() DCE 复杂度阈值。
 */
function checkEarlyExitDeny(
  input: BashToolInput,
  toolPermissionContext: ToolPermissionContext,
): PermissionResult | null {
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    toolPermissionContext,
  )
  if (exactMatchResult.behavior !== 'passthrough') {
    return exactMatchResult
  }
  const denyMatch = matchingRulesForInput(
    input,
    toolPermissionContext,
    'prefix',
  ).matchingDenyRules[0]
  if (denyMatch !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
      decisionReason: { type: 'rule', rule: denyMatch },
    }
  }
  return null
}

/**
 * checkSemantics 路径下的 deny 强制逻辑。
 * 它先调用 checkEarlyExitDeny（exact-match + 整条命令的 prefix deny），
 * 然后再拿每个独立的 SimpleCommand.text 区间去检查 prefix deny 规则。
 * 之所以需要对子命令逐个检查，是因为 filterRulesByContentsMatchingInput
 * 内部存在复合命令保护（splitCommand().length > 1 时 prefix 规则直接返回 false），
 * 否则像 `echo foo | eval rm` 这类整条 pipeline 会让 `Bash(eval:*)` 失效。
 * 每个 SimpleCommand span 自身都是单条命令，因此这层保护不会触发。
 *
 * 之所以单独做成 helper，而不是并进 checkEarlyExitDeny 或直接写在调用处，
 * 是因为 bashToolHasPermission 已经非常贴近 Bun 的 feature() DCE 复杂度阈值；
 * 再多加大约 5 行，就会破坏 feature('BASH_CLASSIFIER') 的求值，并丢掉 pendingClassifierCheck。
 */
function checkSemanticsDeny(
  input: BashToolInput,
  toolPermissionContext: ToolPermissionContext,
  commands: readonly { text: string }[],
): PermissionResult | null {
  const fullCmd = checkEarlyExitDeny(input, toolPermissionContext)
  if (fullCmd !== null) return fullCmd
  for (const cmd of commands) {
    const subDeny = matchingRulesForInput(
      { ...input, command: cmd.text },
      toolPermissionContext,
      'prefix',
    ).matchingDenyRules[0]
    if (subDeny !== undefined) {
      return {
        behavior: 'deny',
        message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
        decisionReason: { type: 'rule', rule: subDeny },
      }
    }
  }
  return null
}

/**
 * 如果 classifier 已启用且存在 allow 描述，则构建 pending classifier check 的元数据。
 * 若 classifier 已禁用、当前处于 auto 模式，或根本没有 allow 描述，则返回 undefined。
 */
function buildPendingClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
): { command: string; cwd: string; descriptions: string[] } | undefined {
  if (!isClassifierPermissionsEnabled()) {
    return undefined
  }
  // 自动模式下直接跳过，因为 auto mode classifier 会接管所有权限判定。
  if (feature('TRANSCRIPT_CLASSIFIER') && toolPermissionContext.mode === 'auto')
    return undefined
  if (toolPermissionContext.mode === 'bypassPermissions') return undefined

  const allowDescriptions = getBashPromptAllowDescriptions(
    toolPermissionContext,
  )
  if (allowDescriptions.length === 0) return undefined

  return {
    command,
    cwd: getCwd(),
    descriptions: allowDescriptions,
  }
}

const speculativeChecks = new Map<string, Promise<ClassifierResult>>()

/**
 * 提前启动一次 speculative 的 bash allow classifier 检查，
 * 让它与 pre-tool hooks、deny/ask classifier 和 permission dialog 初始化并行执行。
 * 结果稍后可以由 executeAsyncClassifierCheck 通过
 * consumeSpeculativeClassifierCheck 消费。
 */
export function peekSpeculativeClassifierCheck(
  command: string,
): Promise<ClassifierResult> | undefined {
  return speculativeChecks.get(command)
}

export function startSpeculativeClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): boolean {
  // 这里沿用与 buildPendingClassifierCheck 相同的前置门控条件。
  if (!isClassifierPermissionsEnabled()) return false
  if (feature('TRANSCRIPT_CLASSIFIER') && toolPermissionContext.mode === 'auto')
    return false
  if (toolPermissionContext.mode === 'bypassPermissions') return false
  const allowDescriptions = getBashPromptAllowDescriptions(
    toolPermissionContext,
  )
  if (allowDescriptions.length === 0) return false

  const cwd = getCwd()
  const promise = classifyBashCommand(
    command,
    cwd,
    allowDescriptions,
    'allow',
    signal,
    isNonInteractiveSession,
  )
  // 防止在该 promise 被消费前，signal 先 abort 时产生未处理的 rejection。
  // 原始 promise 仍会保存在 Map 里，供后续消费者继续 await。
  promise.catch(() => {})
  speculativeChecks.set(command, promise)
  return true
}

/**
 * 消费指定命令对应的 speculative classifier 检查结果。
 * 如果存在，就返回该 promise 并将其从 map 中移除；否则返回 undefined。
 */
export function consumeSpeculativeClassifierCheck(
  command: string,
): Promise<ClassifierResult> | undefined {
  const promise = speculativeChecks.get(command)
  if (promise) {
    speculativeChecks.delete(command)
  }
  return promise
}

export function clearSpeculativeChecks(): void {
  speculativeChecks.clear()
}

/**
 * 等待一条挂起中的 classifier 检查；如果得到高置信度 allow，
 * 就返回对应的 PermissionDecisionReason，否则返回 undefined。
 *
 * swarm agent（无论 tmux 还是 in-process）会用它来做权限转发门控：
 * 先跑 classifier，只有在 classifier 没有自动批准时才向 leader 升级。
 */
export async function awaitClassifierAutoApproval(
  pendingCheck: PendingClassifierCheck,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<PermissionDecisionReason | undefined> {
  const { command, cwd, descriptions } = pendingCheck
  const speculativeResult = consumeSpeculativeClassifierCheck(command)
  const classifierResult = speculativeResult
    ? await speculativeResult
    : await classifyBashCommand(
        command,
        cwd,
        descriptions,
        'allow',
        signal,
        isNonInteractiveSession,
      )

  logClassifierResultForAnts(command, 'allow', descriptions, classifierResult)

  if (
    feature('BASH_CLASSIFIER') &&
    classifierResult.matches &&
    classifierResult.confidence === 'high'
  ) {
    return {
      type: 'classifier',
      classifier: 'bash_allow',
      reason: `Allowed by prompt rule: "${classifierResult.matchedDescription}"`,
    }
  }
  return undefined
}

type AsyncClassifierCheckCallbacks = {
  shouldContinue: () => boolean
  onAllow: (decisionReason: PermissionDecisionReason) => void
  onComplete?: () => void
}

/**
 * 异步执行 bash allow classifier 检查。
 * 当权限弹窗显示时，它会在后台并行运行。
 * 如果 classifier 以高置信度判定为 allow，且用户还没交互，就会自动批准。
 *
 * @param pendingCheck - 来自 bashToolHasPermission 的 classifier 检查元数据
 * @param signal - 中止信号
 * @param isNonInteractiveSession - 是否处于非交互会话
 * @param callbacks - 用于判断是否继续以及处理批准结果的回调
 */
export async function executeAsyncClassifierCheck(
  pendingCheck: { command: string; cwd: string; descriptions: string[] },
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  callbacks: AsyncClassifierCheckCallbacks,
): Promise<void> {
  const { command, cwd, descriptions } = pendingCheck
  const speculativeResult = consumeSpeculativeClassifierCheck(command)

  let classifierResult: ClassifierResult
  try {
    classifierResult = speculativeResult
      ? await speculativeResult
      : await classifyBashCommand(
          command,
          cwd,
          descriptions,
          'allow',
          signal,
          isNonInteractiveSession,
        )
  } catch (error: unknown) {
    // 当 coordinator session 被取消时，中止信号会触发，
    // classifier 的 API 调用会以 APIUserAbortError 被拒绝。这属于预期行为，
    // 不应表现成未处理的 promise 拒绝。
    if (error instanceof APIUserAbortError || error instanceof AbortError) {
      callbacks.onComplete?.()
      return
    }
    callbacks.onComplete?.()
    throw error
  }

  logClassifierResultForAnts(command, 'allow', descriptions, classifierResult)

  // 如果用户已经做出决定，或已经与权限对话框交互过
  // （例如按方向键、Tab、输入内容），就不要再自动批准。
  if (!callbacks.shouldContinue()) return

  if (
    feature('BASH_CLASSIFIER') &&
    classifierResult.matches &&
    classifierResult.confidence === 'high'
  ) {
    callbacks.onAllow({
      type: 'classifier',
      classifier: 'bash_allow',
      reason: `Allowed by prompt rule: "${classifierResult.matchedDescription}"`,
    })
  } else {
    // 未命中任何规则，通知 UI 清掉“正在检查”的指示器。
    callbacks.onComplete?.()
  }
}

/**
 * 核心实现：检查在给定输入下调用 BashTool 是否需要用户授权。
 */
export async function bashToolHasPermission(
  input: BashToolInput,
  context: ToolUseContext,
  getCommandSubcommandPrefixFn = getCommandSubcommandPrefix,
): Promise<PermissionResult> {
  let appState = context.getAppState()

  // 0. 基于 AST 的安全解析。这会同时替代 tryParseShellCommand
  // （即 shell-quote 的预检查）和 bashCommandIsSafe 的误解析门控。
  // tree-sitter 最终只会给出两类结果：
  // 一类是干净的 SimpleCommand[]（引号已解析、无隐藏替换），
  // 另一类是 'too-complex'。这正是我们判断 splitCommand 输出是否可信所需的信号。
  //
  // 如果 tree-sitter WASM 不可用，或者通过 env var 禁用了注入检查，
  // 就回退到旧路径（legacy gate 会在 ~1370 继续执行）。
  const injectionCheckDisabled = isEnvTruthy(
    process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK,
  )
  // GrowthBook 为 shadow mode 提供了熔断开关。
  // 一旦关闭，就彻底跳过原生解析。这个值只计算一次；
  // 下方三元表达式里的 feature() 仍必须保持内联。
  const shadowEnabled = feature('TREE_SITTER_BASH_SHADOW')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_birch_trellis', true)
    : false
  // 这里只解析一次；得到的 AST 会同时供 parseForSecurityFromAst
  // 和 bashToolCheckCommandOperatorPermissions 复用。
  let astRoot = injectionCheckDisabled
    ? null
    : feature('TREE_SITTER_BASH_SHADOW') && !shadowEnabled
      ? null
      : await parseCommandRaw(input.command)
  let astResult: ParseForSecurityResult = astRoot
    ? parseForSecurityFromAst(input.command, astRoot)
    : { kind: 'parse-unavailable' }
  let astSubcommands: string[] | null = null
  let astRedirects: Redirect[] | undefined
  let astCommands: SimpleCommand[] | undefined
  let shadowLegacySubs: string[] | undefined

  // 在 shadow-test 模式下运行 tree-sitter：先记录它的判定结果，
  // 然后强制把结果改成 parse-unavailable，让 legacy 路径继续保持权威来源。
  // parseCommand 仍只受 TREE_SITTER_BASH 控制，而不是 SHADOW，
  // 这样 legacy 内部逻辑就还能保持纯 regex。
  // 每次 bash 调用只记录一条事件，统一包含“分歧”和“不可用原因”；
  // 模块加载失败则另由 session 级的 tengu_tree_sitter_load 事件单独覆盖。
  if (feature('TREE_SITTER_BASH_SHADOW')) {
    const available = astResult.kind !== 'parse-unavailable'
    let tooComplex = false
    let semanticFail = false
    let subsDiffer = false
    if (available) {
      tooComplex = astResult.kind === 'too-complex'
      semanticFail =
        astResult.kind === 'simple' && !checkSemantics(astResult.commands).ok
      const tsSubs =
        astResult.kind === 'simple'
          ? astResult.commands.map(c => c.text)
          : undefined
      const legacySubs = splitCommand(input.command)
      shadowLegacySubs = legacySubs
      subsDiffer =
        tsSubs !== undefined &&
        (tsSubs.length !== legacySubs.length ||
          tsSubs.some((s, i) => s !== legacySubs[i]))
    }
    logEvent('tengu_tree_sitter_shadow', {
      available,
      astTooComplex: tooComplex,
      astSemanticFail: semanticFail,
      subsDiffer,
      injectionCheckDisabled,
      killswitchOff: !shadowEnabled,
      cmdOverLength: input.command.length > 10000,
    })
    // 始终强制走 legacy；shadow mode 只用于观测，不参与实际裁决。
    astResult = { kind: 'parse-unavailable' }
    astRoot = null
  }

  if (astResult.kind === 'too-complex') {
    // 解析虽然成功，但命中了我们无法静态分析的结构
    // （如命令替换、展开、控制流、解析器差异）。
    // 这里先尊重 exact-match 的 deny/ask/allow，再检查 prefix/wildcard deny。
    // 只有在没有 deny 命中时才落回 ask，绝不能把 deny 降级成 ask。
    const earlyExit = checkEarlyExitDeny(input, appState.toolPermissionContext)
    if (earlyExit !== null) return earlyExit
    const decisionReason: PermissionDecisionReason = {
      type: 'other' as const,
      reason: astResult.reason,
    }
    logEvent('tengu_bash_ast_too_complex', {
      nodeTypeId: nodeTypeId(astResult.nodeType),
    })
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      suggestions: [],
      ...(feature('BASH_CLASSIFIER')
        ? {
            pendingClassifierCheck: buildPendingClassifierCheck(
              input.command,
              appState.toolPermissionContext,
            ),
          }
        : {}),
    }
  }

  if (astResult.kind === 'simple') {
    // 解析结果干净时，还要再检查语义层面的风险
    // （例如 zsh builtin、eval 等）。这些东西在分词层面完全正常，
    // 但仅从命令名就已足够危险。
    const sem = checkSemantics(astResult.commands)
    if (!sem.ok) {
      // 这里沿用与 too-complex 路径相同的 deny 强制逻辑：
      // 配了 `Bash(eval:*)` deny 的用户，期望 `eval "rm"` 被直接拦住，
      // 而不是降级成 ask。
      const earlyExit = checkSemanticsDeny(
        input,
        appState.toolPermissionContext,
        astResult.commands,
      )
      if (earlyExit !== null) return earlyExit
      const decisionReason: PermissionDecisionReason = {
        type: 'other' as const,
        reason: sem.reason,
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
        suggestions: [],
      }
    }
    // 把已经分词好的子命令暂存下来供后续流程复用。
    // 下游逻辑（规则匹配、路径提取、cd 检测）目前仍然基于字符串工作，
    // 因此这里保留每个 SimpleCommand 的原始源码区间。
    // 下游处理（stripSafeWrappers、parseCommandArguments）会再次对这些 span 做分词，
    // 而这层二次分词存在已知缺陷（例如 stripCommentLines 会错误处理引号内换行）。
    // 不过 checkSemantics 先前已经拦掉了所有 argv 中包含换行的情况，
    // 因此这些缺陷此时不会真正产生影响。
    // 真正迁移到“下游直接消费 argv”会放到后续提交里处理。
    astSubcommands = astResult.commands.map(c => c.text)
    astRedirects = astResult.commands.flatMap(c => c.redirects)
    astCommands = astResult.commands
  }

  // legacy 的 shell-quote 预检查。只有在 'parse-unavailable' 时才会走到这里
  // （即 tree-sitter 未加载，或 TREE_SITTER_BASH feature 被关闭）。
  // 之后会继续落到完整的 legacy 路径。
  if (astResult.kind === 'parse-unavailable') {
    logForDebugging(
      'bashToolHasPermission: tree-sitter unavailable, using legacy shell-quote path',
    )
    const parseResult = tryParseShellCommand(input.command)
    if (!parseResult.success) {
      const decisionReason = {
        type: 'other' as const,
        reason: `Command contains malformed syntax that cannot be parsed: ${parseResult.error}`,
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  // 检查 sandbox auto-allow（它仍会尊重显式的 deny/ask 规则）。
  // 只有在 sandboxing 与 auto-allow 同时开启时才应调用这里。
  if (
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input)
  ) {
    const sandboxAutoAllowResult = checkSandboxAutoAllow(
      input,
      appState.toolPermissionContext,
    )
    if (sandboxAutoAllowResult.behavior !== 'passthrough') {
      return sandboxAutoAllowResult
    }
  }

  // 先检查 exact match。
  const exactMatchResult = bashToolCheckExactMatchPermission(
    input,
    appState.toolPermissionContext,
  )

  // 如果 exact command 已被拒绝，就直接返回。
  if (exactMatchResult.behavior === 'deny') {
    return exactMatchResult
  }

  // 并行检查 Bash prompt 的拒绝与询问规则（两者都使用 Haiku）。
  // 拒绝优先于询问，而拒绝/询问又都优先于允许规则。
  // 如果当前处于自动模式，就跳过这一步，因为权限判断会完全交给 auto mode classifier。
  if (
    isClassifierPermissionsEnabled() &&
    !(
      feature('TRANSCRIPT_CLASSIFIER') &&
      appState.toolPermissionContext.mode === 'auto'
    )
  ) {
    const denyDescriptions = getBashPromptDenyDescriptions(
      appState.toolPermissionContext,
    )
    const askDescriptions = getBashPromptAskDescriptions(
      appState.toolPermissionContext,
    )
    const hasDeny = denyDescriptions.length > 0
    const hasAsk = askDescriptions.length > 0

    if (hasDeny || hasAsk) {
      const [denyResult, askResult] = await Promise.all([
        hasDeny
          ? classifyBashCommand(
              input.command,
              getCwd(),
              denyDescriptions,
              'deny',
              context.abortController.signal,
              context.options.isNonInteractiveSession,
            )
          : null,
        hasAsk
          ? classifyBashCommand(
              input.command,
              getCwd(),
              askDescriptions,
              'ask',
              context.abortController.signal,
              context.options.isNonInteractiveSession,
            )
          : null,
      ])

      if (context.abortController.signal.aborted) {
        throw new AbortError()
      }

      if (denyResult) {
        logClassifierResultForAnts(
          input.command,
          'deny',
          denyDescriptions,
          denyResult,
        )
      }
      if (askResult) {
        logClassifierResultForAnts(
          input.command,
          'ask',
          askDescriptions,
          askResult,
        )
      }

      // 拒绝结果优先级最高。
      if (denyResult?.matches && denyResult.confidence === 'high') {
        return {
          behavior: 'deny',
          message: `Denied by Bash prompt rule: "${denyResult.matchedDescription}"`,
          decisionReason: {
            type: 'other',
            reason: `Denied by Bash prompt rule: "${denyResult.matchedDescription}"`,
          },
        }
      }

      if (askResult?.matches && askResult.confidence === 'high') {
        // 跳过 Haiku 调用，由 UI 在本地计算 prefix 并允许用户编辑。
        // 但在测试覆盖该函数时，仍然需要调用注入进来的版本。
        let suggestions: PermissionUpdate[]
        if (getCommandSubcommandPrefixFn === getCommandSubcommandPrefix) {
          suggestions = suggestionForExactCommand(input.command)
        } else {
          const commandPrefixResult = await getCommandSubcommandPrefixFn(
            input.command,
            context.abortController.signal,
            context.options.isNonInteractiveSession,
          )
          if (context.abortController.signal.aborted) {
            throw new AbortError()
          }
          suggestions = commandPrefixResult?.commandPrefix
            ? suggestionForPrefix(commandPrefixResult.commandPrefix)
            : suggestionForExactCommand(input.command)
        }
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name),
          decisionReason: {
            type: 'other',
            reason: `Required by Bash prompt rule: "${askResult.matchedDescription}"`,
          },
          suggestions,
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }
    }
  }

  // 检查那些不属于“子命令本体”的 Bash 操作符，比如 `>`、`|` 等。
  // 这一步必须先于危险路径检查执行，
  // 这样带管道的命令才能走 operator 逻辑，并生成“multiple operations”提示信息。
  const commandOperatorResult = await checkCommandOperatorPermissions(
    input,
    (i: BashToolInput) =>
      bashToolHasPermission(i, context, getCommandSubcommandPrefixFn),
    { isNormalizedCdCommand, isNormalizedGitCommand },
    astRoot,
  )
  if (commandOperatorResult.behavior !== 'passthrough') {
    // 安全修复：即便 pipe segment 处理返回了 `allow`，
    // 我们仍然必须验证 ORIGINAL 命令。
    // 因为 pipe segment 逻辑会在检查各段之前先剥掉重定向，
    // 所以像下面这种命令：
    //   示例命令：echo 'x' | xargs printf '%s' >> /tmp/file
    // 会让两个 segment（echo 与 xargs printf）都通过，
    // 但 `>>` 重定向却因此绕过校验。这里必须额外检查：
    // 1. 输出重定向的路径约束
    // 2. 重定向目标里的危险模式（反引号等）是否安全
    if (commandOperatorResult.behavior === 'allow') {
      // 检查原始命令里是否存在危险模式（反引号、$() 等）。
      // 这能捕获类似 `echo x | xargs echo > `pwd`/evil.txt` 的情况，
      // 因为这里的反引号出现在重定向目标里，而 segment 级处理中已经把它剥掉了。
      // 这里还要受 AST 门控：如果 astSubcommands 非空，说明 tree-sitter 已完成结构校验，
      // 这类“重定向目标中的反引号/$()”早就会被判成 too-complex。
      // 这与 ~1481、~1706、~1755 的门控保持一致。
      // 同时也能避免 `find -exec {} \; | grep x` 因 backslash-; 触发误报。
      // bashCommandIsSafe 会跑完整套 legacy regex 电池（约 20 个模式），
      // 因此只有在我们确实会使用它的结果时才调用。
      const safetyResult =
        astSubcommands === null
          ? await bashCommandIsSafeAsync(input.command)
          : null
      if (
        safetyResult !== null &&
        safetyResult.behavior !== 'passthrough' &&
        safetyResult.behavior !== 'allow'
      ) {
        // 挂上 pending classifier check，用户回应前有机会被自动批准。
        appState = context.getAppState()
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(BashTool.name, {
            type: 'other',
            reason:
              safetyResult.message ??
              'Command contains patterns that require approval',
          }),
          decisionReason: {
            type: 'other',
            reason:
              safetyResult.message ??
              'Command contains patterns that require approval',
          },
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }

      appState = context.getAppState()
      // 安全性：compoundCommandHasCd 必须从完整命令重新计算，绝不能硬编码成 false。
      // 之前的 pipe-handling 路径在这里传了 `false`，导致 pathValidation.ts:821 的
      // cd+redirect 检查失效。于是只要把 `| echo done` 追加到
      // `cd .claude && echo x > settings.json` 后面，就会以
      // compoundCommandHasCd=false 走到这条路径，让重定向写入
      // .claude/settings.json 时绕过 cd+redirect 阻断。
      const pathResult = checkPathConstraints(
        input,
        getCwd(),
        appState.toolPermissionContext,
        commandHasAnyCd(input.command),
        astRedirects,
        astCommands,
      )
      if (pathResult.behavior !== 'passthrough') {
        return pathResult
      }
    }

    // 当 pipe segment 返回 `ask`（也就是某些单独 segment 未被规则允许）时，
    // 要挂上 pending classifier check，用户回应前它仍可能自动批准。
    if (commandOperatorResult.behavior === 'ask') {
      appState = context.getAppState()
      return {
        ...commandOperatorResult,
        ...(feature('BASH_CLASSIFIER')
          ? {
              pendingClassifierCheck: buildPendingClassifierCheck(
                input.command,
                appState.toolPermissionContext,
              ),
            }
          : {}),
      }
    }

    return commandOperatorResult
  }

  // 安全性：legacy 的 misparsing gate。只有在 tree-sitter 模块未加载时才会运行。
  // 超时/abort 并不会流到这里，而是会在更早的 too-complex 路径上以 fail-closed 方式处理。
  // 一旦 AST 解析成功，astSubcommands 就会是非空值，并且结构已验证完毕，
  // 此时这整个分支都会被跳过。AST 的 `too-complex` 结果已经覆盖了
  // isBashSecurityCheckForMisparsing 所负责的全部问题；
  // 两者回答的其实都是同一个问题：
  // “在这条输入上，splitCommand 的结果还能不能被信任？”
  if (
    astSubcommands === null &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    const originalCommandSafetyResult = await bashCommandIsSafeAsync(
      input.command,
    )
    if (
      originalCommandSafetyResult.behavior === 'ask' &&
      originalCommandSafetyResult.isBashSecurityCheckForMisparsing
    ) {
      // 带安全 heredoc 模式的复合命令（如 $(cat <<'EOF'...EOF)）
      // 会在未拆分命令上触发 $() 检查。这里要先剥掉这些安全 heredoc，
      // 再检查余下部分；如果还存在其他 misparsing 模式
      // （例如反斜杠转义操作符），它们仍必须继续阻断。
      const remainder = stripSafeHeredocSubstitutions(input.command)
      const remainderResult =
        remainder !== null ? await bashCommandIsSafeAsync(remainder) : null
      if (
        remainder === null ||
        (remainderResult?.behavior === 'ask' &&
          remainderResult.isBashSecurityCheckForMisparsing)
      ) {
        // 如果 exact command 存在显式 allow 权限，就允许通过。
        // 这表示用户曾明确决定放行这条具体命令。
        appState = context.getAppState()
        const exactMatchResult = bashToolCheckExactMatchPermission(
          input,
          appState.toolPermissionContext,
        )
        if (exactMatchResult.behavior === 'allow') {
          return exactMatchResult
        }
        // 挂上 pending classifier check，用户响应前可能会被自动批准。
        const decisionReason: PermissionDecisionReason = {
          type: 'other' as const,
          reason: originalCommandSafetyResult.message,
        }
        return {
          behavior: 'ask',
          message: createPermissionRequestMessage(
            BashTool.name,
            decisionReason,
          ),
          decisionReason,
          suggestions: [], // 不要建议保存一条潜在危险命令。
          ...(feature('BASH_CLASSIFIER')
            ? {
                pendingClassifierCheck: buildPendingClassifierCheck(
                  input.command,
                  appState.toolPermissionContext,
                ),
              }
            : {}),
        }
      }
    }
  }

  // 将命令拆分成子命令。优先使用 AST 提取出的源码 span；
  // 只有在 tree-sitter 不可用时才回退到 splitCommand。
  // 其中的 cd-cwd 过滤器会去掉模型常爱前置的 `cd ${cwd}`。
  const cwd = getCwd()
  const cwdMingw =
    getPlatform() === 'windows' ? windowsPathToPosixPath(cwd) : cwd
  const rawSubcommands =
    astSubcommands ?? shadowLegacySubs ?? splitCommand(input.command)
  const { subcommands, astCommandsByIdx } = filterCdCwdSubcommands(
    rawSubcommands,
    astCommands,
    cwd,
    cwdMingw,
  )

  // CC-643：对子命令 fanout 设置上限。
  // 只有 legacy splitCommand 路径才可能膨胀；AST 路径要么返回有界列表
  // （astSubcommands !== null），要么在碰到无法表示的结构时直接短路成 `too-complex`。
  if (
    astSubcommands === null &&
    subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK
  ) {
    logForDebugging(
      `bashPermissions: ${subcommands.length} subcommands exceeds cap (${MAX_SUBCOMMANDS_FOR_SECURITY_CHECK}) — returning ask`,
      { level: 'debug' },
    )
    const decisionReason = {
      type: 'other' as const,
      reason: `Command splits into ${subcommands.length} subcommands, too many to safety-check individually`,
    }
    return {
      behavior: 'ask',
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
      decisionReason,
    }
  }

  // 如果命令里出现多个 `cd`，则要求审批。
  const cdCommands = subcommands.filter(subCommand =>
    isNormalizedCdCommand(subCommand),
  )
  if (cdCommands.length > 1) {
    const decisionReason = {
      type: 'other' as const,
      reason:
        'Multiple directory changes in one command require approval for clarity',
    }
    return {
      behavior: 'ask',
      decisionReason,
      message: createPermissionRequestMessage(BashTool.name, decisionReason),
    }
  }

  // 记录复合命令里是否包含 cd，供后续安全校验使用。
  // 这能防止通过 `cd .claude/ && mv test.txt settings.json` 之类的方式绕过路径检查。
  const compoundCommandHasCd = cdCommands.length > 0

  // 安全性：必须拦截同时包含 cd 与 git 的复合命令。
  // 这样可以防止通过 `cd /malicious/dir && git status` 逃逸 sandbox，
  // 因为恶意目录里可能藏着带 core.fsmonitor 的 bare git repo。
  // 这个检查必须放在这里（也就是子命令级权限检查之前），
  // 因为 bashToolCheckPermission 会通过 BashTool.isReadOnly()
  // 独立检查每个子命令。那样一来，仅看 `git status` 本身时会重新推导出
  // compoundCommandHasCd=false，进而绕过 readOnlyValidation.ts 的保护。
  if (compoundCommandHasCd) {
    const hasGitCommand = subcommands.some(cmd =>
      isNormalizedGitCommand(cmd.trim()),
    )
    if (hasGitCommand) {
      const decisionReason = {
        type: 'other' as const,
        reason:
          'Compound commands with cd and git require approval to prevent bare repository attacks',
      }
      return {
        behavior: 'ask',
        decisionReason,
        message: createPermissionRequestMessage(BashTool.name, decisionReason),
      }
    }
  }

  appState = context.getAppState() // 重新获取最新状态，以防用户刚刚按过 shift+tab。

  // 安全修复：必须先检查 Bash deny/ask 规则，再检查 path constraint。
  // 这样显式 deny 规则（如 Bash(ls:*)）才能优先于“项目外路径触发 ask”的路径约束结果。
  // 如果顺序反过来，像 ls /home 这样的绝对路径命令就会因为
  // checkPathConstraints 先返回 `ask` 而绕过 deny 规则。
  //
  // 注意：bashToolCheckPermission 内部虽然也会调用 checkPathConstraints，
  // 并对每个子命令执行输出重定向校验，但 splitCommand 在到这里之前已经把重定向剥掉了。
  // 因此这里仍然必须在“检查 deny 规则之后、返回结果之前”对 ORIGINAL 命令再校验一次输出重定向。
  const subcommandPermissionDecisions = subcommands.map((command, i) =>
    bashToolCheckPermission(
      { command },
      appState.toolPermissionContext,
      compoundCommandHasCd,
      astCommandsByIdx[i],
    ),
  )

  // 只要任一子命令被 deny，整条命令就直接 deny。
  const deniedSubresult = subcommandPermissionDecisions.find(
    _ => _.behavior === 'deny',
  )
  if (deniedSubresult !== undefined) {
    return {
      behavior: 'deny',
      message: `Permission to use ${BashTool.name} with command ${input.command} has been denied.`,
      decisionReason: {
        type: 'subcommandResults',
        reasons: new Map(
          subcommandPermissionDecisions.map((result, i) => [
            subcommands[i]!,
            result,
          ]),
        ),
      },
    }
  }

  // 在 ORIGINAL 命令上校验输出重定向（因为 splitCommand 在更早阶段已经把它们剥掉了）。
  // 这一步必须发生在 deny 规则检查之后、结果返回之前。
  // 像 "> /etc/passwd" 这样的输出重定向在 splitCommand 后就看不见了，
  // 所以逐子命令的 checkPathConstraints 不会捕获到它们。这里必须直接对原始输入再校验一次。
  // 安全性：如果 AST 数据可用，就把 AST 派生出的 redirects 直接传给 checkPathConstraints，
  // 避免它再次借助 shell-quote 重新解析。
  // 因为 shell-quote 已知存在“单引号中的反斜杠”误解析缺陷，
  // 可能把 redirect operator 悄悄隐藏掉。
  const pathResult = checkPathConstraints(
    input,
    getCwd(),
    appState.toolPermissionContext,
    compoundCommandHasCd,
    astRedirects,
    astCommands,
  )
  if (pathResult.behavior === 'deny') {
    return pathResult
  }

  const askSubresult = subcommandPermissionDecisions.find(
    _ => _.behavior === 'ask',
  )
  const nonAllowCount = count(
    subcommandPermissionDecisions,
    _ => _.behavior !== 'allow',
  )

  // 安全修复（GH#28784）：只有在没有任何子命令单独产生 `ask` 时，
  // 才能对 path-constraint 的 `ask` 进行短路返回。
  // checkPathConstraints 会在完整输入上重新跑一遍 path-command 循环，
  // 因此 `cd <outside-project> && python3 foo.py` 可能只生成一条
  // Read(<dir>/**) 建议。UI 会把它渲染成“允许读取 <dir>/”，
  // 一旦用户选了它，就会在无感知的情况下顺带批准 python3。
  // 如果某个子命令本身也有 ask（例如 cd 子命令自己的 path-constraint ask），
  // 就应该继续往下走：要么命中下面的 askSubresult 短路（只有一个 non-allow 子命令），
  // 要么在 merge 流程里为每个 non-allow 子命令收集 Bash 规则建议。
  // 该路径上的 cd 目标所需 Read 规则，其实已经由 bashToolCheckPermission 内部
  // 那次逐子命令的 checkPathConstraints 捕获到了。
  //
  // 反过来，如果没有任何子命令发出 ask（要么都 allow，要么都只是 passthrough，
  // 比如 `printf > file`），那么 pathResult 就是唯一的 ask，
  // 应当直接返回它，让重定向检查正常显露出来。
  if (pathResult.behavior === 'ask' && askSubresult === undefined) {
    return pathResult
  }

  // 如果有子命令需要审批（例如边界外的 ls/cd），就在这里 ask。
  // 但只有在“恰好一个子命令需要审批”时才可以直接短路返回；
  // 如果有多个相关子命令（例如 cd-outside-project ask + python3 passthrough），
  // 就必须落到 merge 流程，确保提示里展示的是所有相关 Bash 规则建议，
  // 而不只是第一个 ask 对应的 Read 规则（GH#28784）。
  if (askSubresult !== undefined && nonAllowCount === 1) {
    return {
      ...askSubresult,
      ...(feature('BASH_CLASSIFIER')
        ? {
            pendingClassifierCheck: buildPendingClassifierCheck(
              input.command,
              appState.toolPermissionContext,
            ),
          }
        : {}),
    }
  }

  // 如果 exact command 已被允许，就直接放行。
  if (exactMatchResult.behavior === 'allow') {
    return exactMatchResult
  }

  // 如果所有子命令都通过 exact 或 prefix 规则获得了允许，
  // 那么整条命令也可以放行，但前提是不存在命令注入可能性。
  // 当 AST 解析成功时，每个子命令都已经被证明是安全的
  // （没有隐藏替换，也没有结构性花招），因此逐子命令再检查一次是冗余的。
  // 只有走 legacy 路径时，才需要对每个子命令重新运行 bashCommandIsSafeAsync。
  let hasPossibleCommandInjection = false
  if (
    astSubcommands === null &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK)
  ) {
    // CC-643：把分歧 telemetry 合并成单条 logEvent。
    // 逐子命令单独上报会成为热点路径上的 syscall 驱动源
    // （每次调用都会经由 process.memoryUsage() 读取 /proc/self/stat）。
    // 聚合后的 count 仍然能保留有效信号。
    let divergenceCount = 0
    const onDivergence = () => {
      divergenceCount++
    }
    const results = await Promise.all(
      subcommands.map(c => bashCommandIsSafeAsync(c, onDivergence)),
    )
    hasPossibleCommandInjection = results.some(
      r => r.behavior !== 'passthrough',
    )
    if (divergenceCount > 0) {
      logEvent('tengu_tree_sitter_security_divergence', {
        quoteContextDivergence: true,
        count: divergenceCount,
      })
    }
  }
  if (
    subcommandPermissionDecisions.every(_ => _.behavior === 'allow') &&
    !hasPossibleCommandInjection
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: new Map(
          subcommandPermissionDecisions.map((result, i) => [
            subcommands[i]!,
            result,
          ]),
        ),
      },
    }
  }

  // 向 Haiku 查询命令前缀建议。
  // 默认跳过这次 Haiku 调用，因为 UI 会在本地计算 prefix，
  // 并允许用户自行编辑；但如果测试注入了自定义函数，仍然要调用它。
  let commandSubcommandPrefix: Awaited<
    ReturnType<typeof getCommandSubcommandPrefixFn>
  > = null
  if (getCommandSubcommandPrefixFn !== getCommandSubcommandPrefix) {
    commandSubcommandPrefix = await getCommandSubcommandPrefixFn(
      input.command,
      context.abortController.signal,
      context.options.isNonInteractiveSession,
    )
    if (context.abortController.signal.aborted) {
      throw new AbortError()
    }
  }

  // 如果只有一个命令，就不需要再走多子命令处理流程。
  appState = context.getAppState() // 重新获取最新状态，以防用户刚刚按过 shift+tab。
  if (subcommands.length === 1) {
    const result = await checkCommandAndSuggestRules(
      { command: subcommands[0]! },
      appState.toolPermissionContext,
      commandSubcommandPrefix,
      compoundCommandHasCd,
      astSubcommands !== null,
    )
    // 如果命令尚未被允许，就附加 pending classifier check。
    // 到这里为止，`ask` 只能来自 bashCommandIsSafe
    // （也就是 checkCommandAndSuggestRules 内部的安全检查），
    // 不可能再来自显式 ask 规则，因为它们已经在第 13 步
    // （askSubresult 检查）里被过滤掉了。classifier 可以绕过这层安全检查。
    if (result.behavior === 'ask' || result.behavior === 'passthrough') {
      return {
        ...result,
        ...(feature('BASH_CLASSIFIER')
          ? {
              pendingClassifierCheck: buildPendingClassifierCheck(
                input.command,
                appState.toolPermissionContext,
              ),
            }
          : {}),
      }
    }
    return result
  }

  // 检查各个子命令的权限结果。
  const subcommandResults: Map<string, PermissionResult> = new Map()
  for (const subcommand of subcommands) {
    subcommandResults.set(
      subcommand,
      await checkCommandAndSuggestRules(
        {
          // 透传 `sandbox` 之类的输入参数。
          ...input,
          command: subcommand,
        },
        appState.toolPermissionContext,
        commandSubcommandPrefix?.subcommandPrefixes.get(subcommand),
        compoundCommandHasCd,
        astSubcommands !== null,
      ),
    )
  }

  // 如果所有子命令都已被允许，就整体放行。
  // 注意这和 6b 不同，因为这里额外把命令注入检查结果也纳入了判断。
  if (
    subcommands.every(subcommand => {
      const permissionResult = subcommandResults.get(subcommand)
      return permissionResult?.behavior === 'allow'
    })
  ) {
    // decisionReason 中保留原始 subcommandResults，继续使用 PermissionResult 结构。
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'subcommandResults',
        reasons: subcommandResults,
      },
    }
  }

  // 否则就发起权限请求。
  const collectedRules: Map<string, PermissionRuleValue> = new Map()

  for (const [subcommand, permissionResult] of subcommandResults) {
    if (
      permissionResult.behavior === 'ask' ||
      permissionResult.behavior === 'passthrough'
    ) {
      const updates =
        'suggestions' in permissionResult
          ? permissionResult.suggestions
          : undefined

      const rules = extractRules(updates)
      for (const rule of rules) {
        // 用字符串形式做 key，便于去重。
        const ruleKey = permissionRuleValueToString(rule)
        collectedRules.set(ruleKey, rule)
      }

      // GH#28784 后续修复：安全检查类 ask（如 compound-cd+write、process substitution 等）
      // 本身不携带 suggestions。这样在 `cd ~/out && rm -rf x` 这种复合命令里，
      // 最终可能只收集到 cd 的 Read 规则，UI 也只会显示“允许读取 <dir>/”，
      // 完全不提 rm。这里补造一条 Bash(exact) 规则，确保 UI 能展示整条链式命令。
      // 但显式 ask 规则（decisionReason.type 为 'rule'）例外，
      // 因为那代表用户就是想每次都重新审查。
      if (
        permissionResult.behavior === 'ask' &&
        rules.length === 0 &&
        permissionResult.decisionReason?.type !== 'rule'
      ) {
        for (const rule of extractRules(
          suggestionForExactCommand(subcommand),
        )) {
          const ruleKey = permissionRuleValueToString(rule)
          collectedRules.set(ruleKey, rule)
        }
      }
      // 注意：这里只收集规则，不收集 mode change 一类的其他更新。
      // 对 bash 子命令来说，这样是合理的，因为它们主要需要的是规则建议。
    }
  }

  const decisionReason = {
    type: 'subcommandResults' as const,
    reasons: subcommandResults,
  }

  // GH#11380：把建议规则数量限制在 MAX_SUGGESTED_RULES_FOR_COMPOUND 以内。
  // Map 会保留插入顺序（即子命令顺序），因此 slice 后保留的是最左侧的前 N 条。
  const cappedRules = Array.from(collectedRules.values()).slice(
    0,
    MAX_SUGGESTED_RULES_FOR_COMPOUND,
  )
  const suggestedUpdates: PermissionUpdate[] | undefined =
    cappedRules.length > 0
      ? [
          {
            type: 'addRules',
            rules: cappedRules,
            behavior: 'allow',
            destination: 'localSettings',
          },
        ]
      : undefined

  // 挂上 pending classifier check，用户回应前仍可能被自动批准。
  // 只要任一子命令是 `ask`（例如 path constraint 或 ask rule），
  // 这里的整体行为就应是 `ask`。
  // 在 GH#28784 修复之前，ask subresult 总会在上面短路返回，
  // 所以这条路径过去只会见到 `passthrough` 子命令，并把行为硬编码成那样。
  return {
    behavior: askSubresult !== undefined ? 'ask' : 'passthrough',
    message: createPermissionRequestMessage(BashTool.name, decisionReason),
    decisionReason,
    suggestions: suggestedUpdates,
    ...(feature('BASH_CLASSIFIER')
      ? {
          pendingClassifierCheck: buildPendingClassifierCheck(
            input.command,
            appState.toolPermissionContext,
          ),
        }
      : {}),
  }
}

/**
 * 在去掉安全 wrapper（env var、timeout 等）与 shell 引号后，
 * 检查某个子命令是否为 git 命令。
 *
 * 安全性：匹配前必须先完成归一化，防止被以下形式绕过：
 *   'git' status    — shell 引号会让朴素 regex 看不见真实命令
 *   NO_COLOR=1 git status — env var 前缀会把命令藏起来
 */
export function isNormalizedGitCommand(command: string): boolean {
  // 快速路径：在任何解析之前先拦住最常见情况。
  if (command.startsWith('git ') || command === 'git') {
    return true
  }
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    // 直接的 git 命令。
    if (parsed.tokens[0] === 'git') {
      return true
    }
    // `xargs git ...` 会在当前目录中执行 git，
    // 因此在 cd+git 安全检查里必须把它视为 git 命令。
    // 这与 filterRulesByContentsMatchingInput 中对 xargs 前缀的处理保持一致。
    if (parsed.tokens[0] === 'xargs' && parsed.tokens.includes('git')) {
      return true
    }
    return false
  }
  return /^git(?:\s|$)/.test(stripped)
}

/**
 * 在去掉安全 wrapper（env var、timeout 等）与 shell 引号后，
 * 检查某个子命令是否为 cd 类命令。
 *
 * 安全性：匹配前必须先做归一化，防止出现如下绕过：
 *   FORCE_COLOR=1 cd sub — env var 前缀会让朴素 /^cd / regex 看不见 cd
 *   这里与 isNormalizedGitCommand 保持对称处理。
 *
 * 同时也会匹配 pushd/popd，因为它们和 cd 一样会改变 cwd，
 * 所以 `pushd /tmp/bare-repo && git status`
 * 也必须触发同样的 cd+git 防护。
 * 这与 PowerShell 中的 DIRECTORY_CHANGE_ALIASES
 * （src/utils/powershell/parser.ts）保持一致。
 */
export function isNormalizedCdCommand(command: string): boolean {
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    const cmd = parsed.tokens[0]
    return cmd === 'cd' || cmd === 'pushd' || cmd === 'popd'
  }
  return /^(?:cd|pushd|popd)(?:\s|$)/.test(stripped)
}

/**
 * 检查复合命令中是否包含任何 cd 类命令，
 * 使用的是能处理 env var 前缀与 shell 引号的归一化检测逻辑。
 */
export function commandHasAnyCd(command: string): boolean {
  return splitCommand(command).some(subcmd =>
    isNormalizedCdCommand(subcmd.trim()),
  )
}
