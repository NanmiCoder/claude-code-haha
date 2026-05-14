import { createPortal } from 'react-dom'

let overlayRoot: HTMLElement | null = null

export function getOverlayRoot(): HTMLElement {
  if (!overlayRoot) {
    overlayRoot = document.getElementById('app-overlay-root') ?? document.body
  }
  return overlayRoot
}

export function createOverlayPortal(children: React.ReactNode): React.ReactPortal {
  return createPortal(children, getOverlayRoot())
}