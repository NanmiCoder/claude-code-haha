import { useMemo, useState } from 'react'
import { useTranslation } from '../../i18n'
import { computerUseApi } from '../../api/computerUse'
import { useChatStore } from '../../stores/chatStore'
import { isWebRuntime } from '../../lib/desktopRuntime'
import type {
  ComputerUsePermissionRequest,
  ComputerUsePermissionResponse,
} from '../../types/chat'
import { Button } from '../shared/Button'
import { Modal } from '../shared/Modal'

type Props = {
  sessionId: string
  request: ComputerUsePermissionRequest | null
}

const DEFAULT_GRANT_FLAGS = {
  clipboardRead: false,
  clipboardWrite: false,
  systemKeyCombos: false,
} as const

function denyAllResponse(): ComputerUsePermissionResponse {
  return {
    granted: [],
    denied: [],
    flags: { ...DEFAULT_GRANT_FLAGS },
    userConsented: false,
  }
}

function buildAllowResponse(
  request: ComputerUsePermissionRequest,
): ComputerUsePermissionResponse {
  const now = Date.now()
  const granted = request.apps.flatMap((app) => {
    if (!app.resolved || app.alreadyGranted) return []
    return [{
      bundleId: app.resolved.bundleId,
      displayName: app.resolved.displayName,
      grantedAt: now,
      tier: app.proposedTier,
    }]
  })

  const denied = request.apps.flatMap((app) => {
    if (app.resolved) return []
    return [{
      bundleId: app.requestedName,
      reason: 'not_installed' as const,
    }]
  })

  const flags = {
    ...DEFAULT_GRANT_FLAGS,
    ...Object.fromEntries(
      Object.entries(request.requestedFlags).filter(([, value]) => value === true),
    ),
  }

  return {
    granted,
    denied,
    flags,
    userConsented: true,
  }
}

export function ComputerUsePermissionModal({ sessionId, request }: Props) {
  if (isWebRuntime()) return null

  const t = useTranslation()
  const respondToComputerUsePermission = useChatStore(
    (s) => s.respondToComputerUsePermission,
  )
  const [openingPane, setOpeningPane] = useState<
    'Privacy_Accessibility' | 'Privacy_ScreenCapture' | null
  >(null)

  const requestedFlags = useMemo(
    () =>
      request
        ? Object.entries(request.requestedFlags)
            .filter(([, enabled]) => enabled)
            .map(([flag]) => flag)
        : [],
    [request],
  )

  if (!request) return null

  const handleDeny = () => {
    respondToComputerUsePermission(
      sessionId,
      request.requestId,
      denyAllResponse(),
    )
  }

  const handleAllow = () => {
    respondToComputerUsePermission(
      sessionId,
      request.requestId,
      buildAllowResponse(request),
    )
  }

  const openSettings = async (
    pane: 'Privacy_Accessibility' | 'Privacy_ScreenCapture',
  ) => {
    setOpeningPane(pane)
    try {
      await computerUseApi.openSettings(pane)
    } finally {
      setOpeningPane(null)
    }
  }

  const tccState = request.tccState

  return (
    <Modal
      open
      onClose={handleDeny}
      title={
        tccState
          ? t('computerUseApproval.titleTcc')
          : t('computerUseApproval.titleApps')
      }
      width={640}
      footer={
        tccState ? (
          <Button variant="ghost" onClick={handleDeny}>
            {t('computerUseApproval.deny')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={handleDeny}>
              {t('computerUseApproval.deny')}
            </Button>
            <Button variant="primary" onClick={handleAllow}>
              {t('computerUseApproval.allow')}
            </Button>
          </>
        )
      }
    >
      {tccState ? (
        <div className="space-y-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t('computerUseApproval.tccHint')}
          </p>

          <div className="space-y-3">
            <PermissionRow
              label={t('computerUseApproval.accessibility')}
              granted={tccState.accessibility}
              actionLabel={t('computerUseApproval.openAccessibility')}
              actionLoading={openingPane === 'Privacy_Accessibility'}
              onAction={() => openSettings('Privacy_Accessibility')}
            />
            <PermissionRow
              label={t('computerUseApproval.screenRecording')}
              granted={tccState.screenRecording}
              actionLabel={t('computerUseApproval.openScreenRecording')}
              actionLoading={openingPane === 'Privacy_ScreenCapture'}
              onAction={() => openSettings('Privacy_ScreenCapture')}
            />
          </div>

          <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3 text-xs text-[var(--color-text-tertiary)]">
            {t('computerUseApproval.tryAgainHint')}
          </div>

          <div className="flex justify-end">
            <Button variant="secondary" onClick={handleDeny}>
              {t('computerUseApproval.tryAgain')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {request.reason ? (
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
                {t('computerUseApproval.reason')}
              </div>
              <div className="mt-1 text-sm text-[var(--color-text-primary)]">
                {request.reason}
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            {request.apps.map((app) => {
              const resolved = app.resolved
              return (
                <div
                  key={resolved?.bundleId ?? app.requestedName}
                  className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-[var(--color-text-primary)]">
                        {resolved?.displayName ?? app.requestedName}
                      </div>
                      <div className="mt-1 text-xs text-[var(--color-text-tertiary)]">
                        {resolved?.bundleId ?? t('computerUseApproval.notInstalled')}
                      </div>
                    </div>
                    <span className="rounded-full bg-[var(--color-surface-container)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
                      {app.proposedTier}
                    </span>
                  </div>

                  {!resolved ? (
                    <p className="mt-2 text-xs text-[var(--color-error)]">
                      {t('computerUseApproval.notInstalled')}
                    </p>
                  ) : null}

                  {app.alreadyGranted ? (
                    <p className="mt-2 text-xs text-[var(--color-success)]">
                      {t('computerUseApproval.alreadyGranted')}
                    </p>
                  ) : null}

                  {app.isSentinel ? (
                    <p className="mt-2 text-xs text-[var(--color-warning)]">
                      {t('computerUseApproval.sensitiveApp')}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </div>

          {requestedFlags.length > 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
                {t('computerUseApproval.alsoRequested')}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {requestedFlags.map((flag) => (
                  <span
                    key={flag}
                    className="rounded-full bg-[var(--color-surface-container)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)]"
                  >
                    {flag}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {request.willHide && request.willHide.length > 0 ? (
            <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3 text-sm text-[var(--color-text-secondary)]">
              {request.autoUnhideEnabled
                ? t('computerUseApproval.hideWhileWorkingRestore', {
                    count: request.willHide.length,
                  })
                : t('computerUseApproval.hideWhileWorking', {
                    count: request.willHide.length,
                  })}
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  )
}

function PermissionRow({
  label,
  granted,
  actionLabel,
  actionLoading,
  onAction,
}: {
  label: string
  granted: boolean
  actionLabel: string
  actionLoading: boolean
  onAction: () => void
}) {
  const t = useTranslation()

  return (
    <div className="flex items-center justify-between gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3">
      <div>
        <div className="text-sm font-semibold text-[var(--color-text-primary)]">
          {label}
        </div>
        <div className="mt-1 text-xs text-[var(--color-text-tertiary)]">
          {granted
            ? t('computerUseApproval.granted')
            : t('computerUseApproval.notGranted')}
        </div>
      </div>

      {!granted ? (
        <Button
          variant="secondary"
          size="sm"
          loading={actionLoading}
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}
