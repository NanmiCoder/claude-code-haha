import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Loader2, RotateCw } from 'lucide-react'

type Props = {
  url: string
  canGoBack: boolean
  canGoForward: boolean
  loading?: boolean
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
}

export function BrowserAddressBar({ url, canGoBack, canGoForward, loading = false, onNavigate, onBack, onForward, onReload }: Props) {
  const [draft, setDraft] = useState(url)
  useEffect(() => { setDraft(url) }, [url])

  return (
    <div className="relative flex items-center gap-1 px-2 py-1.5 border-b border-[var(--color-border)]">
      <button aria-label="后退" disabled={!canGoBack} onClick={onBack} className="p-1 disabled:opacity-40"><ArrowLeft size={16} /></button>
      <button aria-label="前进" disabled={!canGoForward} onClick={onForward} className="p-1 disabled:opacity-40"><ArrowRight size={16} /></button>
      <button aria-label="刷新" aria-busy={loading} onClick={onReload} className="p-1">
        {loading ? <Loader2 size={16} className="animate-spin" /> : <RotateCw size={16} />}
      </button>
      <form className="flex-1" onSubmit={(e) => { e.preventDefault(); onNavigate(draft.trim()) }}>
        <input
          className="w-full rounded-md bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
      </form>
      {loading && (
        <div
          role="progressbar"
          aria-label="加载中"
          data-testid="browser-loading-bar"
          className="progress-indeterminate-track pointer-events-none absolute inset-x-0 bottom-0 h-0.5"
        />
      )}
    </div>
  )
}
