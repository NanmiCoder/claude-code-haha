import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import { CodeViewer } from './CodeViewer'
import { Modal } from '../shared/Modal'
import { CopyButton } from '../shared/CopyButton'
import { api } from '../../api/client'

type Props = {
  code: string
}

export function PlantUMLRenderer({ code }: Props) {
  const [svg, setSvg] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    api.post<{ svg: string | null; error?: string }>('/api/settings/plantuml/render', { code })
      .then((result) => {
        if (cancelled) return
        if (result.error) {
          setError(result.error)
          setSvg(null)
        } else if (result.svg) {
          setSvg(DOMPurify.sanitize(result.svg, {
            ADD_TAGS: ['foreignObject'],
            USE_PROFILES: { svg: true, svgFilters: true },
          }))
          setError(null)
        } else {
          setSvg(null)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'PlantUML render failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [code])

  if (loading) {
    return (
      <div className="my-4 flex items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)]/50 bg-[var(--color-surface-container-low)] py-8">
        <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-tertiary)]">
          <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
          Rendering diagram...
        </div>
      </div>
    )
  }

  if (!svg) {
    if (error) {
      return (
        <div className="my-4 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-error)]/40 bg-[var(--color-surface-container-low)]">
          <div className="flex items-center gap-2 border-b border-[var(--color-error)]/20 px-3 py-2 text-[11px] text-[var(--color-error)]">
            <span className="material-symbols-outlined text-[14px]">error</span>
            <span className="font-semibold">PlantUML Render Error</span>
          </div>
          <pre className="overflow-auto p-3 text-[11px] text-[var(--color-text-tertiary)]">{error}</pre>
        </div>
      )
    }
    return (
      <div className="my-4">
        <CodeViewer code={code} language="plantuml" />
      </div>
    )
  }

  return (
    <>
      <div className="my-4 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-outline-variant)]/50 bg-[var(--color-surface-container-low)]">
        <div className="flex items-center justify-between border-b border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container)] px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)]">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[14px]">schema</span>
            <span className="font-semibold uppercase tracking-[0.14em]">PlantUML</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPreviewOpen(true)}
              className="flex items-center gap-1 rounded-md border border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container-lowest)] px-2 py-1 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
            >
              <span className="material-symbols-outlined text-[12px]">fullscreen</span>
              Preview
            </button>
            <CopyButton
              text={code}
              className="rounded-md border border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container-lowest)] px-2 py-1 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
            />
          </div>
        </div>
        <div
          className="flex items-center justify-center overflow-auto bg-white p-4"
          style={{ maxHeight: 400 }}
          onClick={() => setPreviewOpen(true)}
          dangerouslySetInnerHTML={{ __html: svg }}
          role="img"
          aria-label="PlantUML diagram"
        />
      </div>

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} width={1100}>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
              <span className="material-symbols-outlined text-[18px]">schema</span>
              PlantUML Diagram
            </div>
            <CopyButton
              text={code}
              className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)]"
            />
          </div>
          <div className="overflow-auto rounded-xl bg-white" style={{ maxHeight: '75vh' }}>
            <div className="p-6" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        </div>
      </Modal>
    </>
  )
}
