/**
 * 如果 bash 命令的第一行是 `# comment`（而不是 `#!` shebang），
 * 则返回去掉 `#` 前缀后的注释文本；否则返回 undefined。
 *
 * 在全屏模式下，它既是非 verbose 的 tool-use 标签，
 * 也是 collapse-group 的 ⎿ 提示，也就是 Claude 写给人类看的那段说明。
 */
export function extractBashCommentLabel(command: string): string | undefined {
  const nl = command.indexOf('\n')
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim()
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined
  return firstLine.replace(/^#+\s*/, '') || undefined
}
