/**
 * 为 bridge 轮询循环共享的 capacity-wake 原语。
 *
 * replBridge.ts 和 bridgeMain.ts 都需要在 "at capacity" 时休眠，
 * 但当以下任一情况发生时要提前唤醒：(a) 外层循环 signal 中止（shutdown），
 * 或 (b) 容量释放（session 完成 / transport 丢失）。该模块封装了
 * 可变 wake-controller 与双 signal 合并逻辑，这部分代码此前在两个
 * 轮询循环里都是逐字重复的。
 */

export type CapacitySignal = { signal: AbortSignal; cleanup: () => void }

export type CapacityWake = {
  /**
   * 创建一个 signal：当外层循环 signal 或 capacity-wake controller
   * 任一触发时就中止。返回合并后的 signal，以及一个 cleanup
   * 函数，用于在这次休眠正常结束时移除监听器
   * （即不是因 abort 结束）。
   */
  signal(): CapacitySignal
  /**
   * 中止当前的 at-capacity 休眠，并重新装配一个新的 controller，
   * 让轮询循环立刻重新检查是否有新 work。
   */
  wake(): void
}

export function createCapacityWake(outerSignal: AbortSignal): CapacityWake {
  let wakeController = new AbortController()

  function wake(): void {
    wakeController.abort()
    wakeController = new AbortController()
  }

  function signal(): CapacitySignal {
    const merged = new AbortController()
    const abort = (): void => merged.abort()
    if (outerSignal.aborted || wakeController.signal.aborted) {
      merged.abort()
      return { signal: merged.signal, cleanup: () => {} }
    }
    outerSignal.addEventListener('abort', abort, { once: true })
    const capSig = wakeController.signal
    capSig.addEventListener('abort', abort, { once: true })
    return {
      signal: merged.signal,
      cleanup: () => {
        outerSignal.removeEventListener('abort', abort)
        capSig.removeEventListener('abort', abort)
      },
    }
  }

  return { signal, wake }
}
