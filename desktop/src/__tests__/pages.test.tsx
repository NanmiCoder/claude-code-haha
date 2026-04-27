import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { skillsApi } from '../api/skills'
import { mcpApi } from '../api/mcp'
import { useUIStore } from '../stores/uiStore'

vi.mock('../api/skills', () => ({
  skillsApi: {
    list: vi.fn(async () => ({ skills: [] })),
  },
}))

vi.mock('../api/mcp', () => ({
  mcpApi: {
    list: vi.fn(async () => ({ servers: [] })),
    status: vi.fn(async (name: string) => ({
      server: {
        name,
        scope: 'user',
        transport: 'http',
        enabled: true,
        status: 'connected',
        statusLabel: 'Connected',
        configLocation: 'User',
        summary: 'https://mcp.example.com/mcp',
        canEdit: true,
        canRemove: true,
        canReconnect: true,
        canToggle: true,
        config: { type: 'http', url: 'https://mcp.example.com/mcp', headers: {} },
      },
    })),
  },
}))

// Import all pages
import { EmptySession } from '../pages/EmptySession'
import { ActiveSession } from '../pages/ActiveSession'
import { AgentTeams } from '../pages/AgentTeams'
import { ScheduledTasks } from '../pages/ScheduledTasks'
import { ToolInspection } from '../pages/ToolInspection'

// Layout components (chrome is now here, not in pages)
import { Sidebar } from '../components/layout/Sidebar'
import { UserMessage } from '../components/chat/UserMessage'
import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTabStore } from '../stores/tabStore'

/**
 * Core rendering tests: content-only pages must render without crashing
 * and contain key structural elements from the prototype.
 */
describe('Content-only pages render without errors', () => {
  it('EmptySession slash picker includes dynamic skills before the first session starts', async () => {
    vi.mocked(skillsApi.list).mockResolvedValueOnce({
      skills: [
        {
          name: 'lark-mail',
          description: 'Draft, send, and search emails',
          source: 'user',
          userInvocable: true,
          contentLength: 120,
          hasDirectory: true,
        },
        {
          name: 'internal-only',
          description: 'Should stay hidden',
          source: 'user',
          userInvocable: false,
          contentLength: 60,
          hasDirectory: true,
        },
      ],
    })

    render(<EmptySession />)

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '/', selectionStart: 1 },
    })

    expect(await screen.findByText('/lark-mail')).toBeInTheDocument()
    expect(screen.getByText('/mcp')).toBeInTheDocument()
    expect(screen.getByText('/skills')).toBeInTheDocument()
    expect(screen.getByText('/help')).toBeInTheDocument()
    expect(screen.getByText('/plugin')).toBeInTheDocument()
    expect(screen.getByText('/context')).toBeInTheDocument()
    expect(screen.queryByText('/plugins')).not.toBeInTheDocument()
    expect(screen.queryByText('/internal-only')).not.toBeInTheDocument()
  })

  it('EmptySession renders mascot and composer', () => {
    const { container } = render(<EmptySession />)
    expect(container.querySelector('textarea')).toBeInTheDocument()
    expect(container.innerHTML).toContain('New session')
    expect(container.innerHTML).toContain('Ask anything')
  })

  it('EmptySession plus menu exposes uploads and slash commands before chat starts', () => {
    render(<EmptySession />)
    fireEvent.click(screen.getByRole('button', { name: 'Open composer tools' }))
    expect(screen.getByText('Add files or photos')).toBeInTheDocument()
    expect(screen.getByText('Slash commands')).toBeInTheDocument()
  })

  it('ActiveSession renders with chat components', () => {
    const SESSION_ID = 'test-active-session'
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
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
    const { container } = render(<ActiveSession />)
    // With empty messages, the hero is shown
    expect(container.innerHTML).toContain('New session')
    // ChatInput has a textarea
    const textarea = container.querySelector('textarea')
    expect(textarea).toBeInTheDocument()
    expect(textarea).toHaveAttribute('placeholder', 'Ask anything...')
    expect(textarea).toHaveAttribute('rows', '2')
    expect(container.innerHTML).not.toContain('Preview')
    // Cleanup
    useTabStore.setState({ tabs: [], activeTabId: null })
    useChatStore.setState({ sessions: {} })
  })

  it('ActiveSession keeps the compact composer once messages exist', () => {
    const SESSION_ID = 'test-active-session-with-messages'
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [{
            id: 'msg-1',
            type: 'user_text',
            content: 'hello',
            timestamp: Date.now(),
          }],
          chatState: 'idle',
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
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 1,
        projectPath: '',
        workDir: null,
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })

    render(<ActiveSession />)

    const textarea = screen.getByPlaceholderText('Ask Claude to edit, debug or explain...')
    expect(textarea).toHaveAttribute('rows', '1')

    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useChatStore.setState({ sessions: {} })
  })

  it('ActiveSession shows a single primary action button while a turn is active', () => {
    useTabStore.setState({ activeTabId: 'active-tab', tabs: [{ sessionId: 'active-tab', title: 'Test', type: 'session' as const, status: 'idle' }] })
    useChatStore.setState({
      sessions: {
        'active-tab': {
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
    render(<ActiveSession />)

    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument()
    useChatStore.setState({ sessions: {} })
  })

  it('ActiveSession opens a local /mcp panel and clicking an item routes to settings', async () => {
    const SESSION_ID = 'mcp-panel-session'
    const sendMessage = vi.fn()
    vi.mocked(mcpApi.list).mockResolvedValueOnce({
      servers: [
        {
          name: 'deepwiki',
          scope: 'user',
          transport: 'http',
          enabled: true,
          status: 'connected',
          statusLabel: 'Connected',
          configLocation: '/tmp/config',
          summary: 'https://mcp.deepwiki.com/mcp',
          canEdit: true,
          canRemove: true,
          canReconnect: true,
          canToggle: true,
          config: { type: 'http', url: 'https://mcp.deepwiki.com/mcp', headers: {} },
        },
      ],
    })
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
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
      sendMessage,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/mcp', selectionStart: 4 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(await screen.findByText('Available MCP tools')).toBeInTheDocument()
    fireEvent.click(screen.getByText('deepwiki'))
    expect(useTabStore.getState().activeTabId).toBe('__settings__')
    expect(useUIStore.getState().pendingSettingsTab).toBe('mcp')

    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useChatStore.setState({ sessions: {} })
  })

  it('ActiveSession opens a local /skills panel from the fallback slash commands', async () => {
    const SESSION_ID = 'skills-panel-session'
    const sendMessage = vi.fn()
    vi.mocked(skillsApi.list).mockResolvedValueOnce({
      skills: [
        {
          name: 'lark-mail',
          description: 'Draft, send, and search emails',
          source: 'user',
          userInvocable: true,
          contentLength: 120,
          hasDirectory: true,
        },
      ],
    })
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
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
      sendMessage,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/skills', selectionStart: 7 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(await screen.findByText('Available skills')).toBeInTheDocument()
    expect(screen.getByText('/lark-mail')).toBeInTheDocument()

    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useChatStore.setState({ sessions: {} })
  })

  it('ActiveSession routes /plugin to Settings > Plugins instead of sending a chat message', () => {
    const SESSION_ID = 'plugin-panel-session'
    const sendMessage = vi.fn()
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
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
      sendMessage,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/plugin', selectionStart: 7 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(useTabStore.getState().activeTabId).toBe('__settings__')
    expect(useUIStore.getState().pendingSettingsTab).toBe('plugins')

    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useChatStore.setState({ sessions: {} })
  })

  it('ActiveSession routes /help to the local command panel', () => {
    const SESSION_ID = 'help-panel-session'
    const sendMessage = vi.fn()
    useTabStore.setState({ tabs: [{ sessionId: SESSION_ID, title: 'Test', type: 'session' as const, status: 'idle' }], activeTabId: SESSION_ID })
    useSessionStore.setState({
      sessions: [{
        id: SESSION_ID,
        title: 'Test',
        createdAt: '2026-04-10T00:00:00.000Z',
        modifiedAt: '2026-04-10T00:00:00.000Z',
        messageCount: 0,
        projectPath: '/workspace/project',
        workDir: '/workspace/project',
        workDirExists: true,
      }],
      activeSessionId: SESSION_ID,
      isLoading: false,
      error: null,
    })
    useChatStore.setState({
      sessions: {
        [SESSION_ID]: {
          messages: [],
          chatState: 'idle',
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
          slashCommands: [
            { name: 'cost', description: 'Show token usage and costs' },
            ...Array.from({ length: 14 }, (_, index) => ({
              name: `extra-${index + 1}`,
              description: `Extra command ${index + 1}`,
            })),
          ],
          agentTaskNotifications: {},
          elapsedTimer: null,
        },
      },
      sendMessage,
    })

    render(<ActiveSession />)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '/help', selectionStart: 5 } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(screen.getByText('Slash commands')).toBeInTheDocument()
    expect(screen.getByText('/clear')).toBeInTheDocument()
    expect(screen.getByText('/cost')).toBeInTheDocument()
    expect(screen.getByText('13 more commands available. Type / to search the full command list.')).toBeInTheDocument()

    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
    useChatStore.setState({ sessions: {} })
  })

  it('AgentTeams renders team strip and members', () => {
    const { container } = render(<AgentTeams />)
    expect(container.innerHTML).toContain('Architect')
    expect(container.innerHTML).toContain('session-dev')
    expect(container.innerHTML).toContain('groups')
  })

  it('ScheduledTasks renders (store-connected)', async () => {
    const { container } = render(<ScheduledTasks />)
    await screen.findByText('Scheduled tasks')
    expect(container.innerHTML).toContain('Scheduled tasks')
  })

  it('ToolInspection renders diff viewer', () => {
    const { container } = render(<ToolInspection />)
    expect(container.innerHTML).toContain('edit_file')
    expect(container.innerHTML).toContain('Split')
    expect(container.innerHTML).toContain('Unified')
  })
})

describe('Chat attachments', () => {
  it('UserMessage opens image gallery when an attachment is clicked', () => {
    render(
      <UserMessage
        content=""
        attachments={[
          {
            type: 'image',
            name: 'diagram.png',
            data: 'data:image/png;base64,abc123',
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('diagram.png')).toBeInTheDocument()
  })
})

describe('AppShell layout renders chrome', () => {
  it('AppShell renders sidebar and session shell', () => {
    const { container } = render(<Sidebar />)
    expect(container.querySelector('aside')).toBeInTheDocument()
    expect(container.innerHTML).toContain('New session')
    expect(container.innerHTML).toContain('Scheduled')
    expect(container.innerHTML).toContain('All projects')
  })
})

describe('Design system compliance', () => {
  it('Pages use Material Symbols Outlined icons', () => {
    const pages = [EmptySession, AgentTeams, ToolInspection]
    for (const Page of pages) {
      const { container, unmount } = render(<Page />)
      const icons = container.querySelectorAll('.material-symbols-outlined')
      expect(icons.length).toBeGreaterThan(0)
      unmount()
    }
  })

  it('Current brand color is used in content pages', () => {
    const pages = [EmptySession]
    for (const Page of pages) {
      const { container, unmount } = render(<Page />)
      const html = container.innerHTML
      expect(
        html.includes('C47A5A') ||
        html.includes('8F482F') ||
        html.includes('var(--color-brand)') ||
        html.includes('bg-[var(--color-brand)]'),
      ).toBe(true)
      unmount()
    }
  })
})

describe('Mock data integration', () => {
  it('AgentTeams shows team members from mock data', () => {
    const { container } = render(<AgentTeams />)
    expect(container.innerHTML).toContain('Architect')
    expect(container.innerHTML).toContain('Frontend Dev')
    expect(container.innerHTML).toContain('Backend Dev')
    expect(container.innerHTML).toContain('Tester')
  })
})
