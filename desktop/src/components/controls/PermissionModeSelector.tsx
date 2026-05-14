import { useState, useRef, useEffect } from 'react'
import DOMPurify from 'dompurify'
import { createPortal } from 'react-dom'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import type { PermissionMode } from '../../types/settings'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import { isTauriRuntime } from '../../lib/desktopRuntime'
import { MobileBottomSheet } from '../shared/MobileBottomSheet'
import { getOverlayRoot } from '../../lib/overlayRoot'

const MODE_ICONS: Record<PermissionMode, string> = {
  default: 'verified_user',
  acceptEdits: 'bolt',
  plan: 'architecture',
  bypassPermissions: 'gavel',
  dontAsk: 'gavel',
}

type Props = {
  workDir?: string
  compact?: boolean
  /** Controlled mode: override current value */
  value?: PermissionMode
  /** Controlled mode: called on change instead of updating global store */
  onChange?: (mode: PermissionMode) => void
}

export function PermissionModeSelector({ workDir: workDirProp, compact = false, value, onChange }: Props = {}) {
  const t = useTranslation()
  const isMobile = useMobileViewport() && !isTauriRuntime()
  const { permissionMode: storeMode, setPermissionMode } = useSettingsStore()
  const setSessionPermissionMode = useChatStore((s) => s.setSessionPermissionMode)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const [open, setOpen] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const isControlled = value !== undefined
  const currentMode = isControlled ? value : storeMode

  const PERMISSION_ITEMS: Array<{
    value: PermissionMode
    label: string
    description: string
    icon: string
    color?: string
  }> = [
    {
      value: 'default',
      label: t('permMode.askPermissions'),
      description: t('permMode.askPermDesc'),
      icon: 'verified_user',
    },
    {
      value: 'acceptEdits',
      label: t('permMode.autoAccept'),
      description: t('permMode.autoAcceptDesc'),
      icon: 'bolt',
    },
    {
      value: 'plan',
      label: t('permMode.planMode'),
      description: t('permMode.planModeDesc'),
      icon: 'architecture',
      color: 'text-[var(--color-text-tertiary)]',
    },
    {
      value: 'bypassPermissions',
      label: t('permMode.bypass'),
      description: t('permMode.bypassDesc'),
      icon: 'gavel',
      color: 'text-[var(--color-error)]',
    },
  ]

  const MODE_LABELS: Record<PermissionMode, string> = {
    default: t('permMode.label.default'),
    acceptEdits: t('permMode.label.acceptEdits'),
    plan: t('permMode.label.plan'),
    bypassPermissions: t('permMode.label.bypassPermissions'),
    dontAsk: t('permMode.label.dontAsk'),
  }

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const workDir = workDirProp || activeSession?.workDir || '~'
  const compactButtonClass = compact
    ? isMobile
      ? 'h-11 w-11 justify-center rounded-xl p-0'
      : 'h-8 w-8 justify-center rounded-full p-0'
    : 'gap-1.5 rounded-full px-2.5 py-1.5 text-xs'
  const menuId = 'permission-mode-menu'

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  const permissionOptions = (
    <div id={menuId} ref={menuRef} role="menu">
      {PERMISSION_ITEMS.map((item) => (
        <button
          key={item.value}
          role="menuitem"
          onClick={() => {
            if (item.value === 'bypassPermissions') {
              setOpen(false)
              setConfirmDialog(true)
              return
            }
            if (isControlled) {
              onChange?.(item.value)
            } else {
              void setPermissionMode(item.value)
              if (activeTabId) setSessionPermissionMode(activeTabId, item.value)
            }
            setOpen(false)
          }}
          className={`
            flex w-full items-start gap-3 px-4 py-3 text-left transition-colors
            hover:bg-[var(--color-surface-hover)]
            ${item.value === currentMode ? 'bg-[var(--color-surface-selected)]' : ''}
          `}
        >
          <span className={`material-symbols-outlined mt-0.5 text-[20px] ${item.color || 'text-[var(--color-text-secondary)]'}`}>
            {item.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-[var(--color-text-primary)]">{item.label}</div>
            <div className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">{item.description}</div>
          </div>
          {item.value === currentMode && (
            <span className="material-symbols-outlined mt-0.5 text-[16px] text-[var(--color-brand)]" style={{ fontVariationSettings: "'FILL' 1" }}>
              check_circle
            </span>
          )}
        </button>
      ))}
    </div>
  )

  const menuContent = (
    <>
      <div className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[var(--color-outline)]">
        {t('permMode.executionPermissions')}
      </div>
      {permissionOptions}
    </>
  )

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label={MODE_LABELS[currentMode]}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={compact ? MODE_LABELS[currentMode] : undefined}
        className={`flex items-center bg-[var(--color-surface-container-low)] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] ${
          compactButtonClass
        }`}
      >
        <span className="material-symbols-outlined text-[14px]">{MODE_ICONS[currentMode]}</span>
        {!compact && (
          <>
            <span>{MODE_LABELS[currentMode]}</span>
            <span className="material-symbols-outlined text-[12px]">expand_more</span>
          </>
        )}
      </button>

      {open && (
        isMobile ? (
          <MobileBottomSheet
            open={open}
            onClose={() => setOpen(false)}
            title={t('permMode.executionPermissions')}
            closeLabel={t('tabs.close')}
            ariaLabel={t('permMode.executionPermissions')}
            contentClassName="py-2"
          >
            {permissionOptions}
          </MobileBottomSheet>
        ) : (
          <div id={menuId} ref={menuRef} role="menu" className="absolute left-0 bottom-full mb-2 w-[320px] rounded-xl bg-[var(--color-surface-container-lowest)] border border-[var(--color-border)] shadow-[var(--shadow-dropdown)] z-50 py-2">
            {menuContent}
          </div>
        )
      )}

      {/* Bypass confirmation dialog */}
      {confirmDialog && createPortal(
        <div className={`fixed inset-0 z-[100] flex items-center justify-center bg-black/40 ${isMobile ? 'px-4' : 'pl-[var(--sidebar-width)] pr-4'}`} onClick={() => setConfirmDialog(false)}>
          <div
            className={`${isMobile ? 'w-full max-w-md' : 'w-[420px]'} rounded-2xl bg-[var(--color-surface-container-lowest)] border border-[var(--color-border)] shadow-[var(--shadow-dropdown)] overflow-hidden`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-4 bg-[var(--color-error)]/8 border-b border-[var(--color-error)]/15">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--color-error)]/12">
                <span className="material-symbols-outlined text-[22px] text-[var(--color-error)]">warning</span>
              </div>
              <div>
                <div className="text-sm font-bold text-[var(--color-text-primary)]">{t('permMode.enableBypassTitle')}</div>
                <div className="text-xs text-[var(--color-text-tertiary)] mt-0.5">{t('permMode.enableBypassSubtitle')}</div>
              </div>
            </div>

            {/* Body */}
            <div className="px-5 py-4">
              <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed mb-3" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(t('permMode.enableBypassBody')) }} />
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-surface-container)] border border-[var(--color-border)]" title={workDir}>
                <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)] shrink-0">folder</span>
                <code className="text-xs font-[var(--font-mono)] text-[var(--color-text-primary)] truncate">{workDir}</code>
              </div>
              <ul className="mt-3 space-y-1.5 text-xs text-[var(--color-text-secondary)]">
                <li className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-[14px] text-[var(--color-error)] mt-0.5">check</span>
                  {t('permMode.permReadWrite')}
                </li>
                <li className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-[14px] text-[var(--color-error)] mt-0.5">check</span>
                  {t('permMode.permShell')}
                </li>
                <li className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-[14px] text-[var(--color-error)] mt-0.5">check</span>
                  {t('permMode.permPackages')}
                </li>
              </ul>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
              <button
                onClick={() => setConfirmDialog(false)}
                className="px-4 py-2 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  if (isControlled) {
                    onChange?.('bypassPermissions')
                  } else {
                    void setPermissionMode('bypassPermissions')
                    if (activeTabId) setSessionPermissionMode(activeTabId, 'bypassPermissions')
                  }
                  setConfirmDialog(false)
                }}
                className="px-4 py-2 text-xs font-semibold text-white bg-[var(--color-error)] hover:opacity-90 rounded-lg transition-colors"
              >
                {t('permMode.enableBypassBtn')}
              </button>
            </div>
          </div>
        </div>,
        getOverlayRoot(),
      )}
    </div>
  )
}
