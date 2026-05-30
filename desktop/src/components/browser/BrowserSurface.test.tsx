import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})

const { bridge } = vi.hoisted(() => ({
  bridge: { open: vi.fn(), navigate: vi.fn(), setBounds: vi.fn(), setVisible: vi.fn(), close: vi.fn(), eval: vi.fn() },
}))
vi.mock('../../lib/previewBridge', () => ({ previewBridge: bridge }))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

import { BrowserSurface } from './BrowserSurface'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'

afterEach(() => {
  Object.values(bridge).forEach((f) => f.mockReset())
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
})

describe('BrowserSurface', () => {
  it('opens the preview at the session url on mount when surface is open', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    expect(bridge.open).toHaveBeenCalledWith('http://localhost:5173/', expect.objectContaining({ width: expect.any(Number) }))
  })

  it('navigating via address bar calls store + bridge', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'http://localhost:3000/' } })
    fireEvent.submit(input.closest('form')!)
    expect(bridge.navigate).toHaveBeenCalledWith('http://localhost:3000/')
    expect(useBrowserPanelStore.getState().bySession['s1']!.url).toBe('http://localhost:3000/')
  })

  it('hides the native webview on unmount', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    const { unmount } = render(<BrowserSurface sessionId="s1" />)
    unmount()
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('截图 button triggers a capture via preview_eval', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    fireEvent.click(screen.getByLabelText('截图'))
    expect(bridge.eval).toHaveBeenCalledWith(expect.stringContaining('capture'))
  })

  it('选择元素 button toggles pickerActive and signals the bridge', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    fireEvent.click(screen.getByLabelText('选择元素'))
    expect(useBrowserPanelStore.getState().bySession['s1']!.pickerActive).toBe(true)
    expect(bridge.eval).toHaveBeenCalledWith(expect.stringContaining('enter-picker'))
    fireEvent.click(screen.getByLabelText('选择元素'))
    expect(useBrowserPanelStore.getState().bySession['s1']!.pickerActive).toBe(false)
    expect(bridge.eval).toHaveBeenLastCalledWith(expect.stringContaining('exit-picker'))
  })

  it('renders the loading indicator while the session is loading (open starts loading)', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    render(<BrowserSurface sessionId="s1" />)
    expect(screen.getByTestId('browser-loading-bar')).toBeInTheDocument()
    expect(screen.getByLabelText('刷新')).toHaveAttribute('aria-busy', 'true')
  })

  it('hides the loading indicator once the page is ready', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    useBrowserPanelStore.getState().setReady('s1')
    render(<BrowserSurface sessionId="s1" />)
    expect(screen.queryByTestId('browser-loading-bar')).not.toBeInTheDocument()
    expect(screen.getByLabelText('刷新')).toHaveAttribute('aria-busy', 'false')
  })

  it('reload flips the session back into loading and shows the indicator', () => {
    useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
    useBrowserPanelStore.getState().setReady('s1')
    render(<BrowserSurface sessionId="s1" />)
    expect(screen.queryByTestId('browser-loading-bar')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('刷新'))
    expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(true)
    expect(bridge.navigate).toHaveBeenCalledWith('http://localhost:5173/')
    expect(screen.getByTestId('browser-loading-bar')).toBeInTheDocument()
  })

  it('forces loading off after the timeout fallback elapses', () => {
    vi.useFakeTimers()
    try {
      useBrowserPanelStore.getState().open('s1', 'http://localhost:5173/')
      render(<BrowserSurface sessionId="s1" />)
      expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(true)
      vi.advanceTimersByTime(15000)
      expect(useBrowserPanelStore.getState().bySession['s1']!.loading).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
