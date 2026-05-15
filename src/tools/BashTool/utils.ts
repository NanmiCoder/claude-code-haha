import type {
  Base64ImageSource,
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { readFile, stat } from 'fs/promises'
import { getOriginalCwd } from 'src/bootstrap/state.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import { getCwd } from 'src/utils/cwd.js'
import { pathInAllowedWorkingPath } from 'src/utils/permissions/filesystem.js'
import { setCwd } from 'src/utils/Shell.js'
import { shouldMaintainProjectWorkingDir } from '../../utils/envUtils.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { getMaxOutputLength } from '../../utils/shell/outputLimits.js'
import { countCharInString, plural } from '../../utils/stringUtils.js'
/**
 * 去掉开头和结尾那些只包含空白字符/换行的行。
 * 与 trim() 不同，它会保留内容行内部的空白，只删除首尾完全空白的行。
 */
export function stripEmptyLines(content: string): string {
  const lines = content.split('\n')

  // 找到第一条非空行。
  let startIndex = 0
  while (startIndex < lines.length && lines[startIndex]?.trim() === '') {
    startIndex++
  }

  // 找到最后一条非空行。
  let endIndex = lines.length - 1
  while (endIndex >= 0 && lines[endIndex]?.trim() === '') {
    endIndex--
  }

  // 如果所有行都为空，则返回空字符串。
  if (startIndex > endIndex) {
    return ''
  }

  // 返回包含非空行的切片。
  return lines.slice(startIndex, endIndex + 1).join('\n')
}

/**
 * 检查内容是否是 base64 编码的图片 data URL。
 */
export function isImageOutput(content: string): boolean {
  return /^data:image\/[a-z0-9.+_-]+;base64,/i.test(content)
}

const DATA_URI_RE = /^data:([^;]+);base64,(.+)$/

/**
 * 将 data-URI 字符串解析为 media type 与 base64 payload。
 * 匹配前会先对输入执行 trim。
 */
export function parseDataUri(
  s: string,
): { mediaType: string; data: string } | null {
  const match = s.trim().match(DATA_URI_RE)
  if (!match || !match[1] || !match[2]) return null
  return { mediaType: match[1], data: match[2] }
}

/**
 * 从 shell stdout 中包含的 data URI 构建 image 类型的 tool_result block。
 * 如果解析失败则返回 null，让调用方回退到文本处理流程。
 */
export function buildImageToolResult(
  stdout: string,
  toolUseID: string,
): ToolResultBlockParam | null {
  const parsed = parseDataUri(stdout)
  if (!parsed) return null
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: parsed.mediaType as Base64ImageSource['media_type'],
          data: parsed.data,
        },
      },
    ],
  }
}

// 文件读取上限为 20 MB。任何超过这个大小的图片 data URI 都远超 API 可接受范围
// （base64 后 5 MB），而且读入内存时也很容易触发 OOM。
const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024

/**
 * 重新调整 shell tool 输出的图片尺寸。
 * 当从 shell 输出文件中回读 stdout 时，内容会被 getMaxOutputLength() 截断；
 * 如果完整输出已经溢写到磁盘，就必须从磁盘重新读回来，否则被截断的 base64
 * 会解码成损坏图片，要么在这里报错，要么被 API 拒收。
 * 这里还会限制图片尺寸：compressImageBuffer 只检查字节大小，
 * 因此某些“字节不大但 DPI 很高”的 PNG（例如 matplotlib 的 dpi=300）
 * 会以完整分辨率漏过去，从而污染多图请求（CC-304）。
 *
 * 成功时返回重新编码后的 data URI；如果源内容本身无法解析为 data URI，
 * 则返回 null（是否把 isImage 翻回去由调用方决定）。
 */
export async function resizeShellImageOutput(
  stdout: string,
  outputFilePath: string | undefined,
  outputFileSize: number | undefined,
): Promise<string | null> {
  let source = stdout
  if (outputFilePath) {
    const size = outputFileSize ?? (await stat(outputFilePath)).size
    if (size > MAX_IMAGE_FILE_SIZE) return null
    source = await readFile(outputFilePath, 'utf8')
  }
  const parsed = parseDataUri(source)
  if (!parsed) return null
  const buf = Buffer.from(parsed.data, 'base64')
  const ext = parsed.mediaType.split('/')[1] || 'png'
  const resized = await maybeResizeAndDownsampleImageBuffer(
    buf,
    buf.length,
    ext,
  )
  return `data:image/${resized.mediaType};base64,${resized.buffer.toString('base64')}`
}

export function formatOutput(content: string): {
  totalLines: number
  truncatedContent: string
  isImage?: boolean
} {
  const isImage = isImageOutput(content)
  if (isImage) {
    return {
      totalLines: 1,
      truncatedContent: content,
      isImage,
    }
  }

  const maxOutputLength = getMaxOutputLength()
  if (content.length <= maxOutputLength) {
    return {
      totalLines: countCharInString(content, '\n') + 1,
      truncatedContent: content,
      isImage,
    }
  }

  const truncatedPart = content.slice(0, maxOutputLength)
  const remainingLines = countCharInString(content, '\n', maxOutputLength) + 1
  const truncated = `${truncatedPart}\n\n... [${remainingLines} lines truncated] ...`

  return {
    totalLines: countCharInString(content, '\n') + 1,
    truncatedContent: truncated,
    isImage,
  }
}

export const stdErrAppendShellResetMessage = (stderr: string): string =>
  `${stderr.trim()}\nShell cwd was reset to ${getOriginalCwd()}`

export function resetCwdIfOutsideProject(
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const cwd = getCwd()
  const originalCwd = getOriginalCwd()
  const shouldMaintain = shouldMaintainProjectWorkingDir()
  if (
    shouldMaintain ||
    // 快路径：originalCwd 一定存在于 allWorkingDirectories 中
    // （见 filesystem.ts），因此当 cwd 没变时，pathInAllowedWorkingPath
    // 必然为真，可以跳过其系统调用，优化“没有 cd”的常见路径。
    (cwd !== originalCwd &&
      !pathInAllowedWorkingPath(cwd, toolPermissionContext))
  ) {
    // 如果要求维持项目目录，或当前目录已跑到允许工作目录之外，就重置回原目录。
    setCwd(originalCwd)
    if (!shouldMaintain) {
      logEvent('tengu_bash_tool_reset_to_original_dir', {})
      return true
    }
  }
  return false
}

/**
 * 为结构化内容块生成一段适合人读的摘要。
 * 用于在 UI 中展示同时包含图片和文本的 MCP 结果。
 */
export function createContentSummary(content: ContentBlockParam[]): string {
  const parts: string[] = []
  let textCount = 0
  let imageCount = 0

  for (const block of content) {
    if (block.type === 'image') {
      imageCount++
    } else if (block.type === 'text' && 'text' in block) {
      textCount++
      // 带上文本块的前 200 个字符，作为上下文预览。
      const preview = block.text.slice(0, 200)
      parts.push(preview + (block.text.length > 200 ? '...' : ''))
    }
  }

  const summary: string[] = []
  if (imageCount > 0) {
    summary.push(`[${imageCount} ${plural(imageCount, 'image')}]`)
  }
  if (textCount > 0) {
    summary.push(`[${textCount} text ${plural(textCount, 'block')}]`)
  }

  return `MCP Result: ${summary.join(', ')}${parts.length > 0 ? '\n\n' + parts.join('\n\n') : ''}`
}
