import type { ToolPermissionContext } from '../../Tool.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'

/**
 * 辅助函数：用 allowlist 校验 flags。
 * 同时支持单独 flag 和组合 flag（例如 -nE）。
 * @param flags 要校验的 flag 数组
 * @param allowedFlags 允许的单字符 flag 与长 flag 数组
 * @returns 全部 flag 合法时返回 true，否则返回 false
 */
function validateFlagsAgainstAllowlist(
  flags: string[],
  allowedFlags: string[],
): boolean {
  for (const flag of flags) {
    // 处理 -nE 或 -Er 这类组合 flag。
    if (flag.startsWith('-') && !flag.startsWith('--') && flag.length > 2) {
      // 逐个检查组合 flag 中的每个字符。
      for (let i = 1; i < flag.length; i++) {
        const singleFlag = '-' + flag[i]
        if (!allowedFlags.includes(singleFlag)) {
          return false
        }
      }
    } else {
      // 单个 flag 或长 flag。
      if (!allowedFlags.includes(flag)) {
        return false
      }
    }
  }
  return true
}

/**
 * 模式 1：检查它是否是带 -n flag 的行打印命令。
 * 允许：sed -n 'N' 或 sed -n 'N,M'，并可附带可选的 -E、-r、-z。
 * 也允许用分号分隔的打印命令，例如：sed -n '1p;2p;3p'
 * 该模式允许带文件参数。
 * @internal Exported for testing
 */
export function isLinePrintingCommand(
  command: string,
  expressions: string[],
): boolean {
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return false
  const parsed = parseResult.tokens

  // 提取所有 flag。
  const flags: string[] = []
  for (const arg of parsed) {
    if (typeof arg === 'string' && arg.startsWith('-') && arg !== '--') {
      flags.push(arg)
    }
  }

  // 校验 flag，只允许 -n、-E、-r、-z 及其长形式。
  const allowedFlags = [
    '-n',
    '--quiet',
    '--silent',
    '-E',
    '--regexp-extended',
    '-r',
    '-z',
    '--zero-terminated',
    '--posix',
  ]

  if (!validateFlagsAgainstAllowlist(flags, allowedFlags)) {
    return false
  }

  // 检查是否存在 -n flag（模式 1 的必要条件）。
  let hasNFlag = false
  for (const flag of flags) {
    if (flag === '-n' || flag === '--quiet' || flag === '--silent') {
      hasNFlag = true
      break
    }
    // 同时检查组合 flag 的情况。
    if (flag.startsWith('-') && !flag.startsWith('--') && flag.includes('n')) {
      hasNFlag = true
      break
    }
  }

  // 模式 1 必须带 -n flag。
  if (!hasNFlag) {
    return false
  }

  // 至少要有一个 expression。
  if (expressions.length === 0) {
    return false
  }

  // 所有 expression 都必须是打印命令（严格 allowlist）。
  // 允许使用分号分隔多个命令。
  for (const expr of expressions) {
    const commands = expr.split(';')
    for (const cmd of commands) {
      if (!isPrintCommand(cmd.trim())) {
        return false
      }
    }
  }

  return true
}

/**
 * 辅助函数：检查单条命令是否是合法的打印命令。
 * 严格 allowlist，只允许以下精确形式：
 * - p (print all)
 * - Np (print line N, where N is digits)
 * - N,Mp (print lines N through M)
 * 其他任何形式（包括 w、W、e、E 命令）都会被拒绝。
 * @internal Exported for testing
 */
export function isPrintCommand(cmd: string): boolean {
  if (!cmd) return false
  // 单一且严格的正则，只匹配允许的打印命令。
  // ^(?:\d+|\d+,\d+)?p$ matches: p, 1p, 123p, 1,5p, 10,200p
  return /^(?:\d+|\d+,\d+)?p$/.test(cmd)
}

/**
 * 模式 2：检查它是否是替换命令。
 * 允许：sed 's/pattern/replacement/flags'，其中 flags 仅允许 g、p、i、I、m、M、1-9。
 * 当 allowFileWrites 为 true 时，允许 -i flag 和文件参数，用于原地编辑。
 * 当 allowFileWrites 为 false（默认）时，只允许 stdout 输出模式
 * （不允许文件参数，也不允许 -i flag）。
 * @internal Exported for testing
 */
function isSubstitutionCommand(
  command: string,
  expressions: string[],
  hasFileArguments: boolean,
  options?: { allowFileWrites?: boolean },
): boolean {
  const allowFileWrites = options?.allowFileWrites ?? false

  // 在不允许文件写入时，绝不能带文件参数。
  if (!allowFileWrites && hasFileArguments) {
    return false
  }

  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return false
  const parsed = parseResult.tokens

  // 提取所有 flag。
  const flags: string[] = []
  for (const arg of parsed) {
    if (typeof arg === 'string' && arg.startsWith('-') && arg !== '--') {
      flags.push(arg)
    }
  }

  // 按模式校验 flag。
  // 这是两种模式下都允许的基础 flag。
  const allowedFlags = ['-E', '--regexp-extended', '-r', '--posix']

  // 如果允许文件写入，则额外放行 -i 和 --in-place。
  if (allowFileWrites) {
    allowedFlags.push('-i', '--in-place')
  }

  if (!validateFlagsAgainstAllowlist(flags, allowedFlags)) {
    return false
  }

  // 必须恰好只有一个 expression。
  if (expressions.length !== 1) {
    return false
  }

  const expr = expressions[0]!.trim()

  // 严格 allowlist：必须是一个以 's' 开头的标准替换命令。
  // 这会拒绝 'e'、'w file' 之类独立命令。
  if (!expr.startsWith('s')) {
    return false
  }

  // 解析替换命令：s/pattern/replacement/flags
  // 这里只允许 / 作为分隔符（严格模式）。
  const substitutionMatch = expr.match(/^s\/(.*?)$/)
  if (!substitutionMatch) {
    return false
  }

  const rest = substitutionMatch[1]!

  // 查找 / 分隔符的位置。
  let delimiterCount = 0
  let lastDelimiterPos = -1
  let i = 0
  while (i < rest.length) {
    if (rest[i] === '\\') {
      // 跳过被转义的字符。
      i += 2
      continue
    }
    if (rest[i] === '/') {
      delimiterCount++
      lastDelimiterPos = i
    }
    i++
  }

  // 必须恰好找到 2 个分隔符（pattern 和 replacement 之间）。
  if (delimiterCount !== 2) {
    return false
  }

  // 提取 flags（最后一个分隔符之后的全部内容）。
  const exprFlags = rest.slice(lastDelimiterPos + 1)

  // 校验 flags：只允许 g、p、i、I、m、M，以及最多一个数字 1-9。
  const allowedFlagChars = /^[gpimIM]*[1-9]?[gpimIM]*$/
  if (!allowedFlagChars.test(exprFlags)) {
    return false
  }

  return true
}

/**
 * 检查某条 sed 命令是否被 allowlist 允许。
 * allowlist 本身已经足够严格，能够拒绝危险操作。
 * @param command 要检查的 sed 命令
 * @param options.allowFileWrites 为 true 时，替换命令允许 -i flag 和文件参数
 * @returns 当命令命中 allowlist 且通过 denylist 检查时返回 true，否则返回 false
 */
export function sedCommandIsAllowedByAllowlist(
  command: string,
  options?: { allowFileWrites?: boolean },
): boolean {
  const allowFileWrites = options?.allowFileWrites ?? false

  // 提取 sed expressions（即引号内实际承载 sed 命令的内容）。
  let expressions: string[]
  try {
    expressions = extractSedExpressions(command)
  } catch (_error) {
    // 解析失败时，一律视为不允许。
    return false
  }

  // 检查 sed 命令是否带有文件参数。
  const hasFileArguments = hasFileArgs(command)

  // 检查命令是否匹配 allowlist 模式。
  let isPattern1 = false
  let isPattern2 = false

  if (allowFileWrites) {
    // 允许文件写入时，只检查替换命令（模式 2 变体）。
    // 模式 1（行打印）本身不需要文件写入能力。
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments, {
      allowFileWrites: true,
    })
  } else {
    // 标准只读模式下，同时检查两种模式。
    isPattern1 = isLinePrintingCommand(command, expressions)
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments)
  }

  if (!isPattern1 && !isPattern2) {
    return false
  }

  // 模式 2 不允许分号（命令分隔符）。
  // 模式 1 则允许用分号分隔多个打印命令。
  for (const expr of expressions) {
    if (isPattern2 && expr.includes(';')) {
      return false
    }
  }

  // 纵深防御：即使命中了 allowlist，也还要再走一遍 denylist 检查。
  for (const expr of expressions) {
    if (containsDangerousOperations(expr)) {
      return false
    }
  }

  return true
}

/**
 * 检查 sed 命令是否带有文件参数（而不只是从 stdin 读取）。
 * @internal Exported for testing
 */
export function hasFileArgs(command: string): boolean {
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return true
  const parsed = parseResult.tokens

  try {
    let argCount = 0
    let hasEFlag = false

    for (let i = 0; i < parsed.length; i++) {
      const arg = parsed[i]

      // 同时处理字符串参数和 glob 模式（例如 *.log）。
      if (typeof arg !== 'string' && typeof arg !== 'object') continue

      // 如果是 glob 模式，也算文件参数。
      if (
        typeof arg === 'object' &&
        arg !== null &&
        'op' in arg &&
        arg.op === 'glob'
      ) {
        return true
      }

      // 跳过那些既不是字符串也不是 glob 的参数。
      if (typeof arg !== 'string') continue

      // 处理 -e 后跟 expression 的形式。
      if ((arg === '-e' || arg === '--expression') && i + 1 < parsed.length) {
        hasEFlag = true
        i++ // 下一个参数就是 expression，跳过它。
        continue
      }

      // 处理 --expression=value 形式。
      if (arg.startsWith('--expression=')) {
        hasEFlag = true
        continue
      }

      // 处理 -e=value 形式（虽然非标准，但这里做纵深防御）。
      if (arg.startsWith('-e=')) {
        hasEFlag = true
        continue
      }

      // 其他 flag 直接跳过。
      if (arg.startsWith('-')) continue

      argCount++

      // 一旦使用了 -e flag，后续所有非 flag 参数都应视为文件参数。
      if (hasEFlag) {
        return true
      }

      // 如果没有使用 -e flag，那么第一个非 flag 参数就是 sed expression，
      // 因此至少要有第二个非 flag 参数，才说明真的带了文件参数。
      if (argCount > 1) {
        return true
      }
    }

    return false
  } catch (_error) {
    return true // 解析失败时按危险处理。
  }
}

/**
 * 从命令中提取 sed expressions，忽略 flags 和文件名。
 * @param command 完整的 sed 命令
 * @returns 需要进一步检查危险操作的 sed expression 数组
 * @throws 解析失败时抛出 Error
 * @internal Exported for testing
 */
export function extractSedExpressions(command: string): string[] {
  const expressions: string[] = []

  // 通过裁掉前 N 个字符来得到 withoutSed（即移除前导的 'sed '）。
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return expressions

  const withoutSed = command.slice(sedMatch[0].length)

  // 拒绝危险的 flag 组合，例如 -ew、-eW、-ee、-we
  // （即把 -e/-w 与危险命令组合在一起）。
  if (/-e[wWe]/.test(withoutSed) || /-w[eE]/.test(withoutSed)) {
    throw new Error('Dangerous flag combination detected')
  }

  // 使用 shell-quote 正确解析参数。
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) {
    // shell 语法损坏时直接抛错，由调用方统一捕获。
    throw new Error(`Malformed shell syntax: ${parseResult.error}`)
  }
  const parsed = parseResult.tokens
  try {
    let foundEFlag = false
    let foundExpression = false

    for (let i = 0; i < parsed.length; i++) {
      const arg = parsed[i]

      // 跳过非字符串参数（例如控制操作符）。
      if (typeof arg !== 'string') continue

      // 处理 -e 后跟 expression 的形式。
      if ((arg === '-e' || arg === '--expression') && i + 1 < parsed.length) {
        foundEFlag = true
        const nextArg = parsed[i + 1]
        if (typeof nextArg === 'string') {
          expressions.push(nextArg)
          i++ // 下一个参数已被消费，直接跳过。
        }
        continue
      }

      // 处理 --expression=value 形式。
      if (arg.startsWith('--expression=')) {
        foundEFlag = true
        expressions.push(arg.slice('--expression='.length))
        continue
      }

      // 处理 -e=value 形式（虽然非标准，但这里做纵深防御）。
      if (arg.startsWith('-e=')) {
        foundEFlag = true
        expressions.push(arg.slice('-e='.length))
        continue
      }

      // 其他 flag 直接跳过。
      if (arg.startsWith('-')) continue

      // 如果此前没有遇到 -e flag，那么第一个非 flag 参数就是 sed expression。
      if (!foundEFlag && !foundExpression) {
        expressions.push(arg)
        foundExpression = true
        continue
      }

      // 如果已经遇到过 -e flag，或已经拿到一个独立 expression，
      // 那么剩余的非 flag 参数就都应当视为文件名。
      break
    }
  } catch (error) {
    // 如果 shell-quote 解析阶段出错，就把这个 sed 命令视为不安全。
    throw new Error(
      `Failed to parse sed command: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }

  return expressions
}

/**
 * 检查单条 sed expression 是否包含危险操作（denylist）。
 * @param expression 单条 sed expression（不含引号）
 * @returns 危险时返回 true，安全时返回 false
 */
function containsDangerousOperations(expression: string): boolean {
  const cmd = expression.trim()
  if (!cmd) return false

  // 保守拒绝策略：对那些可能危险的模式一律广泛拦截。
  // 拿不准时，统一按不安全处理。

  // 拒绝非 ASCII 字符（Unicode 同形异义字符、组合字符等）。
  // 例如：ｗ（全角）、ᴡ（小型大写）、w̃（组合波浪号）。
  // 这里检查所有超出 ASCII 范围的字符（0x01-0x7F，排除 null byte）。
  // eslint-disable-next-line no-control-regex
  if (/[^\x01-\x7F]/.test(cmd)) {
    return true
  }

  // 拒绝花括号（代码块），因为太难安全解析。
  if (cmd.includes('{') || cmd.includes('}')) {
    return true
  }

  // 拒绝换行，多行命令过于复杂。
  if (cmd.includes('\n')) {
    return true
  }

  // 拒绝注释（即 # 不是紧跟在 s 命令之后的情况）。
  // 注释通常长这样：#comment 或直接以 # 开头。
  // 而合法分隔符形式则类似：s#pattern#replacement#
  const hashIndex = cmd.indexOf('#')
  if (hashIndex !== -1 && !(hashIndex > 0 && cmd[hashIndex - 1] === 's')) {
    return true
  }

  // 拒绝否定操作符。
  // 否定可能出现在：开头（!/pattern/）、地址之后（/pattern/!、1,10!、$!）。
  // 而分隔符形式则像：s!pattern!replacement!（前面会有 's'）。
  if (/^!/.test(cmd) || /[/\d$]!/.test(cmd)) {
    return true
  }

  // 拒绝 GNU 步进地址格式中的波浪线（digit~digit、,~digit 或 $~digit）。
  // 这里允许波浪线两侧有空白。
  if (/\d\s*~\s*\d|,\s*~\s*\d|\$\s*~\s*\d/.test(cmd)) {
    return true
  }

  // 拒绝以逗号开头（裸逗号是 1,$ 地址范围的简写）。
  if (/^,/.test(cmd)) {
    return true
  }

  // 拒绝逗号后紧跟 +/- 的形式（GNU offset address）。
  if (/,\s*[+-]/.test(cmd)) {
    return true
  }

  // 拒绝反斜杠技巧：
  // 1. s\ （以反斜杠作为替换分隔符）
  // 2. \X，其中 X 可能是另类分隔符（|、#、% 等），而不是普通正则转义
  if (/s\\/.test(cmd) || /\\[|#%@]/.test(cmd)) {
    return true
  }

  // 拒绝“转义斜杠后接 w/W”的模式（如 /\/path\/to\/file/w）。
  if (/\\\/.*[wW]/.test(cmd)) {
    return true
  }

  // 拒绝那些我们无法可靠理解的畸形/可疑模式。
  // 典型特征是：斜杠后跟非斜杠字符，再跟空白，然后出现危险命令。
  // 例如：/pattern w file、/pattern e cmd、/foo X;w file
  if (/\/[^/]*\s+[wWeE]/.test(cmd)) {
    return true
  }

  // 拒绝不符合常规格式的畸形替换命令。
  // 例如：s/foobareoutput.txt（缺少分隔符）、s/foo/bar//w（多了一个分隔符）。
  if (/^s\//.test(cmd) && !/^s\/[^/]*\/[^/]*\/[^/]*$/.test(cmd)) {
    return true
  }

  // 偏执式防御：凡是以 's' 开头、以危险字符（w、W、e、E）结尾，
  // 且又不符合我们已知安全替换模式的命令，一律拒绝。
  // 这样可以抓住那些使用非斜杠分隔符、试图偷偷带危险 flag 的畸形 s 命令。
  if (/^s./.test(cmd) && /[wWeE]$/.test(cmd)) {
    // 检查它是否是一个格式正确的替换命令（允许任意分隔符，而不只限于 /）。
    const properSubst = /^s([^\\\n]).*?\1.*?\1[^wWeE]*$/.test(cmd)
    if (!properSubst) {
      return true
    }
  }

  // 检查危险的写入命令。
  // 模式包括：[address]w filename、[address]W filename、/pattern/w filename、/pattern/W filename
  // 这里做了简化，以避免指数级回溯（CodeQL issue）。
  // 核心是在那些会把 w/W 解释为命令的位置上做检测（允许可选空白）。
  if (
    /^[wW]\s*\S+/.test(cmd) || // At start: w file
    /^\d+\s*[wW]\s*\S+/.test(cmd) || // After line number: 1w file or 1 w file
    /^\$\s*[wW]\s*\S+/.test(cmd) || // After $: $w file or $ w file
    /^\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd) || // After pattern: /pattern/w file
    /^\d+,\d+\s*[wW]\s*\S+/.test(cmd) || // After range: 1,10w file
    /^\d+,\$\s*[wW]\s*\S+/.test(cmd) || // After range: 1,$w file
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd) // After pattern range: /s/,/e/w file
  ) {
    return true
  }

  // 检查危险的执行命令。
  // 模式包括：[address]e [command]、/pattern/e [command]，或直接以 e 开头的命令。
  // 这里同样做了简化，以避免指数级回溯（CodeQL issue）。
  // 核心是在那些会把 e 解释为命令的位置上做检测（允许可选空白）。
  if (
    /^e/.test(cmd) || // At start: e cmd
    /^\d+\s*e/.test(cmd) || // After line number: 1e or 1 e
    /^\$\s*e/.test(cmd) || // After $: $e or $ e
    /^\/[^/]*\/[IMim]*\s*e/.test(cmd) || // After pattern: /pattern/e
    /^\d+,\d+\s*e/.test(cmd) || // After range: 1,10e
    /^\d+,\$\s*e/.test(cmd) || // After range: 1,$e
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*e/.test(cmd) // After pattern range: /s/,/e/e
  ) {
    return true
  }

  // 检查带有危险 flag 的替换命令。
  // 模式：s<delim>pattern<delim>replacement<delim>flags，其中 flags 包含 w 或 e。
  // 按 POSIX 规定，sed 允许除反斜杠和换行外的任意字符作为分隔符。
  const substitutionMatch = cmd.match(/s([^\\\n]).*?\1.*?\1(.*?)$/)
  if (substitutionMatch) {
    const flags = substitutionMatch[2] || ''

    // 检查写入 flag：例如 s/old/new/w filename 或 s/old/new/gw filename。
    if (flags.includes('w') || flags.includes('W')) {
      return true
    }

    // 检查执行 flag：例如 s/old/new/e 或 s/old/new/ge。
    if (flags.includes('e') || flags.includes('E')) {
      return true
    }
  }

  // 检查 y（transliterate）命令后是否跟随危险操作。
  // 模式：y<delim>source<delim>dest<delim> 后面再接任意内容。
  // y 命令与 s 命令使用相同的分隔符语法。
  // 偏执式防御：只要 y 命令在分隔符之后任意位置出现 w/W/e/E，就直接拒绝。
  const yCommandMatch = cmd.match(/y([^\\\n])/)
  if (yCommandMatch) {
    // 一旦看到 y 命令，就检查整条命令里是否还出现了 w、W、e 或 E。
    // 这虽然偏保守，但 y 命令本来就少见，而 y 之后再出现 w/e 非常可疑。
    if (/[wWeE]/.test(cmd)) {
      return true
    }
  }

  return false
}

/**
 * 针对 sed 命令的横切校验步骤。
 *
 * 这是一个与模式无关的约束检查，会拦截危险的 sed 操作。
 * 对非 sed 命令或安全的 sed 命令返回 'passthrough'；
 * 对危险的 sed 操作（w/W/e/E 命令）返回 'ask'。
 *
 * @param input - 包含命令字符串的对象
 * @param toolPermissionContext - 包含模式与权限信息的上下文
 * @returns
 * - 任意 sed 命令包含危险操作时返回 'ask'
 * - 没有 sed 命令，或全部 sed 命令都安全时返回 'passthrough'
 */
export function checkSedConstraints(
  input: { command: string },
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const commands = splitCommand_DEPRECATED(input.command)

  for (const cmd of commands) {
    // 跳过非 sed 命令。
    const trimmed = cmd.trim()
    const baseCmd = trimmed.split(/\s+/)[0]
    if (baseCmd !== 'sed') {
      continue
    }

    // 在 acceptEdits 模式下，允许文件写入（-i flag），
    // 但仍然要拦截危险操作。
    const allowFileWrites = toolPermissionContext.mode === 'acceptEdits'

    const isAllowed = sedCommandIsAllowedByAllowlist(trimmed, {
      allowFileWrites,
    })

    if (!isAllowed) {
      return {
        behavior: 'ask',
        message:
          'sed command requires approval (contains potentially dangerous operations)',
        decisionReason: {
          type: 'other',
          reason:
            'sed command contains operations that require explicit approval (e.g., write commands, execute commands)',
        },
      }
    }
  }

  // 未发现危险 sed 命令（或者根本没有 sed 命令）。
  return {
    behavior: 'passthrough',
    message: 'No dangerous sed operations detected',
  }
}
