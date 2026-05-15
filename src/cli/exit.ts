/**
 * 供子命令处理器使用的 CLI 退出辅助函数。
 *
 * 将那段 4-5 行的“print + lint-suppress + exit”代码块收敛起来，
 * 这段代码此前在 `claude mcp *` / `claude plugin *` handlers 中被复制粘贴了约 60 次。
 * `: never` 返回类型让 TypeScript 能在调用点收窄控制流，
 * 无需额外写尾部 `return`。
 */
/* eslint-disable custom-rules/no-process-exit -- centralized CLI exit point */

// `return undefined as never`（不是 exit 之后再 throw）—— tests 会 spy on
// process.exit 并让它返回。调用点会写成 `return cliError(...)`，
// 这样后续代码就不会在 mock 环境下解引用已被收窄掉的值。
// cliError 使用 console.error（tests 会 spy on console.error）；cliOk 使用
// process.stdout.write（tests 会 spy on process.stdout.write，而 Bun 的 console.log
// 不会走到被 spy 的 process.stdout.write）。

/** 将错误消息写入 stderr（如果提供），并以退出码 1 退出。 */
export function cliError(msg?: string): never {
  // biome-ignore lint/suspicious/noConsole: centralized CLI error output
  if (msg) console.error(msg)
  process.exit(1)
  return undefined as never
}

/** 将消息写入 stdout（如果提供），并以退出码 0 退出。 */
export function cliOk(msg?: string): never {
  if (msg) process.stdout.write(msg + '\n')
  process.exit(0)
  return undefined as never
}
