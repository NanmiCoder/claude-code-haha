import chalk from 'chalk'
import type { Color, TextStyles } from './styles.js'

/**
 * xterm.js（VS Code、Cursor、code-server、Coder）自 2017 年起就支持 truecolor，
 * 但 code-server/Coder 容器经常不会设置 COLORTERM=truecolor。chalk 的
 * supports-color 也识别不了 TERM_PROGRAM=vscode（它只认识
 * iTerm.app/Apple_Terminal），于是会退回到 -256color 正则，对应 level 2。
 * 在 level 2 下，chalk.rgb() 会降级到最近的 6×6×6 色立方颜色：
 * rgb(215,119,87)（Claude 橙）会变成 idx 174 的 rgb(215,135,135)，
 * 看起来像褪色的鲑鱼色。
 *
 * 这里只在 level === 2 时才生效（而不是 < 3），以尊重 NO_COLOR /
 * FORCE_COLOR=0；这两种情况会得到 level 0，明确表示“不要颜色”。桌面版
 * VS Code 自己会设置 COLORTERM=truecolor，因此在那里这是 no-op（本来就是 3）。
 *
 * 必须在 tmux clamp 之前运行。如果 tmux 运行在 VS Code 终端里，最终应以 tmux
 * 的 passthrough 限制为准，因此我们仍希望得到 level 2。
 */
function boostChalkLevelForXtermJs(): boolean {
  if (process.env.TERM_PROGRAM === 'vscode' && chalk.level === 2) {
    chalk.level = 3
    return true
  }
  return false
}

/**
 * tmux 能正确把 truecolor SGR（\e[48;2;r;g;bm）解析进自己的 cell buffer，
 * 但只有外层终端通过 terminal-overrides 声明了 Tc/RGB 能力时，它的 client 端发射器
 * 才会把 truecolor 原样重新发射出去。默认 tmux 配置不会设置这个能力，因此 tmux
 * 发往 iTerm2 等外层终端时会丢掉背景色序列，导致外层终端 buffer 的 bg=default，
 * 在暗色主题下就会变成黑底。把级别限制到 2 后，chalk 会发出 256 色
 *（\e[48;5;Nm），这能被 tmux 干净地透传。grey93（255）在视觉上与
 * rgb(240,240,240) 几乎一致。
 *
 * 已经手动设置 `terminal-overrides ,*:Tc` 的用户会遭遇一次技术上并不必要的降级，
 * 但视觉差异几乎不可感知。若为了判断这一点而在启动时执行
 * `tmux show -gv terminal-overrides`，就得额外起一个子进程，不值得。
 *
 * $TMUX 是 tmux 自己设置的 pty 生命周期环境变量，不会来自 globalSettings.env，
 * 因此在这里读取它是正确的。chalk 是单例，所以这里会限制整个应用中所有的
 * truecolor 输出（fg + bg + hex）。
 */
function clampChalkLevelForTmux(): boolean {
  // bg.ts 会在 attach 前设置 terminal-overrides :Tc，因此 truecolor 可以正常透传，
  // 这时应跳过 clamp。这也是给所有已正确配置 tmux 的用户预留的通用逃生门。
  if (process.env.CLAUDE_CODE_TMUX_TRUECOLOR) return false
  if (process.env.TMUX && chalk.level > 2) {
    chalk.level = 2
    return true
  }
  return false
}
// 只在模块加载时计算一次，因为终端 / tmux 环境在会话中途不会变化。
// 顺序很重要：先 boost，这样当 tmux 运行在 VS Code 终端里时，后面的 tmux clamp
// 还能再次把级别压回去。导出仅用于调试；若未使用，会被 tree-shake 掉。
export const CHALK_BOOSTED_FOR_XTERMJS = boostChalkLevelForXtermJs()
export const CHALK_CLAMPED_FOR_TMUX = clampChalkLevelForTmux()

export type ColorType = 'foreground' | 'background'

const RGB_REGEX = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/
const ANSI_REGEX = /^ansi256\(\s?(\d+)\s?\)$/

export const colorize = (
  str: string,
  color: string | undefined,
  type: ColorType,
): string => {
  if (!color) {
    return str
  }

  if (color.startsWith('ansi:')) {
    const value = color.substring('ansi:'.length)
    switch (value) {
      case 'black':
        return type === 'foreground' ? chalk.black(str) : chalk.bgBlack(str)
      case 'red':
        return type === 'foreground' ? chalk.red(str) : chalk.bgRed(str)
      case 'green':
        return type === 'foreground' ? chalk.green(str) : chalk.bgGreen(str)
      case 'yellow':
        return type === 'foreground' ? chalk.yellow(str) : chalk.bgYellow(str)
      case 'blue':
        return type === 'foreground' ? chalk.blue(str) : chalk.bgBlue(str)
      case 'magenta':
        return type === 'foreground' ? chalk.magenta(str) : chalk.bgMagenta(str)
      case 'cyan':
        return type === 'foreground' ? chalk.cyan(str) : chalk.bgCyan(str)
      case 'white':
        return type === 'foreground' ? chalk.white(str) : chalk.bgWhite(str)
      case 'blackBright':
        return type === 'foreground'
          ? chalk.blackBright(str)
          : chalk.bgBlackBright(str)
      case 'redBright':
        return type === 'foreground'
          ? chalk.redBright(str)
          : chalk.bgRedBright(str)
      case 'greenBright':
        return type === 'foreground'
          ? chalk.greenBright(str)
          : chalk.bgGreenBright(str)
      case 'yellowBright':
        return type === 'foreground'
          ? chalk.yellowBright(str)
          : chalk.bgYellowBright(str)
      case 'blueBright':
        return type === 'foreground'
          ? chalk.blueBright(str)
          : chalk.bgBlueBright(str)
      case 'magentaBright':
        return type === 'foreground'
          ? chalk.magentaBright(str)
          : chalk.bgMagentaBright(str)
      case 'cyanBright':
        return type === 'foreground'
          ? chalk.cyanBright(str)
          : chalk.bgCyanBright(str)
      case 'whiteBright':
        return type === 'foreground'
          ? chalk.whiteBright(str)
          : chalk.bgWhiteBright(str)
    }
  }

  if (color.startsWith('#')) {
    return type === 'foreground'
      ? chalk.hex(color)(str)
      : chalk.bgHex(color)(str)
  }

  if (color.startsWith('ansi256')) {
    const matches = ANSI_REGEX.exec(color)

    if (!matches) {
      return str
    }

    const value = Number(matches[1])

    return type === 'foreground'
      ? chalk.ansi256(value)(str)
      : chalk.bgAnsi256(value)(str)
  }

  if (color.startsWith('rgb')) {
    const matches = RGB_REGEX.exec(color)

    if (!matches) {
      return str
    }

    const firstValue = Number(matches[1])
    const secondValue = Number(matches[2])
    const thirdValue = Number(matches[3])

    return type === 'foreground'
      ? chalk.rgb(firstValue, secondValue, thirdValue)(str)
      : chalk.bgRgb(firstValue, secondValue, thirdValue)(str)
  }

  return str
}

/**
 * 使用 chalk 将 TextStyles 应用到字符串上。
 * 这与解析 ANSI 码是反向过程：这里从结构化样式生成 ANSI。
 * 主题解析发生在组件层，而不是这里。
 */
export function applyTextStyles(text: string, styles: TextStyles): string {
  let result = text

  // 以期望嵌套顺序的逆序应用样式。
  // chalk 会层层包裹文本，因此后调用的会成为外层包装。
  // Desired order (outermost to innermost):
  //   background > foreground > text modifiers
  // So we apply: text modifiers first, then foreground, then background last.

  if (styles.inverse) {
    result = chalk.inverse(result)
  }

  if (styles.strikethrough) {
    result = chalk.strikethrough(result)
  }

  if (styles.underline) {
    result = chalk.underline(result)
  }

  if (styles.italic) {
    result = chalk.italic(result)
  }

  if (styles.bold) {
    result = chalk.bold(result)
  }

  if (styles.dim) {
    result = chalk.dim(result)
  }

  if (styles.color) {
    // Color is now always a raw color value (theme resolution happens at component layer)
    result = colorize(result, styles.color, 'foreground')
  }

  if (styles.backgroundColor) {
    // backgroundColor is now always a raw color value
    result = colorize(result, styles.backgroundColor, 'background')
  }

  return result
}

/**
 * Apply a raw color value to text.
 * Theme resolution should happen at component layer, not here.
 */
export function applyColor(text: string, color: Color | undefined): string {
  if (!color) {
    return text
  }
  return colorize(text, color, 'foreground')
}
