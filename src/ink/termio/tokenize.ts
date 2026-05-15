/**
 * 输入 Tokenizer - 转义序列边界检测
 *
 * 将终端输入切分为 token：文本片段和原始转义序列。
 * 与负责语义解释的 Parser 不同，这里只负责识别边界，供键盘输入解析使用。
 */

import { C0, ESC_TYPE, isEscFinal } from './ansi.js'
import { isCSIFinal, isCSIIntermediate, isCSIParam } from './csi.js'

export type Token =
  | { type: 'text'; value: string }
  | { type: 'sequence'; value: string }

type State =
  | 'ground'
  | 'escape'
  | 'escapeIntermediate'
  | 'csi'
  | 'ss3'
  | 'osc'
  | 'dcs'
  | 'apc'

export type Tokenizer = {
  /** 输入数据并获取产生的 token */
  feed(input: string): Token[]
  /** 刷出所有缓冲中的不完整序列 */
  flush(): Token[]
  /** 重置 tokenizer 状态 */
  reset(): void
  /** 获取当前缓冲中的不完整序列 */
  buffer(): string
}

type TokenizerOptions = {
  /**
   * 将 `CSI M` 视为 X10 鼠标事件前缀，并额外消耗 3 个 payload 字节。
   * 仅应在 stdin 输入中启用，因为在输出流里 `\x1b[M` 同时也是 CSI DL
   *（Delete Lines）；若在那里启用，会把显示文本吞掉。默认值为 false。
   */
  x10Mouse?: boolean
}

/**
 * 为终端输入创建一个流式 tokenizer。
 *
 * 用法：
 * ```typescript
 * const tokenizer = createTokenizer()
 * const tokens1 = tokenizer.feed('hello\x1b[')
 * const tokens2 = tokenizer.feed('A')  // completes the escape sequence
 * const remaining = tokenizer.flush()  // force output incomplete sequences
 * ```
 */
export function createTokenizer(options?: TokenizerOptions): Tokenizer {
  let currentState: State = 'ground'
  let currentBuffer = ''
  const x10Mouse = options?.x10Mouse ?? false

  return {
    feed(input: string): Token[] {
      const result = tokenize(
        input,
        currentState,
        currentBuffer,
        false,
        x10Mouse,
      )
      currentState = result.state.state
      currentBuffer = result.state.buffer
      return result.tokens
    },

    flush(): Token[] {
      const result = tokenize('', currentState, currentBuffer, true, x10Mouse)
      currentState = result.state.state
      currentBuffer = result.state.buffer
      return result.tokens
    },

    reset(): void {
      currentState = 'ground'
      currentBuffer = ''
    },

    buffer(): string {
      return currentBuffer
    },
  }
}

type InternalState = {
  state: State
  buffer: string
}

function tokenize(
  input: string,
  initialState: State,
  initialBuffer: string,
  flush: boolean,
  x10Mouse: boolean,
): { tokens: Token[]; state: InternalState } {
  const tokens: Token[] = []
  const result: InternalState = {
    state: initialState,
    buffer: '',
  }

  const data = initialBuffer + input
  let i = 0
  let textStart = 0
  let seqStart = 0

  const flushText = (): void => {
    if (i > textStart) {
      const text = data.slice(textStart, i)
      if (text) {
        tokens.push({ type: 'text', value: text })
      }
    }
    textStart = i
  }

  const emitSequence = (seq: string): void => {
    if (seq) {
      tokens.push({ type: 'sequence', value: seq })
    }
    result.state = 'ground'
    textStart = i
  }

  while (i < data.length) {
    const code = data.charCodeAt(i)

    switch (result.state) {
      case 'ground':
        if (code === C0.ESC) {
          flushText()
          seqStart = i
          result.state = 'escape'
          i++
        } else {
          i++
        }
        break

      case 'escape':
        if (code === ESC_TYPE.CSI) {
          result.state = 'csi'
          i++
        } else if (code === ESC_TYPE.OSC) {
          result.state = 'osc'
          i++
        } else if (code === ESC_TYPE.DCS) {
          result.state = 'dcs'
          i++
        } else if (code === ESC_TYPE.APC) {
          result.state = 'apc'
          i++
        } else if (code === 0x4f) {
          // 'O' - SS3
          result.state = 'ss3'
          i++
        } else if (isCSIIntermediate(code)) {
          // 中间字节（例如用于字符集的 ESC (）- 继续缓冲
          result.state = 'escapeIntermediate'
          i++
        } else if (isEscFinal(code)) {
          // 双字符转义序列
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (code === C0.ESC) {
          // 双 ESC - 先发出前一个，再开始新的序列
          emitSequence(data.slice(seqStart, i))
          seqStart = i
          result.state = 'escape'
          i++
        } else {
          // 无效，按普通文本处理 ESC
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'escapeIntermediate':
        // 读到中间字节后，继续等待结束字节
        if (isCSIIntermediate(code)) {
          // 继续出现中间字节
          i++
        } else if (isEscFinal(code)) {
          // 结束字节 - 完成整个序列
          i++
          emitSequence(data.slice(seqStart, i))
        } else {
          // 无效，按文本处理
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'csi':
        // X10 鼠标：CSI M + 3 个原始 payload 字节（Cb+32、Cx+32、Cy+32）。
        // 若 `[` 后立即就是 M（偏移 2），表示没有参数；而 SGR 鼠标
        //（CSI < … M）前面会先有一个 `<` 参数字节，因此 M 出现时偏移会大于 2。
        // 那些忽略 DECSET 1006、但支持 1000/1002 的终端会发这种旧编码；没有
        // 这个分支时，后面的 3 个 payload 字节会作为文本泄漏出来
        //（提示符中出现 `` `rK `` / `arK` 之类垃圾）。
        //
        // 该逻辑受 x10Mouse 开关控制，因为 `\x1b[M` 同时也是 CSI DL
        //（Delete Lines）；若无脑吞掉 3 个字符，会破坏输出渲染（Parser/Ansi），
        // 还会截断 bracketed-paste 的 PASTE_END。只有 stdin 会启用它。
        // 对每个 payload 槽位做 ≥0x20 检查属于额外保险：X10 保证 Cb≥32、
        // Cx≥33、Cy≥33，因此任何槽位里若出现控制字节（ESC=0x1B），就说明这
        // 更像是与另一个序列相邻的 CSI DL，而不是鼠标事件。检查全部三个槽位
        // 可以防止当粘贴内容以 `\x1b[M`+0-2 个字符结尾时，把 PASTE_END 的 ESC
        // 一并吞掉。
        //
        // 已知限制：这里按 JS 字符数计数，但 X10 是面向字节的，而 stdin 使用
        // utf8 编码（见 App.tsx）。在列 162-191 × 行 96-159 的区域，两个坐标字节
        //（0xC2-0xDF、0x80-0xBF）会构成一个合法的 UTF-8 双字节序列并折叠成
        // 一个字符，导致长度检查失败，事件会一直缓冲到下一个按键把它吸收掉。
        // 要彻底修复需要让 stdin 改用 latin1；X10 223 坐标上限本来就是 SGR
        // 被发明出来的原因，而在 162+ 列上仍不用 SGR 的终端也很少见。
        if (
          x10Mouse &&
          code === 0x4d /* M */ &&
          i - seqStart === 2 &&
          (i + 1 >= data.length || data.charCodeAt(i + 1) >= 0x20) &&
          (i + 2 >= data.length || data.charCodeAt(i + 2) >= 0x20) &&
          (i + 3 >= data.length || data.charCodeAt(i + 3) >= 0x20)
        ) {
          if (i + 4 <= data.length) {
            i += 4
            emitSequence(data.slice(seqStart, i))
          } else {
            // 序列不完整，退出循环；输入末尾从 seqStart 开始进入缓冲。
            // 重新进入时，会通过 invalid-CSI 的 fallthrough 从 ground 重新 tokenize。
            i = data.length
          }
          break
        }
        if (isCSIFinal(code)) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (isCSIParam(code) || isCSIIntermediate(code)) {
          i++
        } else {
          // 无效的 CSI，终止并按文本处理
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'ss3':
        // SS3 序列：ESC O 后接单个结束字节
        if (code >= 0x40 && code <= 0x7e) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else {
          // 无效，按文本处理
          result.state = 'ground'
          textStart = seqStart
        }
        break

      case 'osc':
        if (code === C0.BEL) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (
          code === C0.ESC &&
          i + 1 < data.length &&
          data.charCodeAt(i + 1) === ESC_TYPE.ST
        ) {
          i += 2
          emitSequence(data.slice(seqStart, i))
        } else {
          i++
        }
        break

      case 'dcs':
      case 'apc':
        if (code === C0.BEL) {
          i++
          emitSequence(data.slice(seqStart, i))
        } else if (
          code === C0.ESC &&
          i + 1 < data.length &&
          data.charCodeAt(i + 1) === ESC_TYPE.ST
        ) {
          i += 2
          emitSequence(data.slice(seqStart, i))
        } else {
          i++
        }
        break
    }
  }

  // 处理输入结束
  if (result.state === 'ground') {
    flushText()
  } else if (flush) {
    // 强制输出不完整序列
    const remaining = data.slice(seqStart)
    if (remaining) tokens.push({ type: 'sequence', value: remaining })
    result.state = 'ground'
  } else {
    // 将不完整序列缓存到下一次调用
    result.buffer = data.slice(seqStart)
  }

  return { tokens, state: result }
}
