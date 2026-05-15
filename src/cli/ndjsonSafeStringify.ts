import { jsonStringify } from '../utils/slowOperations.js'

// JSON.stringify 会原样输出 U+2028/U+2029（按 ECMA-404 属于合法内容）。当
// 输出是一行 NDJSON 时，任何使用 JavaScript
// 行终止符语义（ECMA-262 §11.3 —— \n \r U+2028 U+2029）来
// 切分流的接收方，都会在 JSON 字符串中间把它截断。ProcessTransport 现在
// 会静默跳过非 JSON 行而不是崩溃（gh-28405），但
// 被截断的片段仍然会丢失——这条消息会被静默丢弃。
//
// \uXXXX 形式是等价 JSON（解析后仍是同一个字符串），但
// 任何接收方都不可能把它误判为行终止符。这也是
// ES2019 的 "Subsume JSON" 提案和 Node 的 util.inspect 的做法。
//
// 使用带 alternation 的单个 regex：每次匹配只分发一次 callback，
// 比完整扫描两遍整个字符串更便宜。
const JS_LINE_TERMINATORS = /\u2028|\u2029/g

function escapeJsLineTerminators(json: string): string {
  return json.replace(JS_LINE_TERMINATORS, c =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  )
}

/**
 * 面向单消息单行 transport 的 JSON.stringify。会转义 U+2028
 * LINE SEPARATOR 和 U+2029 PARAGRAPH SEPARATOR，确保序列化输出
 * 不会被按行切分的接收方打断。输出仍然是合法的
 * JSON，解析结果也保持不变。
 */
export function ndjsonSafeStringify(value: unknown): string {
  return escapeJsLineTerminators(jsonStringify(value))
}
