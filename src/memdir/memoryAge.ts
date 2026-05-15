/**
 * 自 mtime 以来经过的天数。向下取整——今天为 0，昨天为 1，
 * 更早则为 2+。负输入（未来的 mtime、时钟偏差）
 * 会被钳制为 0。
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000))
}

/**
 * 人类可读的年龄字符串。模型不擅长做日期运算——
 * 原始 ISO 时间戳无法像
 * “47 days ago” 那样触发过时性推理。
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}

/**
 * 面向超过 1 天的 memories 的纯文本过时提醒。对新鲜的
 *（今天/昨天）memory 返回 ''——此时再提醒只会产生噪音。
 *
 * 当消费方已经提供了自己的包裹层时使用它
 *（例如 messages.ts 的 relevant_memories → wrapMessagesInSystemReminder）。
 *
 * 这来自用户报告：过期的代码状态 memory（引用已经变更的代码 file:line）
 * 会被当作事实来断言——而 citation 只会让这类过时 claim 听起来更权威，
 * 而不是更不可靠。
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return ''
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}

/**
 * 按 memory 单条生成的过时提醒，并包裹在 <system-reminder> 标签中。
 * 对于 ≤ 1 天的 memory 返回 ''。用于那些不会自行添加
 * system-reminder 包裹层的调用方（例如 FileReadTool 输出）。
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs)
  if (!text) return ''
  return `<system-reminder>${text}</system-reminder>\n`
}
