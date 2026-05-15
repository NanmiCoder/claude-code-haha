import supportsHyperlinksLib from 'supports-hyperlinks'

// 额外补充一些支持 OSC 8 超链接、但不会被 supports-hyperlinks 检测到的终端。
// 会同时检查 TERM_PROGRAM 与 LC_TERMINAL（后者在 tmux 中会被保留下来）。
export const ADDITIONAL_HYPERLINK_TERMINALS = [
  'ghostty',
  'Hyper',
  'kitty',
  'alacritty',
  'iTerm.app',
  'iTerm2',
]

type EnvLike = Record<string, string | undefined>

type SupportsHyperlinksOptions = {
  env?: EnvLike
  stdoutSupported?: boolean
}

/**
 * 返回 stdout 是否支持 OSC 8 超链接。
 * 在 supports-hyperlinks 库的基础上补充了额外的终端检测逻辑。
 * @param options 供测试使用的可选覆盖项（env、stdoutSupported）
 */
export function supportsHyperlinks(
  options?: SupportsHyperlinksOptions,
): boolean {
  const stdoutSupported =
    options?.stdoutSupported ?? supportsHyperlinksLib.stdout
  if (stdoutSupported) {
    return true
  }

  const env = options?.env ?? process.env

  // 检查那些不会被 supports-hyperlinks 检测到的额外终端
  const termProgram = env['TERM_PROGRAM']
  if (termProgram && ADDITIONAL_HYPERLINK_TERMINALS.includes(termProgram)) {
    return true
  }

  // 一些终端（例如 iTerm2）会设置 LC_TERMINAL，且它在 tmux 内部也会被保留；
  // 而 TERM_PROGRAM 在 tmux 中会被改写为 'tmux'。
  const lcTerminal = env['LC_TERMINAL']
  if (lcTerminal && ADDITIONAL_HYPERLINK_TERMINALS.includes(lcTerminal)) {
    return true
  }

  // Kitty 会设置 TERM=xterm-kitty
  const term = env['TERM']
  if (term?.includes('kitty')) {
    return true
  }

  return false
}
