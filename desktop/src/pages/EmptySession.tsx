import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { skillsApi } from '../api/skills'
import { useTranslation } from '../i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useChatStore } from '../stores/chatStore'
import { useSessionRuntimeStore, DRAFT_RUNTIME_SELECTION_KEY } from '../stores/sessionRuntimeStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { SETTINGS_TAB_ID, useTabStore } from '../stores/tabStore'
import { RepositoryLaunchControls } from '../components/shared/RepositoryLaunchControls'
import { PermissionModeSelector } from '../components/controls/PermissionModeSelector'
import { ModelSelector } from '../components/controls/ModelSelector'
import { AttachmentGallery } from '../components/chat/AttachmentGallery'
import { ContextUsageIndicator } from '../components/chat/ContextUsageIndicator'
import { FileSearchMenu, type FileSearchMenuHandle } from '../components/chat/FileSearchMenu'
import { LocalSlashCommandPanel, type LocalSlashCommandName } from '../components/chat/LocalSlashCommandPanel'
import { useMobileViewport } from '../hooks/useMobileViewport'
import { isTauriRuntime } from '../lib/desktopRuntime'

// Build-time gate (BUILD_TARGET=web vite build sets this); runtime detection
// would also flag jsdom unit tests as "web", which we don't want here.
const IS_WEB_BUILD =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_BUILD_TARGET === 'web'
import {
  FALLBACK_SLASH_COMMANDS,
  findSlashToken,
  insertSlashTrigger,
  mergeSlashCommands,
  replaceSlashCommand,
  resolveSlashUiAction,
} from '../components/chat/composerUtils'
import type { AttachmentRef } from '../types/chat'
import type { SlashCommandOption } from '../components/chat/composerUtils'

type Attachment = {
  id: string
  name: string
  type: 'image' | 'file'
  path?: string
  mimeType?: string
  previewUrl?: string
  data?: string
}

type Translate = ReturnType<typeof useTranslation>

function getApiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body
  if (!body || typeof body !== 'object' || !('error' in body)) return null
  return typeof body.error === 'string' ? body.error : null
}

function resolveCreateSessionErrorMessage(error: unknown, t: Translate): string {
  const code = getApiErrorCode(error)
  switch (code) {
    case 'WORKDIR_MISSING':
    case 'WORKDIR_NOT_DIRECTORY':
      return t('empty.createError.workdirMissing')
    case 'REPOSITORY_NOT_GIT':
      return t('empty.createError.notGit')
    case 'REPOSITORY_BRANCH_NOT_FOUND':
      return t('empty.createError.branchNotFound')
    case 'REPOSITORY_DIRTY_WORKTREE':
      return t('empty.createError.dirtyWorktree')
    case 'REPOSITORY_BRANCH_CHECKED_OUT':
      return t('empty.createError.branchCheckedOut')
    case 'REPOSITORY_WORKTREE_CREATE_FAILED':
      return t('empty.createError.worktreeCreateFailed', {
        detail: error instanceof Error ? error.message : t('empty.failedToCreate'),
      })
    case 'REPOSITORY_SWITCH_FAILED':
      return t('empty.createError.switchFailed', {
        detail: error instanceof Error ? error.message : t('empty.failedToCreate'),
      })
    case 'REPOSITORY_CONTEXT_ERROR':
      return t('empty.createError.contextFailed')
    default:
      return error instanceof Error ? error.message : t('empty.failedToCreate')
  }
}

export function EmptySession() {
  const t = useTranslation()
  const [input, setInput] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [workDir, setWorkDir] = useState('')
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null)
  const [useWorktree, setUseWorktree] = useState(false)
  const [repositoryLaunchReady, setRepositoryLaunchReady] = useState(true)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [fileSearchOpen, setFileSearchOpen] = useState(false)
  const [localSlashPanel, setLocalSlashPanel] = useState<LocalSlashCommandName | null>(null)
  const [atFilter, setAtFilter] = useState('')
  const [atCursorPos, setAtCursorPos] = useState(-1)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [slashCommands, setSlashCommands] = useState<SlashCommandOption[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const plusMenuRef = useRef<HTMLDivElement>(null)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const fileSearchRef = useRef<FileSearchMenuHandle>(null)
  const slashItemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const createSession = useSessionStore((state) => state.createSession)
  const sendMessage = useChatStore((state) => state.sendMessage)
  const connectToSession = useChatStore((state) => state.connectToSession)
  const setActiveView = useUIStore((state) => state.setActiveView)
  const addToast = useUIStore((state) => state.addToast)
  const currentModel = useSettingsStore((state) => state.currentModel)
  const draftRuntimeSelection = useSessionRuntimeStore((state) => state.selections[DRAFT_RUNTIME_SELECTION_KEY])
  const draftRuntimeSelectionKey = draftRuntimeSelection
    ? `${draftRuntimeSelection.providerId ?? 'official'}:${draftRuntimeSelection.modelId}`
    : undefined
  const draftModelLabel = draftRuntimeSelection?.modelId ?? currentModel?.name ?? currentModel?.id
  const isMobileComposer = useMobileViewport() && !isTauriRuntime()

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!plusMenuOpen) return
    const handleClick = (event: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(event.target as Node)) {
        setPlusMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [plusMenuOpen])

  useEffect(() => {
    if (!slashMenuOpen) return
    const handleClick = (event: MouseEvent) => {
      if (
        slashMenuRef.current &&
        !slashMenuRef.current.contains(event.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(event.target as Node)
      ) {
        setSlashMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [slashMenuOpen])

  useEffect(() => {
    if (!localSlashPanel) return
    const handleClick = (event: MouseEvent) => {
      if (
        slashMenuRef.current &&
        !slashMenuRef.current.contains(event.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(event.target as Node)
      ) {
        setLocalSlashPanel(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [localSlashPanel])

  useEffect(() => {
    if (!fileSearchOpen) return
    const handleClick = (event: MouseEvent) => {
      const menu = document.getElementById('file-search-menu')
      if (
        menu &&
        !menu.contains(event.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(event.target as Node)
      ) {
        setFileSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [fileSearchOpen])

  useEffect(() => {
    let cancelled = false

    skillsApi.list(workDir || undefined)
      .then(({ skills }) => {
        if (cancelled) return
        setSlashCommands(
          skills
            .filter((skill) => skill.userInvocable)
            .map((skill) => ({
              name: skill.name,
              description: skill.description,
            })),
        )
      })
      .catch(() => {
        if (!cancelled) {
          setSlashCommands([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [workDir])

  const allSlashCommands = useMemo(
    () => mergeSlashCommands(slashCommands, FALLBACK_SLASH_COMMANDS),
    [slashCommands],
  )

  const handleWorkDirChange = (newWorkDir: string) => {
    setWorkDir(newWorkDir)
    setSelectedBranch(null)
    setUseWorktree(false)
    setRepositoryLaunchReady(!newWorkDir)
  }

  const filteredCommands = useMemo(() => {
    const source = allSlashCommands
    if (!slashFilter) return source
    const lower = slashFilter.toLowerCase()
    return source.filter((command) => (
      command.name.toLowerCase().includes(lower) ||
      command.description.toLowerCase().includes(lower)
    ))
  }, [allSlashCommands, slashFilter])

  const exactSlashCommand = useMemo(() => {
    const normalized = slashFilter.trim().toLowerCase()
    if (!normalized) return null
    return filteredCommands.find((command) => command.name.toLowerCase() === normalized) ?? null
  }, [filteredCommands, slashFilter])
  const canSubmit = (
    input.trim().length > 0 ||
    attachments.length > 0 ||
    !!workDir
  ) && !isSubmitting && repositoryLaunchReady

  useEffect(() => {
    setSlashSelectedIndex(0)
  }, [slashFilter])

  useEffect(() => {
    const activeItem = slashMenuOpen ? slashItemRefs.current[slashSelectedIndex] : null
    if (activeItem && typeof activeItem.scrollIntoView === 'function') {
      activeItem.scrollIntoView({ block: 'nearest' })
    }
  }, [slashMenuOpen, slashSelectedIndex])

  const handleSubmit = async () => {
    const text = input.trim()
    if (!canSubmit) return

    const slashUiAction = text.startsWith('/') ? resolveSlashUiAction(text.slice(1)) : null
    if (slashUiAction?.type === 'panel') {
      setLocalSlashPanel(slashUiAction.command as LocalSlashCommandName)
      setInput('')
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    if (slashUiAction?.type === 'settings') {
      useUIStore.getState().setPendingSettingsTab(slashUiAction.tab)
      useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
      setInput('')
      setSlashMenuOpen(false)
      setFileSearchOpen(false)
      setPlusMenuOpen(false)
      return
    }

    setIsSubmitting(true)
    try {
      const explicitDraftSelection = useSessionRuntimeStore.getState().selections[DRAFT_RUNTIME_SELECTION_KEY]
      const sessionId = await createSession(
        workDir || undefined,
        selectedBranch
          ? { repository: { branch: selectedBranch, worktree: useWorktree } }
          : undefined,
      )
      if (explicitDraftSelection) {
        useSessionRuntimeStore.getState().setSelection(sessionId, explicitDraftSelection)
        useSessionRuntimeStore.getState().clearSelection(DRAFT_RUNTIME_SELECTION_KEY)
      }
      setActiveView('code')
      useTabStore.getState().openTab(sessionId, 'New Session')
      connectToSession(sessionId)
      const attachmentPayload: AttachmentRef[] = attachments.map((attachment) => ({
        type: attachment.type,
        name: attachment.name,
        path: attachment.path,
        data: attachment.data,
        mimeType: attachment.mimeType,
      }))
      if (text || attachmentPayload.length > 0) {
        sendMessage(sessionId, text, attachmentPayload)
      }
      setInput('')
      setAttachments([])
    } catch (error) {
      addToast({
        type: 'error',
        message: resolveCreateSessionErrorMessage(error, t),
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleInputChange = (value: string, cursorPos: number) => {
    setInput(value)
    const token = findSlashToken(value, cursorPos)
    if (!token) {
      setSlashMenuOpen(false)
    } else {
      setSlashFilter(token.filter)
      setSlashMenuOpen(true)
    }

    // Detect @ trigger for file search
    const textBeforeCursor = value.slice(0, cursorPos)
    let pos = -1
    for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
      const ch = textBeforeCursor[i]!
      if (ch === '@') {
        if (i === 0 || /\s/.test(textBeforeCursor[i - 1]!)) {
          pos = i
          break
        }
        break
      }
      if (/\s/.test(ch)) {
        break
      }
    }
    if (pos < 0) {
      setFileSearchOpen(false)
      setAtFilter('')
      setAtCursorPos(-1)
    } else {
      setAtFilter(textBeforeCursor.slice(pos + 1))
      setAtCursorPos(pos)
      setSlashMenuOpen(false)
      setFileSearchOpen(true)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    // Ignore key events during IME composition (e.g. Chinese input method)
    if (event.nativeEvent.isComposing) return

    // Route file search navigation keys to FileSearchMenu
    if (fileSearchOpen) {
      const key = event.key
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === 'Tab' || key === 'Escape') {
        event.preventDefault()
        if (key === 'Escape') {
          setFileSearchOpen(false)
          setAtFilter('')
          setAtCursorPos(-1)
          return
        }
        fileSearchRef.current?.handleKeyDown(event.nativeEvent)
        return
      }
      return
    }

    if (slashMenuOpen && filteredCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashSelectedIndex((prev) => (prev + 1) % filteredCommands.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (
          event.key === 'Enter' &&
          exactSlashCommand &&
          slashFilter.trim().toLowerCase() === exactSlashCommand.name.toLowerCase()
        ) {
          event.preventDefault()
          void handleSubmit()
          return
        }
        event.preventDefault()
        const selected = filteredCommands[slashSelectedIndex]
        if (selected) selectSlashCommand(selected.name)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashMenuOpen(false)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSubmit()
    }
  }

  const handlePaste = (event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items
    if (!items) return

    let hasImage = false
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (!item || !item.type.startsWith('image/')) continue

      hasImage = true
      event.preventDefault()
      const file = item.getAsFile()
      if (!file) continue
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const reader = new FileReader()
      reader.onload = () => {
        setAttachments((prev) => [
          ...prev,
          {
            id,
            name: `pasted-image-${Date.now()}.png`,
            type: 'image',
            mimeType: file.type || undefined,
            previewUrl: reader.result as string,
            data: reader.result as string,
          },
        ])
      }
      reader.readAsDataURL(file)
    }

    if (!hasImage) return
  }

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files) return

    Array.from(files).forEach((file) => {
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const isImage = file.type.startsWith('image/')
      const reader = new FileReader()
      reader.onload = () => {
        setAttachments((prev) => [
          ...prev,
          {
            id,
            name: file.name,
            type: isImage ? 'image' : 'file',
            mimeType: file.type || undefined,
            previewUrl: isImage ? (reader.result as string) : undefined,
            data: reader.result as string,
          },
        ])
      }
      reader.readAsDataURL(file)
    })

    event.target.value = ''
  }

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const files = event.dataTransfer.files
    if (files.length > 0) {
      const fakeEvent = { target: { files } } as React.ChangeEvent<HTMLInputElement>
      handleFileSelect(fakeEvent)
    }
  }

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
  }

  const selectSlashCommand = (command: string) => {
    const el = textareaRef.current
    if (!el) return
    const cursorPos = el.selectionStart ?? input.length
    const replacement = replaceSlashCommand(input, cursorPos, command)
    if (!replacement) return
    setInput(replacement.value)
    setSlashMenuOpen(false)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(replacement.cursorPos, replacement.cursorPos)
    })
  }

  const insertSlashCommand = () => {
    const el = textareaRef.current
    const cursorPos = el?.selectionStart ?? input.length
    const replacement = insertSlashTrigger(input, cursorPos)
    setInput(replacement.value)
    setPlusMenuOpen(false)
    setSlashFilter('')
    setSlashMenuOpen(true)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(replacement.cursorPos, replacement.cursorPos)
    })
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-[var(--color-surface)]">
      <div className={`flex flex-1 flex-col items-center justify-center ${
        isMobileComposer ? 'px-6 pb-[230px] pt-10' : 'p-8 pb-32'
      }`}>
        <div className={`flex flex-col items-center text-center ${
          isMobileComposer ? 'max-w-[300px]' : 'max-w-md'
        }`}>
          <img
            src="/app-icon.png"
            alt="Claude Code Haha"
            className={isMobileComposer ? 'mb-4 h-16 w-16' : 'mb-6 h-24 w-24'}
          />
          <h1
            className={`mb-2 font-extrabold tracking-tight text-[var(--color-text-primary)] ${
              isMobileComposer ? 'text-2xl' : 'text-3xl'
            }`}
            style={{ fontFamily: 'var(--font-headline)' }}
          >
            {t('empty.title')}
          </h1>
          <p
            className={`mx-auto text-[var(--color-text-secondary)] ${
              isMobileComposer ? 'max-w-[280px] text-sm leading-6' : 'max-w-xs'
            }`}
            style={{ fontFamily: 'var(--font-body)' }}
          >
            {t('empty.subtitle')}
          </p>
        </div>
      </div>

      <div
        data-testid="empty-session-composer-shell"
        className={`absolute left-0 right-0 z-30 flex justify-center ${
        isMobileComposer
          ? 'bottom-0 px-3 pb-[calc(env(safe-area-inset-bottom)+10px)]'
          : 'bottom-4 px-8'
      }`}
      >
        <div className={`flex w-full flex-col ${isMobileComposer ? 'max-w-none' : 'max-w-3xl'}`}>
          <div
            data-testid="empty-session-composer-panel"
            className={`glass-panel relative flex flex-col gap-3 ${
              isMobileComposer ? 'rounded-2xl p-3 shadow-[0_-12px_36px_rgba(54,35,28,0.12)]' : 'rounded-t-xl rounded-b-none p-4'
            }`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            {fileSearchOpen && (
              <FileSearchMenu
                ref={fileSearchRef}
                cwd={workDir || ''}
                filter={atFilter}
                onNavigate={(relativePath) => {
                  if (atCursorPos < 0) return
                  const replacement = `@${relativePath}`
                  const tokenEnd = atCursorPos + 1 + atFilter.length
                  const newValue = `${input.slice(0, atCursorPos)}${replacement}${input.slice(tokenEnd)}`
                  const newCursorPos = atCursorPos + replacement.length
                  setInput(newValue)
                  setAtFilter(relativePath)
                  requestAnimationFrame(() => {
                    textareaRef.current?.focus()
                    textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos)
                  })
                }}
                onSelect={(path, name) => {
                  if (atCursorPos >= 0) {
                    const attachmentName = name.split('/').filter(Boolean).pop() ?? name
                    const tokenEnd = atCursorPos + 1 + atFilter.length
                    const beforeToken = input.slice(0, atCursorPos)
                    const afterToken = beforeToken ? input.slice(tokenEnd) : input.slice(tokenEnd).replace(/^\s+/, '')
                    const spacer = beforeToken && afterToken && !/\s$/.test(beforeToken) && !/^\s/.test(afterToken) ? ' ' : ''
                    const newValue = `${beforeToken}${spacer}${afterToken}`
                    const newCursorPos = atCursorPos + spacer.length
                    setAttachments((prev) => [
                      ...prev,
                      {
                        id: `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                        name: attachmentName,
                        type: 'file',
                        path,
                      },
                    ])
                    setInput(newValue)
                    setFileSearchOpen(false)
                    setAtFilter('')
                    setAtCursorPos(-1)
                    void textareaRef.current?.focus()
                    requestAnimationFrame(() => {
                      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos)
                    })
                  }
                }}
              />
            )}

            {localSlashPanel && (
              <div ref={slashMenuRef}>
                <LocalSlashCommandPanel
                  command={localSlashPanel}
                  cwd={workDir || undefined}
                  commands={allSlashCommands}
                  onClose={() => setLocalSlashPanel(null)}
                />
              </div>
            )}

            {slashMenuOpen && filteredCommands.length > 0 && (
              <div
                ref={slashMenuRef}
                className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]"
              >
                <div className="max-h-[260px] overflow-y-auto py-1">
                  {filteredCommands.map((command, index) => (
                    <button
                      key={command.name}
                      ref={(el) => { slashItemRefs.current[index] = el }}
                      onClick={() => selectSlashCommand(command.name)}
                      onMouseEnter={() => setSlashSelectedIndex(index)}
                      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                        index === slashSelectedIndex ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      <span className="shrink-0 text-sm font-semibold text-[var(--color-text-primary)]">/{command.name}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-tertiary)]">{command.description}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {attachments.length > 0 && (
              <AttachmentGallery attachments={attachments} variant="composer" onRemove={removeAttachment} />
            )}

            <div className="flex items-start gap-3">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => handleInputChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                className={`flex-1 resize-none border-none bg-transparent leading-relaxed text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] ${
                  isMobileComposer ? 'max-h-[132px] min-h-[72px] py-1.5 text-base' : 'py-2'
                }`}
                style={{ fontFamily: 'var(--font-body)' }}
                placeholder={t('empty.placeholder')}
                rows={2}
              />
            </div>

            <div className={`border-t border-[var(--color-border-separator)] pt-3 ${
              isMobileComposer ? 'flex flex-wrap items-center gap-2' : 'flex items-center justify-between'
            }`}>
              <div className="flex shrink-0 items-center gap-2">
                <div ref={plusMenuRef} className="relative">
                  <button
                    onClick={() => setPlusMenuOpen((prev) => !prev)}
                    aria-label="Open composer tools"
                    className={`text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] ${
                      isMobileComposer ? 'inline-flex h-11 w-11 items-center justify-center rounded-xl' : 'rounded-lg p-1.5'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                  </button>

                  {plusMenuOpen && (
                    <div className={`absolute bottom-full left-0 mb-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1 shadow-[var(--shadow-dropdown)] ${
                      isMobileComposer ? 'w-[min(240px,calc(100vw-32px))]' : 'w-[240px]'
                    }`}>
                      <button
                        onClick={() => {
                          fileInputRef.current?.click()
                          setPlusMenuOpen(false)
                        }}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
                      >
                        <span className="material-symbols-outlined text-[18px] text-[var(--color-text-secondary)]">attach_file</span>
                        {t('empty.addFiles')}
                      </button>
                      <button
                        onClick={insertSlashCommand}
                        className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
                      >
                        <span className="w-5 text-center text-[18px] font-bold text-[var(--color-text-secondary)]">/</span>
                        {t('empty.slashCommands')}
                      </button>
                    </div>
                  )}
                </div>

                <PermissionModeSelector workDir={workDir} compact={isMobileComposer} />
              </div>

              <div className={`${isMobileComposer ? 'flex min-w-0 flex-1 items-center justify-end gap-2' : 'flex items-center gap-3'}`}>
                <ContextUsageIndicator
                  chatState="idle"
                  messageCount={0}
                  runtimeSelectionKey={draftRuntimeSelectionKey}
                  fallbackModelLabel={draftModelLabel}
                  draft
                  compact={isMobileComposer}
                />
                <ModelSelector runtimeKey={DRAFT_RUNTIME_SELECTION_KEY} disabled={isSubmitting} compact={isMobileComposer} />
                <button
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  aria-label={t('common.run')}
                  title={isMobileComposer ? t('common.run') : undefined}
                  className={`flex shrink-0 items-center justify-center gap-1 rounded-lg bg-[image:var(--gradient-btn-primary)] text-xs font-semibold text-[var(--color-btn-primary-fg)] shadow-[var(--shadow-button-primary)] transition-all hover:brightness-105 disabled:opacity-30 ${
                    isMobileComposer ? 'h-11 w-11 rounded-xl px-0 py-0' : 'w-[112px] px-3 py-1.5'
                  }`}
                >
                  {!isMobileComposer && t('common.run')}
                  <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                </button>
              </div>
            </div>
          </div>

          {!IS_WEB_BUILD && (
            <RepositoryLaunchControls
              workDir={workDir}
              onWorkDirChange={handleWorkDirChange}
              branch={selectedBranch}
              onBranchChange={setSelectedBranch}
              useWorktree={useWorktree}
              onUseWorktreeChange={setUseWorktree}
              onLaunchReadyChange={setRepositoryLaunchReady}
              disabled={isSubmitting}
            />
          )}
        </div>
      </div>

      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
    </div>
  )
}
