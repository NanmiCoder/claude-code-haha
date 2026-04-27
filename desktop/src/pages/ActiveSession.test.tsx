import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { act } from 'react'

vi.mock('../components/chat/MessageList', () => ({
  MessageList: () => <div data-testid="message-list" />,
}))

vi.mock('../components/chat/ChatInput', () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}))

vi.mock('../components/teams/TeamStatusBar', () => ({
  TeamStatusBar: () => <div data-testid="team-status-bar" />,
}))

vi.mock('../components/chat/SessionTaskBar', () => ({
  SessionTaskBar: () => <div data-testid="session-task-bar" />,
}))

import { ActiveSession } from './ActiveSession'
import { useChatStore } from '../stores/chatStore'
import { useCLITaskStore } from '../stores/cliTaskStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTabStore } from '../stores/tabStore'
import { useTeamStore } from '../stores/teamStore'

afterEach(() => {
  vi.useRealTimers()
  useTabStore.setState({ tabs: [], activeTabId: null })
  useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
  useChatStore.setState({ sessions: {} })
  useTeamStore.setState({ teams: [], activeTeam: null, memberColors: new Map(), error: null })
})

describe('ActiveSession task polling', () => {
  it('refreshes CLI tasks repeatedly while a turn is active', async () => {
    vi.useFakeTimers()

    const sessionId = 'polling-session'
    const originalCliTaskState = useCLITaskStore.getState()
    const fetchSessionTasks = vi.fn().mockResolvedValue(undefined)

    useCLITaskStore.setState({
      sessionId,
      tasks: [],
      fetchSessionTasks,
    })

    useSessionStore.setState({
      sessions: [{
        id: sessionId,
        title: 'Polling Session',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '',
        workDir: null,
        workDirExists: true,
      }],
      activeSessionId: sessionId,
      isLoading: false,
      error: null,
    })
    useTabStore.setState({
      tabs: [{ sessionId, title: 'Polling Session', type: 'session', status: 'idle' }],
      activeTabId: sessionId,
    })
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          messages: [],
          chatState: 'thinking',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
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

    const { unmount } = render(<ActiveSession />)

    expect(fetchSessionTasks).toHaveBeenCalledWith(sessionId)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200)
    })

    expect(
      fetchSessionTasks.mock.calls.filter(([currentSessionId]) => currentSessionId === sessionId),
    ).toHaveLength(4)

    unmount()
    useCLITaskStore.setState(originalCliTaskState)
  })

  it('keeps member sessions interactive and skips leader task polling', () => {
    const memberSessionId = 'team-member:security-reviewer@test-team'
    const originalCliTaskState = useCLITaskStore.getState()
    const fetchSessionTasks = vi.fn().mockResolvedValue(undefined)

    useCLITaskStore.setState({
      sessionId: null,
      tasks: [],
      fetchSessionTasks,
    })

    useTeamStore.setState({
      teams: [],
      activeTeam: {
        name: 'test-team',
        leadAgentId: 'team-lead@test-team',
        leadSessionId: 'leader-session',
        members: [
          {
            agentId: 'team-lead@test-team',
            role: 'team-lead',
            status: 'running',
            sessionId: 'leader-session',
          },
          {
            agentId: 'security-reviewer@test-team',
            role: 'security-reviewer',
            status: 'running',
          },
        ],
      },
      memberColors: new Map(),
      error: null,
    })

    useTabStore.setState({
      tabs: [{ sessionId: memberSessionId, title: 'security-reviewer', type: 'session', status: 'idle' }],
      activeTabId: memberSessionId,
    })

    useChatStore.setState({
      sessions: {
        [memberSessionId]: {
          messages: [],
          chatState: 'thinking',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: null,
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

    const { queryByTestId, unmount } = render(<ActiveSession />)

    expect(queryByTestId('chat-input')).toBeInTheDocument()
    expect(queryByTestId('session-task-bar')).not.toBeInTheDocument()
    expect(fetchSessionTasks).not.toHaveBeenCalled()

    unmount()
    useCLITaskStore.setState(originalCliTaskState)
  })
})
