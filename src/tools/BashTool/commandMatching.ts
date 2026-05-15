import {
  parsePermissionRule,
  type ShellPermissionRule,
  matchWildcardPattern as sharedMatchWildcardPattern,
  permissionRuleExtractPrefix as sharedPermissionRuleExtractPrefix,
} from '../../utils/permissions/shellRuleMatching.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'

// Env-var 赋值前缀（VAR=value），供前缀提取辅助逻辑复用。
const ENV_VAR_ASSIGN_RE = /^[A-Za-z_]\w*=/

// 像 `bash:*`、`sh:*` 这样的裸前缀建议会通过 `-c` 放行任意代码。
// `env:*`、`sudo:*` 这类 wrapper 前缀建议也会带来同样问题。
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
  'env',
  'xargs',
  'nice',
  'stdbuf',
  'nohup',
  'timeout',
  'time',
  'sudo',
  'doas',
  'pkexec',
])

/**
 * 可安全从命令中剥离的环境变量白名单。
 * 这些变量不会执行代码，也不会触发动态库加载。
 */
const SAFE_ENV_VARS = new Set([
  'GOEXPERIMENT',
  'GOOS',
  'GOARCH',
  'CGO_ENABLED',
  'GO111MODULE',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'NODE_ENV',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
  'PYTEST_DEBUG',
  'ANTHROPIC_API_KEY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_TIME',
  'CHARSET',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TZ',
  'LS_COLORS',
  'LSCOLORS',
  'GREP_COLOR',
  'GREP_COLORS',
  'GCC_COLORS',
  'TIME_STYLE',
  'BLOCK_SIZE',
  'BLOCKSIZE',
])

/**
 * 仅供 ant 使用、但也可安全从命令中剥离的环境变量。
 */
const ANT_ONLY_SAFE_ENV_VARS = new Set([
  'KUBECONFIG',
  'DOCKER_HOST',
  'AWS_PROFILE',
  'CLOUDSDK_CORE_PROJECT',
  'CLUSTER',
  'COO_CLUSTER',
  'COO_CLUSTER_NAME',
  'COO_NAMESPACE',
  'COO_LAUNCH_YAML_DRY_RUN',
  'SKIP_NODE_VERSION_CHECK',
  'EXPECTTEST_ACCEPT',
  'CI',
  'GIT_LFS_SKIP_SMUDGE',
  'CUDA_VISIBLE_DEVICES',
  'JAX_PLATFORMS',
  'COLUMNS',
  'TMUX',
  'POSTGRESQL_VERSION',
  'FIRESTORE_EMULATOR_HOST',
  'HARNESS_QUIET',
  'TEST_CROSSCHECK_LISTS_MATCH_UPDATE',
  'DBT_PER_DEVELOPER_ENVIRONMENTS',
  'STATSIG_FORD_DB_CHECKS',
  'ANT_ENVIRONMENT',
  'ANT_SERVICE',
  'MONOREPO_ROOT_DIR',
  'PYENV_VERSION',
  'PGPASSWORD',
  'GH_TOKEN',
  'GROWTHBOOK_API_KEY',
])

function isSafeEnvVar(varName: string): boolean {
  const isAntOnlySafe =
    process.env.USER_TYPE === 'ant' && ANT_ONLY_SAFE_ENV_VARS.has(varName)
  return SAFE_ENV_VARS.has(varName) || isAntOnlySafe
}

/**
 * 从原始命令字符串中提取稳定的命令前缀（command + subcommand）。
 */
export function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    if (!isSafeEnvVar(varName)) {
      return null
    }
    i++
  }

  const remaining = tokens.slice(i)
  if (remaining.length < 2) return null
  const subcmd = remaining[1]!
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(subcmd)) return null
  return remaining.slice(0, 2).join(' ')
}

/**
 * 仅供 UI 使用的回退逻辑：当拿不到 2-token 前缀时，只提取第一个单词。
 */
export function getFirstWordPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean)

  let i = 0
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i]!)) {
    const varName = tokens[i]!.split('=')[0]!
    if (!isSafeEnvVar(varName)) {
      return null
    }
    i++
  }

  const cmd = tokens[i]
  if (!cmd) return null
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(cmd)) return null
  if (BARE_SHELL_PREFIXES.has(cmd)) return null
  return cmd
}

/**
 * 从旧版 :* 语法中提取前缀（例如 "npm:*" -> "npm"）。
 */
export const permissionRuleExtractPrefix = sharedPermissionRuleExtractPrefix

/**
 * 用通配模式匹配命令（Bash 中区分大小写）。
 */
export function matchWildcardPattern(
  pattern: string,
  command: string,
): boolean {
  return sharedMatchWildcardPattern(pattern, command)
}

/**
 * 将权限规则解析为结构化规则对象。
 */
export const bashPermissionRule: (
  permissionRule: string,
) => ShellPermissionRule = parsePermissionRule

/**
 * 去掉命令中的整行注释。
 */
function stripCommentLines(command: string): string {
  const lines = command.split('\n')
  const nonCommentLines = lines.filter(line => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  })

  if (nonCommentLines.length === 0) {
    return command
  }

  return nonCommentLines.join('\n')
}

/**
 * 从 Bash 命令中剥离安全的 env-var 前缀和 wrapper command。
 */
export function stripSafeWrappers(command: string): string {
  const SAFE_WRAPPER_PATTERNS = [
    /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
    /^time[ \t]+(?:--[ \t]+)?/,
    /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
    /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
    /^nohup[ \t]+(?:--[ \t]+)?/,
  ] as const

  const ENV_VAR_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/

  let stripped = command
  let previousStripped = ''

  while (stripped !== previousStripped) {
    previousStripped = stripped
    stripped = stripCommentLines(stripped)

    const envVarMatch = stripped.match(ENV_VAR_PATTERN)
    if (envVarMatch) {
      const varName = envVarMatch[1]!
      if (isSafeEnvVar(varName)) {
        stripped = stripped.replace(ENV_VAR_PATTERN, '')
      }
    }
  }

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

/**
 * 会导致执行到不同二进制的环境变量（注入或解析劫持）。
 */
export const BINARY_HIJACK_VARS = /^(LD_|DYLD_|PATH$)/

/**
 * 无论是否在安全名单中，都剥离命令开头的所有 env var 前缀。
 */
export function stripAllLeadingEnvVars(
  command: string,
  blocklist?: RegExp,
): string {
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

/**
 * 在剥离安全 wrapper 后，判断某个子命令是否是 git 命令。
 */
export function isNormalizedGitCommand(command: string): boolean {
  if (command.startsWith('git ') || command === 'git') {
    return true
  }
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    if (parsed.tokens[0] === 'git') {
      return true
    }
    if (parsed.tokens[0] === 'xargs' && parsed.tokens.includes('git')) {
      return true
    }
    return false
  }
  return /^git(?:\s|$)/.test(stripped)
}

/**
 * 在剥离安全 wrapper 后，判断某个子命令是否是 cd 类命令。
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
 * 检查复合命令中是否包含任何 cd 类命令。
 */
export function commandHasAnyCd(command: string): boolean {
  return splitCommand_DEPRECATED(command).some(subcmd =>
    isNormalizedCdCommand(subcmd.trim()),
  )
}