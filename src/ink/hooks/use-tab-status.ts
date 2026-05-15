import { useContext, useEffect, useRef } from 'react'
import {
  CLEAR_TAB_STATUS,
  supportsTabStatus,
  tabStatus,
  wrapForMultiplexer,
} from '../termio/osc.js'
import type { Color } from '../termio/types.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'

export type TabStatusKind = 'idle' | 'busy' | 'waiting'

const rgb = (r: number, g: number, b: number): Color => ({
  type: 'rgb',
  r,
  g,
  b,
})

// 按照 OSC 21337 使用指南推荐的映射。
const TAB_STATUS_PRESETS: Record<
  TabStatusKind,
  { indicator: Color; status: string; statusColor: Color }
> = {
  idle: {
    indicator: rgb(0, 215, 95),
    status: 'Idle',
    statusColor: rgb(136, 136, 136),
  },
  busy: {
    indicator: rgb(255, 149, 0),
    status: 'Working…',
    statusColor: rgb(255, 149, 0),
  },
  waiting: {
    indicator: rgb(95, 135, 255),
    status: 'Waiting',
    statusColor: rgb(95, 135, 255),
  },
}

/**
 * 以声明式方式设置 tab-status 指示器（OSC 21337）。
 *
 * 会向标签页侧边栏输出一个彩色圆点和一段简短状态文本。不支持 OSC 21337 的
 * 终端会静默丢弃该序列，因此可以无条件调用。会为 tmux/screen 做 passthrough 包装。
 *
 * 传入 `null` 表示关闭。如果之前设置过状态，那么切换到 `null` 时会发出
 * CLEAR_TAB_STATUS，避免在会话中途关闭后残留旧的圆点。进程退出时的清理由
 * ink.tsx 的 unmount 路径处理。
 */
export function useTabStatus(kind: TabStatusKind | null): void {
  const writeRaw = useContext(TerminalWriteContext)
  const prevKindRef = useRef<TabStatusKind | null>(null)

  useEffect(() => {
    // 当 kind 从非 null 变成 null 时（例如用户在会话中途关闭
    // showStatusInTerminalTab），清除残留的旧圆点。
    if (kind === null) {
      if (prevKindRef.current !== null && writeRaw && supportsTabStatus()) {
        writeRaw(wrapForMultiplexer(CLEAR_TAB_STATUS))
      }
      prevKindRef.current = null
      return
    }

    prevKindRef.current = kind
    if (!writeRaw || !supportsTabStatus()) return
    writeRaw(wrapForMultiplexer(tabStatus(TAB_STATUS_PRESETS[kind])))
  }, [kind, writeRaw])
}
