import { nonAlphanumericKeys, type ParsedKey } from '../parse-keypress.js'
import { Event } from './event.js'

export type Key = {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  pageDown: boolean
  pageUp: boolean
  wheelUp: boolean
  wheelDown: boolean
  home: boolean
  end: boolean
  return: boolean
  escape: boolean
  ctrl: boolean
  shift: boolean
  fn: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  meta: boolean
  super: boolean
}

function parseKey(keypress: ParsedKey): [Key, string] {
  const key: Key = {
    upArrow: keypress.name === 'up',
    downArrow: keypress.name === 'down',
    leftArrow: keypress.name === 'left',
    rightArrow: keypress.name === 'right',
    pageDown: keypress.name === 'pagedown',
    pageUp: keypress.name === 'pageup',
    wheelUp: keypress.name === 'wheelup',
    wheelDown: keypress.name === 'wheeldown',
    home: keypress.name === 'home',
    end: keypress.name === 'end',
    return: keypress.name === 'return',
    escape: keypress.name === 'escape',
    fn: keypress.fn,
    ctrl: keypress.ctrl,
    shift: keypress.shift,
    tab: keypress.name === 'tab',
    backspace: keypress.name === 'backspace',
    delete: keypress.name === 'delete',
    // `parseKeypress` 会把 \u001B\u001B[A（meta + 向上箭头）解析成 meta = false
    // 但 option = true，因此这里需要把这种情况一并考虑进去，避免在 Ink 中引入
    // 破坏性变化。
    // TODO(vadimdemedes): 考虑在下一个 major 版本移除这段兼容逻辑。
    meta: keypress.meta || keypress.name === 'escape' || keypress.option,
    // Super（macOS 上的 Cmd / Windows 上的 Win 键）只会通过 kitty keyboard
    // protocol 的 CSI u 序列到达。它与 meta（Alt/Option）区分开来，
    // 因而像 cmd+c 这样的绑定可以与 opt+c 分别表达。
    super: keypress.super,
  }

  let input = keypress.ctrl ? keypress.name : keypress.sequence

  // 处理 input 为 undefined 的情况
  if (input === undefined) {
    input = ''
  }

  // 当 ctrl 为 true 时，space 对应的 keypress.name 是字面字符串 "space"。
  // 这里把它转换成真实空格字符，以与 CSI u 分支的行为保持一致
  // （该分支会把 'space' 映射为 ' '）。否则 ctrl+space 会把字面词 "space"
  // 泄漏进文本输入。
  if (keypress.ctrl && input === 'space') {
    input = ' '
  }

  // 屏蔽那些被解析成 function key（命中 FN_KEY_RE）但在 keyName map 中
  // 没有名字的未识别转义序列。
  // 例如：ESC[25~（Windows 上的 F13/Right Alt）、ESC[26~（F14）等。
  // 没有这层处理时，下面去掉 ESC 前缀后，剩余部分（例如 "[25~"）会作为
  // 字面文本泄漏到输入里。
  if (keypress.code && !keypress.name) {
    input = ''
  }

  // 屏蔽缺失 ESC 前缀的 SGR 鼠标片段。当沉重的 React commit 让事件循环阻塞
  // 超过 App 的 50ms NORMAL_TIMEOUT flush 时，一个被拆成多个 stdin chunk 的
  // CSI 会先把缓冲里的 ESC 当成单独的 Escape 键刷出来，而后续片段会以
  // name='' 的 text token 形式到达。它会绕过 parseKeypress 中所有以 ESC 为锚点
  // 的正则，以及下面的 nonAlphanumericKeys 清理逻辑（因为 name 是 falsy），
  // 最终把字面文本 `[<64;74;16M` 泄漏进提示符。这里与上面的 F13 保护一样，
  // 属于防御性兜底；真正的 tokenizer flush 竞争发生在这一层之前。
  if (!keypress.name && /^\[<\d+;\d+;\d+[Mm]/.test(input)) {
    input = ''
  }

  // 如果 `parseKeypress` 之后还残留 meta 前缀，则把它去掉。
  // TODO(vadimdemedes): 考虑在下一个 major 版本移除这段兼容逻辑。
  if (input.startsWith('\u001B')) {
    input = input.slice(1)
  }

  // 记录当前输入是否已作为特殊序列处理过，并已把 input 转成 key name
  //（CSI u 或 application keypad mode）。对于这类情况，不应再被下面的
  // nonAlphanumericKeys 检查清空。
  let processedAsSpecialSequence = false

  // 处理 CSI u 序列（Kitty keyboard protocol）：去掉 ESC 后，剩下的是
  // "[codepoint;modifieru"（例如 Alt+b 对应 "[98;3u"）。这里改用解析后的
  // key name 作为输入。要求 `[` 后面必须跟数字，因为真实的 CSI u 一定是
  // [<digits>…u；如果只写 startsWith('[')，会把第 85 行的 X10 mouse
  //（Cy = 85+32 = 'u'）误判进去，进而经由 processedAsSpecialSequence
  // 把字面文本 "mouse" 泄漏到提示符中。
  if (/^\[\d/.test(input) && input.endsWith('u')) {
    if (!keypress.name) {
      // 未映射的 Kitty 功能键（Caps Lock 57358、F13–F35、数字键盘导航、
      // 裸修饰键等），即 keycodeToName() 返回 undefined 的情况。这里直接吞掉，
      // 避免原始的 "[57358u" 泄漏到提示符。见 #38781。
      input = ''
    } else {
      // 'space' → ' '；'escape' → ''（key.escape 已经携带该信息；
      // processedAsSpecialSequence 会绕过下面的 nonAlphanumericKeys 清理，
      // 因此这里必须显式处理）；否则直接使用 key name。
      input =
        keypress.name === 'space'
          ? ' '
          : keypress.name === 'escape'
            ? ''
            : keypress.name
    }
    processedAsSpecialSequence = true
  }

  // 处理 xterm modifyOtherKeys 序列：去掉 ESC 后剩下
  // "[27;modifier;keycode~"（例如 Alt+b 对应 "[27;3;98~"）。提取逻辑与
  // CSI u 相同；没有这一步时，可打印字符 keycode（单字母 name）会绕过
  // nonAlphanumericKeys 清理，并把 "[27;..." 泄漏成输入。
  if (input.startsWith('[27;') && input.endsWith('~')) {
    if (!keypress.name) {
      // 未映射的 modifyOtherKeys keycode。为与上面的 CSI u 处理保持一致，
      // 这里直接吞掉。按当前情况几乎无法触发（xterm modifyOtherKeys 只发送
      // ASCII keycode，且都已有映射），但可以防御未来终端行为变化。
      input = ''
    } else {
      input =
        keypress.name === 'space'
          ? ' '
          : keypress.name === 'escape'
            ? ''
            : keypress.name
    }
    processedAsSpecialSequence = true
  }

  // 处理 application keypad mode 序列：去掉 ESC 后剩下的是 "O<letter>"
  //（例如数字键盘 0 对应 "Op"，数字键盘 9 对应 "Oy"）。这里使用解析后的
  // key name（即数字字符）作为输入。
  if (
    input.startsWith('O') &&
    input.length === 2 &&
    keypress.name &&
    keypress.name.length === 1
  ) {
    input = keypress.name
    processedAsSpecialSequence = true
  }

  // 对非字母数字按键（方向键、功能键等）清空 input。
  // CSI u 和 application keypad mode 序列已经被转换成正确的输入字符，
  // 因此这里要跳过。
  if (
    !processedAsSpecialSequence &&
    keypress.name &&
    nonAlphanumericKeys.includes(keypress.name)
  ) {
    input = ''
  }

  // 对大写字母（A-Z）设置 shift=true。
  // 必须确认它真的是字母，而不是某个调用 toUpperCase 后恰好不变的字符。
  if (
    input.length === 1 &&
    typeof input[0] === 'string' &&
    input[0] >= 'A' &&
    input[0] <= 'Z'
  ) {
    key.shift = true
  }

  return [key, input]
}

export class InputEvent extends Event {
  readonly keypress: ParsedKey
  readonly key: Key
  readonly input: string

  constructor(keypress: ParsedKey) {
    super()
    const [key, input] = parseKey(keypress)

    this.keypress = keypress
    this.key = key
    this.input = input
  }
}
