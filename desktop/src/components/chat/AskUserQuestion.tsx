import { useMemo, useRef, useState } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import { Button } from '../shared/Button'

type QuestionOption = {
  label: string
  description?: string
}

type Question = {
  question: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

type AskUserInput = {
  questions?: Question[]
  question?: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

type Props = {
  sessionId?: string | null
  toolUseId: string
  input: unknown
  result?: unknown
}

/**
 * Parse the AskUserQuestion input which may come in different shapes.
 */
function parseInput(input: unknown): Question[] {
  if (!input || typeof input !== 'object') return []
  const obj = input as AskUserInput

  // Shape 1: { questions: [...] }
  if (Array.isArray(obj.questions)) {
    return obj.questions
  }

  // Shape 2: { question: "...", options: [...] }
  if (typeof obj.question === 'string') {
    return [{
      question: obj.question,
      header: obj.header,
      options: obj.options,
      multiSelect: obj.multiSelect,
    }]
  }

  return []
}

type QuestionSelections = Record<number, string[]>

function getSelectedAnswer(question: Question, selected: string[] | undefined) {
  if (!selected || selected.length === 0) return ''
  return question.multiSelect ? selected.join(', ') : selected[0] ?? ''
}

export function AskUserQuestion({ sessionId, toolUseId, input, result }: Props) {
  const { respondToPermission } = useChatStore()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const targetSessionId = sessionId ?? activeTabId
  const pendingPermission = useChatStore((s) => targetSessionId ? s.sessions[targetSessionId]?.pendingPermission : undefined)
  const t = useTranslation()
  const questions = parseInput(input)
  const inputObject = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const [activeTab, setActiveTab] = useState(0)
  const [selections, setSelections] = useState<QuestionSelections>({})
  const [freeTexts, setFreeTexts] = useState<Record<number, string>>({})
  const [hasSubmitted, setHasSubmitted] = useState(false)
  const composingRef = useRef(false)

  if (questions.length === 0) return null

  const resultAnswers = useMemo(() => {
    if (!result || typeof result !== 'object') return {}
    const answers = (result as { answers?: unknown }).answers
    return answers && typeof answers === 'object'
      ? answers as Record<string, string>
      : {}
  }, [result])

  const pendingRequest = pendingPermission?.toolUseId === toolUseId ? pendingPermission : null
  const answeredText = useMemo(() => {
    if (Object.keys(resultAnswers).length > 0) {
      return questions
        .map((question) => resultAnswers[question.question])
        .filter((answer): answer is string => typeof answer === 'string' && answer.trim().length > 0)
        .join(', ')
    }
    const textParts = questions.map((_q, i) => freeTexts[i]?.trim()).filter(Boolean)
    const selectParts = questions
      .map((question, i) => freeTexts[i]?.trim() ? '' : getSelectedAnswer(question, selections[i]))
      .filter(Boolean)
    return textParts.join('; ') + (textParts.length > 0 && selectParts.length > 0 ? '; ' : '') + selectParts.join('; ')
  }, [freeTexts, questions, resultAnswers, selections])
  const submitted = Object.keys(resultAnswers).length > 0 || hasSubmitted

  const handleSelect = (qIndex: number, label: string) => {
    if (submitted) return
    setSelections((prev) => {
      const question = questions[qIndex]
      const selected = prev[qIndex] ?? []
      if (question?.multiSelect) {
        const nextSelected = selected.includes(label)
          ? selected.filter((value) => value !== label)
          : [...selected, label]
        const next = { ...prev }
        if (nextSelected.length > 0) {
          next[qIndex] = nextSelected
        } else {
          delete next[qIndex]
        }
        return next
      }
      if (selected[0] === label) {
        const next = { ...prev }
        delete next[qIndex]
        return next
      }
      return { ...prev, [qIndex]: [label] }
    })
    setFreeTexts((prev) => { const next = { ...prev }; delete next[qIndex]; return next })
  }

  const handleSubmit = () => {
    if (submitted) return

    const parts: string[] = []
    for (let i = 0; i < questions.length; i++) {
      const text = freeTexts[i]?.trim()
      if (text) {
        parts.push(text)
      } else {
        const selected = getSelectedAnswer(questions[i]!, selections[i])
        if (selected) parts.push(selected)
      }
    }
    const response = parts.join('; ') || ''
    if (!response) return

    if (!targetSessionId || !pendingRequest) return

    const answers = questions.reduce<Record<string, string>>((acc, question, index) => {
      const text = freeTexts[index]?.trim()
      if (text) {
        acc[question.question] = text
      } else {
        const selected = getSelectedAnswer(question, selections[index])
        if (selected) acc[question.question] = selected
      }
      return acc
    }, {})

    setHasSubmitted(true)
    respondToPermission(targetSessionId, pendingRequest.requestId, true, {
      updatedInput: {
        ...inputObject,
        answers,
      },
    })
  }

  // All questions must be answered (via selection or free text) to enable submit
  const allAnswered = questions.every((_, i) =>
    (freeTexts[i]?.trim()?.length ?? 0) > 0 || (selections[i]?.length ?? 0) > 0
  )
  const safeActiveTab = Math.min(activeTab, questions.length - 1)
  const activeQuestion = questions[safeActiveTab]

  if (!activeQuestion) return null

  return (
    <div className={`mb-4 rounded-[var(--radius-lg)] border overflow-hidden ${
      submitted
        ? 'border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container-low)] opacity-70'
        : 'border-[var(--color-secondary)] bg-[var(--color-surface-container-lowest)]'
    }`}>
      {/* Header */}
      <div className={`flex items-center gap-3 px-4 py-3 ${
        submitted
          ? 'bg-[var(--color-surface-container-low)]'
          : 'bg-[var(--color-surface-container)]'
      }`}>
        <div className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] bg-[var(--color-secondary)]/10">
          <span className="material-symbols-outlined text-[18px] text-[var(--color-secondary)]">
            help
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t('question.needsInput')}
          </span>
          {submitted && (
            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]">
              {t('question.answered')}
            </span>
          )}
        </div>
      </div>

      {/* Question tabs — horizontal tab bar (only show when multiple questions) */}
      {questions.length > 1 && (
        <div className="flex px-4 border-b border-[var(--color-outline-variant)]/20 bg-[var(--color-surface-container-low)] overflow-x-auto">
          {questions.map((q, i) => {
            const isActive = safeActiveTab === i
            const isAnswered = (freeTexts[i]?.trim()?.length ?? 0) > 0 || (selections[i]?.length ?? 0) > 0
            const tabLabel = q.header || `Q${i + 1}`
            return (
              <button
                key={i}
                onClick={() => setActiveTab(i)}
                className={`relative flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium whitespace-nowrap transition-colors ${
                  isActive
                    ? 'text-[var(--color-secondary)]'
                    : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                {isAnswered && (
                  <span className="material-symbols-outlined text-[14px] text-[var(--color-success)]">check_circle</span>
                )}
                {tabLabel}
                {isActive && (
                  <div className="absolute bottom-0 left-2 right-2 h-[2px] bg-[var(--color-secondary)] rounded-t" />
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Active question content */}
      <div className="px-4 py-3">
        <p className="text-sm font-medium text-[var(--color-text-primary)] mb-3">
          {activeQuestion.question}
        </p>

        {/* Option cards */}
        {activeQuestion.options && activeQuestion.options.length > 0 && (
          <div className="space-y-2 mb-3">
            {activeQuestion.options.map((opt, optIndex) => {
              const isSelected = selections[safeActiveTab]?.includes(opt.label) ?? false
              const isMultiSelect = activeQuestion.multiSelect === true
              return (
                <button
                  key={optIndex}
                  onClick={() => handleSelect(safeActiveTab, opt.label)}
                  disabled={submitted}
                  className={`w-full text-left px-4 py-3 rounded-[var(--radius-md)] border transition-all duration-150 cursor-pointer ${
                    isSelected
                      ? 'border-[var(--color-secondary)] bg-[var(--color-secondary)]/8 ring-1 ring-[var(--color-secondary)]/30'
                      : 'border-[var(--color-outline-variant)]/40 bg-[var(--color-surface)] hover:border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-container-low)]'
                  } ${submitted ? 'cursor-default' : ''}`}
                >
                  <div className="flex items-start gap-3">
                    {/* Selection indicator */}
                    <div className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                      isSelected
                        ? 'border-[var(--color-secondary)] bg-[var(--color-secondary)]'
                        : 'border-[var(--color-outline)]'
                    } ${isMultiSelect ? 'rounded-[var(--radius-xs)]' : 'rounded-full'}`}>
                      {isSelected && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className={`text-sm font-medium ${
                        isSelected
                          ? 'text-[var(--color-secondary)]'
                          : 'text-[var(--color-text-primary)]'
                      }`}>
                        {opt.label}
                      </span>
                      {opt.description && (
                        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                          {opt.description}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {/* Free text input */}
        {!submitted && (
          <div>
            <label className="text-xs text-[var(--color-text-tertiary)] mb-1.5 block">
              {t('question.customResponse')}
            </label>
            <input
              type="text"
              value={freeTexts[safeActiveTab] ?? ''}
              onChange={(e) => {
                setFreeTexts((prev) => ({ ...prev, [safeActiveTab]: e.target.value }))
                if (e.target.value.trim()) {
                  setSelections((prev) => { const next = { ...prev }; delete next[safeActiveTab]; return next })
                }
              }}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false }}
              onKeyDown={(e) => {
                if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return
                if (e.key === 'Enter' && allAnswered) handleSubmit()
              }}
              placeholder={t('question.typePlaceholder')}
              className="w-full px-3 py-2 text-sm bg-[var(--color-surface)] border border-[var(--color-outline-variant)]/40 rounded-[var(--radius-md)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:outline-none focus:border-[var(--color-secondary)] focus:ring-1 focus:ring-[var(--color-secondary)]/30"
            />
          </div>
        )}

        {/* Submitted answer display */}
        {submitted && (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <span className="material-symbols-outlined text-[14px] text-[var(--color-success)]">check_circle</span>
            <span>
              {t('question.answeredPrefix')}<strong>{answeredText}</strong>
            </span>
          </div>
        )}
      </div>

      {/* Submit button */}
      {!submitted && (
        <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--color-outline-variant)]/20 bg-[var(--color-surface-container-low)]">
          <Button
            variant="primary"
            size="sm"
            disabled={!allAnswered || !pendingRequest}
            onClick={handleSubmit}
            icon={
              <span className="material-symbols-outlined text-[14px]">send</span>
            }
          >
            {t('question.submit')}
          </Button>
        </div>
      )}
    </div>
  )
}
