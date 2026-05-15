import { Event } from './event.js'

type EventPhase = 'none' | 'capturing' | 'at_target' | 'bubbling'

type TerminalEventInit = {
  bubbles?: boolean
  cancelable?: boolean
}

/**
 * 所有采用 DOM 风格传播的终端事件的基类。
 *
 * 继承自 Event，使现有事件类型（ClickEvent、InputEvent、
 * TerminalFocusEvent）共享同一个祖先类型，并可在后续平滑迁移。
 *
 * 与浏览器的 Event API 保持一致：target、currentTarget、eventPhase、
 * stopPropagation()、preventDefault()、timeStamp。
 */
export class TerminalEvent extends Event {
  readonly type: string
  readonly timeStamp: number
  readonly bubbles: boolean
  readonly cancelable: boolean

  private _target: EventTarget | null = null
  private _currentTarget: EventTarget | null = null
  private _eventPhase: EventPhase = 'none'
  private _propagationStopped = false
  private _defaultPrevented = false

  constructor(type: string, init?: TerminalEventInit) {
    super()
    this.type = type
    this.timeStamp = performance.now()
    this.bubbles = init?.bubbles ?? true
    this.cancelable = init?.cancelable ?? true
  }

  get target(): EventTarget | null {
    return this._target
  }

  get currentTarget(): EventTarget | null {
    return this._currentTarget
  }

  get eventPhase(): EventPhase {
    return this._eventPhase
  }

  get defaultPrevented(): boolean {
    return this._defaultPrevented
  }

  stopPropagation(): void {
    this._propagationStopped = true
  }

  override stopImmediatePropagation(): void {
    super.stopImmediatePropagation()
    this._propagationStopped = true
  }

  preventDefault(): void {
    if (this.cancelable) {
      this._defaultPrevented = true
    }
  }

  // -- Dispatcher 使用的内部 setter

  /** @internal */
  _setTarget(target: EventTarget): void {
    this._target = target
  }

  /** @internal */
  _setCurrentTarget(target: EventTarget | null): void {
    this._currentTarget = target
  }

  /** @internal */
  _setEventPhase(phase: EventPhase): void {
    this._eventPhase = phase
  }

  /** @internal */
  _isPropagationStopped(): boolean {
    return this._propagationStopped
  }

  /** @internal */
  _isImmediatePropagationStopped(): boolean {
    return this.didStopImmediatePropagation()
  }

  /**
   * 子类可覆写的钩子，用于在每个 handler 触发前执行针对当前节点的准备逻辑。
   * 默认不执行任何操作。
   */
  _prepareForTarget(_target: EventTarget): void {}
}

export type EventTarget = {
  parentNode: EventTarget | undefined
  _eventHandlers?: Record<string, unknown>
}
