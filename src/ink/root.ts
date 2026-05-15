import type { ReactNode } from 'react'
import { logForDebugging } from 'src/utils/debug.js'
import { Stream } from 'stream'
import type { FrameEvent } from './frame.js'
import Ink, { type Options as InkOptions } from './ink.js'
import instances from './instances.js'

export type RenderOptions = {
  /**
  * 应用将被渲染到的输出流。
   *
   * @default process.stdout
   */
  stdout?: NodeJS.WriteStream
  /**
  * 应用监听输入所使用的输入流。
   *
   * @default process.stdin
   */
  stdin?: NodeJS.ReadStream
  /**
  * 错误输出流。
   * @default process.stderr
   */
  stderr?: NodeJS.WriteStream
  /**
  * 配置 Ink 是否应监听 Ctrl+C 键盘输入并退出应用。当 `process.stdin`
  * 处于 raw mode 时，这一点尤为重要，因为此时 Ctrl+C 默认不会被处理，
  * 需要由进程自行接管。
   *
   * @default true
   */
  exitOnCtrlC?: boolean

  /**
    * Patch console 方法，确保 console 输出不会与 Ink 输出相互混杂。
   *
   * @default true
   */
  patchConsole?: boolean

  /**
   * 每一帧渲染后调用，提供耗时与闪烁信息。
   */
  onFrame?: (event: FrameEvent) => void
}

export type Instance = {
  /**
    * 用新的根节点替换旧的根节点，或更新当前根节点的 props。
   */
  rerender: Ink['render']
  /**
    * 手动卸载整个 Ink 应用。
   */
  unmount: Ink['unmount']
  /**
    * 返回一个 promise，并在应用卸载时 resolve。
   */
  waitUntilExit: Ink['waitUntilExit']
  cleanup: () => void
}

/**
 * 一个受管理的 Ink root，类似于 react-dom 的 createRoot API。
 * 它将实例创建与渲染分离，使同一个 root 可被多个顺序出现的 screen 复用。
 */
export type Root = {
  render: (node: ReactNode) => void
  unmount: () => void
  waitUntilExit: () => Promise<void>
}

/**
 * 挂载组件并渲染输出。
 */
export const renderSync = (
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Instance => {
  const opts = getOptions(options)
  const inkOptions: InkOptions = {
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    exitOnCtrlC: true,
    patchConsole: true,
    ...opts,
  }

  const instance: Ink = getInstance(
    inkOptions.stdout,
    () => new Ink(inkOptions),
  )

  instance.render(node)

  return {
    rerender: instance.render,
    unmount() {
      instance.unmount()
    },
    waitUntilExit: instance.waitUntilExit,
    cleanup: () => instances.delete(inkOptions.stdout),
  }
}

const wrappedRender = async (
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> => {
  // 保留过去 `await loadYoga()` 所提供的 microtask 边界。
  // 没有它时，第一次 render 会在异步启动工作（例如 useReplBridge 的通知状态）
  // 完成之前同步触发，后续的 Static 写入就会覆盖 scrollback，而不是追加到 logo 下方。
  await Promise.resolve()
  const instance = renderSync(node, options)
  logForDebugging(
    `[render] first ink render: ${Math.round(process.uptime() * 1000)}ms since process start`,
  )
  return instance
}

export default wrappedRender

/**
 * 创建一个尚未进行任何渲染的 Ink root。
 * 类似 react-dom 的 createRoot，调用 root.render() 后才会真正挂载树。
 */
export async function createRoot({
  stdout = process.stdout,
  stdin = process.stdin,
  stderr = process.stderr,
  exitOnCtrlC = true,
  patchConsole = true,
  onFrame,
}: RenderOptions = {}): Promise<Root> {
  // 参见 wrappedRender：保留旧 WASM await 带来的 microtask 边界。
  await Promise.resolve()
  const instance = new Ink({
    stdout,
    stdin,
    stderr,
    exitOnCtrlC,
    patchConsole,
    onFrame,
  })

  // 注册到 instances map 中，这样那些通过 stdout 查找 Ink 实例的代码
  //（例如外部编辑器的 pause/resume 流程）就能找到它。
  instances.set(stdout, instance)

  return {
    render: node => instance.render(node),
    unmount: () => instance.unmount(),
    waitUntilExit: () => instance.waitUntilExit(),
  }
}

const getOptions = (
  stdout: NodeJS.WriteStream | RenderOptions | undefined = {},
): RenderOptions => {
  if (stdout instanceof Stream) {
    return {
      stdout,
      stdin: process.stdin,
    }
  }

  return stdout
}

const getInstance = (
  stdout: NodeJS.WriteStream,
  createInstance: () => Ink,
): Ink => {
  let instance = instances.get(stdout)

  if (!instance) {
    instance = createInstance()
    instances.set(stdout, instance)
  }

  return instance
}
