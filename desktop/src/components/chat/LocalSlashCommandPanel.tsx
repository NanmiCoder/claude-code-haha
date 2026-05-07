import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { skillsApi } from '../../api/skills'
import { mcpApi } from '../../api/mcp'
import { filesystemApi } from '../../api/filesystem'
import {
  sessionsApi,
  type SessionContextSnapshot,
  type SessionInspectionResponse,
  type SessionUsageSnapshot,
} from '../../api/sessions'
import { useTranslation, type TranslationKey } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { useChatStore } from '../../stores/chatStore'
import { SETTINGS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useSkillStore } from '../../stores/skillStore'
import type { McpServerRecord } from '../../types/mcp'
import type { SkillMeta } from '../../types/skill'
import type { SlashCommandOption } from './composerUtils'

export type LocalSlashCommandName = 'mcp' | 'skills' | 'add-dir' | 'help' | 'status' | 'cost' | 'context'

type Props = {
  command: LocalSlashCommandName
  sessionId?: string
  cwd?: string
  commands?: SlashCommandOption[]
  onClose: () => void
}

type SessionInspectorTab = 'status' | 'usage' | 'context'
type Translate = ReturnType<typeof useTranslation>

function toneForStatus(status: McpServerRecord['status']) {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
    case 'needs-auth':
      return 'bg-amber-500/10 text-amber-600 border-amber-500/20'
    case 'failed':
      return 'bg-rose-500/10 text-rose-600 border-rose-500/20'
    case 'disabled':
      return 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border-[var(--color-border)]'
    default:
      return ''
  }
}

function scopeLabel(scope: string, t: ReturnType<typeof useTranslation>) {
  switch (scope) {
    case 'user':
      return t('settings.mcp.scope.user')
    case 'local':
      return t('settings.mcp.scope.local')
    case 'project':
      return t('settings.mcp.scope.project')
    default:
      return scope
  }
}

function projectBadge(path?: string, t?: ReturnType<typeof useTranslation>) {
  if (!path || !t) return null
  const label = path.replace(/\/$/, '').split('/').pop() || path
  return t('slash.mcp.projectBadge', { name: label })
}

function PanelShell({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-3 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
        <div>
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">{title}</h3>
          <p className="mt-1 text-sm text-[var(--color-text-tertiary)]">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>
      <div className="max-h-[min(620px,72vh)] overflow-y-auto px-5 py-4">{children}</div>
    </div>
  )
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-tertiary)]">
      <div className="mr-3 h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-brand)] border-t-transparent" />
      {label}
    </div>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-10 text-center">
      <div className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</div>
      <div className="mt-2 text-xs leading-6 text-[var(--color-text-tertiary)]">{body}</div>
    </div>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-[var(--color-error)]/20 bg-[var(--color-error)]/8 px-5 py-4 text-sm text-[var(--color-error)]">
      {message}
    </div>
  )
}

function formatNumber(value: number | undefined) {
  return new Intl.NumberFormat().format(value ?? 0)
}

function formatDuration(seconds: number | undefined) {
  const total = Math.max(0, Math.round(seconds ?? 0))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const remaining = total % 60
  return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`
}

function formatPercent(value: number | undefined) {
  const percent = Math.max(0, Math.min(100, value ?? 0))
  return `${percent.toFixed(percent >= 10 || Number.isInteger(percent) ? 0 : 1)}%`
}

function sessionInspectorInitialTab(command: LocalSlashCommandName): SessionInspectorTab {
  if (command === 'cost') return 'usage'
  if (command === 'context') return 'context'
  return 'status'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object')
}

function isSessionInspectionResponse(value: unknown): value is SessionInspectionResponse {
  if (!isRecord(value)) return false
  if (typeof value.active !== 'boolean') return false
  if (!isRecord(value.status)) return false
  return (
    typeof value.status.sessionId === 'string' &&
    typeof value.status.workDir === 'string' &&
    typeof value.status.permissionMode === 'string'
  )
}

function assertSessionInspectionResponse(value: unknown, t: Translate): SessionInspectionResponse {
  if (isSessionInspectionResponse(value)) return value
  throw new Error(t('slash.inspector.error.unavailable'))
}

function InspectorSectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-4">
      <div className="font-mono text-[12px] font-semibold uppercase tracking-[0.24em] text-[var(--color-inspector-heading)]">{children}</div>
      {action}
    </div>
  )
}

function MetricCard({ label, value, detail }: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className="min-h-[82px] rounded-md border border-[var(--color-inspector-border)] bg-[var(--color-inspector-panel)] px-4 py-4 font-mono">
      <div className="text-[12px] uppercase tracking-[0.2em] text-[var(--color-inspector-heading)]">{label}</div>
      <div className="mt-3 whitespace-pre-line text-[15px] leading-6 text-[var(--color-inspector-text)]">{value}</div>
      {detail && <div className="mt-1 text-[13px] leading-5 text-[var(--color-inspector-muted)]">{detail}</div>}
    </div>
  )
}

function InspectorNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-[var(--color-inspector-border)] bg-[var(--color-inspector-surface)] px-4 py-3 text-[14px] text-[var(--color-inspector-heading)]">
      <span className="material-symbols-outlined text-[18px] text-[var(--color-inspector-muted)]">info</span>
      <span>{children}</span>
    </div>
  )
}

function KeyValueRows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <div className="overflow-hidden rounded-md border border-[var(--color-inspector-border)] bg-[var(--color-inspector-surface)] font-mono">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[220px_minmax(0,1fr)] border-t border-[var(--color-inspector-border)] first:border-t-0">
          <div className="border-r border-[var(--color-inspector-border)] bg-[var(--color-inspector-panel)] px-4 py-3 text-[12px] font-semibold uppercase tracking-[0.24em] text-[var(--color-inspector-heading)]">
            {label}
          </div>
          <div className="min-w-0 break-words px-4 py-3 text-[14px] text-[var(--color-inspector-text)]">{value}</div>
        </div>
      ))}
    </div>
  )
}

function UsageTab({
  usage,
  context,
  error,
  t,
}: {
  usage?: SessionUsageSnapshot
  context?: SessionContextSnapshot
  error?: string
  t: Translate
}) {
  if (error && !usage) return <ErrorState message={error} />
  if (!usage) {
    return <EmptyState title={t('slash.inspector.usage.emptyTitle')} body={t('slash.inspector.usage.emptyBody')} />
  }

  const usageHasTokens = (
    usage.totalInputTokens +
    usage.totalOutputTokens +
    usage.totalCacheReadInputTokens +
    usage.totalCacheCreationInputTokens
  ) > 0
  const apiUsage = context?.apiUsage
  const useContextUsageFallback = !usageHasTokens && !!apiUsage
  const totalInputTokens = useContextUsageFallback ? apiUsage.input_tokens : usage.totalInputTokens
  const totalOutputTokens = useContextUsageFallback ? apiUsage.output_tokens : usage.totalOutputTokens
  const totalCacheReadInputTokens = useContextUsageFallback ? apiUsage.cache_read_input_tokens : usage.totalCacheReadInputTokens
  const totalCacheCreationInputTokens = useContextUsageFallback ? apiUsage.cache_creation_input_tokens : usage.totalCacheCreationInputTokens
  const models = Array.isArray(usage.models) && usage.models.length > 0
    ? usage.models
    : useContextUsageFallback
      ? [{
          model: context?.model ?? 'current-model',
          displayName: context?.model ?? t('slash.inspector.status.activeModel'),
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadInputTokens: totalCacheReadInputTokens,
          cacheCreationInputTokens: totalCacheCreationInputTokens,
          webSearchRequests: 0,
          costUSD: 0,
          costDisplay: 'n/a',
          contextWindow: context?.rawMaxTokens ?? 0,
          maxOutputTokens: 0,
        }]
      : []
  const sourceLabel = useContextUsageFallback
    ? t('slash.inspector.usage.source.contextSnapshot')
    : usage.source === 'transcript'
      ? t('slash.inspector.usage.source.transcript')
      : t('slash.inspector.usage.source.currentProcess')

  return (
    <div className="space-y-7">
      {useContextUsageFallback && (
        <InspectorNotice>
          {t('slash.inspector.usage.contextSnapshotNotice')}
        </InspectorNotice>
      )}
      {usage.source === 'transcript' && (
        <div className="rounded-md border border-[var(--color-inspector-border)] bg-[var(--color-inspector-surface)] px-4 py-3 text-sm text-[var(--color-inspector-muted-strong)]">
          {t('slash.inspector.usage.transcriptNotice')}
        </div>
      )}
      {usage.hasUnknownModelCost && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-700">
          {t('slash.inspector.usage.unknownCost')}
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label={t('slash.inspector.usage.totalCost')} value={useContextUsageFallback ? 'n/a' : usage.costDisplay} />
        <MetricCard label={t('slash.inspector.usage.source')} value={sourceLabel} />
        <MetricCard label={t('slash.inspector.usage.apiDuration')} value={usage.source === 'transcript' || useContextUsageFallback ? '0ms' : formatDuration(usage.totalAPIDuration)} />
        <MetricCard label={usage.source === 'transcript' ? t('slash.inspector.usage.usageSpan') : t('slash.inspector.usage.wallDuration')} value={useContextUsageFallback ? '0ms' : formatDuration(usage.totalDuration)} />
        <MetricCard
          label={t('slash.inspector.usage.codeChanges')}
          value={`${formatNumber(usage.totalLinesAdded)}/${formatNumber(usage.totalLinesRemoved)}`}
        />
        <MetricCard label={t('slash.inspector.usage.input')} value={formatNumber(totalInputTokens)} />
        <MetricCard label={t('slash.inspector.usage.output')} value={formatNumber(totalOutputTokens)} />
        <MetricCard label={t('slash.inspector.usage.cacheReadWrite')} value={`${formatNumber(totalCacheReadInputTokens)} / ${formatNumber(totalCacheCreationInputTokens)}`} />
        <MetricCard label={t('slash.inspector.usage.webSearch')} value={formatNumber(usage.totalWebSearchRequests)} />
      </div>
      <section>
        <div className="mb-3 text-[22px] font-semibold text-[var(--color-inspector-text)]">{t('slash.inspector.usage.byModel')}</div>
        {models.length === 0 ? (
          <EmptyState title={t('slash.inspector.usage.noModelTitle')} body={t('slash.inspector.usage.noModelBody')} />
        ) : (
          <div className="overflow-hidden rounded-md border border-[var(--color-inspector-border)] bg-[var(--color-inspector-surface)] font-mono">
            {models.map((model) => (
              <div key={model.model} className="border-t border-[var(--color-inspector-border)] first:border-t-0">
                <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-4 border-b border-[var(--color-inspector-border)] px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-[var(--color-inspector-text)]">{model.displayName || model.model}</div>
                    {(model.contextWindow > 0 || context?.rawMaxTokens) && (
                      <div className="mt-1 truncate text-[11px] text-[var(--color-inspector-muted)]">
                        {t('slash.inspector.status.contextWindow')}: {formatNumber(model.contextWindow || context?.rawMaxTokens)}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--color-inspector-heading)]">{t('slash.inspector.usage.tokens')}</div>
                </div>
                <div className="grid grid-cols-[160px_minmax(0,1fr)_120px] items-center gap-4 border-b border-[var(--color-inspector-border)] px-4 py-3 last:border-b-0">
                  <div className="text-[12px] uppercase tracking-[0.18em] text-[var(--color-inspector-heading)]">{t('slash.inspector.usage.input')}</div>
                  <div className="h-1 overflow-hidden rounded-full bg-[var(--color-inspector-chip)]">
                    <div className="h-full rounded-full bg-[var(--color-inspector-accent)]" style={{ width: '95%' }} />
                  </div>
                  <div className="text-right text-[13px] text-[var(--color-inspector-text)]">{formatNumber(model.inputTokens)}</div>
                </div>
                <div className="grid grid-cols-[160px_minmax(0,1fr)_120px] items-center gap-4 px-4 py-3">
                  <div className="text-[12px] uppercase tracking-[0.18em] text-[var(--color-inspector-heading)]">{t('slash.inspector.usage.output')}</div>
                  <div className="h-1 overflow-hidden rounded-full bg-[var(--color-inspector-chip)]">
                    <div className="h-full rounded-full bg-[var(--color-inspector-accent-secondary)]" style={{ width: `${Math.max(4, Math.min(100, (model.outputTokens / Math.max(1, model.inputTokens)) * 100))}%` }} />
                  </div>
                  <div className="text-right text-[13px] text-[var(--color-inspector-text)]">{formatNumber(model.outputTokens)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

type ContextCategory = SessionContextSnapshot['categories'][number]

function isCapacityCategory(category: ContextCategory) {
  const name = category.name.toLowerCase()
  return category.isDeferred || name.includes('free') || name.includes('autocompact')
}

function ContextStackedBar({ categories, rawMaxTokens }: { categories: ContextCategory[]; rawMaxTokens: number }) {
  const activeCategories = categories.filter((category) => !isCapacityCategory(category) && category.tokens > 0)
  if (activeCategories.length === 0) return null

  return (
    <div className="overflow-hidden rounded-full bg-[var(--color-inspector-chip)]">
      <div className="flex h-2.5 w-full">
        {activeCategories.map((category) => (
          <div
            key={category.name}
            title={`${category.name}: ${formatNumber(category.tokens)} tokens`}
            style={{
              width: `${Math.max(0.5, (category.tokens / rawMaxTokens) * 100)}%`,
              backgroundColor: category.color,
            }}
          />
        ))}
      </div>
    </div>
  )
}

function CategoryBreakdown({ categories, rawMaxTokens, t }: { categories: ContextCategory[]; rawMaxTokens: number; t: Translate }) {
  const visibleCategories = categories.filter((category) => category.tokens > 0)
  if (visibleCategories.length === 0) {
    return <EmptyState title={t('slash.inspector.context.noCategoriesTitle')} body={t('slash.inspector.context.noCategoriesBody')} />
  }

  return (
    <div className="rounded-md border border-[var(--color-inspector-border)] bg-[var(--color-inspector-panel)] px-5 py-5 font-mono">
      <InspectorSectionTitle>{t('slash.inspector.context.categoryTitle')}</InspectorSectionTitle>
      <div className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
        {visibleCategories.map((category) => {
          const percent = rawMaxTokens > 0 ? (category.tokens / rawMaxTokens) * 100 : 0
          const muted = isCapacityCategory(category)
          return (
            <div
              key={category.name}
              className="min-w-0"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`min-w-0 truncate text-[14px] font-semibold ${muted ? 'text-[var(--color-inspector-muted-strong)]' : 'text-[var(--color-inspector-text)]'}`}>
                    {category.name}
                  </span>
                </div>
                <div className="shrink-0 text-right leading-tight">
                  <div className="text-sm text-[var(--color-inspector-text)]">{formatNumber(category.tokens)}</div>
                  <div className="mt-0.5 text-[12px] text-[var(--color-inspector-muted)]">{formatPercent(percent)}</div>
                </div>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--color-inspector-chip)]">
                <div
                  className={muted ? 'h-full rounded-full opacity-65' : 'h-full rounded-full'}
                  style={{
                    width: `${Math.min(100, Math.max(0.5, percent))}%`,
                    backgroundColor: muted ? 'var(--color-inspector-capacity)' : 'var(--color-inspector-accent)',
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ContextStatPill({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 font-mono">
      <div className="truncate text-[12px] font-semibold uppercase tracking-[0.22em] text-[var(--color-inspector-muted)]">{label}</div>
      <div className="mt-2 truncate text-[16px] font-semibold text-[var(--color-inspector-text)]">{value}</div>
      {detail && <div className="mt-1 truncate text-[13px] text-[var(--color-inspector-muted)]">{detail}</div>}
    </div>
  )
}

function statusDisplayLabel(status: string, t: Translate) {
  const normalized = status.toLowerCase()
  if (normalized === 'connected') return t('slash.inspector.status.connected')
  if (normalized === 'failed') return t('slash.inspector.status.failed')
  return status
}

function InspectorStatusBadge({ status, t }: { status: string; t: Translate }) {
  const normalized = status.toLowerCase()
  const isConnected = normalized === 'connected'
  const isFailed = normalized === 'failed'
  const badgeClass = isConnected
    ? 'bg-[var(--color-inspector-success-bg)] text-[var(--color-inspector-success)]'
    : isFailed
      ? 'bg-[var(--color-inspector-danger-bg)] text-[var(--color-inspector-danger)]'
      : 'bg-[var(--color-inspector-chip)] text-[var(--color-inspector-muted-strong)]'
  const dotClass = isConnected ? 'bg-[var(--color-inspector-success)]' : isFailed ? 'bg-[var(--color-inspector-danger)]' : 'bg-[var(--color-inspector-muted)]'

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] ${badgeClass}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      {statusDisplayLabel(status, t)}
    </span>
  )
}

function McpServerIcon({ status }: { status: string }) {
  const isFailed = status === 'failed'
  const icon = isFailed ? 'power_off' : 'dns'
  return (
    <span className={`material-symbols-outlined text-[20px] ${isFailed ? 'text-[var(--color-inspector-danger)]' : 'text-[var(--color-inspector-success)]'}`}>
      {icon}
    </span>
  )
}

function ContextOverview({ context, categories, t }: { context: SessionContextSnapshot; categories: ContextCategory[]; t: Translate }) {
  const usedPercent = Math.min(100, Math.max(0, context.percentage))
  const freeTokens = Math.max(0, context.rawMaxTokens - context.totalTokens)
  const freePercent = context.rawMaxTokens > 0 ? (freeTokens / context.rawMaxTokens) * 100 : 0
  return (
    <div className="rounded-md border border-[var(--color-inspector-border)] bg-[var(--color-inspector-panel)] px-5 py-6">
      <div className="mb-8 flex items-start justify-between gap-4">
        <InspectorSectionTitle>{t('slash.inspector.context.windowUsage')}</InspectorSectionTitle>
        <span className="rounded-sm border border-[var(--color-inspector-border)] bg-[var(--color-inspector-chip)] px-2 py-1 font-mono text-xs text-[var(--color-inspector-muted-strong)]">{context.model}</span>
      </div>
      <div className="font-mono text-[24px] font-semibold text-[var(--color-inspector-text)]">
        {formatNumber(context.totalTokens)}
        <span className="mx-1.5 text-[var(--color-inspector-text)]">/</span>
        <span>{formatNumber(context.rawMaxTokens)}</span>
        <span className="ml-3 align-middle text-sm font-normal text-[var(--color-inspector-accent-secondary)]">[{formatPercent(usedPercent)} {t('slash.inspector.context.used')}]</span>
      </div>
      <div className="mt-7">
        <ContextStackedBar categories={categories} rawMaxTokens={context.rawMaxTokens} />
      </div>
      <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-md border border-[var(--color-inspector-border)] bg-[var(--color-inspector-surface)] px-4 py-3">
          <ContextStatPill label={t('slash.inspector.context.free')} value={formatNumber(freeTokens)} detail={formatPercent(freePercent)} />
        </div>
        <div className="rounded-md border border-[var(--color-inspector-border)] bg-[var(--color-inspector-surface)] px-4 py-3">
          <ContextStatPill label={t('slash.inspector.context.messages')} value={formatNumber(context.messageBreakdown?.assistantMessageTokens ?? 0)} detail={t('slash.inspector.context.assistant')} />
        </div>
        <div className="rounded-md border border-[var(--color-inspector-border)] bg-[var(--color-inspector-surface)] px-4 py-3">
          <ContextStatPill label={t('slash.inspector.context.toolResults')} value={formatNumber(context.messageBreakdown?.toolResultTokens ?? 0)} />
        </div>
        <div className="rounded-md border border-[var(--color-inspector-border)] bg-[var(--color-inspector-surface)] px-4 py-3">
          <ContextStatPill label={t('slash.inspector.context.context')} value={formatPercent(usedPercent)} />
        </div>
      </div>
    </div>
  )
}

function ContextTab({
  context,
  error,
  loading,
  t,
}: {
  context?: SessionContextSnapshot
  error?: string
  loading?: boolean
  t: Translate
}) {
  if (error && !context) return <ErrorState message={error} />
  if (loading && !context) return <LoadingState label={t('slash.inspector.context.loading')} />
  if (!context) {
    return <EmptyState title={t('slash.inspector.context.emptyTitle')} body={t('slash.inspector.context.emptyBody')} />
  }

  const categories = Array.isArray(context.categories) ? context.categories : []
  return (
    <div className="space-y-6">
      <ContextOverview context={context} categories={categories} t={t} />
      <CategoryBreakdown categories={categories} rawMaxTokens={context.rawMaxTokens} t={t} />
    </div>
  )
}

function StatusTab({
  data,
  commands,
  t,
}: {
  data: SessionInspectionResponse
  commands?: SlashCommandOption[]
  t: Translate
}) {
  const mcpServers = Array.isArray(data.status.mcpServers) ? data.status.mcpServers : []
  const tools = Array.isArray(data.status.tools) ? data.status.tools : []
  const context = data.context ?? data.contextEstimate
  const model = data.status.model ?? context?.model ?? data.usage?.models?.[0]?.displayName ?? data.usage?.models?.[0]?.model ?? t('slash.inspector.status.unknown')
  const contextWindow = context?.rawMaxTokens ?? data.usage?.models?.find((entry) => entry.contextWindow > 0)?.contextWindow
  const slashCommandCount = (data.status.slashCommandCount ?? 0) > 0
    ? data.status.slashCommandCount
    : commands?.length ?? 0
  const connectedMcp = mcpServers.filter((server) => server.status === 'connected').length
  const failedMcp = mcpServers.filter((server) => server.status === 'failed').length
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          label={t('slash.inspector.status.cliStatus')}
          value={(
            <span className="inline-flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${data.active ? 'bg-[var(--color-inspector-success)]' : 'bg-[var(--color-inspector-danger)]'}`} />
              {data.active ? t('slash.inspector.status.running') : t('slash.inspector.status.notRunning')}
            </span>
          )}
        />
        <MetricCard
          label={t('slash.inspector.status.activeModel')}
          value={model}
          detail={contextWindow ? `${t('slash.inspector.status.contextWindow')}: ${formatNumber(contextWindow)}` : undefined}
        />
        <MetricCard
          label={t('slash.inspector.status.mcpConnections')}
          value={(
            <span>
              <span className="text-[var(--color-inspector-success)]">{formatNumber(connectedMcp)}</span>
              <span className="mx-5 text-[var(--color-inspector-text)]">/</span>
              <span className="text-[var(--color-inspector-danger)]">{formatNumber(failedMcp)}</span>
            </span>
          )}
          detail={(
            <span>
              <span className="text-[var(--color-inspector-success)]">{t('slash.inspector.status.connected')}</span>
              <span className="mx-5 text-[var(--color-inspector-text)]" />
              <span className="text-[var(--color-inspector-danger)]">{t('slash.inspector.status.failed')}</span>
            </span>
          )}
        />
        <MetricCard label={t('slash.inspector.status.registeredTools')} value={`${formatNumber(tools.length)} / ${formatNumber(slashCommandCount)} ${t('slash.inspector.status.commands')}`} />
      </div>
      <section>
        <InspectorSectionTitle>{t('slash.inspector.status.sessionMetadata')}</InspectorSectionTitle>
        <KeyValueRows
          rows={[
            [t('slash.inspector.status.version'), data.status.version ?? t('slash.inspector.status.unknown')],
            [t('slash.inspector.status.sessionId'), <span className="font-mono text-[13px]">{data.status.sessionId}</span>],
            [t('slash.inspector.status.workingDirectory'), <span className="font-mono text-[13px]">{data.status.cwd ?? data.status.workDir}</span>],
            [t('slash.inspector.status.permissionMode'), <span className="rounded-sm bg-[var(--color-inspector-chip)] px-1.5 py-1">{data.status.permissionMode}</span>],
            [t('slash.inspector.status.authToken'), data.status.apiKeySource ?? t('slash.inspector.status.unknown')],
            [t('slash.inspector.status.outputStyle'), data.status.outputStyle ?? t('slash.inspector.status.default')],
          ]}
        />
      </section>
      {mcpServers.length > 0 && (
        <section>
          <InspectorSectionTitle
            action={<button type="button" className="font-mono text-[12px] tracking-[0.18em] text-[var(--color-inspector-accent)] hover:text-[var(--color-inspector-accent-hover)]">↻ {t('slash.inspector.status.refresh')}</button>}
          >
            {t('slash.inspector.status.mcpServers')}
          </InspectorSectionTitle>
          <div className="grid gap-3 lg:grid-cols-2">
            {mcpServers.map((server) => (
              <div
                key={`${server.name}:${server.status}`}
                className={`flex min-h-[48px] items-center justify-between gap-4 rounded-md border px-4 py-3 font-mono ${
                  server.status === 'failed' ? 'border-[var(--color-inspector-danger-border)] bg-[var(--color-inspector-danger-surface)]' : 'border-[var(--color-inspector-border)] bg-[var(--color-inspector-panel)]'
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <McpServerIcon status={server.status} />
                  <span className="min-w-0 truncate text-[14px] text-[var(--color-inspector-text)]">{server.name}</span>
                </div>
                <InspectorStatusBadge status={server.status} t={t} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function SessionInspectorShell({
  selectedTab,
  tabs,
  onSelectTab,
  onClose,
  children,
  t,
}: {
  selectedTab: SessionInspectorTab
  tabs: Array<{ id: SessionInspectorTab; label: string }>
  onSelectTab: (tab: SessionInspectorTab) => void
  onClose: () => void
  children: React.ReactNode
  t: Translate
}) {
  return (
    <div
      className="absolute bottom-full left-0 right-0 z-50 mb-4 overflow-hidden rounded-[10px] border border-[var(--color-inspector-border)] bg-[var(--color-inspector-surface)] text-[var(--color-inspector-text)] shadow-[var(--shadow-inspector)]"
    >
      <div className="grid min-h-[64px] grid-cols-[1fr_auto_1fr] items-center border-b border-[var(--color-inspector-border)] bg-[var(--color-inspector-surface)] px-6">
        <div className="font-mono text-[16px] font-semibold uppercase text-[var(--color-inspector-accent)]">{t('slash.inspector.title')}</div>
        <div className="flex items-center gap-8">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              className={`relative h-10 px-0 font-sans text-sm transition-colors ${
                selectedTab === tab.id ? 'text-[var(--color-inspector-accent)]' : 'text-[var(--color-inspector-muted-strong)] hover:text-[var(--color-inspector-accent)]'
              }`}
            >
              {tab.label}
              {selectedTab === tab.id && <span className="absolute bottom-1 left-0 right-0 h-[2px] bg-[var(--color-inspector-accent)]" />}
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            aria-label={t('slash.inspector.close')}
            className="flex h-10 w-10 items-center justify-center text-[var(--color-inspector-accent)] transition-colors hover:text-[var(--color-inspector-accent-hover)]"
          >
            <span className="material-symbols-outlined text-[24px]">close</span>
          </button>
        </div>
      </div>
      <div className="max-h-[min(540px,58vh)] overflow-y-auto bg-[var(--color-inspector-surface)] px-6 py-6">{children}</div>
    </div>
  )
}

function SessionInspectorPanel({
  command,
  sessionId,
  commands,
  onClose,
}: {
  command: LocalSlashCommandName
  sessionId?: string
  commands?: SlashCommandOption[]
  onClose: () => void
}) {
  const t = useTranslation()
  const [selectedTab, setSelectedTab] = useState<SessionInspectorTab>(() => sessionInspectorInitialTab(command))
  const [data, setData] = useState<SessionInspectionResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  const contextRequestSessionRef = useRef<string | null>(null)

  useEffect(() => {
    if (command !== 'status' && command !== 'cost' && command !== 'context') return
    setSelectedTab(sessionInspectorInitialTab(command))
  }, [command])

  useEffect(() => {
    if (!sessionId) {
      setError(t('slash.inspector.error.noActiveSession'))
      return
    }
    let cancelled = false
    setData(null)
    setError(null)
    setContextLoading(false)
    setContextError(null)
    contextRequestSessionRef.current = null
    sessionsApi.getInspection(sessionId, { includeContext: false })
      .then((response) => {
        if (!cancelled) setData(assertSessionInspectionResponse(response, t))
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, t])

  useEffect(() => {
    if (!sessionId || selectedTab !== 'context' || data === null || data.context) return
    if (contextRequestSessionRef.current === sessionId) return
    contextRequestSessionRef.current = sessionId
    let cancelled = false
    setContextLoading(true)
    setContextError(null)
    sessionsApi.getInspection(sessionId, { includeContext: true, contextOnly: true, timeout: 45_000 })
      .then((response) => {
        if (cancelled) return
        const inspected = assertSessionInspectionResponse(response, t)
        setData((current) => current
          ? {
              ...current,
              context: inspected.context,
              errors: {
                ...(current.errors ?? {}),
                ...(inspected.errors ?? {}),
              },
            }
          : inspected)
        setContextError(inspected.errors?.context ?? null)
      })
      .catch((err) => {
        if (!cancelled) setContextError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [data, selectedTab, sessionId, t])

  const tabs: Array<{ id: SessionInspectorTab; label: string }> = [
    { id: 'status', label: t('slash.inspector.tab.status') },
    { id: 'usage', label: t('slash.inspector.tab.usage') },
    { id: 'context', label: t('slash.inspector.tab.context') },
  ]

  return (
    <SessionInspectorShell selectedTab={selectedTab} tabs={tabs} onSelectTab={setSelectedTab} onClose={onClose} t={t}>
      {error ? (
        <ErrorState message={error} />
      ) : data === null ? (
        <LoadingState label={t('slash.inspector.loading')} />
      ) : selectedTab === 'usage' ? (
        <UsageTab usage={data.usage} context={data.context ?? data.contextEstimate} error={data.errors?.usage} t={t} />
      ) : selectedTab === 'context' ? (
        <ContextTab
          context={data.context ?? data.contextEstimate}
          error={contextError ?? data.errors?.context}
          loading={contextLoading && !data.contextEstimate}
          t={t}
        />
      ) : (
        <StatusTab data={data} commands={commands} t={t} />
      )}
    </SessionInspectorShell>
  )
}

function McpPanel({ cwd, onClose }: { cwd?: string; onClose: () => void }) {
  const t = useTranslation()
  const setPendingSettingsTab = useUIStore((s) => s.setPendingSettingsTab)
  const selectServer = useMcpStore((s) => s.selectServer)
  const [servers, setServers] = useState<McpServerRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    mcpApi.list(cwd)
      .then(async (response) => {
        if (cancelled) return
        const visibleServers = response.servers.filter((server) => server.scope === 'user' || server.scope === 'local' || server.scope === 'project')
        setServers(visibleServers)

        const statusResults = await Promise.allSettled(
          visibleServers.map((server) => mcpApi.status(server.name, cwd)),
        )
        if (cancelled) return

        const liveServers = new Map<string, McpServerRecord>()
        for (const result of statusResults) {
          if (result.status === 'fulfilled') {
            liveServers.set(result.value.server.name, result.value.server)
          }
        }
        if (liveServers.size > 0) {
          setServers((current) =>
            current?.map((server) => liveServers.get(server.name) ?? server) ?? current,
          )
        }
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  const grouped = useMemo(() => {
    const groups = new Map<string, McpServerRecord[]>()
    for (const server of servers ?? []) {
      const key = server.scope
      const existing = groups.get(key) ?? []
      existing.push(server)
      groups.set(key, existing)
    }
    return groups
  }, [servers])

  return (
    <PanelShell
      title={t('slash.mcp.title')}
      subtitle={cwd ? t('slash.mcp.subtitleWithProject', { path: cwd }) : t('slash.mcp.subtitle')}
      onClose={onClose}
    >
      {error ? (
        <ErrorState message={error} />
      ) : servers === null ? (
        <LoadingState label={t('common.loading')} />
      ) : servers.length === 0 ? (
        <EmptyState title={t('slash.mcp.emptyTitle')} body={t('slash.mcp.emptyBody')} />
      ) : (
        <div className="space-y-5">
          {['user', 'local', 'project'].filter((scope) => grouped.has(scope)).map((scope) => (
            <section key={scope}>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-[var(--color-text-primary)]">{scopeLabel(scope, t)}</div>
                <div className="text-xs text-[var(--color-text-tertiary)]">{grouped.get(scope)?.length ?? 0}</div>
              </div>
              <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
                {grouped.get(scope)?.map((server) => (
                  <button
                    type="button"
                    key={`${server.scope}:${server.projectPath ?? 'global'}:${server.name}`}
                    onClick={() => {
                      selectServer(server)
                      setPendingSettingsTab('mcp')
                      useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
                      onClose()
                    }}
                    className="block w-full border-t border-[var(--color-border)] px-4 py-4 text-left first:border-t-0 hover:bg-[var(--color-surface-hover)]"
                  >
                    <div className="flex items-center gap-3">
                      <div className="text-sm font-semibold text-[var(--color-text-primary)]">{server.name}</div>
                      <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-semibold ${toneForStatus(server.status)}`}>
                        {server.statusLabel}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
                      <span className="rounded-full bg-[var(--color-surface-hover)] px-2 py-1">{server.transport}</span>
                      {server.projectPath && (
                        <span className="rounded-full bg-[var(--color-surface-hover)] px-2 py-1" title={server.projectPath}>
                          {projectBadge(server.projectPath, t)}
                        </span>
                      )}
                      <span className="truncate">{server.summary}</span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PanelShell>
  )
}

function SkillsPanel({ cwd, onClose }: { cwd?: string; onClose: () => void }) {
  const t = useTranslation()
  const setPendingSettingsTab = useUIStore((s) => s.setPendingSettingsTab)
  const fetchSkillDetail = useSkillStore((s) => s.fetchSkillDetail)
  const [skills, setSkills] = useState<SkillMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    skillsApi.list(cwd)
      .then((response) => {
        if (cancelled) return
        setSkills(response.skills.filter((skill) => skill.userInvocable))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  return (
    <PanelShell
      title={t('slash.skills.title')}
      subtitle={cwd ? t('slash.skills.subtitleWithProject', { path: cwd }) : t('slash.skills.subtitle')}
      onClose={onClose}
    >
      {error ? (
        <ErrorState message={error} />
      ) : skills === null ? (
        <LoadingState label={t('common.loading')} />
      ) : skills.length === 0 ? (
        <EmptyState title={t('slash.skills.emptyTitle')} body={t('slash.skills.emptyBody')} />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {skills.map((skill) => (
            <button
              type="button"
              key={`${skill.source}:${skill.name}`}
              onClick={async () => {
                await fetchSkillDetail(skill.source, skill.name, cwd, 'skills')
                setPendingSettingsTab('skills')
                useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
                onClose()
              }}
              className="block w-full border-t border-[var(--color-border)] px-4 py-4 text-left first:border-t-0 hover:bg-[var(--color-surface-hover)]"
            >
              <div className="flex items-center gap-3">
                <div className="text-sm font-semibold text-[var(--color-text-primary)]">/{skill.name}</div>
                <span className="rounded-full bg-[var(--color-surface-hover)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)]">
                  {skill.source}
                </span>
              </div>
              <div className="mt-2 text-xs leading-6 text-[var(--color-text-tertiary)]">{skill.description}</div>
            </button>
          ))}
        </div>
      )}
    </PanelShell>
  )
}

type BrowseEntry = { name: string; path: string; isDirectory: boolean }

function AddDirPanel({
  sessionId,
  cwd,
  onClose,
}: {
  sessionId?: string
  cwd?: string
  onClose: () => void
}) {
  const t = useTranslation()
  const sendMessage = useChatStore((s) => s.sendMessage)
  const [selectedPath, setSelectedPath] = useState('')
  const [remember, setRemember] = useState(false)
  const [browseEntries, setBrowseEntries] = useState<BrowseEntry[]>([])
  const [browsePath, setBrowsePath] = useState('')
  const [browseParent, setBrowseParent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'input' | 'browse'>('input')

  const loadBrowseDir = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await filesystemApi.browse(path)
      setBrowsePath(result.currentPath)
      setBrowseParent(result.parentPath)
      setBrowseEntries(result.entries.filter((e) => e.isDirectory))
    } catch {
      setError(t('slash.addDir.browseError'))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    if (mode === 'browse' && browseEntries.length === 0 && !browsePath) {
      loadBrowseDir(cwd || undefined)
    }
  }, [mode, browseEntries.length, browsePath, cwd, loadBrowseDir])

  const handleSubmit = () => {
    if (!selectedPath.trim() || !sessionId) return
    const command = remember
      ? `/add-dir ${selectedPath} --remember`
      : `/add-dir ${selectedPath}`
    sendMessage(sessionId, command)
    onClose()
  }

  const handleChooseFolder = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('slash.addDir.chooseFolder'),
      })
      if (selected) {
        setSelectedPath(selected)
      }
    } catch (err) {
      console.error('[AddDirPanel] Failed to open folder dialog:', err)
    }
  }

  const handleBrowseSelect = (path: string) => {
    setSelectedPath(path)
    setMode('input')
  }

  return (
    <PanelShell
      title={t('slash.addDir.title')}
      subtitle={t('slash.addDir.subtitle')}
      onClose={onClose}
    >
      <div className="space-y-4">
        {mode === 'input' ? (
          <>
            <div>
              <label className="mb-2 block text-sm font-medium text-[var(--color-text-primary)]">
                {t('slash.addDir.pathLabel')}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={selectedPath}
                  onChange={(e) => setSelectedPath(e.target.value)}
                  placeholder={t('slash.addDir.pathPlaceholder')}
                  className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-brand)] focus:outline-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSubmit()
                  }}
                />
                <button
                  type="button"
                  onClick={handleChooseFolder}
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors"
                  title={t('slash.addDir.browseFolders')}
                >
                  <span className="material-symbols-outlined text-[16px]">folder_open</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('browse')
                    loadBrowseDir(cwd || undefined)
                  }}
                  className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors"
                  title={t('slash.addDir.browseTree')}
                >
                  <span className="material-symbols-outlined text-[16px]">account_tree</span>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 rounded border-[var(--color-border)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                />
                {t('slash.addDir.rememberLabel')}
              </label>
            </div>

            {remember && (
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-tertiary)]">
                {t('slash.addDir.rememberHint')}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!selectedPath.trim() || !sessionId}
                className="rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('slash.addDir.addButton')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-[var(--color-border)] pb-2">
              <button
                type="button"
                onClick={() => setMode('input')}
                className="text-xs text-[var(--color-text-accent)] hover:underline"
              >
                {'← ' + t('slash.addDir.backToInput')}
              </button>
              <span className="text-xs text-[var(--color-text-tertiary)] font-mono truncate">
                {browsePath}
              </span>
            </div>

            {error ? (
              <ErrorState message={error} />
            ) : loading ? (
              <LoadingState label={t('common.loading')} />
            ) : (
              <div className="max-h-[300px] overflow-y-auto">
                {browseParent && browseParent !== browsePath && (
                  <button
                    type="button"
                    onClick={() => loadBrowseDir(browseParent)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-surface-hover)]"
                  >
                    <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)]">arrow_upward</span>
                    <span className="text-xs text-[var(--color-text-secondary)]">..</span>
                  </button>
                )}
                {browseEntries.length === 0 ? (
                  <EmptyState
                    title={t('slash.addDir.noSubdirs')}
                    body={t('slash.addDir.noSubdirsBody')}
                  />
                ) : (
                  browseEntries.map((entry) => (
                    <div
                      key={entry.path}
                      className="flex items-center gap-2 border-t border-[var(--color-border)] px-3 py-2 first:border-t-0"
                    >
                      <button
                        type="button"
                        onClick={() => loadBrowseDir(entry.path)}
                        className="flex items-center gap-2 flex-1 min-w-0 text-left hover:bg-[var(--color-surface-hover)] -mx-1 px-1 rounded"
                      >
                        <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)]">folder</span>
                        <span className="text-xs text-[var(--color-text-primary)] truncate">{entry.name}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleBrowseSelect(entry.path)}
                        className="shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold text-[var(--color-brand)] hover:bg-[var(--color-primary-fixed)] transition-colors"
                      >
                        {t('common.select')}
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}

            {browsePath && (
              <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-3">
                <span className="text-[10px] text-[var(--color-text-tertiary)] font-mono truncate max-w-[60%]">
                  {browsePath}
                </span>
                <button
                  type="button"
                  onClick={() => handleBrowseSelect(browsePath)}
                  className="rounded-lg bg-[var(--color-brand)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                >
                  {t('dirPicker.useThisFolder')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </PanelShell>
  )
}

const COMMAND_GROUPS = [
  {
    titleKey: 'slash.help.group.context',
    names: ['clear', 'compact', 'context', 'cost'],
  },
  {
    titleKey: 'slash.help.group.project',
    names: ['init', 'review', 'commit', 'pr', 'add-dir'],
  },
  {
    titleKey: 'slash.help.group.desktop',
    names: ['mcp', 'skills', 'plugin', 'help'],
  },
] satisfies Array<{ titleKey: TranslationKey; names: string[] }>

function HelpPanel({
  commands,
  onClose,
}: {
  commands?: SlashCommandOption[]
  onClose: () => void
}) {
  const t = useTranslation()
  const commandMap = useMemo(() => {
    const map = new Map<string, SlashCommandOption>()
    for (const command of commands ?? []) {
      map.set(command.name, command)
    }
    return map
  }, [commands])

  const groupedNames = new Set(COMMAND_GROUPS.flatMap((group) => group.names))
  const otherCommands = (commands ?? [])
    .filter((command) => !groupedNames.has(command.name))
    .slice(0, 12)
  const hiddenOtherCommandCount = Math.max(
    0,
    (commands ?? []).filter((command) => !groupedNames.has(command.name)).length - otherCommands.length,
  )

  const renderCommand = (command: SlashCommandOption) => (
    <div key={command.name} className="flex min-w-0 items-start gap-3 border-t border-[var(--color-border)] px-4 py-3 first:border-t-0">
      <div className="shrink-0 font-mono text-sm font-semibold text-[var(--color-text-primary)]">/{command.name}</div>
      <div className="min-w-0 flex-1 text-xs leading-5 text-[var(--color-text-tertiary)]">{command.description}</div>
    </div>
  )

  return (
    <PanelShell
      title={t('slash.help.title')}
      subtitle={t('slash.help.subtitle')}
      onClose={onClose}
    >
      <div className="space-y-4">
        {COMMAND_GROUPS.map((group) => {
          const entries = group.names
            .map((name) => commandMap.get(name))
            .filter((command): command is SlashCommandOption => Boolean(command))
          if (entries.length === 0) return null
          return (
            <section key={group.titleKey}>
              <div className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">{t(group.titleKey)}</div>
              <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
                {entries.map(renderCommand)}
              </div>
            </section>
          )
        })}

        {otherCommands.length > 0 && (
          <section>
            <div className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">{t('slash.help.group.more')}</div>
            <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
              {otherCommands.map(renderCommand)}
            </div>
            {hiddenOtherCommandCount > 0 && (
              <p className="mt-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
                {t('slash.help.moreAvailable', { count: hiddenOtherCommandCount })}
              </p>
            )}
          </section>
        )}
      </div>
    </PanelShell>
  )
}

export function LocalSlashCommandPanel({ command, sessionId, cwd, commands, onClose }: Props) {
  if (command === 'mcp') return <McpPanel cwd={cwd} onClose={onClose} />
  if (command === 'skills') return <SkillsPanel cwd={cwd} onClose={onClose} />
  if (command === 'add-dir') return <AddDirPanel sessionId={sessionId} cwd={cwd} onClose={onClose} />
  if (command === 'status' || command === 'cost' || command === 'context') {
    return <SessionInspectorPanel command={command} sessionId={sessionId} commands={commands} onClose={onClose} />
  }
  return <HelpPanel commands={commands} onClose={onClose} />
}
