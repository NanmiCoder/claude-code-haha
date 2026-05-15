/**
 * OSC（Operating System Command）类型与解析器
 */

import { Buffer } from 'buffer'
import { env } from '../../utils/env.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { BEL, ESC, ESC_TYPE, SEP } from './ansi.js'
import type { Action, Color, TabStatusAction } from './types.js'

export const OSC_PREFIX = ESC + String.fromCharCode(ESC_TYPE.OSC)

/** String Terminator（ESC \）- 用于终止 OSC 的 BEL 替代方案 */
export const ST = ESC + '\\'

/** 生成 OSC 序列：ESC ] p1;p2;...;pN <terminator>
 * Kitty 使用 ST 作为终止符（避免蜂鸣），其余终端使用 BEL */
export function osc(...parts: (string | number)[]): string {
  const terminator = env.terminal === 'kitty' ? ST : BEL
  return `${OSC_PREFIX}${parts.join(SEP)}${terminator}`
}

/**
 * 将转义序列包装为 terminal multiplexer passthrough 形式。
 * tmux 与 GNU screen 会拦截转义序列；DCS passthrough 会把它们原样隧穿到外层终端。
 *
 * tmux 3.3+ 通过 `allow-passthrough` 控制这一能力（默认关闭）。关闭时，tmux
 * 会静默丢弃整个 DCS，不会产生垃圾输出，其效果也不会比未包装的 OSC 更差。
 * 需要 passthrough 的用户应在自己的 .tmux.conf 中配置；我们不会替他们修改。
 *
 * 不要包装 BEL：原始 \x07 会触发 tmux 的 bell-action（窗口标记）；而被包装后的
 * \x07 只是透明 DCS payload，tmux 根本看不到这个 bell。
 */
export function wrapForMultiplexer(sequence: string): string {
  if (process.env['TMUX']) {
    const escaped = sequence.replaceAll('\x1b', '\x1b\x1b')
    return `\x1bPtmux;${escaped}\x1b\\`
  }
  if (process.env['STY']) {
    return `\x1bP${sequence}\x1b\\`
  }
  return sequence
}

/**
 * 根据环境状态，判断 setClipboard() 将走哪条路径。该判断是同步的，因此调用方
 * 无需等待复制动作本身，就能显示一个准确的提示。
 *
 * - 'native'：会运行 pbcopy（或等价工具），高度可靠地写入系统剪贴板；tmux
 *   buffer 也可能顺带被写入。
 * - 'tmux-buffer'：会运行 tmux load-buffer，但不会调用本地工具；此时可以用
 *   prefix+] 粘贴。系统剪贴板是否同步取决于 tmux 的 set-clipboard 选项以及
 *   外层终端是否支持 OSC 52；这里只无法确定。
 * - 'osc52'：只会把原始 OSC 52 序列写到 stdout。
 *   这是 best-effort；iTerm2 默认关闭 OSC 52。
 *
 * pbcopy 的门控条件特意使用 SSH_CONNECTION，而不是 SSH_TTY；因为 tmux pane
 * 即使在本地重新 attach 之后也会永远继承 SSH_TTY，但 SSH_CONNECTION 属于
 * tmux 默认 update-environment 集合，会被正确清除。
 */
export type ClipboardPath = 'native' | 'tmux-buffer' | 'osc52'

export function getClipboardPath(): ClipboardPath {
  const nativeAvailable =
    process.platform === 'darwin' && !process.env['SSH_CONNECTION']
  if (nativeAvailable) return 'native'
  if (process.env['TMUX']) return 'tmux-buffer'
  return 'osc52'
}

/**
 * 将 payload 包装到 tmux 的 DCS passthrough 中：ESC P tmux ; <payload> ESC \
 * tmux 会把 payload 转发给外层终端，绕过它自己的解析器。
 * 内层 ESC 必须成对转义。需要在 ~/.tmux.conf 中设置
 * `set -g allow-passthrough on`；否则 tmux 会静默丢弃整个 DCS（不会退化）。
 */
function tmuxPassthrough(payload: string): string {
  return `${ESC}Ptmux;${payload.replaceAll(ESC, ESC + ESC)}${ST}`
}

/**
 * 通过 `tmux load-buffer` 将文本载入 tmux 的 paste buffer。
 * -w（tmux 3.2+）会通过 tmux 自己发出的 OSC 52，将内容继续传播到外层终端的
 * 剪贴板。对 iTerm2 会去掉 -w，因为 tmux 发出的 OSC 52 会在 SSH 下导致 iTerm2
 * 会话崩溃。
 *
 * 若 buffer 成功载入，则返回 true。
 */
export async function tmuxLoadBuffer(text: string): Promise<boolean> {
  if (!process.env['TMUX']) return false
  const args =
    process.env['LC_TERMINAL'] === 'iTerm2'
      ? ['load-buffer', '-']
      : ['load-buffer', '-w', '-']
  const { code } = await execFileNoThrow('tmux', args, {
    input: text,
    useCwd: false,
    timeout: 2000,
  })
  return code === 0
}

/**
 * OSC 52 剪贴板写入：ESC ] 52 ; c ; <base64> BEL/ST
 * 其中 'c' 表示选择剪贴板（X11 下 'p' 表示 primary selection）。
 *
 * 在 tmux 内部（设置了 $TMUX）时，主路径是 `tmux load-buffer -w -`。
 * tmux buffer 始终可达，可跨 SSH 工作，能穿越 detach/reattach，也不受过期 env
 * 变量影响。-w 标志（tmux 3.2+）会让 tmux 再通过它自己的 OSC 52 路径传播到
 * 外层终端，而 tmux 会针对当前附着的客户端正确包装该序列。对于更旧的 tmux，
 * -w 会被忽略，但 buffer 仍会被加载。对 iTerm2 会去掉 -w（#22432），因为
 * tmux 自己发出的 OSC 52（空 selection 参数：ESC]52;;b64）会在 SSH 下使 iTerm2 崩溃。
 *
 * load-buffer 成功后，我们还会返回一段经过 DCS passthrough 包装的 OSC 52，
 * 交给调用方写入 stdout。我们的序列显式使用 `c`（而不是 tmux 那个会导致崩溃的
 * 空参数变体），因此能绕开 #22432。若 `allow-passthrough on` 且外层终端支持
 * OSC 52，选择内容就能进入系统剪贴板；若任一条件不满足，tmux 会静默丢弃该 DCS，
 * 但 prefix+] 依旧可用。参见 Greg Smith 的 “free pony”：
 * https://anthropic.slack.com/archives/C07VBSHV7EV/p1773177228548119。
 *
 * 若 load-buffer 完全失败，则退回到原始 OSC 52。
 *
 * 在 tmux 外部，则把原始 OSC 52 写到 stdout（具体写入由调用方完成）。
 *
 * 本地环境（没有 SSH_CONNECTION）下，还会额外调用原生剪贴板工具。
 * OSC 52 和 tmux -w 都依赖终端设置：iTerm2 默认关闭 OSC 52，VS Code 首次使用时
 * 还会弹权限提示。原生工具（pbcopy/wl-copy/xclip/xsel/clip.exe）在本地始终可用。
 * 但在 SSH 下，这些工具只会写远端机器的剪贴板，因此那种情况下 OSC 52 才是正确路径。
 *
 * 返回供调用方写到 stdout 的序列（tmux 外部为原始 OSC 52，tmux 内部为
 * DCS 包装后的版本）。
 */
export async function setClipboard(text: string): Promise<string> {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  const raw = osc(OSC.CLIPBOARD, 'c', b64)

  // 原生兜底路径要优先触发，并且要在等待 tmux 返回之前执行，这样用户在选择后
  // 快速切换焦点时，就不会和 pbcopy 发生竞态。此前它是在等待 tmux load-buffer
  // 之后才执行，导致 pbcopy 真正启动前又多了 ~50-100ms 的子进程延迟，快速的
  // cmd+tab → paste 能够抢在它前面
  //（https://anthropic.slack.com/archives/C07VBSHV7EV/p1773943921788829）。
  // 这里用 SSH_CONNECTION 而不是 SSH_TTY 做门控，因为 tmux pane 会永久继承
  // SSH_TTY，而 SSH_CONNECTION 属于 tmux 默认 update-environment 集合，
  // 在本地 attach 时会被清除。这里采用 fire-and-forget。
  if (!process.env['SSH_CONNECTION']) copyNative(text)

  const tmuxBufferLoaded = await tmuxLoadBuffer(text)

  // 内层 OSC 直接使用 BEL（而不是 osc()），因为 ST 中的 ESC 同样需要成倍转义，
  // 而 BEL 对 OSC 52 在所有环境下都能工作。
  if (tmuxBufferLoaded) return tmuxPassthrough(`${ESC}]52;c;${b64}${BEL}`)
  return raw
}

// Linux 剪贴板工具：undefined 表示尚未探测，null 表示都不可用。
// 探测顺序：wl-copy（Wayland）→ xclip（X11）→ xsel（X11 兜底）。
// 首次尝试后会缓存结果，后续重复 mouse-up 可跳过整条探测链。
let linuxCopy: 'wl-copy' | 'xclip' | 'xsel' | null | undefined

/**
 * 作为 OSC 52 的兜底方案，调用原生剪贴板工具。
 * 仅在非 SSH 会话中调用（SSH 下这些工具只会写到远端机器的剪贴板，那里正确的
 * 做法是使用 OSC 52）。
 * 采用 fire-and-forget：失败会静默，因为 OSC 52 可能已经成功。
 */
function copyNative(text: string): void {
  const opts = { input: text, useCwd: false, timeout: 2000 }
  switch (process.platform) {
    case 'darwin':
      void execFileNoThrow('pbcopy', [], opts)
      return
    case 'linux': {
      if (linuxCopy === null) return
      if (linuxCopy === 'wl-copy') {
        void execFileNoThrow('wl-copy', [], opts)
        return
      }
      if (linuxCopy === 'xclip') {
        void execFileNoThrow('xclip', ['-selection', 'clipboard'], opts)
        return
      }
      if (linuxCopy === 'xsel') {
        void execFileNoThrow('xsel', ['--clipboard', '--input'], opts)
        return
      }
      // 首次调用：先探测 wl-copy（Wayland），再探测 xclip/xsel（X11），并缓存胜出者。
      void execFileNoThrow('wl-copy', [], opts).then(r => {
        if (r.code === 0) {
          linuxCopy = 'wl-copy'
          return
        }
        void execFileNoThrow('xclip', ['-selection', 'clipboard'], opts).then(
          r2 => {
            if (r2.code === 0) {
              linuxCopy = 'xclip'
              return
            }
            void execFileNoThrow('xsel', ['--clipboard', '--input'], opts).then(
              r3 => {
                linuxCopy = r3.code === 0 ? 'xsel' : null
              },
            )
          },
        )
      })
      return
    }
    case 'win32':
      // Windows 上始终有 clip.exe。其 Unicode 处理并不完美
      //（受系统区域编码影响），但作为兜底已经足够。
      void execFileNoThrow('clip', [], opts)
      return
  }
}

/** @internal test-only */
export function _resetLinuxCopyCache(): void {
  linuxCopy = undefined
}

/**
 * OSC 命令编号
 */
export const OSC = {
  SET_TITLE_AND_ICON: 0,
  SET_ICON: 1,
  SET_TITLE: 2,
  SET_COLOR: 4,
  SET_CWD: 7,
  HYPERLINK: 8,
  ITERM2: 9, // iTerm2 proprietary sequences
  SET_FG_COLOR: 10,
  SET_BG_COLOR: 11,
  SET_CURSOR_COLOR: 12,
  CLIPBOARD: 52,
  KITTY: 99, // Kitty notification protocol
  RESET_COLOR: 104,
  RESET_FG_COLOR: 110,
  RESET_BG_COLOR: 111,
  RESET_CURSOR_COLOR: 112,
  SEMANTIC_PROMPT: 133,
  GHOSTTY: 777, // Ghostty notification protocol
  TAB_STATUS: 21337, // Tab status extension
} as const

/**
 * 将 OSC 序列解析为动作
 *
 * @param content - 序列内容（不包含 ESC ] 与终止符）
 */
export function parseOSC(content: string): Action | null {
  const semicolonIdx = content.indexOf(';')
  const command = semicolonIdx >= 0 ? content.slice(0, semicolonIdx) : content
  const data = semicolonIdx >= 0 ? content.slice(semicolonIdx + 1) : ''

  const commandNum = parseInt(command, 10)

  // 窗口 / 图标标题
  if (commandNum === OSC.SET_TITLE_AND_ICON) {
    return { type: 'title', action: { type: 'both', title: data } }
  }
  if (commandNum === OSC.SET_ICON) {
    return { type: 'title', action: { type: 'iconName', name: data } }
  }
  if (commandNum === OSC.SET_TITLE) {
    return { type: 'title', action: { type: 'windowTitle', title: data } }
  }

  // 超链接（OSC 8）
  if (commandNum === OSC.HYPERLINK) {
    const parts = data.split(';')
    const paramsStr = parts[0] ?? ''
    const url = parts.slice(1).join(';')

    if (url === '') {
      return { type: 'link', action: { type: 'end' } }
    }

    const params: Record<string, string> = {}
    if (paramsStr) {
      for (const pair of paramsStr.split(':')) {
        const eqIdx = pair.indexOf('=')
        if (eqIdx >= 0) {
          params[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1)
        }
      }
    }

    return {
      type: 'link',
      action: {
        type: 'start',
        url,
        params: Object.keys(params).length > 0 ? params : undefined,
      },
    }
  }

  // 标签状态（OSC 21337）
  if (commandNum === OSC.TAB_STATUS) {
    return { type: 'tabStatus', action: parseTabStatus(data) }
  }

  return { type: 'unknown', sequence: `\x1b]${content}` }
}

/**
 * 将 XParseColor 风格的颜色描述解析为 RGB Color。
 * 接受 `#RRGGBB` 与 `rgb:R/G/B` 两种格式（每个分量 1-4 位十六进制，并会缩放到
 * 8 位）。解析失败时返回 null。
 */
export function parseOscColor(spec: string): Color | null {
  const hex = spec.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (hex) {
    return {
      type: 'rgb',
      r: parseInt(hex[1]!, 16),
      g: parseInt(hex[2]!, 16),
      b: parseInt(hex[3]!, 16),
    }
  }
  const rgb = spec.match(
    /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i,
  )
  if (rgb) {
    // XParseColor：N 位十六进制 → value / (16^N - 1)，再缩放到 0-255
    const scale = (s: string) =>
      Math.round((parseInt(s, 16) / (16 ** s.length - 1)) * 255)
    return {
      type: 'rgb',
      r: scale(rgb[1]!),
      g: scale(rgb[2]!),
      b: scale(rgb[3]!),
    }
  }
  return null
}

/**
 * 解析 OSC 21337 payload：`key=value;key=value;...`，其中值内部允许出现
 * `\;` 与 `\\` 转义。裸 key 或 `key=` 表示清除该字段；未知 key 会被忽略。
 */
function parseTabStatus(data: string): TabStatusAction {
  const action: TabStatusAction = {}
  for (const [key, value] of splitTabStatusPairs(data)) {
    switch (key) {
      case 'indicator':
        action.indicator = value === '' ? null : parseOscColor(value)
        break
      case 'status':
        action.status = value === '' ? null : value
        break
      case 'status-color':
        action.statusColor = value === '' ? null : parseOscColor(value)
        break
    }
  }
  return action
}

/** 拆分 `k=v;k=v`，并正确处理 `\;` 与 `\\` 转义。产出 [key, unescapedValue]。 */
function* splitTabStatusPairs(data: string): Generator<[string, string]> {
  let key = ''
  let val = ''
  let inVal = false
  let esc = false
  for (const c of data) {
    if (esc) {
      if (inVal) val += c
      else key += c
      esc = false
    } else if (c === '\\') {
      esc = true
    } else if (c === ';') {
      yield [key, val]
      key = ''
      val = ''
      inVal = false
    } else if (c === '=' && !inVal) {
      inVal = true
    } else if (inVal) {
      val += c
    } else {
      key += c
    }
  }
  if (key || inVal) yield [key, val]
}

// 输出生成器

/** 开始一个超链接（OSC 8）。会根据 URL 自动分配一个 id= 参数，
 *  这样终端就能把同一链接被换行后的多行内容归并在一起（规范要求 URI 匹配且
 *  id 非空的单元格才会被视为同一个链接；没有 id 时，每一条折行都会变成一个
 *  独立链接，导致 hover 行为不一致、tooltip 也可能残缺）。
 *  url 为空时表示关闭序列（按规范使用空参数）。 */
export function link(url: string, params?: Record<string, string>): string {
  if (!url) return LINK_END
  const p = { id: osc8Id(url), ...params }
  const paramStr = Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(':')
  return osc(OSC.HYPERLINK, paramStr, url)
}

function osc8Id(url: string): string {
  let h = 0
  for (let i = 0; i < url.length; i++)
    h = ((h << 5) - h + url.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** 结束一个超链接（OSC 8） */
export const LINK_END = osc(OSC.HYPERLINK, '', '')

// iTerm2 OSC 9 子命令

/** iTerm2 OSC 9 子命令编号 */
export const ITERM2 = {
  NOTIFY: 0,
  BADGE: 2,
  PROGRESS: 4,
} as const

/** 进度操作码（供 ITERM2.PROGRESS 使用） */
export const PROGRESS = {
  CLEAR: 0,
  SET: 1,
  ERROR: 2,
  INDETERMINATE: 3,
} as const

/**
 * 清除 iTerm2 进度条序列（OSC 9;4;0;BEL）
 * 这里使用 BEL 作为终止符，因为这是清理路径（不是运行时通知），
 * 我们希望无论终端类型如何都能确保发送出去。
 */
export const CLEAR_ITERM2_PROGRESS = `${OSC_PREFIX}${OSC.ITERM2};${ITERM2.PROGRESS};${PROGRESS.CLEAR};${BEL}`

/**
 * 清除终端标题序列（OSC 0 + 空字符串 + BEL）。
 * 清理路径使用 BEL 终止符，在所有终端上都安全。
 */
export const CLEAR_TERMINAL_TITLE = `${OSC_PREFIX}${OSC.SET_TITLE_AND_ICON};${BEL}`

/** 清除 OSC 21337 的全部三个 tab-status 字段。用于退出时清理。 */
export const CLEAR_TAB_STATUS = osc(
  OSC.TAB_STATUS,
  'indicator=;status=;status-color=',
)

/**
 * 是否允许发出 OSC 21337（tab-status indicator）的门控。由于规范仍不稳定，
 * 当前只对 Ant 用户开放。不认识该序列的终端会静默丢弃，因此发射本身可以无条件
 * 进行；我们不再按终端类型门控，因为预计多个终端都会逐步支持它。
 *
 * 调用方必须用 wrapForMultiplexer() 包裹输出，这样 tmux/screen 的
 * DCS passthrough 才能把该序列带到外层终端。
 */
export function supportsTabStatus(): boolean {
  return process.env.USER_TYPE === 'ant'
}

/**
 * 发出一个 OSC 21337 tab-status 序列。缺省字段会在接收端保持不变；`null`
 * 会发送空值以执行清除。状态文本中的 `;` 与 `\` 会按规范进行转义。
 */
export function tabStatus(fields: TabStatusAction): string {
  const parts: string[] = []
  const rgb = (c: Color) =>
    c.type === 'rgb'
      ? `#${[c.r, c.g, c.b].map(n => n.toString(16).padStart(2, '0')).join('')}`
      : ''
  if ('indicator' in fields)
    parts.push(`indicator=${fields.indicator ? rgb(fields.indicator) : ''}`)
  if ('status' in fields)
    parts.push(
      `status=${fields.status?.replaceAll('\\', '\\\\').replaceAll(';', '\\;') ?? ''}`,
    )
  if ('statusColor' in fields)
    parts.push(
      `status-color=${fields.statusColor ? rgb(fields.statusColor) : ''}`,
    )
  return osc(OSC.TAB_STATUS, parts.join(';'))
}
