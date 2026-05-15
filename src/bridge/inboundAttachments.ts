/**
 * 解析 inbound bridge 用户消息中的 file_uuid 附件。
 *
 * Web composer 通过基于 cookie 鉴权的 /api/{org}/upload 上传文件，并在消息中
 * 携带 file_uuid。这里会通过 GET /api/oauth/files/{uuid}/content 逐个拉取
 * （同一存储，基于 OAuth 鉴权），写入 ~/.claude/uploads/{sessionId}/，然后
 * 返回待追加的 @path 引用。之后由 Claude 的 Read tool 接手处理。
 *
 * Best-effort：任何失败（无 token、网络、非 2xx、磁盘）都会记调试日志并
 * 跳过该附件。消息仍会送达 Claude，只是没有对应的 @path。
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import axios from 'axios'
import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { z } from 'zod/v4'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { lazySchema } from '../utils/lazySchema.js'
import { getBridgeAccessToken, getBridgeBaseUrl } from './bridgeConfig.js'

const DOWNLOAD_TIMEOUT_MS = 30_000

function debug(msg: string): void {
  logForDebugging(`[bridge:inbound-attach] ${msg}`)
}

const attachmentSchema = lazySchema(() =>
  z.object({
    file_uuid: z.string(),
    file_name: z.string(),
  }),
)
const attachmentsArraySchema = lazySchema(() => z.array(attachmentSchema()))

export type InboundAttachment = z.infer<ReturnType<typeof attachmentSchema>>

/** 从宽松类型的 inbound message 中提取 file_attachments。 */
export function extractInboundAttachments(msg: unknown): InboundAttachment[] {
  if (typeof msg !== 'object' || msg === null || !('file_attachments' in msg)) {
    return []
  }
  const parsed = attachmentsArraySchema().safeParse(msg.file_attachments)
  return parsed.success ? parsed.data : []
}

/**
 * 去除路径部分，仅保留文件名安全字符。file_name 来自网络
 * （web composer），即使它由 composer 控制，也要视为不可信输入。
 */
function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base || 'attachment'
}

function uploadsDir(): string {
  return join(getClaudeConfigHomeDir(), 'uploads', getSessionId())
}

/**
 * 拉取并写入单个附件。成功时返回绝对路径，任意失败则返回 undefined。
 */
async function resolveOne(att: InboundAttachment): Promise<string | undefined> {
  const token = getBridgeAccessToken()
  if (!token) {
    debug('skip: no oauth token')
    return undefined
  }

  let data: Buffer
  try {
    // getOauthConfig()（经由 getBridgeBaseUrl）在遇到不在 allowlist 中的
    // CLAUDE_CODE_CUSTOM_OAUTH_URL 时会抛错。把它放在 try 里，这样错误的
    // FedStart URL 只会退化为“没有 @path”，而不会让 print.ts 的 reader loop
    // 直接崩掉（那里对 await 没有 catch）。
    const url = `${getBridgeBaseUrl()}/api/oauth/files/${encodeURIComponent(att.file_uuid)}/content`
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
      validateStatus: () => true,
    })
    if (response.status !== 200) {
      debug(`fetch ${att.file_uuid} failed: status=${response.status}`)
      return undefined
    }
    data = Buffer.from(response.data)
  } catch (e) {
    debug(`fetch ${att.file_uuid} threw: ${e}`)
    return undefined
  }

  // uuid 前缀可避免跨消息和单条消息内部的碰撞
  // （同名文件但内容不同）。8 个字符足够，这不是安全场景。
  const safeName = sanitizeFileName(att.file_name)
  const prefix = (
    att.file_uuid.slice(0, 8) || randomUUID().slice(0, 8)
  ).replace(/[^a-zA-Z0-9_-]/g, '_')
  const dir = uploadsDir()
  const outPath = join(dir, `${prefix}-${safeName}`)

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(outPath, data)
  } catch (e) {
    debug(`write ${outPath} failed: ${e}`)
    return undefined
  }

  debug(`resolved ${att.file_uuid} → ${outPath} (${data.length} bytes)`)
  return outPath
}

/**
 * 将 inbound message 上的所有附件解析为 @path 引用前缀字符串。
 * 如果一个都没解析成功，则返回空字符串。
 */
export async function resolveInboundAttachments(
  attachments: InboundAttachment[],
): Promise<string> {
  if (attachments.length === 0) return ''
  debug(`resolving ${attachments.length} attachment(s)`)
  const paths = await Promise.all(attachments.map(resolveOne))
  const ok = paths.filter((p): p is string => p !== undefined)
  if (ok.length === 0) return ''
  // 使用带引号的形式。extractAtMentionedFiles 会在第一个空格处截断未加引号的
  // @ref，这会破坏包含空格的 home dir（例如 /Users/John Smith/）。
  return ok.map(p => `@"${p}"`).join(' ') + ' '
}

/**
 * 无论 content 是哪种形式，都在前面追加 @path 引用。
 * 目标是最后一个 text block。processUserInputBase 会从
 * processedBlocks[processedBlocks.length - 1] 读取 inputString，因此如果把
 * refs 放进 block[0]，对于 [text, image] 这类内容它们会被静默忽略。
 */
export function prependPathRefs(
  content: string | Array<ContentBlockParam>,
  prefix: string,
): string | Array<ContentBlockParam> {
  if (!prefix) return content
  if (typeof content === 'string') return prefix + content
  const i = content.findLastIndex(b => b.type === 'text')
  if (i !== -1) {
    const b = content[i]!
    if (b.type === 'text') {
      return [
        ...content.slice(0, i),
        { ...b, text: prefix + b.text },
        ...content.slice(i + 1),
      ]
    }
  }
  // 没有 text block，则在末尾追加一个，确保它位于最后。
  return [...content, { type: 'text', text: prefix.trimEnd() }]
}

/**
 * 便捷封装：extract + resolve + prepend。当消息没有 file_attachments 字段时，
 * 直接 no-op（快速路径：不走网络，返回同一个引用）。
 */
export async function resolveAndPrepend(
  msg: unknown,
  content: string | Array<ContentBlockParam>,
): Promise<string | Array<ContentBlockParam>> {
  const attachments = extractInboundAttachments(msg)
  if (attachments.length === 0) return content
  const prefix = await resolveInboundAttachments(attachments)
  return prependPathRefs(content, prefix)
}
