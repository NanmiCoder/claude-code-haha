import { useEffect, useLayoutEffect } from 'react'
import { useEventCallback } from 'usehooks-ts'
import type { InputEvent, Key } from '../events/input-event.js'
import useStdin from './use-stdin.js'

type Handler = (input: string, key: Key, event: InputEvent) => void

type Options = {
  /**
   * 启用或禁用用户输入捕获。
   * 当同时存在多个 useInput hook 时，这有助于避免同一输入被处理多次。
   *
   * @default true
   */
  isActive?: boolean
}

/**
 * 这个 hook 用于处理用户输入。
 * 相比直接使用 `StdinContext` 并监听 `data` 事件，它是更方便的替代方案。
 * 传给 `useInput` 的回调会在用户输入任意字符时被调用。
 * 但如果用户粘贴的文本长度超过一个字符，回调只会被调用一次，并将整段字符串
 * 作为 `input` 传入。
 *
 * ```
 * import {useInput} from 'ink';
 *
 * const UserInput = () => {
 *   useInput((input, key) => {
 *     if (input === 'q') {
 *       // Exit program
 *     }
 *
 *     if (key.leftArrow) {
 *       // Left arrow key pressed
 *     }
 *   });
 *
 *   return …
 * };
 * ```
 */
const useInput = (inputHandler: Handler, options: Options = {}) => {
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin()

  // 使用 useLayoutEffect（而不是 useEffect），这样可以在 React 的 commit
  // 阶段、render() 返回之前同步开启 raw mode。若使用 useEffect，raw mode
  // 的设置会被 React 调度器推迟到下一次事件循环 tick，导致终端暂时停留在
  // cooked mode，按键会回显，且光标会一直可见，直到 effect 真正执行。
  useLayoutEffect(() => {
    if (options.isActive === false) {
      return
    }

    setRawMode(true)

    return () => {
      setRawMode(false)
    }
  }, [options.isActive, setRawMode])

  // 只在挂载时注册一次 listener，这样它在 EventEmitter listener 数组中的
  // 槽位就保持稳定。如果把 isActive 放进 effect 的依赖中，那么 false→true
  // 时 listener 会被重新追加，排到它失活期间新注册的 listener 后面，进而破坏
  // stopImmediatePropagation() 的顺序语义。useEventCallback 会在保持引用稳定
  // 的同时，从闭包中读取最新的 isActive/inputHandler（它通过 useLayoutEffect
  // 同步，因此对编译器安全）。
  const handleData = useEventCallback((event: InputEvent) => {
    if (options.isActive === false) {
      return
    }
    const { input, key } = event

    // 如果应用本来就不应该在 Ctrl+C 时退出，就让输入 listener 自己处理它。
    // 注意：事件发射时，App 层已经调用了 discreteUpdates，因此所有 listener
    // 都已经处于高优先级更新上下文中。
    if (!(input === 'c' && key.ctrl) || !internal_exitOnCtrlC) {
      inputHandler(input, key, event)
    }
  })

  useEffect(() => {
    internal_eventEmitter?.on('input', handleData)

    return () => {
      internal_eventEmitter?.removeListener('input', handleData)
    }
  }, [internal_eventEmitter, handleData])
}

export default useInput
