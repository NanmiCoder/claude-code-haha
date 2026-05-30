import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { BrowserAddressBar } from './BrowserAddressBar'

const baseProps = {
  url: 'http://localhost:5173/', canGoBack: false, canGoForward: false,
  onNavigate: vi.fn(), onBack: vi.fn(), onForward: vi.fn(), onReload: vi.fn(),
}

describe('BrowserAddressBar', () => {
  it('shows the current url in the input', () => {
    render(<BrowserAddressBar {...baseProps} />)
    expect(screen.getByRole('textbox')).toHaveValue('http://localhost:5173/')
  })

  it('submits the edited url via onNavigate', () => {
    const onNavigate = vi.fn()
    render(<BrowserAddressBar {...baseProps} onNavigate={onNavigate} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'http://localhost:3000/x' } })
    fireEvent.submit(input.closest('form')!)
    expect(onNavigate).toHaveBeenCalledWith('http://localhost:3000/x')
  })

  it('disables back when cannot go back', () => {
    render(<BrowserAddressBar {...baseProps} canGoBack={false} />)
    expect(screen.getByLabelText('后退')).toBeDisabled()
  })

  it('enables back and fires onBack when canGoBack', () => {
    const onBack = vi.fn()
    render(<BrowserAddressBar {...baseProps} canGoBack onBack={onBack} />)
    fireEvent.click(screen.getByLabelText('后退'))
    expect(onBack).toHaveBeenCalled()
  })

  it('shows the loading progress bar and a busy reload button while loading', () => {
    render(<BrowserAddressBar {...baseProps} loading />)
    expect(screen.getByTestId('browser-loading-bar')).toBeInTheDocument()
    expect(screen.getByLabelText('刷新')).toHaveAttribute('aria-busy', 'true')
  })

  it('hides the loading progress bar when not loading', () => {
    render(<BrowserAddressBar {...baseProps} loading={false} />)
    expect(screen.queryByTestId('browser-loading-bar')).not.toBeInTheDocument()
    expect(screen.getByLabelText('刷新')).toHaveAttribute('aria-busy', 'false')
  })
})
