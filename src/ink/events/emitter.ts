import { EventEmitter as NodeEventEmitter } from 'events'
import { Event } from './event.js'

// 类似于 Node 内置的 EventEmitter，但也识别我们的 `Event` 类，
// 因此 `emit` 会遵守 `stopImmediatePropagation()`。
export class EventEmitter extends NodeEventEmitter {
  constructor() {
    super()
    // 关闭默认的 maxListeners 警告。在 React 中，很多组件都可能合理地
    // 监听同一个事件（例如 useInput hooks）。默认上限 10 会产生误报。
    this.setMaxListeners(0)
  }

  override emit(type: string | symbol, ...args: unknown[]): boolean {
    // `error` 不按普通事件处理，因此交回给 Node 自己处理
    if (type === 'error') {
      return super.emit(type, ...args)
    }

    const listeners = this.rawListeners(type)

    if (listeners.length === 0) {
      return false
    }

    const ccEvent = args[0] instanceof Event ? args[0] : null

    for (const listener of listeners) {
      listener.apply(this, args)

      if (ccEvent?.didStopImmediatePropagation()) {
        break
      }
    }

    return true
  }
}
