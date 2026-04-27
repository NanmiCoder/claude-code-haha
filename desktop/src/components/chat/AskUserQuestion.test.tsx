import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}))

vi.mock('../../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: sendMock,
  },
}))

vi.mock('../../api/sessions', () => ({
  sessionsApi: {
    getMessages: vi.fn(async () => ({ messages: [] })),
    getSlashCommands: vi.fn(async () => ({ commands: [] })),
  },
}))

import { AskUserQuestion } from './AskUserQuestion'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'

const ACTIVE_TAB = 'active-tab'

describe('AskUserQuestion', () => {
  beforeEach(() => {
    sendMock.mockReset()
    useTabStore.setState({
      activeTabId: ACTIVE_TAB,
      tabs: [{ sessionId: ACTIVE_TAB, title: 'Test', type: 'session', status: 'idle' }],
    })
    useChatStore.setState({
      sessions: {
        [ACTIVE_TAB]: {
          messages: [],
          chatState: 'permission_pending',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: {
            requestId: 'perm-1',
            toolName: 'AskUserQuestion',
            toolUseId: 'tool-1',
            input: {
              questions: [
                {
                  question: 'Should we persist data?',
                  options: [{ label: 'No' }, { label: 'Yes' }],
                },
              ],
            },
          },
          pendingComputerUsePermission: null,
          tokenUsage: { input_tokens: 0, output_tokens: 0 },
          elapsedSeconds: 0,
          statusVerb: '',
          slashCommands: [],
          agentTaskNotifications: {},
          elapsedTimer: null,
          showFullConversation: false,
        },
      },
    })
  })

  it('submits answers through permission_response updatedInput instead of sending a chat message', () => {
    render(
      <AskUserQuestion
        toolUseId="tool-1"
        input={{
          questions: [
            {
              question: 'Should we persist data?',
              options: [{ label: 'No' }, { label: 'Yes' }],
            },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^No$/ }))
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))

    expect(sendMock).toHaveBeenCalledWith(ACTIVE_TAB, {
      type: 'permission_response',
      requestId: 'perm-1',
      allowed: true,
      updatedInput: {
        questions: [
          {
            question: 'Should we persist data?',
            options: [{ label: 'No' }, { label: 'Yes' }],
          },
        ],
        answers: {
          'Should we persist data?': 'No',
        },
      },
    })
  })
})
