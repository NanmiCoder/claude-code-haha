import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Highlight } from 'prism-react-renderer'
import type {
  WorkspaceChangedFile,
  WorkspaceFileStatus,
  WorkspaceTreeEntry,
  WorkspaceTreeResult,
} from '../../api/sessions'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'
import { useShallow } from 'zustand/react/shallow'
import {
  useWorkspacePanelStore,
  type WorkspacePreviewCloseScope,
  type WorkspacePreviewKind,
  type WorkspacePreviewTab,
} from '../../stores/workspacePanelStore'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import {
  getFileExtension,
  normalizePrismLanguage,
  WORKSPACE_PREVIEW_LINE_LIMIT,
  WorkspaceDiffSurface,
  workspacePrismTheme,
} from './WorkspaceCodeSurface'

type WorkspacePanelProps = {
  sessionId: string
}

type TreeNodeProps = {
  sessionId: string
  entry: WorkspaceTreeEntry
  depth: number
  expandedPaths: Set<string>
  treeByPath: Record<string, WorkspaceTreeResult | undefined>
  treeLoadingByPath: Record<string, boolean | undefined>
  treeErrorsByPath: Record<string, string | null | undefined>
  filterQuery: string
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  onFileContextMenu: (event: MouseEvent, path: string) => void
  rightClickedFilePath: string | null
  rightClickedPreviewTabId: string | null
  activePath: string | null
}

const FILE_STATUS_META: Record<WorkspaceFileStatus, { label: string; className: string }> = {
  modified: {
    label: 'M',
    className: 'border-[var(--color-warning)]/35 bg-[var(--color-warning)]/12 text-[var(--color-warning)]',
  },
  added: {
    label: 'A',
    className: 'border-[var(--color-success)]/35 bg-[var(--color-success)]/12 text-[var(--color-success)]',
  },
  deleted: {
    label: 'D',
    className: 'border-[var(--color-error)]/35 bg-[var(--color-error)]/12 text-[var(--color-error)]',
  },
  renamed: {
    label: 'R',
    className: 'border-[var(--color-brand)]/35 bg-[var(--color-brand)]/12 text-[var(--color-brand)]',
  },
  untracked: {
    label: 'U',
    className: 'border-[var(--color-tertiary)]/35 bg-[var(--color-tertiary)]/12 text-[var(--color-tertiary)]',
  },
  copied: {
    label: 'C',
    className: 'border-[var(--color-secondary)]/35 bg-[var(--color-secondary)]/12 text-[var(--color-secondary)]',
  },
  type_changed: {
    label: 'T',
    className: 'border-[var(--color-outline)]/45 bg-[var(--color-outline)]/10 text-[var(--color-text-secondary)]',
  },
  unknown: {
    label: '?',
    className: 'border-[var(--color-outline)]/45 bg-[var(--color-outline)]/10 text-[var(--color-text-secondary)]',
  },
}

const EMPTY_TREE_BY_PATH: Record<string, WorkspaceTreeResult | undefined> = {}
const EMPTY_PREVIEW_TABS: WorkspacePreviewTab[] = []
const EMPTY_EXPANDED_PATHS: string[] = []
const FILE_BADGE_META: Record<string, { label: string; className: string }> = {
  ts: { label: 'TS', className: 'bg-[var(--color-secondary)]/14 text-[var(--color-secondary)]' },
  tsx: { label: 'TSX', className: 'bg-[var(--color-secondary)]/14 text-[var(--color-secondary)]' },
  js: { label: 'JS', className: 'bg-[var(--color-warning)]/16 text-[var(--color-warning)]' },
  jsx: { label: 'JSX', className: 'bg-[var(--color-warning)]/16 text-[var(--color-warning)]' },
  json: { label: '{}', className: 'bg-[var(--color-tertiary)]/14 text-[var(--color-tertiary)]' },
  md: { label: 'MD', className: 'bg-[var(--color-text-tertiary)]/14 text-[var(--color-text-secondary)]' },
  css: { label: 'CSS', className: 'bg-[var(--color-secondary)]/14 text-[var(--color-secondary)]' },
  html: { label: 'H', className: 'bg-[var(--color-brand)]/14 text-[var(--color-brand)]' },
  png: { label: 'IMG', className: 'bg-[var(--color-success)]/14 text-[var(--color-success)]' },
  jpg: { label: 'IMG', className: 'bg-[var(--color-success)]/14 text-[var(--color-success)]' },
  jpeg: { label: 'IMG', className: 'bg-[var(--color-success)]/14 text-[var(--color-success)]' },
  gif: { label: 'IMG', className: 'bg-[var(--color-success)]/14 text-[var(--color-success)]' },
  svg: { label: 'SVG', className: 'bg-[var(--color-success)]/14 text-[var(--color-success)]' },
}

function makeTreeStateKey(sessionId: string, path: string) {
  return `${sessionId}::${path}`
}

function makePreviewStateKey(sessionId: string, tabId: string) {
  return `${sessionId}::${tabId}`
}

function getSessionScopedRecord<T>(
  record: Record<string, T>,
  sessionId: string,
) {
  const prefix = `${sessionId}::`
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key.startsWith(prefix)),
  ) as Record<string, T>
}

function getPreviewKindLabel(
  t: ReturnType<typeof useTranslation>,
  kind: WorkspacePreviewKind,
) {
  return kind === 'diff' ? t('workspace.previewKind.diff') : t('workspace.previewKind.file')
}

function getFileBadgeMeta(name: string) {
  const extension = getFileExtension(name)
  return FILE_BADGE_META[extension] ?? {
    label: extension ? extension.slice(0, 3).toUpperCase() : 'TXT',
    className: 'bg-[var(--color-text-tertiary)]/12 text-[var(--color-text-secondary)]',
  }
}

function resolveWorkspaceAttachmentPath(workDir: string | undefined, filePath: string) {
  if (!workDir || filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath)) return filePath
  return `${workDir.replace(/[\\/]+$/, '')}/${filePath.replace(/^[/\\]+/, '')}`
}

function isMarkdownPreview(tab: WorkspacePreviewTab) {
  if (tab.kind !== 'file') return false
  const language = (tab.language ?? '').toLowerCase()
  const extension = getFileExtension(tab.path)
  return language === 'markdown' || language === 'md' || extension === 'md' || extension === 'markdown'
}

function FileTypeBadge({ name, subtle = false }: { name: string; subtle?: boolean }) {
  const meta = getFileBadgeMeta(name)
  return (
    <span
      className={`inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] px-1 font-[var(--font-label)] text-[9px] font-semibold leading-none ${meta.className} ${subtle ? 'opacity-55 grayscale' : ''}`}
      aria-hidden="true"
    >
      {meta.label}
    </span>
  )
}

function getInlineStateMessage(
  t: ReturnType<typeof useTranslation>,
  state: WorkspacePreviewTab['state'] | WorkspaceTreeResult['state'] | 'not_git_repo' | undefined,
  fallbackError?: string | null,
) {
  switch (state) {
    case 'loading':
      return t('workspace.previewState.loading')
    case 'binary':
      return t('workspace.previewState.binary')
    case 'too_large':
      return t('workspace.previewState.tooLarge')
    case 'missing':
      return t('workspace.previewState.missing')
    case 'not_git_repo':
      return t('workspace.notGitRepo')
    case 'error':
      return fallbackError || t('workspace.loadError')
    default:
      return fallbackError || t('workspace.loadError')
  }
}

function normalizeFilterQuery(query: string) {
  return query.trim().toLowerCase()
}

function changedFileMatchesFilter(file: WorkspaceChangedFile, query: string) {
  if (!query) return true
  return (
    file.path.toLowerCase().includes(query)
    || file.oldPath?.toLowerCase().includes(query)
    || file.status.toLowerCase().includes(query)
  )
}

function treeEntryMatchesFilter(
  entry: WorkspaceTreeEntry,
  query: string,
  treeByPath: Record<string, WorkspaceTreeResult | undefined>,
): boolean {
  if (!query) return true
  if (entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query)) {
    return true
  }

  if (!entry.isDirectory) return false
  const childTree = treeByPath[entry.path]
  if (childTree?.state !== 'ok') return false
  return childTree.entries.some((child) => treeEntryMatchesFilter(child, query, treeByPath))
}

function PanelMessage({
  icon,
  message,
  tone = 'muted',
  compact = false,
}: {
  icon: string
  message: string
  tone?: 'muted' | 'error'
  compact?: boolean
}) {
  const toneClass =
    tone === 'error'
      ? 'text-[var(--color-error)]'
      : 'text-[var(--color-text-tertiary)]'

  return (
    <div
      className={`flex items-center gap-2 px-4 ${compact ? 'py-2 text-[11px]' : 'py-8 text-xs'} ${toneClass}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className={`material-symbols-outlined shrink-0 text-[16px] ${icon === 'progress_activity' ? 'animate-spin' : ''}`}>
        {icon}
      </span>
      <span className="min-w-0 leading-relaxed">{message}</span>
    </div>
  )
}

function ToolbarIconButton({
  icon,
  label,
  onClick,
}: {
  icon: string
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35"
    >
      <span className="material-symbols-outlined text-[16px]">{icon}</span>
    </button>
  )
}

function WorkspaceFilterInput({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const t = useTranslation()

  return (
    <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-2">
      <label className="flex h-8 items-center gap-2 rounded-[9px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-2.5 text-[var(--color-text-tertiary)] transition-colors focus-within:border-[var(--color-border-focus)] focus-within:ring-2 focus-within:ring-[var(--color-brand)]/10">
        <span className="material-symbols-outlined shrink-0 text-[17px]">search</span>
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={t('workspace.filterPlaceholder')}
          placeholder={t('workspace.filterPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
        />
        {value.length > 0 && (
          <button
            type="button"
            aria-label={t('workspace.clearFilter')}
            onClick={() => onChange('')}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <span className="material-symbols-outlined text-[13px]">close</span>
          </button>
        )}
      </label>
    </div>
  )
}

function FileStatusBadge({ status }: { status: WorkspaceFileStatus }) {
  const meta = FILE_STATUS_META[status]
  return (
    <span
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[10px] font-semibold ${meta.className}`}
      aria-label={status}
    >
      {meta.label}
    </span>
  )
}

function CodeSurface({
  value,
  language,
  onAddLineComment,
}: {
  value: string
  language: string
  onAddLineComment: (line: number, note: string, quote: string) => void
}) {
  const t = useTranslation()
  const [commentLine, setCommentLine] = useState<number | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  const [showAllLines, setShowAllLines] = useState(false)
  const lines = value.split('\n')
  const visibleLines = showAllLines ? lines : lines.slice(0, WORKSPACE_PREVIEW_LINE_LIMIT)
  const activeQuote = commentLine ? visibleLines[commentLine - 1] ?? '' : ''
  const usePlainLargePreview = showAllLines && lines.length > WORKSPACE_PREVIEW_LINE_LIMIT
  const visibleCode = usePlainLargePreview ? '' : visibleLines.join('\n')

  useEffect(() => {
    setShowAllLines(false)
    setCommentLine(null)
    setCommentDraft('')
  }, [language, value])

  const submitLineComment = () => {
    if (!commentLine || !commentDraft.trim()) return
    onAddLineComment(commentLine, commentDraft.trim(), activeQuote)
    setCommentLine(null)
    setCommentDraft('')
  }

  const renderLineCommentEditor = (lineNumber: number) => {
    if (commentLine !== lineNumber) return null

    return (
      <div className="grid grid-cols-[48px_minmax(0,720px)] gap-3 bg-[var(--color-brand)]/10 px-3 py-2">
        <span aria-hidden="true" />
        <div className="rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-sm">
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
            <span className="material-symbols-outlined text-[15px] text-[var(--color-text-tertiary)]">chat_bubble</span>
            <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">{t('workspace.localComment')}</span>
            <span className="ml-auto text-[11px] text-[var(--color-text-tertiary)]">
              {t('workspace.commentLineTarget', { line: lineNumber })}
            </span>
          </div>
          <textarea
            value={commentDraft}
            onChange={(event) => setCommentDraft(event.target.value)}
            autoFocus
            rows={3}
            placeholder={t('workspace.commentPlaceholder')}
            className="block w-full resize-none bg-transparent px-3 py-3 text-[13px] leading-6 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
          <div className="flex justify-end gap-2 px-3 pb-3">
            <button
              type="button"
              onClick={() => {
                setCommentLine(null)
                setCommentDraft('')
              }}
              className="rounded-[7px] px-2.5 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={submitLineComment}
              disabled={!commentDraft.trim()}
              className="rounded-[7px] bg-[var(--color-text-primary)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {t('workspace.addCommentToChat')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const renderLineNumberButton = (lineNumber: number) => (
    <button
      type="button"
      aria-label={t('workspace.commentLine', { line: lineNumber })}
      onClick={() => {
        setCommentLine(lineNumber)
        setCommentDraft('')
      }}
      className="select-none text-right text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-brand)] focus-visible:outline-none focus-visible:text-[var(--color-brand)]"
    >
      {lineNumber}
    </button>
  )

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-code-bg)]">
      <div className="relative min-w-max py-2">
        {usePlainLargePreview ? (
          <pre
            data-workspace-code=""
            data-testid="workspace-code"
            className="m-0 font-[var(--font-mono)] text-[12px] leading-[1.55]"
            style={{ color: 'var(--color-code-fg)', background: 'transparent' }}
          >
            {visibleLines.map((line, index) => {
              const lineNumber = index + 1
              return (
                <div key={lineNumber}>
                  <div className="group grid grid-cols-[48px_minmax(0,1fr)] gap-3 px-3 hover:bg-[var(--color-surface-hover)]">
                    {renderLineNumberButton(lineNumber)}
                    <span className="whitespace-pre pr-6">{line || ' '}</span>
                  </div>
                  {renderLineCommentEditor(lineNumber)}
                </div>
              )
            })}
          </pre>
        ) : (
          <Highlight
            theme={workspacePrismTheme}
            code={visibleCode}
            language={normalizePrismLanguage(language)}
          >
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre
                data-workspace-code=""
                data-testid="workspace-code"
                className="m-0 font-[var(--font-mono)] text-[12px] leading-[1.55]"
                style={{ color: 'var(--color-code-fg)', background: 'transparent' }}
              >
                {tokens.map((line, index) => {
                  const { key: lineKey, ...lineProps } = getLineProps({ line, key: index })
                  const lineNumber = index + 1
                  return (
                    <div key={String(lineKey)}>
                      <div
                        {...lineProps}
                        className="group grid grid-cols-[48px_minmax(0,1fr)] gap-3 px-3 hover:bg-[var(--color-surface-hover)]"
                      >
                        {renderLineNumberButton(lineNumber)}
                        <span className="whitespace-pre pr-6">
                          {line.length === 1 && line[0]?.empty ? ' ' : line.map((token, tokenIndex) => {
                            const { key: tokenKey, ...tokenProps } = getTokenProps({ token, key: tokenIndex })
                            return <span key={String(tokenKey)} {...tokenProps} />
                          })}
                        </span>
                      </div>
                      {renderLineCommentEditor(lineNumber)}
                    </div>
                  )
                })}
              </pre>
            )}
          </Highlight>
        )}
        {lines.length > WORKSPACE_PREVIEW_LINE_LIMIT && (
          <div className="sticky bottom-0 flex items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-glass)] px-3 py-2 text-xs text-[var(--color-text-tertiary)] backdrop-blur">
            <span>
              {showAllLines
                ? t('workspace.previewAllLines', { total: lines.length })
                : t('workspace.previewLineLimit', { count: visibleLines.length, total: lines.length })}
            </span>
            <button
              type="button"
              onClick={() => setShowAllLines((current) => !current)}
              className="ml-auto rounded-[6px] px-2 py-1 text-[12px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
            >
              {showAllLines ? t('workspace.collapsePreview') : t('workspace.showAllLoadedLines')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function MarkdownSurface({ value }: { value: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-surface)]">
      <div className="mx-auto w-full max-w-[860px] px-6 py-5">
        <MarkdownRenderer
          content={value}
          variant="document"
          className="workspace-markdown-preview prose-p:text-[14px] prose-p:leading-7 prose-h1:text-[24px] prose-h2:text-[18px] prose-h3:text-[15px] prose-code:text-[12px] prose-pre:my-4"
        />
      </div>
    </div>
  )
}

function ImagePreview({ tab }: { tab: WorkspacePreviewTab }) {
  const t = useTranslation()

  if (!tab.dataUrl) {
    return (
      <PanelMessage
        icon="image_not_supported"
        message={tab.error || t('workspace.imagePreviewUnavailable')}
      />
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-surface)] p-4">
      <div className="flex min-h-full items-center justify-center">
        <img
          src={tab.dataUrl}
          alt={tab.path}
          className="max-h-full max-w-full rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] object-contain shadow-sm"
        />
      </div>
    </div>
  )
}

function ChangedFileRow({
  file,
  onClick,
  onContextMenu,
}: {
  file: WorkspaceChangedFile
  onClick: () => void
  onContextMenu: (event: MouseEvent, path: string) => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={(event) => onContextMenu(event, file.path)}
      className="mx-2 flex w-[calc(100%-16px)] items-center gap-3 rounded-[7px] px-2 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
    >
      <FileStatusBadge status={file.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-[var(--color-text-primary)]">{file.path}</div>
        {file.oldPath && (
          <div className="truncate text-[11px] text-[var(--color-text-tertiary)]">
            {file.oldPath}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right font-[var(--font-mono)] text-[11px] leading-4">
        <div className="text-[var(--color-success)]">+{file.additions}</div>
        <div className="text-[var(--color-error)]">-{file.deletions}</div>
      </div>
    </button>
  )
}

function TreeNode({
  sessionId,
  entry,
  depth,
  expandedPaths,
  treeByPath,
  treeLoadingByPath,
  treeErrorsByPath,
  filterQuery,
  onToggle,
  onOpenFile,
  onFileContextMenu,
  rightClickedFilePath,
  rightClickedPreviewTabId,
  activePath,
}: TreeNodeProps) {
  const t = useTranslation()
  const childTree = treeByPath[entry.path]
  const childLoading = treeLoadingByPath[makeTreeStateKey(sessionId, entry.path)] ?? false
  const childError = treeErrorsByPath[makeTreeStateKey(sessionId, entry.path)] ?? null
  const isExpanded = expandedPaths.has(entry.path)
  const isVisuallyExpanded = isExpanded || filterQuery.length > 0
  const indent = 14 + depth * 20

  if (!entry.isDirectory) {
    const isActive = entry.path === activePath
    return (
      <button
        type="button"
        onClick={() => onOpenFile(entry.path)}
        onContextMenu={(event) => onFileContextMenu(event, entry.path)}
        className={`group mx-2 flex h-8 w-[calc(100%-16px)] items-center gap-2 rounded-[7px] pr-2 text-left transition-colors ${
          isActive
            ? 'bg-[var(--color-surface-selected)] shadow-[inset_0_0_0_1.5px_var(--color-border-focus)]'
            : 'hover:bg-[var(--color-surface-hover)]'
        }${entry.path === rightClickedFilePath ? ' ring-2 ring-[var(--color-brand)] ring-offset-1' : ''}`}
        style={{ paddingLeft: indent }}
      >
        <FileTypeBadge name={entry.name} subtle={!isActive} />
        <span className="min-w-0 truncate text-[14px] font-medium text-[var(--color-text-primary)]">{entry.name}</span>
      </button>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(entry.path)}
        aria-expanded={isVisuallyExpanded}
        className="group mx-2 flex h-8 w-[calc(100%-16px)] items-center gap-2 rounded-[7px] pr-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ paddingLeft: indent }}
      >
        <span className="material-symbols-outlined shrink-0 text-[18px] text-[var(--color-text-tertiary)] transition-colors group-hover:text-[var(--color-text-primary)]">
          {isVisuallyExpanded ? 'expand_more' : 'chevron_right'}
        </span>
        <span className="min-w-0 truncate text-[15px] font-medium text-[var(--color-text-primary)]">{entry.name}</span>
      </button>

      {isVisuallyExpanded && (
        <div className="relative">
          {depth < 4 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-1 top-1 w-px bg-[var(--color-border)]"
              style={{ left: 28 + depth * 20 }}
            />
          )}
          {childLoading && !childTree && (
            <PanelMessage
              compact
              icon="progress_activity"
              message={t('common.loading')}
            />
          )}

          {!childLoading && childError && (
            <PanelMessage compact icon="error" tone="error" message={childError} />
          )}

          {!childLoading && !childError && childTree?.state === 'missing' && (
            <PanelMessage compact icon="folder_off" message={t('workspace.previewState.missing')} />
          )}

          {!childLoading && !childError && childTree?.state === 'error' && (
            <PanelMessage
              compact
              icon="error"
              tone="error"
              message={childTree.error || t('workspace.loadError')}
            />
          )}

          {!childLoading && !childError && childTree?.state === 'ok' && childTree.entries.length === 0 && (
            <PanelMessage compact icon="folder_open" message={t('workspace.noFiles')} />
          )}

          {!childLoading && !childError && childTree?.state === 'ok' && childTree.entries
            .filter((childEntry) => treeEntryMatchesFilter(childEntry, filterQuery, treeByPath))
            .map((childEntry) => (
              <TreeNode
                key={childEntry.path}
                sessionId={sessionId}
                entry={childEntry}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                treeByPath={treeByPath}
                treeLoadingByPath={treeLoadingByPath}
                treeErrorsByPath={treeErrorsByPath}
                filterQuery={filterQuery}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                onFileContextMenu={onFileContextMenu}
                rightClickedFilePath={rightClickedFilePath}
                rightClickedPreviewTabId={rightClickedPreviewTabId}
                activePath={activePath}
              />
            ))}
        </div>
      )}
    </div>
  )
}

export function WorkspacePanel({ sessionId }: WorkspacePanelProps) {
  const t = useTranslation()
  const [filterQuery, setFilterQuery] = useState('')
  const [isViewMenuOpen, setIsViewMenuOpen] = useState(false)
  const [previewTabContextMenu, setPreviewTabContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [rightClickedPreviewTabId, setRightClickedPreviewTabId] = useState<string | null>(null)
  const [fileContextMenu, setFileContextMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  const [rightClickedFilePath, setRightClickedFilePath] = useState<string | null>(null)
  const width = useWorkspacePanelStore((state) => state.width)
  const isOpen = useWorkspacePanelStore((state) => state.isPanelOpen(sessionId))
  const activeView = useWorkspacePanelStore((state) => state.getActiveView(sessionId))
  const status = useWorkspacePanelStore((state) => state.statusBySession[sessionId])
  const treeByPath = useWorkspacePanelStore((state) => state.treeBySessionPath[sessionId] ?? EMPTY_TREE_BY_PATH)
  const previewTabs = useWorkspacePanelStore((state) => state.previewTabsBySession[sessionId] ?? EMPTY_PREVIEW_TABS)
  const activePreviewTabId = useWorkspacePanelStore((state) => state.activePreviewTabIdBySession[sessionId] ?? null)
  const expandedPaths = useWorkspacePanelStore((state) => state.expandedPathsBySession[sessionId] ?? EMPTY_EXPANDED_PATHS)
  const statusLoading = useWorkspacePanelStore((state) => state.loading.statusBySession[sessionId] ?? false)
  const treeLoadingByPath = useWorkspacePanelStore(
    useShallow((state) => getSessionScopedRecord(state.loading.treeBySessionPath, sessionId)),
  )
  const statusError = useWorkspacePanelStore((state) => state.errors.statusBySession[sessionId] ?? null)
  const treeErrorsByPath = useWorkspacePanelStore(
    useShallow((state) => getSessionScopedRecord(state.errors.treeBySessionPath, sessionId)),
  )
  const setActiveView = useWorkspacePanelStore((state) => state.setActiveView)
  const loadStatus = useWorkspacePanelStore((state) => state.loadStatus)
  const loadTree = useWorkspacePanelStore((state) => state.loadTree)
  const toggleTreeNode = useWorkspacePanelStore((state) => state.toggleTreeNode)
  const openPreview = useWorkspacePanelStore((state) => state.openPreview)
  const closePreview = useWorkspacePanelStore((state) => state.closePreview)
  const closePreviewTabs = useWorkspacePanelStore((state) => state.closePreviewTabs)
  const closePanel = useWorkspacePanelStore((state) => state.closePanel)
  const addWorkspaceReference = useWorkspaceChatContextStore((state) => state.addReference)
  const chatState = useChatStore((state) => state.sessions[sessionId]?.chatState ?? 'idle')
  const uiZoom = useSettingsStore((s) => s.uiZoom)
  const refreshLifecycleRef = useRef({
    sessionId,
    isOpen: false,
    chatState: 'idle',
  })

  const rootTree = treeByPath['']
  const rootTreeKey = makeTreeStateKey(sessionId, '')
  const rootTreeLoading = treeLoadingByPath[rootTreeKey] ?? false
  const rootTreeError = treeErrorsByPath[rootTreeKey] ?? null
  const normalizedFilterQuery = normalizeFilterQuery(filterQuery)
  const expandedPathSet = new Set(expandedPaths)
  const activePreviewTab =
    previewTabs.find((tab) => tab.id === activePreviewTabId) ?? previewTabs[previewTabs.length - 1] ?? null
  const activeTreePath = activePreviewTab?.kind === 'file' ? activePreviewTab.path : null
  const filteredChangedFiles = useMemo(
    () => (status?.changedFiles ?? []).filter((file) => changedFileMatchesFilter(file, normalizedFilterQuery)),
    [normalizedFilterQuery, status?.changedFiles],
  )
  const filteredRootEntries = useMemo(
    () => rootTree?.state === 'ok'
      ? rootTree.entries.filter((entry) => treeEntryMatchesFilter(entry, normalizedFilterQuery, treeByPath))
      : [],
    [normalizedFilterQuery, rootTree, treeByPath],
  )
  const activePreviewRequestKey = activePreviewTab
    ? makePreviewStateKey(sessionId, activePreviewTab.id)
    : null
  const activePreviewLoading = useWorkspacePanelStore((state) =>
    activePreviewRequestKey ? state.loading.previewByTabId[activePreviewRequestKey] ?? false : false,
  )
  const activePreviewError = useWorkspacePanelStore((state) =>
    activePreviewRequestKey ? state.errors.previewByTabId[activePreviewRequestKey] ?? null : null,
  )

  useEffect(() => {
    const previous = refreshLifecycleRef.current
    const sessionChanged = previous.sessionId !== sessionId
    const opened = isOpen && (sessionChanged || !previous.isOpen)
    const completedTurn =
      isOpen &&
      !sessionChanged &&
      previous.chatState !== 'idle' &&
      chatState === 'idle'

    refreshLifecycleRef.current = { sessionId, isOpen, chatState }

    const shouldRefreshOnOpen = opened
    const shouldRefreshAfterCompletedTurn = completedTurn && chatState === 'idle'
    if ((!shouldRefreshOnOpen && !shouldRefreshAfterCompletedTurn) || statusLoading) return
    void loadStatus(sessionId)
  }, [chatState, isOpen, loadStatus, sessionId, statusLoading])

  useEffect(() => {
    if (!isOpen || activeView !== 'all' || rootTree || rootTreeLoading || rootTreeError) return
    void loadTree(sessionId, '')
  }, [activeView, isOpen, loadTree, rootTree, rootTreeError, rootTreeLoading, sessionId])

  useEffect(() => {
    if (!previewTabContextMenu && !fileContextMenu) return
    const close = () => {
      setPreviewTabContextMenu(null)
      setFileContextMenu(null)
      setRightClickedPreviewTabId(null)
      setRightClickedFilePath(null)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [fileContextMenu, previewTabContextMenu])

  if (!isOpen) return null

  const hasPreviewTabs = previewTabs.length > 0
  const panelWidth = hasPreviewTabs ? width : Math.min(width, 520)
  const panelMaxWidth = hasPreviewTabs ? 'min(62%, calc(100% - 328px))' : '36%'
  const panelMinWidth = hasPreviewTabs ? 'min(420px, 54%)' : 'min(340px, 40%)'

  const handleRefresh = () => {
    void loadStatus(sessionId)
    if (activeView === 'all') {
      void loadTree(sessionId, '')
    }
  }

  const handleOpenDiff = (path: string) => {
    void openPreview(sessionId, path, 'diff')
  }

  const handleOpenFile = (path: string) => {
    void openPreview(sessionId, path, 'file')
  }

  const addFileToChat = (path: string) => {
    addWorkspaceReference(sessionId, {
      kind: 'file',
      path,
      absolutePath: resolveWorkspaceAttachmentPath(status?.workDir, path),
      name: path.split('/').pop() || path,
    })
  }

  const addLineCommentToChat = (path: string, line: number, note: string, quote: string) => {
    addWorkspaceReference(sessionId, {
      kind: 'code-comment',
      path,
      absolutePath: resolveWorkspaceAttachmentPath(status?.workDir, path),
      name: path.split('/').pop() || path,
      lineStart: line,
      lineEnd: line,
      note,
      quote,
    })
  }

  const handleSetActiveView = (view: 'changed' | 'all') => {
    setActiveView(sessionId, view)
    setIsViewMenuOpen(false)
  }

  const handlePreviewTabContextMenu = (event: MouseEvent, tabId: string) => {
    event.preventDefault()
    event.stopPropagation()
    setFileContextMenu(null)
    setRightClickedFilePath(null)
    setPreviewTabContextMenu({ tabId, x: event.clientX, y: event.clientY })
    setRightClickedPreviewTabId(tabId)
  }

  const handleFileContextMenu = (event: MouseEvent, path: string) => {
    event.preventDefault()
    event.stopPropagation()
    setPreviewTabContextMenu(null)
    setRightClickedPreviewTabId(null)
    setFileContextMenu({ path, x: event.clientX, y: event.clientY })
    setRightClickedFilePath(path)
  }

  const handleClosePreviewTabs = (scope: WorkspacePreviewCloseScope) => {
    if (!previewTabContextMenu) return
    closePreviewTabs(sessionId, previewTabContextMenu.tabId, scope)
    setPreviewTabContextMenu(null)
  }

  const copyWorkspacePath = (path: string) => {
    const resolvedPath = resolveWorkspaceAttachmentPath(status?.workDir, path)
    void navigator.clipboard?.writeText(resolvedPath)
    setFileContextMenu(null)
  }

  const renderChangedView = () => {
    if (statusLoading && !status) {
      return <PanelMessage icon="progress_activity" message={t('common.loading')} />
    }

    if (status?.state === 'missing_workdir') {
      return <PanelMessage icon="folder_off" message={t('workspace.missingWorkdir')} />
    }

    if (status?.state === 'not_git_repo') {
      return <PanelMessage icon="account_tree" message={t('workspace.notGitRepo')} />
    }

    if (statusError || status?.state === 'error') {
      return (
        <PanelMessage
          icon="error"
          tone="error"
          message={statusError || status?.error || t('workspace.loadError')}
        />
      )
    }

    if (!status) {
      return <PanelMessage icon="progress_activity" message={t('common.loading')} />
    }

    if (status.changedFiles.length === 0) {
      return <PanelMessage icon="check_circle" message={t('workspace.noChanges')} />
    }

    if (filteredChangedFiles.length === 0) {
      return <PanelMessage icon="search_off" message={t('workspace.noMatchingFiles')} />
    }

    return (
      <div>
        {filteredChangedFiles.map((file) => (
          <ChangedFileRow
            key={`${file.path}:${file.status}:${file.oldPath ?? ''}`}
            file={file}
            onClick={() => handleOpenDiff(file.path)}
            onContextMenu={handleFileContextMenu}
          />
        ))}
      </div>
    )
  }

  const renderAllFilesView = () => {
    if (rootTreeLoading && !rootTree) {
      return <PanelMessage icon="progress_activity" message={t('common.loading')} />
    }

    if (rootTreeError) {
      return <PanelMessage icon="error" tone="error" message={rootTreeError} />
    }

    if (rootTree?.state === 'missing') {
      return <PanelMessage icon="folder_off" message={t('workspace.missingWorkdir')} />
    }

    if (rootTree?.state === 'error') {
      return <PanelMessage icon="error" tone="error" message={rootTree.error || t('workspace.loadError')} />
    }

    if (!rootTree) {
      return <PanelMessage icon="progress_activity" message={t('common.loading')} />
    }

    if (rootTree.entries.length === 0) {
      return <PanelMessage icon="folder_open" message={t('workspace.noFiles')} />
    }

    if (filteredRootEntries.length === 0) {
      return <PanelMessage icon="search_off" message={t('workspace.noMatchingFiles')} />
    }

    return (
      <div className="py-1">
        {filteredRootEntries.map((entry) => (
          <TreeNode
            key={entry.path}
            sessionId={sessionId}
            entry={entry}
            depth={0}
            expandedPaths={expandedPathSet}
            treeByPath={treeByPath}
            treeLoadingByPath={treeLoadingByPath}
            treeErrorsByPath={treeErrorsByPath}
            filterQuery={normalizedFilterQuery}
            onToggle={(path) => {
              void toggleTreeNode(sessionId, path)
            }}
            onOpenFile={handleOpenFile}
            onFileContextMenu={handleFileContextMenu}
            rightClickedFilePath={rightClickedFilePath}
            rightClickedPreviewTabId={rightClickedPreviewTabId}
            activePath={activeTreePath}
          />
        ))}
      </div>
    )
  }

  const renderPreviewContent = () => {
    if (!activePreviewTab) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-xs text-[var(--color-text-tertiary)]">
          {t('workspace.previewEmpty')}
        </div>
      )
    }

    const kindLabel = getPreviewKindLabel(t, activePreviewTab.kind)
    const state = activePreviewTab.state ?? 'loading'

    return (
      <>
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3 text-[12px]">
          <span className="truncate text-[var(--color-text-tertiary)]">{status?.repoName || 'workspace'}</span>
          {activePreviewTab.path.split('/').map((segment, index, segments) => (
            <span key={`${segment}:${index}`} className="flex min-w-0 items-center gap-1.5">
              <span className="text-[var(--color-text-tertiary)]">›</span>
              <span className={`truncate ${index === segments.length - 1 ? 'font-semibold text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}>
                {segment}
              </span>
            </span>
          ))}
          <button
            type="button"
            onClick={() => addFileToChat(activePreviewTab.path)}
            className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[14px]">person_add</span>
            <span>{t('workspace.addToChat')}</span>
          </button>
          <span className="shrink-0 rounded-[5px] border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
            {kindLabel}
          </span>
        </div>

        {activePreviewLoading || state === 'loading' ? (
          <PanelMessage icon="progress_activity" message={t('workspace.previewState.loading')} />
        ) : state === 'ok' && activePreviewTab.previewType === 'image' ? (
          <ImagePreview tab={activePreviewTab} />
        ) : state === 'ok' && activePreviewTab.kind === 'diff' ? (
          <WorkspaceDiffSurface
            value={activePreviewTab.diff ?? ''}
            path={activePreviewTab.path}
          />
        ) : state === 'ok' && isMarkdownPreview(activePreviewTab) ? (
          <MarkdownSurface value={activePreviewTab.content ?? ''} />
        ) : state === 'ok' ? (
          <CodeSurface
            value={activePreviewTab.content ?? ''}
            language={activePreviewTab.language ?? 'text'}
            onAddLineComment={(line, note, quote) => addLineCommentToChat(activePreviewTab.path, line, note, quote)}
          />
        ) : (
          <PanelMessage
            icon="error"
            tone={state === 'error' ? 'error' : 'muted'}
            message={getInlineStateMessage(t, state, activePreviewError || activePreviewTab.error || null)}
          />
        )}
      </>
    )
  }

  const renderPreviewTabs = () => (
    <>
      <div
        role="tablist"
        aria-label={t('workspace.previewTabs')}
        className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-3"
      >
        {previewTabs.length === 0 ? (
          <div className="flex items-center gap-2 px-1.5 text-[12px] text-[var(--color-text-tertiary)]">
            <span className="material-symbols-outlined text-[15px]">docs</span>
            <span>{t('workspace.preview')}</span>
          </div>
        ) : (
          previewTabs.map((tab) => {
            const kindLabel = getPreviewKindLabel(t, tab.kind)
            const isActive = tab.id === activePreviewTab?.id

            return (
              <div
                key={tab.id}
                onContextMenu={(event) => handlePreviewTabContextMenu(event, tab.id)}
                className={`group flex h-8 min-w-[118px] max-w-[210px] shrink-0 items-center gap-2 rounded-[8px] px-2 text-left text-[13px] transition-colors ${
                  isActive
                    ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
                }${tab.id === rightClickedPreviewTabId ? ' ring-2 ring-[var(--color-brand)] ring-offset-1 ring-offset-[var(--color-surface-container-lowest)]' : ''}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => {
                    void openPreview(sessionId, tab.path, tab.kind)
                  }}
                  className="min-w-0 flex flex-1 items-center gap-2 text-left"
                >
                  {tab.kind === 'diff' ? (
                    <span className="material-symbols-outlined shrink-0 text-[15px] text-[var(--color-text-tertiary)]">difference</span>
                  ) : (
                    <FileTypeBadge name={tab.title} subtle={!isActive} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                </button>
                <button
                  type="button"
                  aria-label={`${t('workspace.closeTab')} ${tab.title} ${kindLabel}`}
                  onClick={() => {
                    closePreview(sessionId, tab.id)
                  }}
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-[var(--color-text-tertiary)] opacity-0 transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <span className="material-symbols-outlined text-[13px] leading-none">close</span>
                </button>
              </div>
            )
          })
        )}
      </div>

      {previewTabContextMenu && (
        <div
          role="menu"
          className="fixed z-50 min-w-[156px] rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1 text-[12px] shadow-[var(--shadow-dropdown)]"
          style={{ left: previewTabContextMenu.x / uiZoom, top: previewTabContextMenu.y / uiZoom }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('current')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.close')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('others')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeOthers')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('left')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeLeft')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('right')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeRight')}
          </button>
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => handleClosePreviewTabs('all')}
            className="block w-full px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            {t('tabs.closeAll')}
          </button>
        </div>
      )}
    </>
  )

  return (
    <aside
      data-testid="workspace-panel"
      className="flex h-full shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface)]"
      style={{ width: panelWidth, maxWidth: panelMaxWidth, minWidth: panelMinWidth }}
    >
      {hasPreviewTabs && (
        <div className="flex min-w-0 flex-1 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
          {renderPreviewTabs()}
          {renderPreviewContent()}
        </div>
      )}

      <div
        className={`${hasPreviewTabs ? 'basis-[32%] min-w-[220px] max-w-[320px]' : 'w-full'} flex h-full shrink-0 flex-col bg-[var(--color-surface)]`}
      >
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-2.5">
          <div className="relative min-w-0">
            <button
              type="button"
              aria-label={activeView === 'changed' ? t('workspace.changedFiles') : t('workspace.allFiles')}
              aria-haspopup="menu"
              aria-expanded={isViewMenuOpen}
              onClick={() => setIsViewMenuOpen((open) => !open)}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-[7px] px-2 py-1 text-[14px] font-semibold leading-5 text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35"
            >
              <span className="truncate">
                {activeView === 'changed' ? t('workspace.changedFiles') : t('workspace.allFiles')}
              </span>
              <span className="material-symbols-outlined shrink-0 text-[15px] font-normal text-[var(--color-text-tertiary)]">expand_more</span>
            </button>
            {isViewMenuOpen && (
              <div
                role="menu"
                className="absolute left-0 top-[calc(100%+4px)] z-30 min-w-[124px] overflow-hidden rounded-[9px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1 shadow-[var(--shadow-dropdown)]"
              >
                {(['changed', 'all'] as const).map((view) => {
                  const selected = activeView === view
                  return (
                    <button
                      key={view}
                      type="button"
                      role="menuitem"
                      onClick={() => handleSetActiveView(view)}
                      className={`flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12px] transition-colors ${
                        selected ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {view === 'changed' ? t('workspace.changedFiles') : t('workspace.allFiles')}
                      </span>
                      {selected && (
                        <span className="material-symbols-outlined text-[14px] text-[var(--color-brand)]">check</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <ToolbarIconButton
              icon="refresh"
              label={t('workspace.refresh')}
              onClick={handleRefresh}
            />
            <ToolbarIconButton
              icon="close"
              label={t('workspace.closePanel')}
              onClick={() => closePanel(sessionId)}
            />
          </div>
        </div>

        <WorkspaceFilterInput value={filterQuery} onChange={setFilterQuery} />

        <div className="min-h-0 flex-1 overflow-auto py-2">
          {activeView === 'changed' ? renderChangedView() : renderAllFilesView()}
        </div>
      </div>

      {fileContextMenu && (
        <div
          role="menu"
          className="fixed z-50 min-w-[156px] rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1 text-[12px] shadow-[var(--shadow-dropdown)]"
          style={{ left: fileContextMenu.x / uiZoom, top: fileContextMenu.y / uiZoom }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              addFileToChat(fileContextMenu.path)
              setFileContextMenu(null)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]">person_add</span>
            <span>{t('workspace.addToChat')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => copyWorkspacePath(fileContextMenu.path)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]">content_copy</span>
            <span>{t('workspace.copyPath')}</span>
          </button>
        </div>
      )}
    </aside>
  )
}
