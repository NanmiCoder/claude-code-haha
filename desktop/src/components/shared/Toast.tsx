import { useUIStore, type Toast as ToastType } from '../../stores/uiStore'
import { createOverlayPortal } from '../../lib/overlayRoot'

const typeStyles: Record<ToastType['type'], string> = {
  success: 'border-l-4 border-l-[var(--color-success)]',
  error: 'border-l-4 border-l-[var(--color-error)]',
  warning: 'border-l-4 border-l-[var(--color-warning)]',
  info: 'border-l-4 border-l-[var(--color-text-accent)]',
}

function ToastItem({ toast }: { toast: ToastType }) {
  const removeToast = useUIStore((s) => s.removeToast)

  return (
    <div
      className={`
        bg-[var(--color-surface)] rounded-[var(--radius-md)] shadow-[var(--shadow-dropdown)]
        px-4 py-3 text-sm text-[var(--color-text-primary)]
        ${typeStyles[toast.type]}
        animate-in slide-in-from-right fade-in duration-200
      `}
    >
      <div className="flex items-center justify-between gap-2">
        <span>{toast.message}</span>
        <button
          onClick={() => removeToast(toast.id)}
          className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] text-lg leading-none"
        >
          ×
        </button>
      </div>
    </div>
  )
}

export function ToastContainer() {
  const toasts = useUIStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return createOverlayPortal(
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>,
  )
}