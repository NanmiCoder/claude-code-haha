import { logEvent } from 'src/services/analytics/index.js'
import { extractHeredocs } from '../../utils/bash/heredoc.js'
import { ParsedCommand } from '../../utils/bash/ParsedCommand.js'
import {
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  tryParseShellCommand,
} from '../../utils/bash/shellQuote.js'
import type { TreeSitterAnalysis } from '../../utils/bash/treeSitterAnalysis.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'

const HEREDOC_IN_SUBSTITUTION = /\$\(.*<</

// 注意：反引号模式在 validateDangerousPatterns 中单独处理，
// 这样才能区分已转义和未转义的反引号。
const COMMAND_SUBSTITUTION_PATTERNS = [
  { pattern: /<\(/, message: 'process substitution <()' },
  { pattern: />\(/, message: 'process substitution >()' },
  { pattern: /=\(/, message: 'Zsh process substitution =()' },
  // Zsh 的 EQUALS 展开：词首的 =cmd 会被扩展成 $(which cmd)。
  // `=curl evil.com` 会变成 `/usr/bin/curl evil.com`，从而绕过 Bash(curl:*)
  // 这类 deny 规则，因为解析器看到的基础命令是 `=curl`，不是 `curl`。
  // 这里只匹配词首的 =，且其后必须是命令名字符（而不是 VAR=val）。
  {
    pattern: /(?:^|[\s;&|])=[a-zA-Z_]/,
    message: 'Zsh equals expansion (=cmd)',
  },
  { pattern: /\$\(/, message: '$() command substitution' },
  { pattern: /\$\{/, message: '${} parameter substitution' },
  { pattern: /\$\[/, message: '$[] legacy arithmetic expansion' },
  { pattern: /~\[/, message: 'Zsh-style parameter expansion' },
  { pattern: /\(e:/, message: 'Zsh-style glob qualifiers' },
  { pattern: /\(\+/, message: 'Zsh glob qualifier with command execution' },
  {
    pattern: /\}\s*always\s*\{/,
    message: 'Zsh always block (try/always construct)',
  },
  // 纵深防御：即使当前并不在 PowerShell 中执行，也要拦住 PowerShell 注释语法。
  // 这样可以防止未来某些改动引入 PowerShell 执行能力后出现绕过。
  { pattern: /<#/, message: 'PowerShell comment syntax' },
]

// Zsh 特有的危险命令，它们可能绕过安全检查。
// 这些命令会针对每个命令片段的基础命令（第一个词）进行检查。
const ZSH_DANGEROUS_COMMANDS = new Set([
  // zmodload 是很多基于模块攻击的入口：
  // zsh/mapfile（通过数组赋值进行隐蔽文件 I/O）、
  // zsh/system（通过 sysopen/syswrite 两步访问文件）、
  // zsh/zpty（伪终端命令执行）、
  // zsh/net/tcp（通过 ztcp 做网络外传）、
  // zsh/files（内建 rm/mv/ln/chmod，可绕过二进制检查）
  'zmodload',
  // emulate 搭配 -c 标志相当于 eval，可执行任意代码。
  'emulate',
  // 能启用危险操作的 Zsh 模块内建命令。
  // 理论上它们需要先执行 zmodload，但这里仍然做纵深防御，
  // 以防 zmodload 被绕过，或模块已经预加载。
  'sysopen', // 以细粒度方式打开文件（zsh/system）
  'sysread', // 从文件描述符读取数据（zsh/system）
  'syswrite', // 向文件描述符写入数据（zsh/system）
  'sysseek', // 在文件描述符上执行 seek（zsh/system）
  'zpty', // 在伪终端上执行命令（zsh/zpty）
  'ztcp', // 创建 TCP 连接用于数据外传（zsh/net/tcp）
  'zsocket', // 创建 Unix/TCP socket（zsh/net/socket）
  'mapfile', // 严格说它不是命令，而是通过 zmodload 注入的关联数组
  'zf_rm', // 来自 zsh/files 的内建 rm
  'zf_mv', // 来自 zsh/files 的内建 mv
  'zf_ln', // 来自 zsh/files 的内建 ln
  'zf_chmod', // 来自 zsh/files 的内建 chmod
  'zf_chown', // 来自 zsh/files 的内建 chown
  'zf_mkdir', // 来自 zsh/files 的内建 mkdir
  'zf_rmdir', // 来自 zsh/files 的内建 rmdir
  'zf_chgrp', // 来自 zsh/files 的内建 chgrp
])

// bash 安全检查使用的数字 ID（避免直接记录字符串）。
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,
  JQ_SYSTEM_FUNCTION: 2,
  JQ_FILE_ARGUMENTS: 3,
  OBFUSCATED_FLAGS: 4,
  SHELL_METACHARACTERS: 5,
  DANGEROUS_VARIABLES: 6,
  NEWLINES: 7,
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,
  DANGEROUS_PATTERNS_INPUT_REDIRECTION: 9,
  DANGEROUS_PATTERNS_OUTPUT_REDIRECTION: 10,
  IFS_INJECTION: 11,
  GIT_COMMIT_SUBSTITUTION: 12,
  PROC_ENVIRON_ACCESS: 13,
  MALFORMED_TOKEN_INJECTION: 14,
  BACKSLASH_ESCAPED_WHITESPACE: 15,
  BRACE_EXPANSION: 16,
  CONTROL_CHARACTERS: 17,
  UNICODE_WHITESPACE: 18,
  MID_WORD_HASH: 19,
  ZSH_DANGEROUS_COMMANDS: 20,
  BACKSLASH_ESCAPED_OPERATORS: 21,
  COMMENT_QUOTE_DESYNC: 22,
  QUOTED_NEWLINE: 23,
} as const

type ValidationContext = {
  originalCommand: string
  baseCommand: string
  unquotedContent: string
  fullyUnquotedContent: string
  /** stripSafeRedirections 处理前的 fullyUnquoted，供 validateBraceExpansion
   * 使用，避免因重定向剥离造成反斜杠相邻而出现漏报。 */
  fullyUnquotedPreStrip: string
  /** 类似 fullyUnquotedPreStrip，但会保留引号字符（'/")；例如：
   * echo 'x'# → echo ''#（引号本身保留，从而暴露出与 # 的相邻关系） */
  unquotedKeepQuoteChars: string
  /** 若可用，则提供 Tree-sitter 分析数据。Validator 可优先利用它做更精确的分析，
   * 否则再回退到正则方案。 */
  treeSitter?: TreeSitterAnalysis | null
}

type QuoteExtraction = {
  withDoubleQuotes: string
  fullyUnquoted: string
  /** 类似 fullyUnquoted，但会保留引号字符（'/")：剥离被引用内容的同时保留定界符。
   * 供 validateMidWordHash 使用，用来发现与引号相邻的 #（例如 'x'#，否则剥离引号后
   * 会把这种相邻关系隐藏掉）。 */
  unquotedKeepQuoteChars: string
}

function extractQuotedContent(command: string, isJq = false): QuoteExtraction {
  let withDoubleQuotes = ''
  let fullyUnquoted = ''
  let unquotedKeepQuoteChars = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (escaped) {
      escaped = false
      if (!inSingleQuote) withDoubleQuotes += char
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      if (!inSingleQuote) withDoubleQuotes += char
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      unquotedKeepQuoteChars += char
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      unquotedKeepQuoteChars += char
      // 对 jq 来说，要把引号也纳入提取结果，确保内容能被正确分析。
      if (!isJq) continue
    }

    if (!inSingleQuote) withDoubleQuotes += char
    if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
    if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
  }

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars }
}

function stripSafeRedirections(content: string): string {
  // 安全性说明：下面三个模式都必须带尾部边界 (?=\s|$)。
  // 否则 `> /dev/nullo` 会把 `/dev/null` 当作前缀匹配并剥离，
  // `> /dev/null` 被去掉后只剩下 `o`，于是 `echo hi > /dev/nullo`
  // 会变成 `echo hi o`。这样 validateRedirections 看不到 `>` 就会错误放行。
  // 而对 /dev/nullo 的写入又会在只读路径分支里被自动允许
  // （checkReadOnlyConstraints）。主 bashPermissions 流程仍受保护，
  // 因为 checkPathConstraints 会校验原始命令，但 speculation.ts 单独使用的
  // 只有 checkReadOnlyConstraints。
  return content
    .replace(/\s+2\s*>&\s*1(?=\s|$)/g, '')
    .replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, '')
    .replace(/\s*<\s*\/dev\/null(?=\s|$)/g, '')
}

/**
 * 检查内容中是否包含某个单字符的未转义出现。
 * 会正确处理 bash 的转义规则，即反斜杠会转义其后的那个字符。
 *
 * 重要：这个函数只处理单字符，不处理字符串。如果以后要扩展到多字符字符串，
 * 必须对 shell 的 ANSI-C quoting（例如 $'\n'、$'\x41'、$'\u0041'）格外谨慎，
 * 因为它们能够以很难正确解析的方式编码任意字符和字符串。处理不当会引入
 * 安全漏洞，使攻击者可以绕过安全检查。
 *
 * @param content - 要搜索的字符串（通常来自 extractQuotedContent）
 * @param char - 要查找的单个字符（例如 '`'）
 * @returns 找到未转义出现时返回 true，否则返回 false
 *
 * 示例：
 *   hasUnescapedChar("test \`safe\`", '`') → false（反引号已转义）
 *   hasUnescapedChar("test `dangerous`", '`') → true（反引号未转义）
 *   hasUnescapedChar("test\\`date`", '`') → true（反斜杠被转义，而反引号未转义）
 */
function hasUnescapedChar(content: string, char: string): boolean {
  if (char.length !== 1) {
    throw new Error('hasUnescapedChar only works with single characters')
  }

  let i = 0
  while (i < content.length) {
    // 如果看到反斜杠，就跳过它和后一个字符（两者共同构成转义序列）。
    if (content[i] === '\\' && i + 1 < content.length) {
      i += 2 // 跳过反斜杠以及被它转义的字符。
      continue
    }

    // 检查当前字符是否命中目标字符。
    if (content[i] === char) {
      return true // 找到了未转义出现。
    }

    i++
  }

  return false // 没有找到未转义出现。
}

function validateEmpty(context: ValidationContext): PermissionResult {
  if (!context.originalCommand.trim()) {
    return {
      behavior: 'allow',
      updatedInput: { command: context.originalCommand },
      decisionReason: { type: 'other', reason: 'Empty command is safe' },
    }
  }
  return { behavior: 'passthrough', message: 'Command is not empty' }
}

function validateIncompleteCommands(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context
  const trimmed = originalCommand.trim()

  if (/^\s*\t/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: 'Command appears to be an incomplete fragment (starts with tab)',
    }
  }

  if (trimmed.startsWith('-')) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        'Command appears to be an incomplete fragment (starts with flags)',
    }
  }

  if (/^\s*(&&|\|\||;|>>?|<)/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.INCOMPLETE_COMMANDS,
      subId: 3,
    })
    return {
      behavior: 'ask',
      message:
        'Command appears to be a continuation line (starts with operator)',
    }
  }

  return { behavior: 'passthrough', message: 'Command appears complete' }
}

/**
 * 检查某条命令是否属于“安全的 substitution 内 heredoc”模式，
 * 从而允许绕过通用的 $() 校验器。
 *
 * 这是一个 EARLY-ALLOW 路径：一旦返回 `true`，bashCommandIsSafe 就会直接返回
 * `passthrough`，从而绕过后续所有 validator。正因为权限这么大，
 * 这里的判断必须是“可证明安全”，而不能只是“大概率安全”。
 *
 * 唯一允许的模式如下：
 *   [prefix] $(cat <<'DELIM'\n
 *   [body lines]\n
 *   DELIM\n
 *   ) [suffix]
 *
 * 其中：
 * - delimiter 必须是单引号包裹的（'DELIM'）或转义形式（\DELIM），这样 body
 *   才会被视为完全字面量文本，不发生展开
 * - closing delimiter 必须独占一整行（或者只允许尾部空白再接 `)`，用于
 *   $(cat <<'EOF'\n...\nEOF) 这种内联形式）
 * - closing delimiter 必须是第一条满足条件的行，这要与 bash 的行为精确一致
 *   （不能跳过更早的 delimiter 去寻找后面的 EOF）
 * - 在 $( 之前必须存在非空白文本，也就是说 substitution 只能处于参数位置，
 *   不能充当命令名。否则 heredoc body 会变成任意命令名，而 [suffix] 则会变成参数
 * - 去掉 heredoc 后剩余的文本也必须通过所有 validator
 *
 * 这里采用 LINE-BASED 匹配，而不是 regex [\s\S]*?，
 * 以便精确复现 bash 关闭 heredoc 的行为。
 */
function isSafeHeredoc(command: string): boolean {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) return false

  // 安全性说明：<< 与 delimiter 之间必须使用 [ \t]，不能用 \s。
  // 因为 \s 会匹配换行，但 bash 要求 delimiter 必须与 << 处在同一行。
  // 如果跨换行匹配，就可能接受 bash 实际会拒绝的畸形语法。
  // 同时还要兼容引号变体：'EOF'、''EOF''（splitCommand 可能会把引号弄乱）。
  const heredocPattern =
    /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  let match
  type HeredocMatch = {
    start: number
    operatorEnd: number
    delimiter: string
    isDash: boolean
  }
  const safeHeredocs: HeredocMatch[] = []

  while ((match = heredocPattern.exec(command)) !== null) {
    const delimiter = match[2] || match[3]
    if (delimiter) {
      safeHeredocs.push({
        start: match.index,
        operatorEnd: match.index + match[0].length,
        delimiter,
        isDash: match[1] === '-',
      })
    }
  }

  // 如果没有找到任何安全 heredoc 模式，那它就不是安全的。
  if (safeHeredocs.length === 0) return false

  // 安全性说明：对每个 heredoc，都要用 LINE-BASED 匹配来查找 closing delimiter，
  // 并且这个过程必须与 bash 的行为完全一致。bash 会在第一条“精确匹配 delimiter”
  // 的行上关闭 heredoc。后面再次出现的 delimiter 只会被当成普通内容
  // （或者下一条命令的一部分）。如果使用 regex [\s\S]*?，就可能跳过第一个
  // delimiter，直接去匹配后面的 `DELIM)`，从而把两个 delimiter 之间注入的命令藏起来。
  type VerifiedHeredoc = { start: number; end: number }
  const verified: VerifiedHeredoc[] = []

  for (const { start, operatorEnd, delimiter, isDash } of safeHeredocs) {
    // opening line 必须在 delimiter 后立刻结束（换行前只允许水平空白）。
    // 如果后面还有别的内容（例如 `; rm -rf /`），那就不是一个简单安全的 heredoc。
    const afterOperator = command.slice(operatorEnd)
    const openLineEnd = afterOperator.indexOf('\n')
    if (openLineEnd === -1) return false // No content at all
    const openLineTail = afterOperator.slice(0, openLineEnd)
    if (!/^[ \t]*$/.test(openLineTail)) return false // Extra content on open line

    // body 从换行之后开始。
    const bodyStart = operatorEnd + openLineEnd + 1
    const body = command.slice(bodyStart)
    const bodyLines = body.split('\n')

    // 找出第一条关闭 heredoc 的行。这里只有两种合法形式：
    //   1. `DELIM` 独占一行（标准 bash 形式），并且下一行以 `)` 开头
    //      （其前只允许空白）
    //   2. `DELIM)` 同处一行（即内联 $(cat <<'EOF'\n...\nEOF) 形式，
    //      对应 bash 中 PST_EOFTOKEN 同时关闭 heredoc 与 substitution）
    // 对于 <<-，匹配前还要先剥掉行首 tab。
    let closingLineIdx = -1
    let closeParenLineIdx = -1 // Line index where `)` appears
    let closeParenColIdx = -1 // Column index of `)` on that line

    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!
      const line = isDash ? rawLine.replace(/^\t*/, '') : rawLine

      // 形式 1：delimiter 单独占一行。
      if (line === delimiter) {
        closingLineIdx = i
        // `)` 必须出现在下一行，而且前面只能有空白。
        const nextLine = bodyLines[i + 1]
        if (nextLine === undefined) return false // No closing `)`
        const parenMatch = nextLine.match(/^([ \t]*)\)/)
        if (!parenMatch) return false // `)` not at start of next line
        closeParenLineIdx = i + 1
        closeParenColIdx = parenMatch[1]!.length // Position of `)`
        break
      }

      // 形式 2：delimiter 后面立刻跟 `)`（PST_EOFTOKEN 形式）。
      // delimiter 与 `)` 之间只允许空白。
      if (line.startsWith(delimiter)) {
        const afterDelim = line.slice(delimiter.length)
        const parenMatch = afterDelim.match(/^([ \t]*)\)/)
        if (parenMatch) {
          closingLineIdx = i
          closeParenLineIdx = i
          // 列位置基于 rawLine（即去 tab 之前的原始行），因此需要重新计算。
          const tabPrefix = isDash ? (rawLine.match(/^\t*/)?.[0] ?? '') : ''
          closeParenColIdx =
            tabPrefix.length + delimiter.length + parenMatch[1]!.length
          break
        }
        // 行是以 delimiter 开头，但后面还有其他尾随内容。
        // 这不是 closing line（bash 要求精确匹配，或者 EOF`)` 形式）。
        // 同时这也是危险信号：如果它处在 $() 里，bash 可能会借助其他
        // shell 元字符通过 PST_EOFTOKEN 提前闭合。extractHeredocs 已处理该情况；
        // 这里直接判定它不符合我们的安全模式。
        if (/^[)}`|&;(<>]/.test(afterDelim)) {
          return false // Ambiguous early-closure pattern
        }
      }
    }

    if (closingLineIdx === -1) return false // No closing delimiter found

    // 计算绝对结束位置（即 `)` 字符之后的那个位置）。
    let endPos = bodyStart
    for (let i = 0; i < closeParenLineIdx; i++) {
      endPos += bodyLines[i]!.length + 1 // +1 for newline
    }
    endPos += closeParenColIdx + 1 // +1 to include the `)` itself

    verified.push({ start, end: endPos })
  }

  // 安全性说明：拒绝嵌套匹配。正则只是在 RAW TEXT 中寻找 $(cat <<'X' 模式，
  // 并不真正理解 quoted-heredoc 语义。当外层 heredoc 使用带引号的 delimiter
  // （<<'A'）时，它的 body 在 bash 中就是字面量文本，内部任何 $(cat <<'B'
  // 都只是普通字符，不是真正的 heredoc。但我们的正则会把两者都匹配出来，
  // 形成嵌套区间。剥离嵌套区间会破坏索引：先删掉内层后，外层的 `end` 就过期了，
  // 进而让 `remaining.slice(end)` 返回空字符串，悄悄丢掉后缀
  // （例如 `; rm -rf /`）。由于我们匹配到的 heredoc 全都使用 quoted/escaped
  // delimiter，因此 body 内出现的嵌套命中永远都只可能是字面量文本，
  // 正常用户也不会故意写出这种模式，所以这里直接回退到安全保守路径。
  for (const outer of verified) {
    for (const inner of verified) {
      if (inner === outer) continue
      if (inner.start > outer.start && inner.start < outer.end) {
        return false
      }
    }
  }

  // 从命令中剥离所有已验证的 heredoc，构造出 `remaining`。
  // 采用倒序处理，保证更早的索引不会失效。
  const sortedVerified = [...verified].sort((a, b) => b.start - a.start)
  let remaining = command
  for (const { start, end } of sortedVerified) {
    remaining = remaining.slice(0, start) + remaining.slice(end)
  }

  // 安全性说明：如果剩余文本在（现已被剥离的）heredoc 位置前面只有空白，
  // 但后面还跟着非空白内容，那么它必须被判定为不安全。
  // 因为如果 $() 出现在 COMMAND-NAME 位置（也就是前面没有前缀命令），
  // 它的输出就会变成真正要执行的命令，而后缀文本则会变成参数：
  //   $(cat <<'EOF'\nchmod\nEOF\n) 777 /etc/shadow
  //   → runs `chmod 777 /etc/shadow`
  // 我们只允许 substitution 出现在 ARGUMENT 位置，也就是在 $( 之前
  // 必须已经有一个命令词。
  // 剥离之后，`remaining` 应该长得像 `cmd args... [more args]`。
  // 如果 remaining 只以空白开头（甚至为空），那就说明 $() 原本就是命令名，
  // 这种情况只有在不存在任何尾随参数时才安全。
  const trimmedRemaining = remaining.trim()
  if (trimmedRemaining.length > 0) {
    // 存在前缀命令，这很好。但还必须检查原始命令在第一个 $( 之前
    // 也确实有非空白前缀（因为 heredoc 可能有多个；我们需要的是第一个的前缀）。
    const firstHeredocStart = Math.min(...verified.map(v => v.start))
    const prefix = command.slice(0, firstHeredocStart)
    if (prefix.trim().length === 0) {
      // $() 落在命令名位置，但后面还有尾随文本，这就是不安全的。
      // heredoc body 会变成命令名，而尾随文本会变成参数。
      return false
    }
  }

  // 检查 remaining 是否只包含安全字符。
  // 剥离安全 heredoc 后，剩余文本只应该包含命令名、参数、引号和空白。
  // 这里要拒绝任何 shell 元字符，防止有人在一个安全 heredoc 后面继续串接
  // 运算符（|、&、&&、||、;）或展开（$、`、{、<、>）来执行危险命令。
  // 安全性说明：这里只允许显式的 ASCII 空格/tab，不能用 \s，
  // 因为 \s 会匹配 \u00A0 这类 Unicode 空白，可被用于隐藏内容。
  // 同时也禁止换行，因为那意味着 heredoc 体之外还出现了多行命令。
  if (!/^[a-zA-Z0-9 \t"'.\-/_@=,:+~]*$/.test(remaining)) return false

  // 安全性说明：remaining（也就是剥离 heredoc 后的命令）本身也必须通过
  // 全部安全校验。否则，只要把一个安全 heredoc 拼接到危险命令后面
  // （例如 `zmodload zsh/system $(cat <<'EOF'\nx\nEOF\n)`），
  // 这个 early-allow 路径就会直接返回 passthrough，从而绕过
  // validateZshDangerousCommands、validateProcEnvironAccess 以及其他主 validator。
  // 这里不存在递归风险，因为 `remaining` 中已经不会再含有 `$(... <<` 模式，
  // 所以递归调用里的 validateSafeCommandSubstitution 会立刻走 passthrough。
  if (bashCommandIsSafe_DEPRECATED(remaining).behavior !== 'passthrough')
    return false

  return true
}

/**
 * 检测格式良好的 $(cat <<'DELIM'...DELIM) heredoc substitution 模式。
 * 如果找到，就返回剥离这些 heredoc 后的命令；否则返回 null。
 * 供 pre-split gate 使用，用于先剥掉安全 heredoc，再重新检查剩余内容。
 */
export function stripSafeHeredocSubstitutions(command: string): string | null {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) return null

  const heredocPattern =
    /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  let result = command
  let found = false
  let match
  const ranges: Array<{ start: number; end: number }> = []
  while ((match = heredocPattern.exec(command)) !== null) {
    if (match.index > 0 && command[match.index - 1] === '\\') continue
    const delimiter = match[2] || match[3]
    if (!delimiter) continue
    const isDash = match[1] === '-'
    const operatorEnd = match.index + match[0].length

    const afterOperator = command.slice(operatorEnd)
    const openLineEnd = afterOperator.indexOf('\n')
    if (openLineEnd === -1) continue
    if (!/^[ \t]*$/.test(afterOperator.slice(0, openLineEnd))) continue

    const bodyStart = operatorEnd + openLineEnd + 1
    const bodyLines = command.slice(bodyStart).split('\n')
    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!
      const line = isDash ? rawLine.replace(/^\t*/, '') : rawLine
      if (line.startsWith(delimiter)) {
        const after = line.slice(delimiter.length)
        let closePos = -1
        if (/^[ \t]*\)/.test(after)) {
          const lineStart =
            bodyStart +
            bodyLines.slice(0, i).join('\n').length +
            (i > 0 ? 1 : 0)
          closePos = command.indexOf(')', lineStart)
        } else if (after === '') {
          const nextLine = bodyLines[i + 1]
          if (nextLine !== undefined && /^[ \t]*\)/.test(nextLine)) {
            const nextLineStart =
              bodyStart + bodyLines.slice(0, i + 1).join('\n').length + 1
            closePos = command.indexOf(')', nextLineStart)
          }
        }
        if (closePos !== -1) {
          ranges.push({ start: match.index, end: closePos + 1 })
          found = true
        }
        break
      }
    }
  }
  if (!found) return null
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!
    result = result.slice(0, r.start) + result.slice(r.end)
  }
  return result
}

/** 仅做检测：命令里是否包含安全的 heredoc substitution？ */
export function hasSafeHeredocSubstitution(command: string): boolean {
  return stripSafeHeredocSubstitutions(command) !== null
}

function validateSafeCommandSubstitution(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  if (!HEREDOC_IN_SUBSTITUTION.test(originalCommand)) {
    return { behavior: 'passthrough', message: 'No heredoc in substitution' }
  }

  if (isSafeHeredoc(originalCommand)) {
    return {
      behavior: 'allow',
      updatedInput: { command: originalCommand },
      decisionReason: {
        type: 'other',
        reason:
          'Safe command substitution: cat with quoted/escaped heredoc delimiter',
      },
    }
  }

  return {
    behavior: 'passthrough',
    message: 'Command substitution needs validation',
  }
}

function validateGitCommit(context: ValidationContext): PermissionResult {
  const { originalCommand, baseCommand } = context

  if (baseCommand !== 'git' || !/^git\s+commit\s+/.test(originalCommand)) {
    return { behavior: 'passthrough', message: 'Not a git commit' }
  }

  // 安全性说明：反斜杠会让正则误判引号边界。
  // 例如 `git commit -m "test\"msg" && evil`。真实的 commit message 几乎
  // 不会包含反斜杠，所以这里一旦出现就直接回退到完整 validator 链。
  if (originalCommand.includes('\\')) {
    return {
      behavior: 'passthrough',
      message: 'Git commit contains backslash, needs full validation',
    }
  }

  // 安全性说明：`-m` 前面的 `.*?` 绝不能匹配到 shell 操作符。
  // 过去它会匹配除 `\n` 外的几乎任何字符，包括 `;`、`&`、`|`、`` ` ``、`$(`。
  // 对于 `git commit ; curl evil.com -m 'x'`，`.*?` 会把 `; curl evil.com ` 吞进去，
  // 导致 remainder 变成空字符串（falsy，于是跳过 remainder 检查），最后竟然对复合命令
  // 返回 `allow`。而 early-allow 会跳过全部主 validator（约在 line ~1908），
  // 直接让 validateQuotedNewline、validateBackslashEscapedOperators 等防护失效。
  // 虽然当前 splitCommand 在下游还能兜住这类情况，但 early-allow 表达的是
  // “整个命令已被证明安全”的强正断言，而这里显然达不到这个标准。
  //
  // 另外，`git` 与 `commit` 之间的 `\s+` 也绝不能匹配 `\n`/`\r`
  // （它们在 bash 中是命令分隔符）。这里只能使用 `[ \t]+` 表示水平空白。
  //
  // `[^;&|`$<>()\n\r]*?` 这个字符类会排除 shell 元字符。
  // 这里还把 `<` 和 `>` 一并排除了（重定向符号），因为它们虽然可以在 REMAINDER 中
  // 作为 `--author="Name <email>"` 的一部分出现，但绝不能出现在 `-m` 之前。
  const messageMatch = originalCommand.match(
    /^git[ \t]+commit[ \t]+[^;&|`$<>()\n\r]*?-m[ \t]+(["'])([\s\S]*?)\1(.*)$/,
  )

  if (messageMatch) {
    const [, quote, messageContent, remainder] = messageMatch

    if (quote === '"' && messageContent && /\$\(|`|\$\{/.test(messageContent)) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.GIT_COMMIT_SUBSTITUTION,
        subId: 1,
      })
      return {
        behavior: 'ask',
        message: 'Git commit message contains command substitution patterns',
      }
    }

    // 安全性说明：检查 remainder 中是否存在能串接命令或重定向输出的 shell 操作符。
    // 正则里 `-m` 前面的 `.*` 会吞掉 `--amend` 之类 flag，结果把 `&& evil`
    // 或 `> ~/.bashrc` 留在 remainder 中。过去这里只检查了 $() / `` / ${}，
    // 漏掉了 ; | & && || < > 这些真正危险的操作符。
    //
    // `<` 和 `>` 在 `--author="Name <email>"` 这类参数中，如果出现在引号内部，
    // 是完全合法的。但未加引号的 `>` 就是 shell 重定向操作符。
    // 又因为 validateGitCommit 是 EARLY validator，一旦这里返回 `allow`，
    // bashCommandIsSafe 就会短路，连 validateRedirections 都不会执行。
    // 因此只要看到未加引号的 `<>`，就必须回退为 passthrough，交给主 validator 处理。
    //
    // 攻击示例：`git commit --allow-empty -m 'payload' > ~/.bashrc`
    //   validateGitCommit 返回 allow → bashCommandIsSafe 短路 →
    //   validateRedirections 永远不会执行 → ~/.bashrc 被 git stdout 覆盖，
    //   其中包含 `payload` → 下次 shell 登录时触发 RCE。
    if (remainder && /[;|&()`]|\$\(|\$\{/.test(remainder)) {
      return {
        behavior: 'passthrough',
        message: 'Git commit remainder contains shell metacharacters',
      }
    }
    if (remainder) {
      // 先剥掉引号中的内容，再检查是否还有 `<` 或 `>`。
      // 引号内的 `<>`（如 --author 里的邮箱尖括号）是安全的；
      // 未加引号的 `<>` 则是 shell 重定向。
      // 注意：这个简单的引号跟踪器完全不处理反斜杠。
      // 例如引号外的 `\'` / `\"` 会让它不同步（bash 里 \' 是字面量 '，
      // 但跟踪器会误以为单引号状态翻转）。不过前面已经对 originalCommand 中的
      // 任意反斜杠提前回退，因此这里永远不会遇到带反斜杠的输入。
      // 在“无反斜杠”前提下，这种简单的引号开关逻辑是正确的。
      let unquoted = ''
      let inSQ = false
      let inDQ = false
      for (let i = 0; i < remainder.length; i++) {
        const c = remainder[i]
        if (c === "'" && !inDQ) {
          inSQ = !inSQ
          continue
        }
        if (c === '"' && !inSQ) {
          inDQ = !inDQ
          continue
        }
        if (!inSQ && !inDQ) unquoted += c
      }
      if (/[<>]/.test(unquoted)) {
        return {
          behavior: 'passthrough',
          message: 'Git commit remainder contains unquoted redirect operator',
        }
      }
    }

    // 安全加固：拦截以短横线开头的消息。
    // 这可以捕获诸如 git commit -m "---" 之类潜在的混淆模式。
    if (messageContent && messageContent.startsWith('-')) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
        subId: 5,
      })
      return {
        behavior: 'ask',
        message: 'Command contains quoted characters in flag names',
      }
    }

    return {
      behavior: 'allow',
      updatedInput: { command: originalCommand },
      decisionReason: {
        type: 'other',
        reason: 'Git commit with simple quoted message is allowed',
      },
    }
  }

  return { behavior: 'passthrough', message: 'Git commit needs validation' }
}

function validateJqCommand(context: ValidationContext): PermissionResult {
  const { originalCommand, baseCommand } = context

  if (baseCommand !== 'jq') {
    return { behavior: 'passthrough', message: 'Not jq' }
  }

  if (/\bsystem\s*\(/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.JQ_SYSTEM_FUNCTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'jq command contains system() function which executes arbitrary commands',
    }
  }

  // 文件参数现在允许出现，它们会在 readOnlyValidation.ts 的路径校验阶段被进一步验证。
  // 这里只拦截那些可能把文件读入 jq 变量的危险 flag。
  const afterJq = originalCommand.substring(3).trim()
  if (
    /(?:^|\s)(?:-f\b|--from-file|--rawfile|--slurpfile|-L\b|--library-path)/.test(
      afterJq,
    )
  ) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.JQ_FILE_ARGUMENTS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'jq command contains dangerous flags that could execute code or read arbitrary files',
    }
  }

  return { behavior: 'passthrough', message: 'jq command is safe' }
}

function validateShellMetacharacters(
  context: ValidationContext,
): PermissionResult {
  const { unquotedContent } = context
  const message =
    'Command contains shell metacharacters (;, |, or &) in arguments'

  if (/(?:^|\s)["'][^"']*[;&][^"']*["'](?:\s|$)/.test(unquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 1,
    })
    return { behavior: 'ask', message }
  }

  const globPatterns = [
    /-name\s+["'][^"']*[;|&][^"']*["']/,
    /-path\s+["'][^"']*[;|&][^"']*["']/,
    /-iname\s+["'][^"']*[;|&][^"']*["']/,
  ]

  if (globPatterns.some(p => p.test(unquotedContent))) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 2,
    })
    return { behavior: 'ask', message }
  }

  if (/-regex\s+["'][^"']*[;&][^"']*["']/.test(unquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.SHELL_METACHARACTERS,
      subId: 3,
    })
    return { behavior: 'ask', message }
  }

  return { behavior: 'passthrough', message: 'No metacharacters' }
}

function validateDangerousVariables(
  context: ValidationContext,
): PermissionResult {
  const { fullyUnquotedContent } = context

  if (
    /[<>|]\s*\$[A-Za-z_]/.test(fullyUnquotedContent) ||
    /\$[A-Za-z_][A-Za-z0-9_]*\s*[|<>]/.test(fullyUnquotedContent)
  ) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_VARIABLES,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains variables in dangerous contexts (redirections or pipes)',
    }
  }

  return { behavior: 'passthrough', message: 'No dangerous variables' }
}

function validateDangerousPatterns(
  context: ValidationContext,
): PermissionResult {
  const { unquotedContent } = context

  // 对反引号做特殊处理，只检查“未转义”的反引号。
  // 已转义的反引号（如 \`）是安全的，在 SQL 命令里也很常见。
  if (hasUnescapedChar(unquotedContent, '`')) {
    return {
      behavior: 'ask',
      message: 'Command contains backticks (`) for command substitution',
    }
  }

  // 其他命令替换检查（这里会把双引号内的内容也纳入考虑）。
  for (const { pattern, message } of COMMAND_SUBSTITUTION_PATTERNS) {
    if (pattern.test(unquotedContent)) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId:
          BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION,
        subId: 1,
      })
      return { behavior: 'ask', message: `Command contains ${message}` }
    }
  }

  return { behavior: 'passthrough', message: 'No dangerous patterns' }
}

function validateRedirections(context: ValidationContext): PermissionResult {
  const { fullyUnquotedContent } = context

  if (/</.test(fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_INPUT_REDIRECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains input redirection (<) which could read sensitive files',
    }
  }

  if (/>/.test(fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_PATTERNS_OUTPUT_REDIRECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains output redirection (>) which could write to arbitrary files',
    }
  }

  return { behavior: 'passthrough', message: 'No redirections' }
}

function validateNewlines(context: ValidationContext): PermissionResult {
  // 使用 fullyUnquotedPreStrip（即 stripSafeRedirections 之前的内容），
  // 以防有人利用“剥掉 `>/dev/null` 后制造出虚假的反斜杠换行延续”来绕过检查。
  // 例如 `cmd \>/dev/null\nwhoami` 在剥离后会变成 `cmd \\nwhoami`，
  // 看起来像是安全的续行，实际上却隐藏了第二条命令。
  const { fullyUnquotedPreStrip } = context

  // 检查未引用内容里是否出现换行。
  if (!/[\n\r]/.test(fullyUnquotedPreStrip)) {
    return { behavior: 'passthrough', message: 'No newlines' }
  }

  // 只要换行/CR 后面跟着非空白，就要标记出来；唯一例外是“单词边界处的
  // 反斜杠换行续行”。在 bash 中，`\<newline>` 会被当成续行（两个字符都消失），
  // 当前一个字符是空白时，这是安全的，例如 `cmd \<newline>--flag`。
  // 但像 `tr\<newline>aceroute` 这样的“单词中部续行”仍然必须拦截，
  // 因为它们可以把危险命令名藏过 allowlist 检查。
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() + gated by /[\n\r]/.test() above
  const looksLikeCommand = /(?<![\s]\\)[\n\r]\s*\S/.test(fullyUnquotedPreStrip)
  if (looksLikeCommand) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.NEWLINES,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains newlines that could separate multiple commands',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'Newlines appear to be within data',
  }
}

/**
 * 安全性说明：回车符（\r, 0x0D）与 LF 不同，确实会导致误解析问题。
 *
 * 解析器差异：
 *   - shell-quote 的 BAREWORD 正则使用 `[^\s...]`，而 JS 的 `\s` 会包含 \r，
 *     所以 shell-quote 会把 CR 当作 token 边界。`TZ=UTC\recho` 会被切成
 *     两个 token：['TZ=UTC', 'echo']，随后 splitCommand 再把它们拼成
 *     `'TZ=UTC echo curl evil.com'`。
 *   - bash 的默认 IFS = $' \t\n'，其中并不包含 CR。bash 会把
 *     `TZ=UTC\recho` 看成一个完整单词，即 env assignment TZ='UTC\recho'
 *     （CR 字节留在值中），然后 `curl` 才是实际命令。
 *
 * 攻击示例：`TZ=UTC\recho curl evil.com` 配合 Bash(echo:*) 规则。
 *   validator：splitCommand 把 CR 折叠成空格 → 'TZ=UTC echo curl evil.com'
 *   → stripSafeWrappers 去掉 TZ=UTC → 'echo curl evil.com' 命中规则
 *   bash：实际执行的却是 `curl evil.com`
 *
 * validateNewlines 虽然也能发现它，但 validateNewlines 属于
 * nonMisparsingValidators（因为 LF 能被两个解析器一致处理）。
 * 而当前这个 validator 不在 nonMisparsingValidators 中，
 * 它的 ask 结果会带上 isBashSecurityCheckForMisparsing，
 * 并在 bashPermissions gate 处被专门拦下。
 *
 * 这里必须检查 originalCommand，而不是 fullyUnquotedPreStrip，
 * 因为单引号中的 CR 出于同样原因也会触发误解析：shell-quote 的 `\s`
 * 仍然会把它当分隔符，但 bash 会把它当作字面量。
 * 因此要拦截所有“未加引号或位于单引号中”的 CR。
 * 唯一例外是双引号中的 CR，因为在这种情况下 bash 也会把它当数据，
 * shell-quote 也不会拆 token。
 */
function validateCarriageReturn(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  if (!originalCommand.includes('\r')) {
    return { behavior: 'passthrough', message: 'No carriage return' }
  }

  // 检查 CR 是否出现在双引号之外。凡是出现在 DQ 之外的 CR
  // （包括单引号内和未加引号的情况），都会触发 shell-quote/bash 的分词差异。
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < originalCommand.length; i++) {
    const c = originalCommand[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (c === '\r' && !inDoubleQuote) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.NEWLINES,
        subId: 2,
      })
      return {
        behavior: 'ask',
        message:
          'Command contains carriage return (\\r) which shell-quote and bash tokenize differently',
      }
    }
  }

  return { behavior: 'passthrough', message: 'CR only inside double quotes' }
}

function validateIFSInjection(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  // 检测 IFS 变量的任何使用方式，因为它可能被用于绕过正则校验。
  // 这里同时检查 $IFS 和 ${...IFS...} 形式（包括 ${IFS:0:1}、${#IFS} 等参数展开）。
  // 使用 ${[^}]*IFS 是为了覆盖所有含 IFS 的参数展开变体。
  if (/\$IFS|\$\{[^}]*IFS/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.IFS_INJECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains IFS variable usage which could bypass security validation',
    }
  }

  return { behavior: 'passthrough', message: 'No IFS injection detected' }
}

// 对通过 /proc 文件系统读取环境变量的行为做额外加固。
// 虽然路径校验通常已经会拦住 /proc 访问，但这里仍然做一层纵深防御。
// /proc 下的环境文件可能暴露 API key、secret 等敏感信息。
function validateProcEnvironAccess(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  // 检查那些可能暴露环境变量的 /proc 路径。
  // 例如以下模式：
  // - /proc/self/environ
  // - /proc/1/environ
  // - /proc/*/environ (with any PID)
  if (/\/proc\/.*\/environ/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.PROC_ENVIRON_ACCESS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command accesses /proc/*/environ which could expose sensitive environment variables',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No /proc/environ access detected',
  }
}

/**
 * 检测那些同时包含 malformed token（定界符不平衡）和命令分隔符的命令。
 * 这能抓住一些利用模糊 shell 语法实施注入的潜在模式。
 *
 * 安全性说明：这个检查用于捕获在 HackerOne review 中发现的 eval bypass。
 * 当 shell-quote 去解析像 `echo {"hi":"hi;evil"}` 这种模糊模式时，
 * 它可能产生不平衡 token（例如 `{hi:"hi`）。一旦再叠加命令分隔符，
 * 就可能在 eval 重新解析阶段触发非预期命令执行。
 *
 * 通过强制要求用户审批这些模式，我们可以确保用户在点批准之前，
 * 看到的就是将要真正执行的内容。
 */
function validateMalformedTokenInjection(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  const parseResult = tryParseShellCommand(originalCommand)
  if (!parseResult.success) {
    // 解析失败会由其他地方处理（bashToolHasPermission 会负责兜底）。
    return {
      behavior: 'passthrough',
      message: 'Parse failed, handled elsewhere',
    }
  }

  const parsed = parseResult.tokens

  // 检查是否存在命令分隔符（;、&&、||）。
  const hasCommandSeparator = parsed.some(
    entry =>
      typeof entry === 'object' &&
      entry !== null &&
      'op' in entry &&
      (entry.op === ';' || entry.op === '&&' || entry.op === '||'),
  )

  if (!hasCommandSeparator) {
    return { behavior: 'passthrough', message: 'No command separators' }
  }

  // 检查是否存在 malformed token（定界符不平衡）。
  if (hasMalformedTokens(originalCommand, parsed)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.MALFORMED_TOKEN_INJECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains ambiguous syntax with command separators that could be misinterpreted',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No malformed token injection detected',
  }
}

function validateObfuscatedFlags(context: ValidationContext): PermissionResult {
  // 拦截那些利用 shell quoting 绕过正则中 negative lookahead 的模式，
  // 防止已知危险 flag 被伪装过去。

  const { originalCommand, baseCommand } = context

  // 对混淆 flag 而言，echo 本身是安全的，但前提必须是“简单 echo 命令”。
  // 如果是复合命令（带 |、&、;），就必须检查整条命令，
  // 因为危险的 ANSI-C quoting 可能藏在操作符后面。
  const hasShellOperators = /[|&;]/.test(originalCommand)
  if (baseCommand === 'echo' && !hasShellOperators) {
    return {
      behavior: 'passthrough',
      message: 'echo command is safe and has no dangerous flags',
    }
  }

  // 全面的混淆检测。
  // 下面这些检查用于捕获各种借助 shell quoting 隐藏 flag 的方式。

  // 1. 拦截 ANSI-C quoting（$'...'），因为它可以通过转义序列编码任意字符。
  // 这里使用一个简单模式来匹配任意位置上的 $'...'，它可以正确处理：
  // - grep '$' file => 不匹配（这里的 $ 只是引号内正则锚点，不是 $'...' 结构）
  // - 'test'$'-exec' => 会匹配（普通引号与 ANSI-C quoting 的拼接）
  // - 零宽空格等不可见字符 => 也会匹配
  // 该模式要求出现 $'，后接任意内容（可为空），最后以配对的 ' 结束。
  if (/\$'[^']*'/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 5,
    })
    return {
      behavior: 'ask',
      message: 'Command contains ANSI-C quoting which can hide characters',
    }
  }

  // 2. 拦截 locale quoting（$"..."），它同样可以借助转义序列隐藏内容。
  // 这里沿用与上方 ANSI-C quoting 相同的简单模式。
  if (/\$"[^"]*"/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 6,
    })
    return {
      behavior: 'ask',
      message: 'Command contains locale quoting which can hide characters',
    }
  }

  // 3. 拦截空的 ANSI-C / locale 引号后直接跟 dash 的情况。
  // 例如 $''-exec 或 $""-exec。
  if (/\$['"]{2}\s*-/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 9,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains empty special quotes before dash (potential bypass)',
    }
  }

  // 4. 拦截任意“空引号序列后跟 dash”的模式。
  // 可覆盖：''-、""-、''""-、""''-、''""''- 等等。
  // 该模式会寻找一个或多个空引号对，后面接可选空白和 dash。
  if (/(?:^|\s)(?:''|"")+\s*-/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 7,
    })
    return {
      behavior: 'ask',
      message: 'Command contains empty quotes before dash (potential bypass)',
    }
  }

  // 4b. 安全性：拦截“同类空引号对”紧贴“带引号的 dash”这种模式。
  // 像 `"""-f"` 这样的写法（空 `""` + 带引号的 `"-f"`）在 bash 中会拼接成 `-f`，
  // 但会绕过上面的所有检查：
  //   - 上面第 (4) 条正则 `(?:''|"")+\s*-` 先匹配到 `""`，然后期望看到可选空白和 dash，
  //     结果它遇到的是第三个 `"`，于是匹配失败。
  //   - 下方的引号内容扫描器会把第一个 `""` 看成空内容（不以 dash 开头），
  //     第三个 `"` 则开启了一个新的引号区间，交由主引号状态跟踪器处理。
  //   - 引号状态跟踪器里，`""` 会让 inDoubleQuote 开再关，第三个 `"` 又重新打开；
  //     此时 `"-f"` 中的 `-` 处于引号内，于是被跳过。
  //   - flag 扫描器查找的是 `-` 前面是否有空白；这里 `-` 前面是 `"`。
  //   - fullyUnquotedContent 会把 `""` 和 `"-f"` 一并剥掉。
  //
  // 对 bash 来说，`"""-f"` 等于空字符串 + 字符串 "-f"，最终就是 `-f`。
  // 因此这个绕过手法适用于任何危险 flag 检查（如 jq -f、find -exec、fc -e），
  // 只要权限前缀允许（如 Bash(jq:*)、Bash(find:*)）。
  //
  // 正则 `(?:""|'')+['"]-` 的含义是：
  //   - 一个或多个“同类”的空引号对（`""` 或 `''`），也就是 bash 把空串与 flag 拼接的位置；
  //   - 紧接任意一个引号字符，表示带引号的 flag 区间开始；
  //   - 再紧接一个 `-`，即被混淆的 flag。
  //
  // 位置无关：这里不要求词首（`(?:^|\s)`），因为像 `$x"""-f"`
  // 这样的前缀（未设置或为空的变量）在 bash 中也会同样发生拼接。
  // “同类空引号对”的要求还能排除 `'"'"'` 这种惯用写法，
  // 因为它并不包含真正的同类空对。
  //
  // 可接受的误报：`echo '"""-f" text'` 这种单引号字符串内的字面量模式也会命中，
  // 但这类情况极少见，可以接受。
  if (/(?:""|'')+['"]-/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 10,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains empty quote pair adjacent to quoted dash (potential flag obfuscation)',
    }
  }

  // 4c. 安全性：即便后面没有立刻跟 dash，也要拦截词首连续 3 个以上引号。
  // 这是针对多重引号混淆模式的更宽安全网，用来覆盖上面未枚举的变体
  // （例如 `"""x"-f`，其中引号之间的内容改变了 dash 的位置）。
  // 合法命令在 `"x"` 能工作的情况下，并不需要写成 `"""x"`。
  if (/(?:^|\s)['"]{3,}/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 11,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains consecutive quote characters at word start (potential obfuscation)',
    }
  }

  // 跟踪引号状态，避免把引号内部的内容误判成 flag。
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length - 1; i++) {
    const currentChar = originalCommand[i]
    const nextChar = originalCommand[i + 1]

    // 更新引号状态。
    if (escaped) {
      escaped = false
      continue
    }

    // 安全性：只有在单引号外部，才把反斜杠当作转义符。在 bash 里，
    // `'...'` 内部的 `\` 是字面量。没有这个保护时，`'\'` 会让引号状态跟踪器失步：
    // `\` 会把 escaped 设为 true，而后面的闭合 `'` 又会被上面的 escaped 分支吞掉，
    // 而不是切换 inSingleQuote。于是解析器会一直停留在单引号模式，
    // line ~1121 的 `if (inSingleQuote || inDoubleQuote) continue` 也会跳过
    // 该命令后续所有 flag 检测。例子：`jq '\' "-f" evil` 实际上传给 bash 的参数里
    // 会包含 `-f`，但失步后的解析器却以为 ` "-f" evil` 仍在引号里，
    // 从而绕过 flag 检查。
    // 作为纵深防御，hasShellQuoteSingleQuoteBug 会在 line ~1856 更早拦截 `'\'`
    // 这种模式；但这里仍修复跟踪器，实现上要与本文件中其他正确实现
    // （如 hasBackslashEscaped*、extractQuotedContent）保持一致，
    // 它们都会使用 `!inSingleQuote` 作为保护条件。
    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // 只在不处于引号内部时扫描 flag。
    // 这样可以避免误报，比如 make test TEST="file.py -v"。
    if (inSingleQuote || inDoubleQuote) {
      continue
    }

    // 查找“空白后接引号，且引号内容含 dash”的模式，这通常意味着 flag 混淆。
    // 安全策略上，这里会拦截任何以 dash 开头的带引号内容，宁可保守一些。
    // 能覆盖："-"exec、"-file"、"--flag"、'-'-output 等情况。
    // 如果确实是合法用法，用户仍然可以手动批准，例如 find . -name "-file"。
    if (
      currentChar &&
      nextChar &&
      /\s/.test(currentChar) &&
      /['"`]/.test(nextChar)
    ) {
      const quoteChar = nextChar
      let j = i + 2 // 从开引号之后开始。
      let insideQuote = ''

      // 收集引号内部的内容。
      while (j < originalCommand.length && originalCommand[j] !== quoteChar) {
        insideQuote += originalCommand[j]!
        j++
      }

      // 如果找到了闭合引号，且内容看起来像经过混淆的 flag，就直接拦截。
      // 这里要覆盖三类攻击模式：
      //   1. 引号内就是 flag 名："--flag"、"-exec"、"-X"。
      //   2. 分裂引号 flag："-"exec、"--"output。
      //   3. 链式引号："-""exec"，即第一段里是 dash，后面引号段再补足字母。
      // 如果只是 "---" 或 "--" 这种纯 dash 串，且后面跟的是空白或分隔符，
      // 它们更像分隔符而不是 flag，不应触发这里的检查。
      const charAfterQuote = originalCommand[j + 1]
      // 在双引号内部，$VAR 和 `cmd` 会在运行时展开，因此 "-$VAR" 可能变成 -exec。
      // 这里把 $ 和 ` 也纳入拦截范围，会额外拦下一些单引号字面量，
      // 比如 grep '-$'（其中 $ 只是普通字符），但 startsWith('-') 的主逻辑
      // 本来就已经会拦住这些情况，所以这只是恢复现状，而不是新增误报。
      // 花括号展开（{）不会在引号内部发生，因此这里不需要专门处理它。
      const hasFlagCharsInside = /^-+[a-zA-Z0-9$`]/.test(insideQuote)
      // 闭合引号后仍可能继续组成 flag 的字符集合：
      //   a-zA-Z0-9: "-"exec → -exec（直接拼接）
      //   \\:        "-"\exec → -exec（反斜杠转义被剥离）
      //   -:         "-"-output → --output（继续补 dash）
      //   {:         "-"{exec,delete} → -exec -delete（花括号展开）
      //   $:         "-"$VAR → 当 VAR=exec 时变成 -exec（变量展开）
      //   `:         "-"`echo exec` → -exec（命令替换）
      // 注意：这里故意不包含 glob 字符（*?[），因为它们需要攻击者先控制当前目录里的文件名，
      // 而且如果在这里拦掉，会破坏 `ls -- "-"*` 这类合法用法。
      const FLAG_CONTINUATION_CHARS = /[a-zA-Z0-9\\${`-]/
      const hasFlagCharsContinuing =
        /^-+$/.test(insideQuote) &&
        charAfterQuote !== undefined &&
        FLAG_CONTINUATION_CHARS.test(charAfterQuote)
      // 处理相邻引号串联的情况：像 "-""exec"、"-""-"exec 或 """-"exec
      // 在 shell 里都会被拼成 -exec。这里会沿着相邻引号段一路往后跟，
      // 直到找到包含字母数字的段，或碰到非引号边界为止。
      // 这也覆盖了空前缀引号场景，例如 """-"exec，其中前导的 "" 是空串。
      // 只要拼接后的整体包含 dash 并且后面接上字母数字，就构成一个 flag。
      const hasFlagCharsInNextQuote =
        // 触发条件：第一段要么只有 dash，要么为空（都可能是 flag 前缀）。
        (insideQuote === '' || /^-+$/.test(insideQuote)) &&
        charAfterQuote !== undefined &&
        /['"`]/.test(charAfterQuote) &&
        (() => {
          let pos = j + 1 // 从 charAfterQuote 开始，它本身是一个开引号。
          let combinedContent = insideQuote // 跟踪 shell 最终会拼接出来的内容。
          while (
            pos < originalCommand.length &&
            /['"`]/.test(originalCommand[pos]!)
          ) {
            const segQuote = originalCommand[pos]!
            let end = pos + 1
            while (
              end < originalCommand.length &&
              originalCommand[end] !== segQuote
            ) {
              end++
            }
            const segment = originalCommand.slice(pos + 1, end)
            combinedContent += segment

            // 检查当前拼接结果是否已经形成 flag 模式。
            // 这里把 $ 和 ` 也纳入考虑，因为引号内展开也可能形成 -exec，
            // 例如 "-""$VAR"。
            if (/^-+[a-zA-Z0-9$`]/.test(combinedContent)) return true

            // 如果当前段带来了字母数字或展开，而前面已经积累了 dash，
            // 那它就是一个 flag。像 "-""$*" 这种情况也能覆盖，
            // 即便 segment 本身没有字母数字，运行时也可能展开成位置参数。
            // 同时要防止 segment.length === 0 时出现 slice(0, -0) 这种边界问题。
            const priorContent =
              segment.length > 0
                ? combinedContent.slice(0, -segment.length)
                : combinedContent
            if (/^-+$/.test(priorContent)) {
              if (/[a-zA-Z0-9$`]/.test(segment)) return true
            }

            if (end >= originalCommand.length) break // 引号未闭合。
            pos = end + 1 // 越过闭合引号，继续检查下一段。
          }
          // 链末尾若跟着未加引号的字符，也要一并检查。
          if (
            pos < originalCommand.length &&
            FLAG_CONTINUATION_CHARS.test(originalCommand[pos]!)
          ) {
            // 如果当前拼接内容里已有 dash，那么尾随字符可能把它补全成 flag。
            if (/^-+$/.test(combinedContent) || combinedContent === '') {
              // 检查后续内容是否正在把它补成一个 flag。
              const nextChar = originalCommand[pos]!
              if (nextChar === '-') {
                // 继续追加 dash，仍然可能形成 flag。
                return true
              }
              if (/[a-zA-Z0-9\\${`]/.test(nextChar) && combinedContent !== '') {
                // 前面已有 dash，而现在跟上了字母数字或展开内容。
                return true
              }
            }
            // 原始兜底检查：dash 后直接跟字母数字。
            if (/^-/.test(combinedContent)) {
              return true
            }
          }
          return false
        })()
      if (
        j < originalCommand.length &&
        originalCommand[j] === quoteChar &&
        (hasFlagCharsInside ||
          hasFlagCharsContinuing ||
          hasFlagCharsInNextQuote)
      ) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
          subId: 4,
        })
        return {
          behavior: 'ask',
          message: 'Command contains quoted characters in flag names',
        }
      }
    }

    // 查找“空白后直接跟 dash”的模式，这意味着一个 flag 开始了。
    if (currentChar && nextChar && /\s/.test(currentChar) && nextChar === '-') {
      let j = i + 1 // 从 dash 开始。
      let flagContent = ''

      // 收集整个 flag 的内容。
      while (j < originalCommand.length) {
        const flagChar = originalCommand[j]
        if (!flagChar) break

        // 一旦遇到空白或等号，就说明 flag 内容结束了。
        if (/[\s=]/.test(flagChar)) {
          break
        }
        // 如果遇到引号，且其后不是 flag 字符，也要结束 flag 收集。
        // 这是为了正确处理 -d"," 这类情况，它应该只被解析成 -d。
        if (/['"`]/.test(flagChar)) {
          // cut -d 是一个特例：分隔符值可以写在引号里。
          // 例如 cut -d'"' 应当被解析为 flag 名 -d，flag 值是 '"'。
          // 注意：这个例外只对 cut -d 生效，目的是避免绕过。
          // 否则像 `find -e"xec"` 这样的命令就可能被误解析成 flag 名 -e，
          // 从而绕过我们对 -exec 的拦截。把例外收窄到 cut -d 后，
          // 既保留了合法用法，又防止了其他命令借助带引号 flag 值隐藏危险 flag 名。
          if (
            baseCommand === 'cut' &&
            flagContent === '-d' &&
            /['"`]/.test(flagChar)
          ) {
            // 这是 cut -d 后接带引号的分隔符，flagContent 本身已经完整是 '-d'。
            break
          }

          // 向后看一下引号后面跟的是什么。
          if (j + 1 < originalCommand.length) {
            const nextFlagChar = originalCommand[j + 1]
            if (nextFlagChar && !/[a-zA-Z0-9_'"-]/.test(nextFlagChar)) {
              // 引号后面明显不是 flag 的组成部分，那就结束当前解析。
              break
            }
          }
        }
        flagContent += flagChar
        j++
      }

      if (flagContent.includes('"') || flagContent.includes("'")) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
          subId: 1,
        })
        return {
          behavior: 'ask',
          message: 'Command contains quoted characters in flag names',
        }
      }
    }
  }

  // 同时处理“以引号开头的 flag”，例如 "--"output、'-'-output 等。
  // 这里使用 fullyUnquotedContent，避免把 echo "---" 这类合法带引号内容误判为攻击。
  if (/\s['"`]-/.test(context.fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message: 'Command contains quoted characters in flag names',
    }
  }

  // 这里也覆盖类似 ""--output 这样的情况。
  // 继续使用 fullyUnquotedContent，以减少合法带引号内容带来的误报。
  if (/['"`]{2}-/.test(context.fullyUnquotedContent)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.OBFUSCATED_FLAGS,
      subId: 3,
    })
    return {
      behavior: 'ask',
      message: 'Command contains quoted characters in flag names',
    }
  }

  return { behavior: 'passthrough', message: 'No obfuscated flags detected' }
}

/**
 * 检测引号外部由反斜杠转义的空白字符（空格、制表符）。
 *
 * 在 bash 中，`echo\ test` 会被视为一个单独 token（命令名是 "echo test"），
 * 但 shell-quote 会把这次转义解码成 `echo test`，于是得到两个独立 token。
 * 这种差异会带来路径穿越攻击，例如：
 *   echo\ test/../../../usr/bin/touch /tmp/file
 * 解析器会把它看成 `echo test/.../touch /tmp/file`（像是一条 echo 命令），
 * 但 bash 实际会把它解析成 `/usr/bin/touch /tmp/file`（通过目录 "echo test"）。
 */
function hasBackslashEscapedWhitespace(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (char === '\\' && !inSingleQuote) {
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar === ' ' || nextChar === '\t') {
          return true
        }
      }
      // 跳过被转义的那个字符。无论是在引号外，还是在双引号内都需要这样做，
      // 因为在双引号内，\\、\"、\$、\` 都是合法转义序列。
      i++
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
  }

  return false
}

function validateBackslashEscapedWhitespace(
  context: ValidationContext,
): PermissionResult {
  if (hasBackslashEscapedWhitespace(context.originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BACKSLASH_ESCAPED_WHITESPACE,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains backslash-escaped whitespace that could alter command parsing',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No backslash-escaped whitespace',
  }
}

/**
 * 检测引号外部、紧挨 shell 操作符之前的反斜杠。
 *
 * 安全说明：splitCommand 会把 `\;` 规范化成普通的 `;` 写进输出字符串。
 * 后续代码（如 checkReadOnlyConstraints、checkPathConstraints 等）在重新解析这串
 * 规范化结果时，会把裸 `;` 视为真正的操作符，从而错误地切分命令。
 * 这会让任意文件读取绕过路径检查，例如：
 *
 *   cat safe.txt \; echo ~/.ssh/id_rsa
 *
 * 对 bash 来说，这是一条单独的 cat 命令，它会把 safe.txt、;、echo、~/.ssh/id_rsa
 * 都当成文件参数读取。
 * 但在 splitCommand 规范化后，它会变成 "cat safe.txt ; echo ~/.ssh/id_rsa"。
 * 再次解析时就会变成 ["cat safe.txt", "echo ~/.ssh/id_rsa"]，两个片段都能通过
 * isCommandReadOnly，而隐藏在 echo 片段里的敏感路径完全不会再被路径约束校验。
 * 结果是命令被自动放行，私钥泄露。
 *
 * 因此，这项检查会拦截任何 `\<operator>`，不论反斜杠数量奇偶。
 * 偶数个（如 `\\;`）在 bash 中同样危险，因为 `\\` 会还原成 `\`，而 `;` 仍是分隔符；
 * 奇数个（如 `\;`）虽然在 bash 中本身安全，却会触发上面的双重解析漏洞。
 * 两种都必须拦下。
 *
 * 已知误报：`find . -exec cmd {} \;` 会被提示一次，需要用户确认。
 *
 * 注意：`(` 和 `)` 不在这个集合里，因为 splitCommand 会保留 `\(` 和 `\)` 的原样输出，
 * 可以安全往返，不会触发双重解析问题。这也让
 * `find . \( -name x -o -name y \)` 能够无误报通过。
 */
const SHELL_OPERATORS = new Set([';', '|', '&', '<', '>'])

function hasBackslashEscapedOperator(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    // 安全性：必须先处理反斜杠，再处理引号切换。在 bash 里，双引号内部的 `\"`
    // 只是表示一个字面量 `"`，不会结束引号。如果先处理引号切换，
    // 那么 `"..."` 内部的 `\"` 会把状态跟踪器搞乱：
    //   - `\` 会被忽略（因为被 !inDoubleQuote 限制掉了）
    //   - `"` 会错误地把 inDoubleQuote 切到 false（但 bash 仍认为还在引号里）
    //   - 下一个真正的闭合 `"` 又会把它切回 true，形成永久失步
    //   - 后续的 `\;` 也就无法被检测到，因为 !inDoubleQuote 已经不成立了
    // 利用方式：`tac "x\"y" \; echo ~/.ssh/id_rsa`。bash 实际只执行一条 tac，
    // 会把所有参数都当成文件来读，导致 id_rsa 泄露；但失步后的跟踪器漏掉了 `\;`，
    // 而 splitCommand 的双重解析又会把它“看成”两条安全命令。
    //
    // 这里的修复结构与 hasBackslashEscapedWhitespace 一致
    // （它在 d000dfe84e 之前的某个提交里已经被正确修过）：
    // 先检查反斜杠，只用 !inSingleQuote 作为门控（因为在 '...' 内反斜杠是字面量），
    // 然后无条件执行 i++，即便当前处于双引号内部，也要跳过那个被转义的字符。
    if (char === '\\' && !inSingleQuote) {
      // 只有在双引号外部才拦截 \<operator>。
      // 因为在双引号内部，;|&<> 这些操作符本来就不再具备特殊含义，所以 \; 是无害的。
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar && SHELL_OPERATORS.has(nextChar)) {
          return true
        }
      }
      // 无条件跳过被转义的那个字符。在双引号内部，这能正确处理成对反斜杠：
      // `"x\\"` 中，位置 6 的 `\` 会跳过位置 7 的 `\`，随后位置 8 的 `"`
      // 才会正确地把 inDoubleQuote 切回 false。若不这样无条件跳过，
      // 位置 7 会再次看到 `\`，把位置 8 的 `"` 当成 nextChar 吞掉，
      // 结果闭合引号永远不会触发状态切换，后续引号外的 `\;` 也就都漏掉了。
      // 利用示例：`cat "x\\" \; echo /etc/passwd`，bash 最终会读到 /etc/passwd。
      //
      // 这套逻辑也能正确处理反斜杠数量的奇偶：
      // 奇数个 `\;`（1、3、5...）会被标记，因为紧贴 `;` 前面的未配对反斜杠会被检测到；
      // 偶数个 `\\;`（2、4...）不会被标记，这才是正确行为，因为 bash 会把 `\\`
      // 还原成字面量 `\`，并把 `;` 当作分隔符，此时 splitCommand 也能正常处理，
      // 不存在双重解析漏洞。这与 hasBackslashEscapedWhitespace 在 line ~1340
      // 的处理保持一致。
      i++
      continue
    }

    // 引号状态切换必须放在反斜杠处理之后。
    // 因为前面的逻辑已经跳过了所有被转义的引号字符，
    // 所以下面这些切换只会对真正未转义的引号生效。
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
  }

  return false
}

function validateBackslashEscapedOperators(
  context: ValidationContext,
): PermissionResult {
  // Tree-sitter 路径：如果 tree-sitter 已确认 AST 中不存在真实的操作符节点，
  // 那么任何 \; 都只会是某个单词参数中的转义字符
  // （例如 `find . -exec cmd {} \;`）。这种情况下可以跳过昂贵的正则检查。
  if (context.treeSitter && !context.treeSitter.hasActualOperatorNodes) {
    return { behavior: 'passthrough', message: 'No operator nodes in AST' }
  }

  if (hasBackslashEscapedOperator(context.originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BACKSLASH_ESCAPED_OPERATORS,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains a backslash before a shell operator (;, |, &, <, >) which can hide command structure',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No backslash-escaped operators',
  }
}

/**
 * 通过统计目标字符前连续反斜杠的数量，判断 `content` 中 `pos` 位置的字符是否被转义。
 * 反斜杠数量为奇数表示它被转义。
 */
function isEscapedAtPosition(content: string, pos: number): boolean {
  let backslashCount = 0
  let i = pos - 1
  while (i >= 0 && content[i] === '\\') {
    backslashCount++
    i--
  }
  return backslashCount % 2 === 1
}

/**
 * 检测未加引号的 brace expansion 语法。Bash 会展开它，但 shell-quote/tree-sitter
 * 会把它当成普通字面量字符串处理。这个解析差异会造成权限绕过：
 *   git ls-remote {--upload-pack="touch /tmp/test",test}
 * 解析器只看到一个字面量参数，但 Bash 实际会把它展开成：--upload-pack="touch /tmp/test" test
 *
 * Brace expansion 有两种形式：
 *   1. 逗号分隔：{a,b,c} → a b c
 *   2. 序列展开：{1..5} → 1 2 3 4 5
 *
 * 在 Bash 中，单引号和双引号都会抑制 brace expansion，因此这里使用
 * fullyUnquotedContent，也就是把两类引号都剥离后的内容。
 * 通过反斜杠转义的花括号（\{、\}）同样不会触发展开。
 */
function validateBraceExpansion(context: ValidationContext): PermissionResult {
  // 使用剥离重定向前的内容，避免 stripSafeRedirections 生成新的反斜杠相邻关系，
  // 从而导致漏报（例如 `\>/dev/null{a,b}` 被剥离后变成 `\{a,b}`，
  // 让 isEscapedAtPosition 误以为这个花括号已被转义）。
  const content = context.fullyUnquotedPreStrip

  // 安全性：检查 fullyUnquoted 内容中花括号数量是否失衡。
  // 一旦失衡，通常说明带引号的花括号（如 `'{'` 或 `"{"`）已被 extractQuotedContent
  // 剥掉，导致我们分析的内容里出现不平衡的括号。下方的深度匹配算法默认花括号是平衡的；
  // 如果这个前提不成立，它就可能在错误的位置闭合，漏掉 Bash 实际还能发现的逗号。
  //
  // 利用示例：`git diff {@'{'0},--output=/tmp/pwned}`
  //   - 原始命令里有 2 个 `{` 和 2 个 `}`（其中带引号的 `'{'` 是内容，不是操作符）
  //   - fullyUnquoted 变成 `git diff {@0},--output=/tmp/pwned}`，只剩 1 个 `{`、2 个 `}`
  //   - 我们的深度匹配器会在第一个 `}`（`0` 后面）就闭合，inner=`@0`，看不到逗号
  //   - Bash 在原始命令上则会把带引号的 `{` 当成普通内容，第一个未加引号的 `}`
  //     前面还没有逗号，于是继续往后扫描，最终找到 `,`，再由最后一个 `}` 闭合
  //     并展开成 `@{0} --output=/tmp/pwned`
  //   - 最终 git 会把 diff 写入 /tmp/pwned。这是零权限即可完成的任意文件写入。
  //
  // 这里只统计未转义的花括号（因为带反斜杠的花括号在 bash 中只是字面量）。
  // 如果数量失衡，且至少存在一个未转义的 `{`，就必须拦截，因为此时我们的深度匹配
  // 已不再可信。
  let unescapedOpenBraces = 0
  let unescapedCloseBraces = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{' && !isEscapedAtPosition(content, i)) {
      unescapedOpenBraces++
    } else if (content[i] === '}' && !isEscapedAtPosition(content, i)) {
      unescapedCloseBraces++
    }
  }
  // 只有在“闭合括号数量多于打开括号数量”时才拦截，这是该攻击的特征信号。
  // `}` 比 `{` 多，意味着某个带引号的 `{` 被剥掉了
  // （bash 把它视为内容，而我们这里只看到了额外的 `}`）。反过来如果 `{` 更多，
  // 往往只是合法的未闭合或被转义场景，例如 `{foo` 或 `{a,b\}`，
  // Bash 本来也不会展开它们。
  if (unescapedOpenBraces > 0 && unescapedCloseBraces > unescapedOpenBraces) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        'Command has excess closing braces after quote stripping, indicating possible brace expansion obfuscation',
    }
  }

  // 安全性：除此之外，还要在 ORIGINAL 命令（即引号剥离前）中查找
  // 处于未加引号 brace context 内部的 `'{'` 或 `"{"`。这正是该攻击的原语。
  // 在外层未加引号的 `{...}` 中再嵌一个带引号的花括号，几乎总是混淆行为；
  // 合法命令通常不会这么写。像 awk/find 这样的模式要么整体带引号，
  // 例如 `awk '{print $1}'`，此时外层花括号本身也在引号里。
  //
  // 这还能作为纵深防御，捕获那些经过精心构造、让剥离后的花括号数量仍保持平衡的 payload。
  // 这里使用一个简单启发式：如果原始命令中既有 `'{'`、`'}'`、`"{"`、`"}"`
  // 这种“单个花括号被引号包住”的模式，又同时存在一个未加引号的 `{`，就值得怀疑。
  if (unescapedOpenBraces > 0) {
    const orig = context.originalCommand
    // 查找单个花括号被引号包住的模式：'{', '}', "{", "}"。
    // 这就是该攻击使用的基本原语。
    if (/['"][{}]['"]/.test(orig)) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
        subId: 3,
      })
      return {
        behavior: 'ask',
        message:
          'Command contains quoted brace character inside brace context (potential brace expansion obfuscation)',
      }
    }
  }

  // 扫描所有未转义的 `{`，再检查它们是否真的构成 brace expansion。
  // 这里采用手工扫描，而不是简单的正则后行断言，
  // 因为 lookbehind 处理不了双重转义反斜杠这类情况（\\{ 实际上对应未转义的 `{`）。
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue
    if (isEscapedAtPosition(content, i)) continue

    // 通过跟踪嵌套深度，找到与之匹配的未转义 `}`。
    // 之前的做法在遇到嵌套 `{` 时会出错，导致漏掉外层 `{` 与内层之间的逗号
    // （例如 `{--upload-pack="evil",{test}}`）。
    let depth = 1
    let matchingClose = -1
    for (let j = i + 1; j < content.length; j++) {
      const ch = content[j]
      if (ch === '{' && !isEscapedAtPosition(content, j)) {
        depth++
      } else if (ch === '}' && !isEscapedAtPosition(content, j)) {
        depth--
        if (depth === 0) {
          matchingClose = j
          break
        }
      }
    }

    if (matchingClose === -1) continue

    // 检查当前 `{` 与其匹配 `}` 之间，最外层嵌套深度上是否出现了 `,` 或 `..`。
    // 只有 depth-0 的触发才有意义，因为 Bash 只会在外层逗号/序列位置拆分 brace expansion。
    let innerDepth = 0
    for (let k = i + 1; k < matchingClose; k++) {
      const ch = content[k]
      if (ch === '{' && !isEscapedAtPosition(content, k)) {
        innerDepth++
      } else if (ch === '}' && !isEscapedAtPosition(content, k)) {
        innerDepth--
      } else if (innerDepth === 0) {
        if (
          ch === ',' ||
          (ch === '.' && k + 1 < matchingClose && content[k + 1] === '.')
        ) {
          logEvent('tengu_bash_security_check_triggered', {
            checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
            subId: 1,
          })
          return {
            behavior: 'ask',
            message:
              'Command contains brace expansion that could alter command parsing',
          }
        }
      }
    }
    // No expansion at this level — don't skip past; inner pairs will be
    // caught by subsequent iterations of the outer loop.
  }

  return {
    behavior: 'passthrough',
    message: 'No brace expansion detected',
  }
}

// 匹配那些 shell-quote 会当作单词分隔符、但 bash 会当作普通字面量内容的 Unicode 空白字符。
// 虽然这种差异目前是偏向防御的一侧（shell-quote 会过度拆分），
// 但提前拦住它们可以避免未来出现新的边缘漏洞。
// eslint-disable-next-line no-misleading-character-class
const UNICODE_WS_RE =
  /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/

function validateUnicodeWhitespace(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context
  if (UNICODE_WS_RE.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.UNICODE_WHITESPACE,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains Unicode whitespace characters that could cause parsing inconsistencies',
    }
  }
  return { behavior: 'passthrough', message: 'No Unicode whitespace' }
}

function validateMidWordHash(context: ValidationContext): PermissionResult {
  const { unquotedKeepQuoteChars } = context
  // 匹配前面紧跟非空白字符的 #，也就是“词中 hash”。
  // shell-quote 会把这种 mid-word # 当作注释起点，而 bash 会把它当成普通字面量字符，
  // 从而形成解析差异。
  //
  // 这里使用 unquotedKeepQuoteChars，它会保留引号分隔符但剥掉引号内部内容，
  // 因而能捕获像 'x'# 这样紧贴引号的 #。如果用 fullyUnquotedPreStrip，
  // 则会把引号和内容都删掉，最终把 'x'# 变成单独的 #（落到词首场景）。
  //
  // 安全性：还要检查“续行拼接后”的版本。当前 context 建立在原始命令之上，
  // 尚未做 continuation join。对 `foo\<NL>#bar` 而言，拼接前 `#` 前面是 `\n`
  // （空白，因此 `/\S#/` 不匹配）；拼接后前面却变成了 `o`（非空白，因此会匹配）。
  // shell-quote 工作在拼接后的文本上（splitCommand 会先合并续行），
  // 所以解析差异也会出现在拼接后的版本上。
  // 虽然这条路径目前还不算直接可利用（`#...` 片段仍会以自己的子命令形式触发提示），
  // 但它仍然是一个纵深防御缺口，因为 shell-quote 会把 `#` 后面的内容从路径提取中丢掉。
  //
  // 需要排除 `${#`，因为那是 bash 的字符串长度语法（例如 `${#var}`）。
  // 注意：lookbehind 必须紧挨着 # 放置，而不是放在 \S 前面，
  // 这样它检查的才是正确的 2 字符窗口。
  const joined = unquotedKeepQuoteChars.replace(/\\+\n/g, match => {
    const backslashCount = match.length - 1
    return backslashCount % 2 === 1 ? '\\'.repeat(backslashCount - 1) : match
  })
  if (
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() with atom search: fast when # absent
    /\S(?<!\$\{)#/.test(unquotedKeepQuoteChars) ||
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
    /\S(?<!\$\{)#/.test(joined)
  ) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.MID_WORD_HASH,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains mid-word # which is parsed differently by shell-quote vs bash',
    }
  }
  return { behavior: 'passthrough', message: 'No mid-word hash' }
}

/**
 * 检测 `#` 注释中是否包含会让下游引号跟踪器失步的引号字符
 * （例如 extractQuotedContent）。
 *
 * 在 bash 里，一行中未加引号的 `#` 之后全部都是注释，注释中的引号字符只是普通文本，
 * 不会切换引号状态。但我们的引号跟踪函数并不理解 comment 语义，
 * 因此 `#` 之后出现的 `'` 或 `"` 仍会被当成状态切换。攻击者可以构造 `# ' "`
 * 这样的序列，精确地让跟踪器失步，导致后续内容（包括后续行）看起来像“仍在引号内”，
 * 而实际上在 bash 中它们已经是未加引号的普通内容。
 *
 * 攻击示例：
 *   echo "it's" # ' " <<'MARKER'\n
 *   rm -rf /\n
 *   MARKER
 * 在 bash 中：`#` 开始注释，因此第 2 行的 `rm -rf /` 会真正执行。
 * 在 extractQuotedContent 中：位置 14（位于 # 之后）的 `'` 会打开一个单引号，
 * MARKER 前面的 `'` 再把它关闭；但 MARKER 后面的 `'` 又会重新打开另一个单引号，
 * 从而把换行和 `rm -rf /` 都吞进引号里，最终让 validateNewlines 看不到任何未加引号的换行。
 *
 * 防御思路：如果我们看到未加引号的 `#` 后面在同一行里又跟了任意引号字符，
 * 就把它视为潜在的误解析风险。合法命令很少在注释里写引号；即便有，用户也可以手动批准。
 */
function validateCommentQuoteDesync(
  context: ValidationContext,
): PermissionResult {
  // Tree-sitter 路径：tree-sitter 能正确识别 comment 节点和带引号内容。
  // 这里担心的是基于正则的引号跟踪器会被注释里的引号字符搞乱。
  // 一旦 tree-sitter 提供了准确的引号上下文，这种失步就不可能发生，
  // 因为 AST 才是权威来源，无论命令中是否包含注释都一样。
  if (context.treeSitter) {
    return {
      behavior: 'passthrough',
      message: 'Tree-sitter quote context is authoritative',
    }
  }

  const { originalCommand } = context

  // 按字符跟踪引号状态，逻辑与 extractQuotedContent 保持一致。
  // 也就是说，单引号不会在双引号内部切换状态。
  // 当遇到未加引号的 `#` 时，就检查从这里到行尾的内容里是否还包含引号字符。
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (inDoubleQuote) {
      if (char === '"') inDoubleQuote = false
      // 双引号内部的单引号只是字面量，不会切换状态。
      continue
    }

    if (char === "'") {
      inSingleQuote = true
      continue
    }

    if (char === '"') {
      inDoubleQuote = true
      continue
    }

    // 未加引号的 `#`：在 bash 中它会开启一段注释。
    // 这里检查该行余下部分是否包含会让其他跟踪器失步的引号字符。
    if (char === '#') {
      const lineEnd = originalCommand.indexOf('\n', i)
      const commentText = originalCommand.slice(
        i + 1,
        lineEnd === -1 ? originalCommand.length : lineEnd,
      )
      if (/['"]/.test(commentText)) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.COMMENT_QUOTE_DESYNC,
        })
        return {
          behavior: 'ask',
          message:
            'Command contains quote characters inside a # comment which can desync quote tracking',
        }
      }
      // 直接跳到行尾，剩余部分都属于注释。
      if (lineEnd === -1) break
      i = lineEnd // Loop increment will move past newline
    }
  }

  return { behavior: 'passthrough', message: 'No comment quote desync' }
}

/**
 * 检测“引号字符串内部的换行”，且其下一行会被 stripCommentLines
 * 丢弃的情况（也就是 trim 后以 `#` 开头）。
 *
 * 在 bash 中，引号里的 `\n` 只是普通字面量字符，是参数的一部分。
 * 但 stripCommentLines（由 bashPermissions 中的 stripSafeWrappers 在路径校验和规则匹配前调用）
 * 会直接按 `command.split('\n')` 逐行处理命令，而且完全不跟踪引号状态。
 * 一旦攻击者把换行放进引号里，就可以让下一行在 trim 后以 `#` 开头，
 * 从而使 stripCommentLines 直接把整行删除，达到把敏感路径或参数
 * 从路径校验和权限规则匹配中隐藏起来的效果。
 *
 * 攻击示例（在 acceptEdits 模式、且没有任何 Bash 规则时会被自动放行）：
 *   mv ./decoy '<\n>#' ~/.ssh/id_rsa ./exfil_dir
 * Bash：会把 ./decoy 和 ~/.ssh/id_rsa 都移动到 ./exfil_dir/ 中（同时对 `\n#` 报错）。
 * stripSafeWrappers：第 2 行以 `#` 开头，于是被删除，只剩下 "mv ./decoy '"。
 * shell-quote：再把这个不平衡的尾部引号丢掉，得到 ["mv", "./decoy"]。
 * checkPathConstraints：只能看到 ./decoy（位于 cwd 中）→ passthrough。
 * acceptEdits 模式：mv 的路径都看起来在 cwd 里 → 直接 ALLOW。零点击、无警告。
 *
 * cp（外传）、rm/rm -rf（删除任意文件或目录）也能利用同一模式。
 *
 * 防御思路：只拦截 stripCommentLines 的这个特定触发条件，
 * 也就是“引号内部出现换行，且下一行 trim 后以 `#` 开头”。
 * 这是最小化的检查，既能抓到解析差异，又不会误伤合法的多行引号参数
 * （例如 echo 'line1\nline2'、grep 模式等）。
 * 安全 heredoc（如 $(cat <<'EOF'...)）以及 git commit -m "..."
 * 会被更早的 validator 处理，因此永远不会走到这里。
 *
 * 这个 validator 不属于 nonMisparsingValidators。它一旦返回 ask，
 * 就会带上 isBashSecurityCheckForMisparsing: true，进而在 bashPermissions.ts
 * 的权限流中更早阻断，避免任何逐行处理先行发生。
 */
function validateQuotedNewline(context: ValidationContext): PermissionResult {
  const { originalCommand } = context

  // 快速路径：命令里必须同时包含换行和 # 字符。
  // stripCommentLines 只会删除 trim().startsWith('#') 的行，
  // 因此没有 # 就不可能触发这个问题。
  if (!originalCommand.includes('\n') || !originalCommand.includes('#')) {
    return { behavior: 'passthrough', message: 'No newline or no hash' }
  }

  // 跟踪引号状态，逻辑与 extractQuotedContent / validateCommentQuoteDesync 保持一致：
  // - 单引号不会在双引号内部切换
  // - 反斜杠会转义下一个字符（但单引号内部除外）
  // stripCommentLines 只按 '\n' 分行，不认 \r，所以这里只把 \n 当作真正的分隔符。
  // 行内的 \r 会被 trim() 消掉，不影响“trim 后是否以 # 开头”的判断。
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // 如果引号内部出现换行，那么从 bash 的视角看，下一行其实仍然处在同一个引号字符串里。
    // 这里就要检查那一行是否会被 stripCommentLines 删除，
    // 也就是 trim() 之后是否以 `#` 开头。
    // 这与 lines.filter(l => !l.trim().startsWith('#')) 的行为完全一致。
    if (char === '\n' && (inSingleQuote || inDoubleQuote)) {
      const lineStart = i + 1
      const nextNewline = originalCommand.indexOf('\n', lineStart)
      const lineEnd = nextNewline === -1 ? originalCommand.length : nextNewline
      const nextLine = originalCommand.slice(lineStart, lineEnd)
      if (nextLine.trim().startsWith('#')) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.QUOTED_NEWLINE,
        })
        return {
          behavior: 'ask',
          message:
            'Command contains a quoted newline followed by a #-prefixed line, which can hide arguments from line-based permission checks',
        }
      }
    }
  }

  return { behavior: 'passthrough', message: 'No quoted newline-hash pattern' }
}

/**
 * 校验命令中是否使用了 Zsh 特有的危险命令，因为这些命令可能绕过安全检查。
 * 它们提供的能力包括加载模块、原始文件 I/O、网络访问以及伪终端执行等，
 * 都可能规避正常的权限控制。
 *
 * 这里也会捕获 `fc -e`，因为它可以通过 editor 执行任意历史命令；
 * 以及搭配 `-c` 使用的 `emulate`，它本质上等价于 eval。
 */
function validateZshDangerousCommands(
  context: ValidationContext,
): PermissionResult {
  const { originalCommand } = context

  // 从原始命令中提取基础命令，并剥掉前导空白、环境变量赋值、
  // 以及 Zsh 的 precommand modifier。
  // 例如："FOO=bar command builtin zmodload" -> "zmodload"
  const ZSH_PRECOMMAND_MODIFIERS = new Set([
    'command',
    'builtin',
    'noglob',
    'nocorrect',
  ])
  const trimmed = originalCommand.trim()
  const tokens = trimmed.split(/\s+/)
  let baseCmd = ''
  for (const token of tokens) {
    // 跳过环境变量赋值（VAR=value）。
    if (/^[A-Za-z_]\w*=/.test(token)) continue
    // 跳过 Zsh precommand modifier（它们不会改变真正执行的命令）。
    if (ZSH_PRECOMMAND_MODIFIERS.has(token)) continue
    baseCmd = token
    break
  }

  if (ZSH_DANGEROUS_COMMANDS.has(baseCmd)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message: `Command uses Zsh-specific '${baseCmd}' which can bypass security checks`,
    }
  }

  // 检查 `fc -e`。它允许通过 editor 执行任意命令。
  // 不带 -e 的 fc 是安全的（只是列出历史），而 -e 会指定一个 editor
  // 去处理命令，本质上等价于一次 eval。
  if (baseCmd === 'fc' && /\s-\S*e/.test(trimmed)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.ZSH_DANGEROUS_COMMANDS,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        "Command uses 'fc -e' which can execute arbitrary commands via editor",
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No Zsh dangerous commands',
  }
}

// 匹配那些在 shell 命令中几乎没有正当用途的不可打印控制字符：
// 0x00-0x08、0x0B-0x0C、0x0E-0x1F、0x7F。这里排除了制表符（0x09）、
// 换行（0x0A）和回车（0x0D），因为它们由其他 validator 负责处理。
// Bash 会静默丢弃 null byte，并忽略多数控制字符，因此攻击者可以借此把元字符
// 塞过我们的检查，而 bash 仍会实际执行它们（例如 "echo safe\x00; rm -rf /"）。
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/**
 * @deprecated 旧版 regex/shell-quote 路径。仅在 tree-sitter 不可用时启用。
 * 主入口校验现在是 parseForSecurity（ast.ts）。
 */
export function bashCommandIsSafe_DEPRECATED(
  command: string,
): PermissionResult {
  // 安全性：在任何其他处理之前，先拦截控制字符。
  // Bash 会静默丢弃 null byte 和其他不可打印字符，但这些字符会干扰我们的 validator，
  // 让紧邻它们的元字符有机会绕过检查。
  if (CONTROL_CHAR_RE.test(command)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains non-printable control characters that could be used to bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // 安全性：检测那些会利用 shell-quote 在单引号内错误处理反斜杠的 `\` 模式。
  // 这一步必须在 shell-quote 解析之前执行。
  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains single-quoted backslash pattern that could bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  // 安全性：在运行各类 security validator 之前，先剥掉 heredoc 的 body。
  // 这里只会剥离带引号或带转义的 delimiter（如 <<'EOF'、<<\EOF）对应的 body，
  // 因为这类 body 只是字面量文本，$()、反引号和 ${} 都不会展开。
  // 对于未加引号的 heredoc（<<EOF），shell 会进行完整展开，因此其 body 中可能包含
  // validator 必须看见的可执行命令替换。
  // 如果 extractHeredocs 放弃处理（无法安全解析），就让原始命令继续流经所有 validator，
  // 这是更安全的方向。
  const { processedCommand } = extractHeredocs(command, { quotedOnly: true })

  const baseCommand = command.split(' ')[0] || ''
  const { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars } =
    extractQuotedContent(processedCommand, baseCommand === 'jq')

  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
    treeSitter: null,
  }

  const earlyValidators = [
    validateEmpty,
    validateIncompleteCommands,
    validateSafeCommandSubstitution,
    validateGitCommit,
  ]

  for (const validator of earlyValidators) {
    const result = validator(context)
    if (result.behavior === 'allow') {
      return {
        behavior: 'passthrough',
        message:
          result.decisionReason?.type === 'other' ||
          result.decisionReason?.type === 'safetyCheck'
            ? result.decisionReason.reason
            : 'Command allowed',
      }
    }
    if (result.behavior !== 'passthrough') {
      return result.behavior === 'ask'
        ? { ...result, isBashSecurityCheckForMisparsing: true as const }
        : result
    }
  }

  // 这些 validator 不会设置 isBashSecurityCheckForMisparsing；
  // 它们返回的 ask 结果会走标准权限流程，而不是被提前拦截。
  // LF 换行和重定向都属于 splitCommand 可以正确处理的普通模式，
  // 不属于 misparsing 风险。
  //
  // 注意：validateCarriageReturn 不在这里，因为 CR 确实属于 misparsing 风险。
  // shell-quote 的 `[^\s]` 会把 CR 当作单词分隔符（JS 的 `\s` 包含 \r），
  // 但 bash 的 IFS 并不包含 CR。splitCommand 会把 CR 折叠成空格，这本身就是误解析。
  // 完整攻击链见 validateCarriageReturn。
  const nonMisparsingValidators = new Set([
    validateNewlines,
    validateRedirections,
  ])

  const validators = [
    validateJqCommand,
    validateObfuscatedFlags,
    validateShellMetacharacters,
    validateDangerousVariables,
    // 在 validateNewlines 之前执行 comment-quote-desync，
    // 因为它能捕获那些由于 # 注释导致引号跟踪器失步、从而漏掉换行的场景。
    validateCommentQuoteDesync,
    // 在 validateNewlines 之前执行 quoted-newline，
    // 因为它检测的是相反方向的问题：换行发生在引号内部，而 validateNewlines
    // 按设计会忽略这种情况。攻击者可以借助带引号换行把命令拆到多行，
    // 让基于行的处理（stripCommentLines）删除敏感内容。
    validateQuotedNewline,
    // CR 检查必须在 validateNewlines 之前执行。
    // CR 属于真正的 MISPARSING 风险（shell-quote 与 bash 在 tokenization 上存在差异），
    // 而 LF 不是。
    validateCarriageReturn,
    validateNewlines,
    validateIFSInjection,
    validateProcEnvironAccess,
    validateDangerousPatterns,
    validateRedirections,
    validateBackslashEscapedWhitespace,
    validateBackslashEscapedOperators,
    validateUnicodeWhitespace,
    validateMidWordHash,
    validateBraceExpansion,
    validateZshDangerousCommands,
    // malformed token 检查要放在最后执行，
    // 因为其他 validator 应优先捕获更具体的模式（例如 $() 替换、反引号等），
    // 它们能给出更精确的错误信息。
    validateMalformedTokenInjection,
  ]

  // 安全性：如果列表后面还存在 misparsing validator，
  // 那么当某个 non-misparsing validator 返回 `ask` 时，绝对不能立刻短路返回。
  // non-misparsing 的 ask 结果会在 bashPermissions.ts:~1301-1303 被丢弃
  // （只有带 isBashSecurityCheckForMisparsing 标记的结果才会触发阻断）。
  // 如果 validateRedirections（索引 10，non-misparsing）先因为 `>` 命中，
  // 它返回的会是不带标记的 ask；但后面的 validateBackslashEscapedOperators
  // （索引 12，misparsing）本来还可以带着标记捕获 `\;`。一旦提前短路，
  // 类似 `cat safe.txt \; echo /etc/passwd > ./out` 的 payload 就会漏过去。
  //
  // 修复策略：把 non-misparsing 的 ask 结果先延后保存，继续跑后续 validator；
  // 只要任何 misparsing validator 命中，就返回那个“带标记”的结果。
  // 只有一路跑到结束、仍未出现 misparsing ask 时，才返回延后的 non-misparsing ask。
  let deferredNonMisparsingResult: PermissionResult | null = null
  for (const validator of validators) {
    const result = validator(context)
    if (result.behavior === 'ask') {
      if (nonMisparsingValidators.has(validator)) {
        if (deferredNonMisparsingResult === null) {
          deferredNonMisparsingResult = result
        }
        continue
      }
      return { ...result, isBashSecurityCheckForMisparsing: true as const }
    }
  }
  if (deferredNonMisparsingResult !== null) {
    return deferredNonMisparsingResult
  }

  return {
    behavior: 'passthrough',
    message: 'Command passed all security checks',
  }
}

/**
 * @deprecated 旧版 regex/shell-quote 路径。仅在 tree-sitter 不可用时使用。
 * 当前主要入口校验是 parseForSecurity（ast.ts）。
 *
 * bashCommandIsSafe 的异步版本：如果 tree-sitter 可用，就利用它做更精确的解析；
 * 如果不可用，则回退到同步的 regex 版本。
 *
 * 这个版本应由异步调用方使用（如 bashPermissions.ts、bashCommandHelpers.ts）。
 * 同步调用方（如 readOnlyValidation.ts）应继续使用 bashCommandIsSafe()。
 */
export async function bashCommandIsSafeAsync_DEPRECATED(
  command: string,
  onDivergence?: () => void,
): Promise<PermissionResult> {
  // 尝试获取 tree-sitter 分析结果。
  const parsed = await ParsedCommand.parse(command)
  const tsAnalysis = parsed?.getTreeSitterAnalysis() ?? null

  // 如果拿不到 tree-sitter，就回退到同步版本。
  if (!tsAnalysis) {
    return bashCommandIsSafe_DEPRECATED(command)
  }

  // 运行与同步版相同的安全检查，但上下文会注入 tree-sitter 提供的额外信息。
  // 前置检查（控制字符、shell-quote bug）并不会从 tree-sitter 中获益，
  // 所以这部分逻辑与同步版保持一致。
  if (CONTROL_CHAR_RE.test(command)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.CONTROL_CHARACTERS,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains non-printable control characters that could be used to bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  if (hasShellQuoteSingleQuoteBug(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains single-quoted backslash pattern that could bypass security checks',
      isBashSecurityCheckForMisparsing: true,
    }
  }

  const { processedCommand } = extractHeredocs(command, { quotedOnly: true })

  const baseCommand = command.split(' ')[0] || ''

  // 使用 tree-sitter 的引号上下文，以获得更精确的分析结果。
  const tsQuote = tsAnalysis.quoteContext
  const regexQuote = extractQuotedContent(
    processedCommand,
    baseCommand === 'jq',
  )

  // 以 tree-sitter 的引号上下文为主，但仍保留 regex 结果作为参考，
  // 用于记录两者分歧。
  const withDoubleQuotes = tsQuote.withDoubleQuotes
  const fullyUnquoted = tsQuote.fullyUnquoted
  const unquotedKeepQuoteChars = tsQuote.unquotedKeepQuoteChars

  const context: ValidationContext = {
    originalCommand: command,
    baseCommand,
    unquotedContent: withDoubleQuotes,
    fullyUnquotedContent: stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip: fullyUnquoted,
    unquotedKeepQuoteChars,
    treeSitter: tsAnalysis,
  }

  // 记录 tree-sitter 与 regex 在引号提取上的分歧。
  // heredoc 命令要跳过：tree-sitter 会把（带引号的）heredoc body 直接剥成空，
  // 而 regex 路径则会通过 extractHeredocs 把它替换成占位字符串，
  // 因此两者结果注定不一致。如果每个 heredoc 命令都记录分歧，只会污染信号。
  //
  // onDivergence 回调：当它在 fanout 循环里被调用时
  // （如 bashPermissions.ts 中对各子命令做 Promise.all），
  // 调用方会把多次分歧合并成一次 logEvent，而不是触发 N 次独立上报。
  // 因为每次 logEvent 都会触发 getEventMetadata() → buildProcessMetrics() →
  // process.memoryUsage() → /proc/self/stat 读取；即便 metadata 已缓存，
  // 这些操作仍会以微任务形式堆积，进而饿死事件循环（CC-643）。
  // 单命令调用方则不会传这个回调，仍保留原来“每次直接 logEvent”的行为。
  if (!tsAnalysis.dangerousPatterns.hasHeredoc) {
    const hasDivergence =
      tsQuote.fullyUnquoted !== regexQuote.fullyUnquoted ||
      tsQuote.withDoubleQuotes !== regexQuote.withDoubleQuotes
    if (hasDivergence) {
      if (onDivergence) {
        onDivergence()
      } else {
        logEvent('tengu_tree_sitter_security_divergence', {
          quoteContextDivergence: true,
        })
      }
    }
  }

  const earlyValidators = [
    validateEmpty,
    validateIncompleteCommands,
    validateSafeCommandSubstitution,
    validateGitCommit,
  ]

  for (const validator of earlyValidators) {
    const result = validator(context)
    if (result.behavior === 'allow') {
      return {
        behavior: 'passthrough',
        message:
          result.decisionReason?.type === 'other' ||
          result.decisionReason?.type === 'safetyCheck'
            ? result.decisionReason.reason
            : 'Command allowed',
      }
    }
    if (result.behavior !== 'passthrough') {
      return result.behavior === 'ask'
        ? { ...result, isBashSecurityCheckForMisparsing: true as const }
        : result
    }
  }

  const nonMisparsingValidators = new Set([
    validateNewlines,
    validateRedirections,
  ])

  const validators = [
    validateJqCommand,
    validateObfuscatedFlags,
    validateShellMetacharacters,
    validateDangerousVariables,
    validateCommentQuoteDesync,
    validateQuotedNewline,
    validateCarriageReturn,
    validateNewlines,
    validateIFSInjection,
    validateProcEnvironAccess,
    validateDangerousPatterns,
    validateRedirections,
    validateBackslashEscapedWhitespace,
    validateBackslashEscapedOperators,
    validateUnicodeWhitespace,
    validateMidWordHash,
    validateBraceExpansion,
    validateZshDangerousCommands,
    validateMalformedTokenInjection,
  ]

  let deferredNonMisparsingResult: PermissionResult | null = null
  for (const validator of validators) {
    const result = validator(context)
    if (result.behavior === 'ask') {
      if (nonMisparsingValidators.has(validator)) {
        if (deferredNonMisparsingResult === null) {
          deferredNonMisparsingResult = result
        }
        continue
      }
      return { ...result, isBashSecurityCheckForMisparsing: true as const }
    }
  }
  if (deferredNonMisparsingResult !== null) {
    return deferredNonMisparsingResult
  }

  return {
    behavior: 'passthrough',
    message: 'Command passed all security checks',
  }
}
