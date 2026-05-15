import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import type { z } from 'zod/v4'
import type { ToolPermissionContext } from '../../Tool.js'
import type { Redirect, SimpleCommand } from '../../utils/bash/ast.js'
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getDirectoryForPath } from '../../utils/path.js'
import { allWorkingDirectories } from '../../utils/permissions/filesystem.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { createReadRuleSuggestion } from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import {
  expandTilde,
  type FileOperationType,
  formatDirectoryList,
  isDangerousRemovalPath,
  validatePath,
} from '../../utils/permissions/pathValidation.js'
import type { BashTool } from './BashTool.js'
import { stripSafeWrappers } from './commandMatching.js'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'

export type PathCommand =
  | 'cd'
  | 'ls'
  | 'find'
  | 'mkdir'
  | 'touch'
  | 'rm'
  | 'rmdir'
  | 'mv'
  | 'cp'
  | 'cat'
  | 'head'
  | 'tail'
  | 'sort'
  | 'uniq'
  | 'wc'
  | 'cut'
  | 'paste'
  | 'column'
  | 'tr'
  | 'file'
  | 'stat'
  | 'diff'
  | 'awk'
  | 'strings'
  | 'hexdump'
  | 'od'
  | 'base64'
  | 'nl'
  | 'grep'
  | 'rg'
  | 'sed'
  | 'git'
  | 'jq'
  | 'sha256sum'
  | 'sha1sum'
  | 'md5sum'

/**
 * 检查 rm/rmdir 命令是否命中了始终需要用户显式批准的危险路径，
 * 即便已经存在 allowlist 规则也不能直接放行。
 * 这可以避免 `rm -rf /` 之类命令带来的灾难性数据丢失。
 */
function checkDangerousRemovalPaths(
  command: 'rm' | 'rmdir',
  args: string[],
  cwd: string,
): PermissionResult {
  // 使用现有的路径提取器提取路径。
  const extractor = PATH_EXTRACTORS[command]
  const paths = extractor(args)

  for (const path of paths) {
    // 展开 tilde，并解析为绝对路径。
    // 注意：这里不会解析符号链接，因为像 /tmp 这样的危险路径即使在 macOS 上
    // 实际是 /private/tmp 的符号链接，也仍然应该被捕获。
    const cleanPath = expandTilde(path.replace(/^['"]|['"]$/g, ''))
    const absolutePath = isAbsolute(cleanPath)
      ? cleanPath
      : resolve(cwd, cleanPath)

    // 检查它是否是危险路径（使用未解析符号链接的原始路径）。
    if (isDangerousRemovalPath(absolutePath)) {
      return {
        behavior: 'ask',
        message: `Dangerous ${command} operation detected: '${absolutePath}'\n\nThis command would remove a critical system directory. This requires explicit approval and cannot be auto-allowed by permission rules.`,
        decisionReason: {
          type: 'other',
          reason: `Dangerous ${command} operation on critical path: ${absolutePath}`,
        },
        // 不提供建议，避免鼓励用户保存这类危险命令。
        suggestions: [],
      }
    }
  }

  // 未发现危险路径。
  return {
    behavior: 'passthrough',
    message: `No dangerous removals detected for ${command} command`,
  }
}

/**
 * 安全性说明：提取位置参数（非 flag），并正确处理 POSIX 的 `--`
 * 选项结束分隔符。
 *
 * 大多数命令（rm、cat、touch 等）在遇到 `--` 后就会停止解析选项，
 * 并把之后的所有参数都当作位置参数处理，即便它们以 `-` 开头。
 * 如果天真地使用 `!arg.startsWith('-')` 过滤，这些参数会被错误丢弃，
 * 从而导致如下攻击载荷悄悄绕过路径校验：
 *
 *   示例命令：rm -- -/../.claude/settings.local.json
 *
 * 这里的 `-/../.claude/settings.local.json` 以 `-` 开头，因此 naive filter
 * 会把它丢掉，校验器看到的路径数为零，结果返回 passthrough，文件就会在
 * 没有提示的情况下被删除。正确处理 `--` 后，这个路径会被提取并校验，
 * 从而被 isClaudeConfigFilePath / pathInAllowedWorkingPath 拦住。
 */
function filterOutFlags(args: string[]): string[] {
  const result: string[] = []
  let afterDoubleDash = false
  for (const arg of args) {
    if (afterDoubleDash) {
      result.push(arg)
    } else if (arg === '--') {
      afterDoubleDash = true
    } else if (!arg?.startsWith('-')) {
      result.push(arg)
    }
  }
  return result
}

// 辅助函数：解析 grep/rg 风格命令（先 pattern，后 paths）。
function parsePatternCommand(
  args: string[],
  flagsWithArgs: Set<string>,
  defaults: string[] = [],
): string[] {
  const paths: string[] = []
  let patternFound = false
  // 安全性说明：追踪 `--` 选项结束分隔符。`--` 之后所有参数都应视为
  // 位置参数，不再关心是否以 `-` 开头。详见 filterOutFlags() 的注释。
  let afterDoubleDash = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined || arg === null) continue

    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true
      continue
    }

    if (!afterDoubleDash && arg.startsWith('-')) {
      const flag = arg.split('=')[0]
      // 这些 pattern flag 说明我们已经定位到了 pattern。
      if (flag && ['-e', '--regexp', '-f', '--file'].includes(flag)) {
        patternFound = true
      }
      // 如果该 flag 需要参数，则跳过下一个参数。
      if (flag && flagsWithArgs.has(flag) && !arg.includes('=')) {
        i++
      }
      continue
    }

    // 第一个非 flag 参数是 pattern，后面的才是路径。
    if (!patternFound) {
      patternFound = true
      continue
    }
    paths.push(arg)
  }

  return paths.length > 0 ? paths : defaults
}

/**
 * 针对不同的路径类命令，从命令参数中提取路径。
 * 每种命令对路径和 flag 的处理方式都不一样，因此这里分别定制逻辑。
 */
export const PATH_EXTRACTORS: Record<
  PathCommand,
  (args: string[]) => string[]
> = {
  // cd：特殊情况，所有参数共同组成一个路径。
  cd: args => (args.length === 0 ? [homedir()] : [args.join(' ')]),

  // ls：过滤掉 flag，默认返回当前目录。
  ls: args => {
    const paths = filterOutFlags(args)
    return paths.length > 0 ? paths : ['.']
  },

  // find：在遇到真正的 flag 前持续收集路径，同时也检查那些会接收路径参数的 flag。
  // 安全性说明：`find -- -path` 会把 `-path` 当成起始搜索路径，而不是 predicate。
  // GNU find 支持 `--`，用来允许以 `-` 开头的搜索根路径。进入 `--` 之后，
  // 我们会保守地把剩余所有参数都当成待校验路径。这样会把 `-name foo` 之类
  // predicate 也一起算进去，但由于 find 是只读操作，而且这些 predicate 最终解析到的
  // 路径仍在 cwd 范围内，因此不会误拦合法用法。这种“过度包含”是为了确保
  // `find -- -/../../etc` 之类攻击路径也能被抓住。
  find: args => {
    const paths: string[] = []
    const pathFlags = new Set([
      '-newer',
      '-anewer',
      '-cnewer',
      '-mnewer',
      '-samefile',
      '-path',
      '-wholename',
      '-ilname',
      '-lname',
      '-ipath',
      '-iwholename',
    ])
    const newerPattern = /^-newer[acmBt][acmtB]$/
    let foundNonGlobalFlag = false
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (!arg) continue

      if (afterDoubleDash) {
        paths.push(arg)
        continue
      }

      if (arg === '--') {
        afterDoubleDash = true
        continue
      }

      // 处理 flag。
      if (arg.startsWith('-')) {
        // 全局选项不会中断路径收集。
        if (['-H', '-L', '-P'].includes(arg)) continue

        // 标记已经见到了非全局 flag。
        foundNonGlobalFlag = true

        // 检查这个 flag 是否会接收路径参数。
        if (pathFlags.has(arg) || newerPattern.test(arg)) {
          const nextArg = args[i + 1]
          if (nextArg) {
            paths.push(nextArg)
            i++ // 跳过刚刚已经处理过的路径参数。
          }
        }
        continue
      }

      // 只在遇到第一个非全局 flag 之前收集非 flag 参数。
      if (!foundNonGlobalFlag) {
        paths.push(arg)
      }
    }
    return paths.length > 0 ? paths : ['.']
  },

  // 对所有简单命令：直接过滤掉 flag。
  mkdir: filterOutFlags,
  touch: filterOutFlags,
  rm: filterOutFlags,
  rmdir: filterOutFlags,
  mv: filterOutFlags,
  cp: filterOutFlags,
  cat: filterOutFlags,
  head: filterOutFlags,
  tail: filterOutFlags,
  sort: filterOutFlags,
  uniq: filterOutFlags,
  wc: filterOutFlags,
  cut: filterOutFlags,
  paste: filterOutFlags,
  column: filterOutFlags,
  file: filterOutFlags,
  stat: filterOutFlags,
  diff: filterOutFlags,
  awk: filterOutFlags,
  strings: filterOutFlags,
  hexdump: filterOutFlags,
  od: filterOutFlags,
  base64: filterOutFlags,
  nl: filterOutFlags,
  sha256sum: filterOutFlags,
  sha1sum: filterOutFlags,
  md5sum: filterOutFlags,

  // tr：特殊情况，需要跳过字符集参数。
  tr: args => {
    const hasDelete = args.some(
      a =>
        a === '-d' ||
        a === '--delete' ||
        (a.startsWith('-') && a.includes('d')),
    )
    const nonFlags = filterOutFlags(args)
    return nonFlags.slice(hasDelete ? 1 : 2) // 跳过 SET1，或同时跳过 SET1+SET2。
  },

  // grep：先 pattern，后 paths；若没有路径则默认读 stdin。
  grep: args => {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '--exclude',
      '--include',
      '--exclude-dir',
      '--include-dir',
      '-m',
      '--max-count',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    const paths = parsePatternCommand(args, flags)
    // 特殊情况：如果存在 -r/-R flag 且未提供路径，则使用当前目录。
    if (
      paths.length === 0 &&
      args.some(a => ['-r', '-R', '--recursive'].includes(a))
    ) {
      return ['.']
    }
    return paths
  },

  // rg：先 pattern，后 paths；若未提供路径则默认使用当前目录。
  rg: args => {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '-t',
      '--type',
      '-T',
      '--type-not',
      '-g',
      '--glob',
      '-m',
      '--max-count',
      '--max-depth',
      '-r',
      '--replace',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    return parsePatternCommand(args, flags, ['.'])
  },

  // sed：要么原地处理文件，要么从 stdin 读取。
  sed: args => {
    const paths: string[] = []
    let skipNext = false
    let scriptFound = false
    // 安全性：追踪 `--` 这个选项结束分隔符。`--` 之后的所有参数都应视为
    // 位置参数，不再关心是否以 `-` 开头。详见 filterOutFlags() 的文档注释。
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      if (skipNext) {
        skipNext = false
        continue
      }

      const arg = args[i]
      if (!arg) continue

      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true
        continue
      }

      // 处理 flag（仅在 `--` 之前）。
      if (!afterDoubleDash && arg.startsWith('-')) {
        // -f flag：下一个参数是需要校验的脚本文件。
        if (['-f', '--file'].includes(arg)) {
          const scriptFile = args[i + 1]
          if (scriptFile) {
            paths.push(scriptFile) // 把脚本文件加入待校验路径列表。
            skipNext = true
          }
          scriptFound = true
        }
        // -e flag：下一个参数是表达式，不是文件。
        else if (['-e', '--expression'].includes(arg)) {
          skipNext = true
          scriptFound = true
        }
        // 组合 flag，例如 -ie 或 -nf。
        else if (arg.includes('e') || arg.includes('f')) {
          scriptFound = true
        }
        continue
      }

      // 第一个非 flag 参数就是脚本本体（前提是还没通过 -e/-f 找到）。
      if (!scriptFound) {
        scriptFound = true
        continue
      }

      // 剩余参数都是文件路径。
      paths.push(arg)
    }

    return paths
  },

  // jq：先 filter，后 file paths（与 grep 类似）。
  // jq 的命令结构是：jq [flags] filter [files...]
  // 如果未提供文件，jq 就会从 stdin 读取。
  jq: args => {
    const paths: string[] = []
    const flagsWithArgs = new Set([
      '-e',
      '--expression',
      '-f',
      '--from-file',
      '--arg',
      '--argjson',
      '--slurpfile',
      '--rawfile',
      '--args',
      '--jsonargs',
      '-L',
      '--library-path',
      '--indent',
      '--tab',
    ])
    let filterFound = false
    // 安全性：追踪 `--` 这个选项结束分隔符。`--` 之后的所有参数都应视为
    // 位置参数，不再关心是否以 `-` 开头。详见 filterOutFlags() 的文档注释。
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === undefined || arg === null) continue

      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true
        continue
      }

      if (!afterDoubleDash && arg.startsWith('-')) {
        const flag = arg.split('=')[0]
        // 这些 pattern flag 表示我们已经定位到了 filter。
        if (flag && ['-e', '--expression'].includes(flag)) {
          filterFound = true
        }
        // 如果这个 flag 需要参数，就跳过下一个参数。
        if (flag && flagsWithArgs.has(flag) && !arg.includes('=')) {
          i++
        }
        continue
      }

      // 第一个非 flag 参数是 filter，后面的才是文件路径。
      if (!filterFound) {
        filterFound = true
        continue
      }
      paths.push(arg)
    }

    // 如果没有文件路径，jq 就从 stdin 读取（因此没有路径需要校验）。
    return paths
  },

  // git：处理那些会访问仓库外任意文件的子命令。
  git: args => {
    // git diff --no-index 是特殊情况，它会显式比较 git 控制范围之外的文件。
    // 这个 flag 允许 git diff 比较文件系统上的任意两个文件，
    // 而不仅仅是仓库内文件，因此必须做路径校验。
    if (args.length >= 1 && args[0] === 'diff') {
      if (args.includes('--no-index')) {
        // 安全性：git diff --no-index 允许在文件路径前使用 `--`。
        // 这里必须使用能正确处理 `--` 的 filterOutFlags，
        // 不能天真地只按 startsWith('-') 过滤，
        // 否则会漏掉 `-/../etc/passwd` 这类路径。
        const filePaths = filterOutFlags(args.slice(1))
        return filePaths.slice(0, 2) // git diff --no-index 只期望恰好 2 个路径。
      }
    }
    // 其他 git 命令（add、rm、mv、show 等）都运行在仓库上下文内，
    // 并且已经受到 git 自身安全模型的约束，因此不需要额外的路径校验。
    return []
  },
}

const SUPPORTED_PATH_COMMANDS = Object.keys(PATH_EXTRACTORS) as PathCommand[]

const ACTION_VERBS: Record<PathCommand, string> = {
  cd: 'change directories to',
  ls: 'list files in',
  find: 'search files in',
  mkdir: 'create directories in',
  touch: 'create or modify files in',
  rm: 'remove files from',
  rmdir: 'remove directories from',
  mv: 'move files to/from',
  cp: 'copy files to/from',
  cat: 'concatenate files from',
  head: 'read the beginning of files from',
  tail: 'read the end of files from',
  sort: 'sort contents of files from',
  uniq: 'filter duplicate lines from files in',
  wc: 'count lines/words/bytes in files from',
  cut: 'extract columns from files in',
  paste: 'merge files from',
  column: 'format files from',
  tr: 'transform text from files in',
  file: 'examine file types in',
  stat: 'read file stats from',
  diff: 'compare files from',
  awk: 'process text from files in',
  strings: 'extract strings from files in',
  hexdump: 'display hex dump of files from',
  od: 'display octal dump of files from',
  base64: 'encode/decode files from',
  nl: 'number lines in files from',
  grep: 'search for patterns in files from',
  rg: 'search for patterns in files from',
  sed: 'edit files in',
  git: 'access files with git from',
  jq: 'process JSON from files in',
  sha256sum: 'compute SHA-256 checksums for files in',
  sha1sum: 'compute SHA-1 checksums for files in',
  md5sum: 'compute MD5 checksums for files in',
}

export const COMMAND_OPERATION_TYPE: Record<PathCommand, FileOperationType> = {
  cd: 'read',
  ls: 'read',
  find: 'read',
  mkdir: 'create',
  touch: 'create',
  rm: 'write',
  rmdir: 'write',
  mv: 'write',
  cp: 'write',
  cat: 'read',
  head: 'read',
  tail: 'read',
  sort: 'read',
  uniq: 'read',
  wc: 'read',
  cut: 'read',
  paste: 'read',
  column: 'read',
  tr: 'read',
  file: 'read',
  stat: 'read',
  diff: 'read',
  awk: 'read',
  strings: 'read',
  hexdump: 'read',
  od: 'read',
  base64: 'read',
  nl: 'read',
  grep: 'read',
  rg: 'read',
  sed: 'write',
  git: 'read',
  jq: 'read',
  sha256sum: 'read',
  sha1sum: 'read',
  md5sum: 'read',
}

/**
 * 在路径校验之前运行的命令专用校验器。
 * 返回 true 表示命令有效，返回 false 表示应被拒绝。
 * 主要用于拦截那些可能绕过路径校验的 flag 形式命令。
 */
const COMMAND_VALIDATOR: Partial<
  Record<PathCommand, (args: string[]) => boolean>
> = {
  mv: (args: string[]) => !args.some(arg => arg?.startsWith('-')),
  cp: (args: string[]) => !args.some(arg => arg?.startsWith('-')),
}

function validateCommandPaths(
  command: PathCommand,
  args: string[],
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  operationTypeOverride?: FileOperationType,
): PermissionResult {
  const extractor = PATH_EXTRACTORS[command]
  const paths = extractor(args)
  const operationType = operationTypeOverride ?? COMMAND_OPERATION_TYPE[command]

  // 安全性：先运行命令专用校验器（例如拦截可绕过路径校验的 flag）。
  // 某些命令如 mv/cp 带有像 --target-directory=PATH 这样的 flag，
  // 会绕过路径提取逻辑，因此这里对这类命令的所有 flag 一律要求人工确认。
  const validator = COMMAND_VALIDATOR[command]
  if (validator && !validator(args)) {
    return {
      behavior: 'ask',
      message: `${command} with flags requires manual approval to ensure path safety. For security, Claude Code cannot automatically validate ${command} commands that use flags, as some flags like --target-directory=PATH can bypass path validation.`,
      decisionReason: {
        type: 'other',
        reason: `${command} command with flags requires manual approval`,
      },
    }
  }

  // 安全性：拦截那些同时包含 `cd` 且执行写操作的复合命令。
  // 这样可以防止“先切目录再写文件”的方式绕过路径安全检查。
  // 示例攻击：cd .claude/ && mv test.txt settings.json
  // 之所以能绕过，是因为路径会按原始 CWD 解析，而不会计入 `cd` 的实际影响。
  //
  // 另一种思路是跟踪整条命令链中的有效 CWD
  // （例如在执行完 `cd .claude/` 之后，后续命令都按 CWD=".claude/" 校验）。
  // 这种方式更宽松，但必须非常小心地处理：
  // - 相对路径（cd ../foo）
  // - 特殊 cd 目标（cd ~、cd -、无参数的 cd）
  // - 连续多个 cd 命令
  // - 无法可靠确定 cd 目标的异常情况
  // 目前先采用更保守的做法：统一要求人工批准。
  if (compoundCommandHasCd && operationType !== 'read') {
    return {
      behavior: 'ask',
      message: `Commands that change directories and perform write operations require explicit approval to ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine the final working directory when 'cd' is used in compound commands.`,
      decisionReason: {
        type: 'other',
        reason:
          'Compound command contains cd with write operation - manual approval required to prevent path resolution bypass',
      },
    }
  }

  for (const path of paths) {
    const { allowed, resolvedPath, decisionReason } = validatePath(
      path,
      cwd,
      toolPermissionContext,
      operationType,
    )

    if (!allowed) {
      const workingDirs = Array.from(
        allWorkingDirectories(toolPermissionContext),
      )
      const dirListStr = formatDirectoryList(workingDirs)

      // 如果安全检查已经给出了自定义原因（type: 'other' 或 'safetyCheck'），
      // 就优先使用它；否则退回到标准的 “was blocked” 提示。
      const message =
        decisionReason?.type === 'other' ||
        decisionReason?.type === 'safetyCheck'
          ? decisionReason.reason
          : `${command} in '${resolvedPath}' was blocked. For security, Claude Code may only ${ACTION_VERBS[command]} the allowed working directories for this session: ${dirListStr}.`

      if (decisionReason?.type === 'rule') {
        return {
          behavior: 'deny',
          message,
          decisionReason,
        }
      }

      return {
        behavior: 'ask',
        message,
        blockedPath: resolvedPath,
        decisionReason,
      }
    }
  }

  // 所有路径都合法，返回 passthrough。
  return {
    behavior: 'passthrough',
    message: `Path validation passed for ${command} command`,
  }
}

export function createPathChecker(
  command: PathCommand,
  operationTypeOverride?: FileOperationType,
) {
  return (
    args: string[],
    cwd: string,
    context: ToolPermissionContext,
    compoundCommandHasCd?: boolean,
  ): PermissionResult => {
    // 先做常规路径校验（其中已经包含显式 deny 规则）。
    const result = validateCommandPaths(
      command,
      args,
      cwd,
      context,
      compoundCommandHasCd,
      operationTypeOverride,
    )

    // 如果是显式 deny，就直接尊重该结果，不要再被危险路径提示覆盖。
    if (result.behavior === 'deny') {
      return result
    }

    // 在显式 deny 规则之后、其他结果之前，再检查危险删除路径。
    // 这样即便用户有 allowlist 规则，或者 glob 模式已被拒绝，
    // 这层检查仍然会执行；同时又不会覆盖显式 deny 规则。
    // 对危险模式要返回更具体的报错信息，优先于通用的 glob 拒绝消息。
    if (command === 'rm' || command === 'rmdir') {
      const dangerousPathResult = checkDangerousRemovalPaths(command, args, cwd)
      if (dangerousPathResult.behavior !== 'passthrough') {
        return dangerousPathResult
      }
    }

    // 如果结果是 passthrough，就直接返回。
    if (result.behavior === 'passthrough') {
      return result
    }

    // 如果结果是 ask，就根据操作类型补充建议项。
    if (result.behavior === 'ask') {
      const operationType =
        operationTypeOverride ?? COMMAND_OPERATION_TYPE[command]
      const suggestions: PermissionUpdate[] = []

      // 只有在确实存在被拦截路径时，才建议补目录或规则。
      if (result.blockedPath) {
        if (operationType === 'read') {
          // 对读取操作，建议为目录添加 Read 规则（前提是目录存在）。
          const dirPath = getDirectoryForPath(result.blockedPath)
          const suggestion = createReadRuleSuggestion(dirPath, 'session')
          if (suggestion) {
            suggestions.push(suggestion)
          }
        } else {
          // 对写入/创建操作，建议直接添加该目录。
          suggestions.push({
            type: 'addDirectories',
            directories: [getDirectoryForPath(result.blockedPath)],
            destination: 'session',
          })
        }
      }

      // 对写入操作，再额外建议开启 accept-edits 模式。
      if (operationType === 'write' || operationType === 'create') {
        suggestions.push({
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        })
      }

      result.suggestions = suggestions
    }

    // 最后直接返回这个决策结果。
    return result
  }
}

/**
 * 使用 shell-quote 解析命令参数，并把 glob 对象转换成字符串。
 * 这样做是因为 shell-quote 会把像 *.txt 这样的模式解析成 glob 对象，
 * 但路径校验阶段需要的其实是字符串形式。
 */
function parseCommandArguments(cmd: string): string[] {
  const parseResult = tryParseShellCommand(cmd, env => `$${env}`)
  if (!parseResult.success) {
    // shell 语法损坏时，返回空数组。
    return []
  }
  const parsed = parseResult.tokens
  const extractedArgs: string[] = []

  for (const arg of parsed) {
    if (typeof arg === 'string') {
      // 保留空字符串，因为它们也是合法参数（例如 grep "" /tmp/t）。
      extractedArgs.push(arg)
    } else if (
      typeof arg === 'object' &&
      arg !== null &&
      'op' in arg &&
      arg.op === 'glob' &&
      'pattern' in arg
    ) {
      // shell-quote 会把 glob 模式解析成对象，但校验时我们需要字符串。
      extractedArgs.push(String(arg.pattern))
    }
  }

  return extractedArgs
}

/**
 * 校验单条命令的路径约束与 shell 安全性。
 *
 * 该函数会：
 * 1. 解析命令参数
 * 2. 检查它是否属于路径类命令（cd、ls、find 等）
 * 3. 校验 shell 注入相关模式
 * 4. 校验所有路径是否都位于允许目录中
 *
 * @param cmd - 待校验的命令字符串
 * @param cwd - 当前工作目录
 * @param toolPermissionContext - 包含允许目录信息的上下文
 * @param compoundCommandHasCd - 完整复合命令中是否包含 cd
 * @returns PermissionResult - 若不是路径类命令则返回 'passthrough'，否则返回校验结果
 */
function validateSinglePathCommand(
  cmd: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  // 安全性：在提取基础命令前，先剥离包装命令（timeout、nice、nohup、time）。
  // 否则，被这些工具包裹起来的危险命令会绕过路径校验，
  // 因为系统检查到的会是包装命令（如 `timeout`），而不是真实命令（如 `rm`）。
  // 例如 `timeout 10 rm -rf /` 若不处理，就只会把 `timeout` 识别成基础命令。
  const strippedCmd = stripSafeWrappers(cmd)

  // 把命令解析成参数，同时处理引号与 glob。
  const extractedArgs = parseCommandArguments(strippedCmd)
  if (extractedArgs.length === 0) {
    return {
      behavior: 'passthrough',
      message: 'Empty command - no paths to validate',
    }
  }

  // 检查这是否是我们需要校验的路径类命令。
  const [baseCmd, ...args] = extractedArgs
  if (!baseCmd || !SUPPORTED_PATH_COMMANDS.includes(baseCmd as PathCommand)) {
    return {
      behavior: 'passthrough',
      message: `Command '${baseCmd}' is not a path-restricted command`,
    }
  }

  // 对只读型的 sed 命令（例如 sed -n '1,10p' file.txt），
  // 应按读取操作而不是写入操作来校验文件路径。
  // sed 在路径校验中默认被视为 `write`，但如果命令纯粹是在读
  // （例如配合 -n 做行输出），那么这些文件参数其实是只读的。
  const operationTypeOverride =
    baseCmd === 'sed' && sedCommandIsAllowedByAllowlist(strippedCmd)
      ? ('read' as FileOperationType)
      : undefined

  // 校验所有路径都位于允许目录之内。
  const pathChecker = createPathChecker(
    baseCmd as PathCommand,
    operationTypeOverride,
  )
  return pathChecker(args, cwd, toolPermissionContext, compoundCommandHasCd)
}

/**
 * 与 validateSinglePathCommand 类似，但直接操作 AST 派生出的 argv，
 * 而不是再用 shell-quote 重新解析命令字符串。
 * 这样可以避开 shell-quote 在“单引号 + 反斜杠”场景下的 bug，
 * 否则 parseCommandArguments 可能会悄悄返回 []，进而跳过路径校验。
 */
function validateSinglePathCommandArgv(
  cmd: SimpleCommand,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  const argv = stripWrappersFromArgv(cmd.argv)
  if (argv.length === 0) {
    return {
      behavior: 'passthrough',
      message: 'Empty command - no paths to validate',
    }
  }
  const [baseCmd, ...args] = argv
  if (!baseCmd || !SUPPORTED_PATH_COMMANDS.includes(baseCmd as PathCommand)) {
    return {
      behavior: 'passthrough',
      message: `Command '${baseCmd}' is not a path-restricted command`,
    }
  }
  // sed 的只读覆盖逻辑：allowlist 检查必须使用 .text，
  // 因为 sedCommandIsAllowedByAllowlist 接收的是字符串。
  // argv 虽然已经剥过包装命令，但 .text 仍是原始 tree-sitter span
  // （例如还包含 `timeout 5 ` 这样的前缀），因此这里也要再剥一次。
  const operationTypeOverride =
    baseCmd === 'sed' &&
    sedCommandIsAllowedByAllowlist(stripSafeWrappers(cmd.text))
      ? ('read' as FileOperationType)
      : undefined
  const pathChecker = createPathChecker(
    baseCmd as PathCommand,
    operationTypeOverride,
  )
  return pathChecker(args, cwd, toolPermissionContext, compoundCommandHasCd)
}

function validateOutputRedirections(
  redirections: Array<{ target: string; operator: '>' | '>>' }>,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  // 安全性：拦截那些同时包含 `cd` 与输出重定向的复合命令。
  // 这样可以防止“先切目录再重定向写入”的方式绕过路径安全检查。
  // 示例攻击：cd .claude/ && echo "malicious" > settings.json
  // 因为重定向目标会按原始 CWD 校验，但真实写入发生在 `cd` 生效后的新目录里。
  if (compoundCommandHasCd && redirections.length > 0) {
    return {
      behavior: 'ask',
      message: `Commands that change directories and write via output redirection require explicit approval to ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine the final working directory when 'cd' is used in compound commands.`,
      decisionReason: {
        type: 'other',
        reason:
          'Compound command contains cd with output redirection - manual approval required to prevent path resolution bypass',
      },
    }
  }
  for (const { target } of redirections) {
    // /dev/null 永远安全，因为它只会丢弃输出。
    if (target === '/dev/null') {
      continue
    }
    const { allowed, resolvedPath, decisionReason } = validatePath(
      target,
      cwd,
      toolPermissionContext,
      'create', // 把 > 与 >> 都视为 create 操作。
    )

    if (!allowed) {
      const workingDirs = Array.from(
        allWorkingDirectories(toolPermissionContext),
      )
      const dirListStr = formatDirectoryList(workingDirs)

      // 如果安全检查给出了自定义原因（type: 'other' 或 'safetyCheck'），
      // 就优先使用它；否则使用 deny 规则或工作目录限制的标准提示。
      const message =
        decisionReason?.type === 'other' ||
        decisionReason?.type === 'safetyCheck'
          ? decisionReason.reason
          : decisionReason?.type === 'rule'
            ? `Output redirection to '${resolvedPath}' was blocked by a deny rule.`
            : `Output redirection to '${resolvedPath}' was blocked. For security, Claude Code may only write to files in the allowed working directories for this session: ${dirListStr}.`

      // 如果是 deny 规则导致的拒绝，就返回 `deny` 行为。
      if (decisionReason?.type === 'rule') {
        return {
          behavior: 'deny',
          message,
          decisionReason,
        }
      }

      return {
        behavior: 'ask',
        message,
        blockedPath: resolvedPath,
        decisionReason,
        suggestions: [
          {
            type: 'addDirectories',
            directories: [getDirectoryForPath(resolvedPath)],
            destination: 'session',
          },
        ],
      }
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No unsafe redirections found',
  }
}

/**
 * 检查会访问文件系统的命令（如 cd、ls、find）的路径约束。
 * 同时也会校验输出重定向，确保目标位于允许目录之内。
 *
 * @returns
 * - 'ask' if any path command or redirection tries to access outside allowed directories
 * - 'passthrough' if no path commands were found or if all are within allowed directories
 */
export function checkPathConstraints(
  input: z.infer<typeof BashTool.inputSchema>,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  astRedirects?: Redirect[],
  astCommands?: SimpleCommand[],
): PermissionResult {
  // 安全性：process substitution（>(cmd)）可以执行会写文件的命令，
  // 但这些文件不会以重定向目标的形式显式出现。例如：
  //   示例命令：echo secret > >(tee .git/config)
  // 这里 tee 会写入 .git/config，但它不会被识别成普通重定向目标。
  // 因此只要命令里出现 process substitution，就必须要求显式批准。
  // 如果走的是 AST 路径则跳过，因为 process_substitution 已包含在
  // DANGEROUS_TYPES 中，并且会在更早阶段直接返回 too-complex。
  if (!astCommands && />>\s*>\s*\(|>\s*>\s*\(|<\s*\(/.test(input.command)) {
    return {
      behavior: 'ask',
      message:
        'Process substitution (>(...) or <(...)) can execute arbitrary commands and requires manual approval',
      decisionReason: {
        type: 'other',
        reason: 'Process substitution requires manual approval',
      },
    }
  }

  // 安全性：一旦 AST 派生出的 redirects 可用，就直接使用它们，
  // 不要再回退到 shell-quote 重新解析。shell-quote 已知存在
  // “单引号 + 反斜杠”误解析 bug，会在解析成功的情况下悄悄把
  // redirect operator 合并进损坏 token 中；这不是 parse failure，
  // 因此 fail-closed 守卫也帮不上忙。AST 已经正确解析了目标，
  // 且 checkSemantics 也已完成验证。
  const { redirections, hasDangerousRedirection } = astRedirects
    ? astRedirectsToOutputRedirections(astRedirects)
    : extractOutputRedirections(input.command)

  // 安全性：如果发现某个重定向目标包含 shell 展开语法
  // （如 $VAR 或 %VAR%），就要求人工批准，因为这种目标无法被安全校验。
  if (hasDangerousRedirection) {
    return {
      behavior: 'ask',
      message: 'Shell expansion syntax in paths requires manual approval',
      decisionReason: {
        type: 'other',
        reason: 'Shell expansion syntax in paths requires manual approval',
      },
    }
  }
  const redirectionResult = validateOutputRedirections(
    redirections,
    cwd,
    toolPermissionContext,
    compoundCommandHasCd,
  )
  if (redirectionResult.behavior !== 'passthrough') {
    return redirectionResult
  }

  // 安全性：如果 AST 派生出的命令已可用，就直接遍历这些预解析 argv，
  // 不要再通过 splitCommand_DEPRECATED + shell-quote 重新解析。
  // shell-quote 的“单引号 + 反斜杠” bug 会让 parseCommandArguments
  // 悄悄返回 []，从而跳过路径校验（包括 isDangerousRemovalPath 等检查）。
  // 而 AST 已经正确解析出了 argv。
  if (astCommands) {
    for (const cmd of astCommands) {
      const result = validateSinglePathCommandArgv(
        cmd,
        cwd,
        toolPermissionContext,
        compoundCommandHasCd,
      )
      if (result.behavior === 'ask' || result.behavior === 'deny') {
        return result
      }
    }
  } else {
    const commands = splitCommand_DEPRECATED(input.command)
    for (const cmd of commands) {
      const result = validateSinglePathCommand(
        cmd,
        cwd,
        toolPermissionContext,
        compoundCommandHasCd,
      )
      if (result.behavior === 'ask' || result.behavior === 'deny') {
        return result
      }
    }
  }

  // 始终返回 passthrough，让其他权限检查继续处理这条命令。
  return {
    behavior: 'passthrough',
    message: 'All path commands validated successfully',
  }
}

/**
 * 把 AST 派生出的 Redirect[] 转换成 validateOutputRedirections
 * 所期望的格式。这里只保留输出型重定向（排除 2>&1 这类 fd duplication），
 * 并把操作符统一映射成 '>' 或 '>>'。
 */
function astRedirectsToOutputRedirections(redirects: Redirect[]): {
  redirections: Array<{ target: string; operator: '>' | '>>' }>
  hasDangerousRedirection: boolean
} {
  const redirections: Array<{ target: string; operator: '>' | '>>' }> = []
  for (const r of redirects) {
    switch (r.op) {
      case '>':
      case '>|':
      case '&>':
        redirections.push({ target: r.target, operator: '>' })
        break
      case '>>':
      case '&>>':
        redirections.push({ target: r.target, operator: '>>' })
        break
      case '>&':
        // >&N（纯数字）表示 fd duplication（如 2>&1、>&10），并不是文件写入。
        // 而 >&file 是已弃用的 &>file 旧写法，仍表示把输出重定向到文件。
        if (!/^\d+$/.test(r.target)) {
          redirections.push({ target: r.target, operator: '>' })
        }
        break
      case '<':
      case '<<':
      case '<&':
      case '<<<':
        // 输入重定向，直接跳过。
        break
    }
  }
  // AST 目标都已完全解析（不存在 shell 展开），而且 checkSemantics
  // 已经验证过它们，因此这里不存在危险重定向。
  return { redirections, hasDangerousRedirection: false }
}

// ───────────────────────────────────────────────────────────────────────────
// argv 级的安全包装命令剥离（timeout、nice、stdbuf、env、time、nohup）
//
// 这里是“规范版本”的 stripWrappersFromArgv。bashPermissions.ts 里仍然导出着一份
// 更旧、更窄的拷贝（只覆盖 timeout / nice -n N），那份代码虽然在生产里是 DEAD CODE，
// 没有实际 consumer，但现在还不能删：bashPermissions.ts 已经逼近 Bun 的
// feature() DCE 复杂度阈值，从那个模块里删除约 80 行代码，就会悄悄破坏
// feature('BASH_CLASSIFIER') 的求值结果（把所有 pendingClassifierCheck spread 都裁掉）。
// 这一点已在 PR #21503 第 3 轮验证：删除前 classifier 测试 30/30 通过，
// 删除后变成 22/30 失败。详见团队记忆 bun-feature-dce-cliff.md。
// 该问题在 PR #21075 出现过 3 次，在 #21503 又出现过 2 次。
// 因此扩展后的正式版本现在放在这里（也是唯一的生产使用方）。
//
// 必须与下列逻辑保持同步：
//   - bashPermissions.ts 中的 SAFE_WRAPPER_PATTERNS（基于文本的 stripSafeWrappers）
//   - checkSemantics 中的包装命令剥离循环（src/utils/bash/ast.ts ~1860）
// 如果任一处新增了 wrapper，这里也必须同步补上。
// 否则就会出现不对称：checkSemantics 能看到剥离后的真实命令参与语义检查，
// 但 path validation 看到的却还是 wrapper 名字，结果返回 passthrough，
// 被包装起来的路径也就永远不会被校验（见 PR #21503 review comment 2907319120）。
// ───────────────────────────────────────────────────────────────────────────

// 安全性：timeout 的 flag 值必须命中 allowlist
// （信号值如 TERM/KILL/9，时长如 5/5s/10.5）。
// 这里会拒绝过去曾被 [^ \t]+ 错误放过的 $ ( ) ` | ; & 与换行；
// `timeout -k$(id) 10 ls` 绝不能被剥离。
const TIMEOUT_FLAG_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

/**
 * 解析 timeout 的 GNU flags（长参数 + 短参数，支持 fused 与空格分隔），
 * 并返回 DURATION token 在 argv 中的索引；如果参数无法解析，则返回 -1。
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
    } // end-of-options marker
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
 * 解析 stdbuf 的 flags（-i/-o/-e，支持 fused、空格分隔和 long-= 形式）。
 * 返回被包装 COMMAND 在 argv 中的索引；如果参数无法解析，
 * 或根本没有消费任何 flag（stdbuf 无 flag 时等同于 inert），则返回 -1。
 * 这里与 checkSemantics（ast.ts）的行为保持一致。
 */
function skipStdbufFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    if (/^-[ioe]$/.test(arg) && a[i + 1]) i += 2
    else if (/^-[ioe]./.test(arg)) i++
    else if (/^--(input|output|error)=/.test(arg)) i++
    else if (arg.startsWith('-'))
      return -1 // 遇到未知 flag 时按 fail-closed 处理。
    else break
  }
  return i > 1 && i < a.length ? i : -1
}

/**
 * 解析 env 的 VAR=val 与安全 flags（-i/-0/-v/-u NAME）。
 * 返回被包装 COMMAND 在 argv 中的索引；如果参数无法解析或没有真正的包装命令，
 * 则返回 -1。这里会拒绝 -S（argv splitter）以及 -C/-P（altwd/altpath）。
 * 该行为与 checkSemantics（ast.ts）保持一致。
 */
function skipEnvFlags(a: readonly string[]): number {
  let i = 1
  while (i < a.length) {
    const arg = a[i]!
    if (arg.includes('=') && !arg.startsWith('-')) i++
    else if (arg === '-i' || arg === '-0' || arg === '-v') i++
    else if (arg === '-u' && a[i + 1]) i += 2
    else if (arg.startsWith('-'))
      return -1 // -S/-C/-P/未知 flag：统一按 fail-closed 处理。
    else break
  }
  return i < a.length ? i : -1
}

/**
 * stripSafeWrappers（bashPermissions.ts）的 argv 级对应实现。
 * 它会从 AST 派生出的 argv 中剥掉包装命令。
 * 环境变量已经单独分离进 SimpleCommand.envVars，因此这里不再做环境变量剥离。
 */
export function stripWrappersFromArgv(argv: string[]): string[] {
  let a = argv
  for (;;) {
    if (a[0] === 'time' || a[0] === 'nohup') {
      a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'timeout') {
      const i = skipTimeoutFlags(a)
      // 安全性（PR #21503 第 3 轮）：如果 duration 无法识别
      // （如 `.5`、`+5`、`inf`，这些是 GNU timeout 接受的 strtod 格式），
      // 就原样返回 a，不做剥离。
      // 这是安全的，因为 checkSemantics（ast.ts）对相同输入会先以 fail-closed 拦下，
      // 而且它总是在 bashToolHasPermission 中先于这里执行。
      if (i < 0 || !a[i] || !/^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) return a
      a = a.slice(i + 1)
    } else if (a[0] === 'nice') {
      // 安全性（PR #21503 第 3 轮）：这里必须镜像 checkSemantics，
      // 同时处理裸 `nice cmd` 与旧式 `nice -N cmd`，而不能只处理 `nice -n N cmd`。
      // 过去只有 `-n N` 会被剥掉，因此 `nice rm /outside` 会变成
      // baseCmd='nice' → passthrough → /outside 永远不做路径校验。
      if (a[1] === '-n' && a[2] && /^-?\d+$/.test(a[2]))
        a = a.slice(a[3] === '--' ? 4 : 3)
      else if (a[1] && /^-\d+$/.test(a[1])) a = a.slice(a[2] === '--' ? 3 : 2)
      else a = a.slice(a[1] === '--' ? 2 : 1)
    } else if (a[0] === 'stdbuf') {
      // 安全性（PR #21503 第 3 轮）：这里在 PR 中做了扩宽。
      // PR 之前，`stdbuf -o0 -eL rm` 会被 fragment check 拒掉
      // （旧版 checkSemantics 的 slice(2) 会留下 name='-eL'）。
      // PR 之后，checkSemantics 会剥掉两个 flag，于是 name='rm' 并通过；
      // 但 stripWrappersFromArgv 如果仍原样返回，就会得到
      // baseCmd='stdbuf' → 不在 SUPPORTED_PATH_COMMANDS 中 → passthrough。
      const i = skipStdbufFlags(a)
      if (i < 0) return a
      a = a.slice(i)
    } else if (a[0] === 'env') {
      // 同样的不对称问题：checkSemantics 会剥掉 env，而这里原先不会。
      const i = skipEnvFlags(a)
      if (i < 0) return a
      a = a.slice(i)
    } else {
      return a
    }
  }
}
