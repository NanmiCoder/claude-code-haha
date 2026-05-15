/**
 * 用于在初始 flush 期间控制消息写入的状态机。
 *
 * 当 bridge session 启动时，历史消息会通过一次 HTTP POST flush 到
 * 服务端。在该 flush 期间，新的消息必须先入队，避免与历史消息交错到达
 * 服务端。
 *
 * 生命周期：
 *   start() → enqueue() 返回 true，条目会入队
 *   end()   → 返回已入队条目以便排空，enqueue() 返回 false
 *   drop()  → 丢弃已入队条目（transport 永久关闭）
 *   deactivate() → 清除 active 标记但不丢弃条目
 *                   （transport 被替换，新 transport 会负责排空）
 */
export class FlushGate<T> {
  private _active = false
  private _pending: T[] = []

  get active(): boolean {
    return this._active
  }

  get pendingCount(): number {
    return this._pending.length
  }

  /** 将 flush 标记为进行中。enqueue() 将开始把条目加入队列。 */
  start(): void {
    this._active = true
  }

  /**
    * 结束 flush，并返回所有已入队条目以便排空。
    * 调用方负责发送返回的条目。
   */
  end(): T[] {
    this._active = false
    return this._pending.splice(0)
  }

  /**
    * 如果 flush 处于激活状态，则将条目入队并返回 true。
    * 如果 flush 未激活，则返回 false（调用方应直接发送）。
   */
  enqueue(...items: T[]): boolean {
    if (!this._active) return false
    this._pending.push(...items)
    return true
  }

  /**
    * 丢弃所有已入队条目（transport 永久关闭）。
    * 返回被丢弃的条目数量。
   */
  drop(): number {
    this._active = false
    const count = this._pending.length
    this._pending.length = 0
    return count
  }

  /**
    * 清除 active 标记，但不丢弃已入队条目。
    * 在 transport 被替换时使用（onWorkReceived）；新的
    * transport 的 flush 会排空这些待处理条目。
   */
  deactivate(): void {
    this._active = false
  }
}
