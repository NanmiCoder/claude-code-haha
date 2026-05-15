import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { detectImageFormatFromBase64 } from '../utils/imageResizer.js'

/**
 * 处理来自 bridge 的入站用户消息，提取其中的 content 与 UUID，
 * 供后续入队使用。既支持字符串内容，也支持
 * ContentBlockParam[]（例如包含图片的消息）。
 *
 * 会对 bridge 客户端发来的图片块做归一化处理；某些客户端可能使用 camelCase 的
 * `mediaType`，而不是 snake_case 的 `media_type`（mobile-apps#5825）。
 *
 * 返回提取出的字段；如果消息应被跳过
 * （例如不是 user 类型，或内容缺失/为空），则返回 undefined。
 */
export function extractInboundMessageFields(
  msg: SDKMessage,
):
  | { content: string | Array<ContentBlockParam>; uuid: UUID | undefined }
  | undefined {
  if (msg.type !== 'user') return undefined
  const content = msg.message?.content
  if (!content) return undefined
  if (Array.isArray(content) && content.length === 0) return undefined

  const uuid =
    'uuid' in msg && typeof msg.uuid === 'string'
      ? (msg.uuid as UUID)
      : undefined

  return {
    content: Array.isArray(content) ? normalizeImageBlocks(content) : content,
    uuid,
  }
}

/**
 * 归一化来自 bridge 客户端的图片内容块。iOS/web 客户端可能会发送
 * `mediaType`（camelCase）而不是 `media_type`（snake_case），
 * 也可能完全省略该字段。如果不做归一化，这个坏块会污染整个 session，
 * 导致后续每一次 API 调用都因为
 * "media_type: Field required" 而失败。
 *
 * 快路径扫描会在无需归一化时直接返回原数组引用，
 * 从而让 happy path 保持零额外分配。
 */
export function normalizeImageBlocks(
  blocks: Array<ContentBlockParam>,
): Array<ContentBlockParam> {
  if (!blocks.some(isMalformedBase64Image)) return blocks

  return blocks.map(block => {
    if (!isMalformedBase64Image(block)) return block
    const src = block.source as unknown as Record<string, unknown>
    const mediaType =
      typeof src.mediaType === 'string' && src.mediaType
        ? src.mediaType
        : detectImageFormatFromBase64(block.source.data)
    return {
      ...block,
      source: {
        type: 'base64' as const,
        media_type: mediaType as Base64ImageSource['media_type'],
        data: block.source.data,
      },
    }
  })
}

function isMalformedBase64Image(
  block: ContentBlockParam,
): block is ImageBlockParam & { source: Base64ImageSource } {
  if (block.type !== 'image' || block.source?.type !== 'base64') return false
  return !(block.source as unknown as Record<string, unknown>).media_type
}
