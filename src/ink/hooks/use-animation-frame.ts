import { useContext, useEffect, useState } from 'react'
import { ClockContext } from '../components/ClockContext.js'
import type { DOMElement } from '../dom.js'
import { useTerminalViewport } from './use-terminal-viewport.js'

/**
 * 用于同步动画的 hook，并会在离开屏幕时暂停。
 *
 * 返回一个要挂到动画元素上的 ref，以及当前动画时间。
 * 所有实例共享同一个时钟，因此动画能保持同步。
 * 只有至少存在一个 keepAlive 订阅者时，时钟才会运行。
 *
 * 传入 `null` 可暂停，此时会取消订阅时钟，不再产生 tick。
 * 时间会冻结在最后一个值上，并在再次传入数字时从当前时钟时间继续。
 *
 * @param intervalMs - 更新频率，或传入 null 表示暂停
 * @returns [ref, time] - 要挂到元素上的 Ref，以及以毫秒计的经过时间
 *
 * @example
 * function Spinner() {
 *   const [ref, time] = useAnimationFrame(120)
 *   const frame = Math.floor(time / 120) % FRAMES.length
 *   return <Box ref={ref}>{FRAMES[frame]}</Box>
 * }
 *
 * 终端失焦时，时钟会自动降速，
 * 因此消费者无需自行处理焦点状态。
 */
export function useAnimationFrame(
  intervalMs: number | null = 16,
): [ref: (element: DOMElement | null) => void, time: number] {
  const clock = useContext(ClockContext)
  const [viewportRef, { isVisible }] = useTerminalViewport()
  const [time, setTime] = useState(() => clock?.now() ?? 0)

  const active = isVisible && intervalMs !== null

  useEffect(() => {
    if (!clock || !active) return

    let lastUpdate = clock.now()

    const onChange = (): void => {
      const now = clock.now()
      if (now - lastUpdate >= intervalMs!) {
        lastUpdate = now
        setTime(now)
      }
    }

    // keepAlive: true，表示可见动画会驱动时钟前进
    return clock.subscribe(onChange, true)
  }, [clock, intervalMs, active])

  return [viewportRef, time]
}
