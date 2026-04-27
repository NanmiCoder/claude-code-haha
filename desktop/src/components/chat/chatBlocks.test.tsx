import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { PermissionDialog } from './PermissionDialog'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'

describe('chat blocks', () => {
  beforeEach(() => {
    useTabStore.setState({ activeTabId: 'active-tab', tabs: [{ sessionId: 'active-tab', title: 'Test', type: 'session' as const, status: 'idle' }] })
    useChatStore.setState({ sessions: {} })
  })

  it('keeps thinking collapsed by default', () => {
    const { container } = render(<ThinkingBlock content="this is a long internal reasoning trace" isActive />)

    expect(screen.getByText(/Thinking/)).toBeTruthy()
    expect(container.textContent).toContain('this is a long internal reasoning trace')
    expect(container.querySelector('.thinking-cursor')).toBeNull()
  })

  it('does not animate inactive historical thinking blocks', () => {
    const { container } = render(<ThinkingBlock content="old reasoning" isActive={false} />)

    expect(container.querySelector('.thinking-inline-cursor')).toBeNull()
  })

  it('shows tool previews only after expanding the tool block', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="Read"
        input={{ file_path: '/tmp/example.ts', limit: 20 }}
        result={{ content: 'const answer = 42\nconsole.log(answer)', isError: false }}
      />,
    )

    expect(container.textContent).toContain('Read')
    expect(container.textContent).not.toContain('const answer = 42')

    fireEvent.click(screen.getByRole('button'))

    expect(container.textContent).toContain('Tool Input')
    expect(container.textContent).not.toContain('const answer = 42')
  })

  it('does not surface bash stdout in the transcript preview', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="Bash"
        input={{ command: 'ls -la', description: 'List files' }}
        result={{ content: 'file-a\nfile-b\nfile-c', isError: false }}
      />,
    )

    expect(container.textContent).toContain('Bash')
    expect(container.textContent).not.toContain('file-a')

    fireEvent.click(screen.getByRole('button'))

    expect(container.textContent).toContain('ls -la')
    expect(container.textContent).not.toContain('file-a')
  })

  it('shows a collapsed error summary for failed bash commands', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="Bash"
        input={{ command: 'git show 5016bc0 --no-stat', description: 'Show full diff of latest commit' }}
        result={{ content: 'fatal: unrecognized argument: --no-stat\nExit code 128', isError: true }}
      />,
    )

    expect(container.textContent).toContain('Bash')
    expect(container.textContent).toContain('fatal: unrecognized argument: --no-stat')
  })

  it('expands tool errors so full Computer Use gate messages are readable', () => {
    const { container } = render(
      <ToolCallBlock
        toolName="mcp__computer-use__left_click"
        input={{ coordinate: [120, 220] }}
        result={{
          content: '"Claude Code Haha" is not in the allowed applications and is currently in front. Take a new screenshot — it may have appeared since your last one.',
          isError: true,
        }}
      />,
    )

    expect(container.textContent).toContain('mcp__computer-use__left_click')
    expect(container.textContent).not.toContain('Take a new screenshot')

    fireEvent.click(screen.getByRole('button'))

    expect(container.textContent).toContain('Take a new screenshot')
    expect(container.textContent).toContain('allowed applications')
  })

  it('shows a diff preview for edit permission requests', () => {
    useChatStore.setState({
      sessions: {
        'active-tab': {
          messages: [],
          chatState: 'idle',
          connectionState: 'connected',
          streamingText: '',
          streamingToolInput: '',
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          pendingPermission: {
            requestId: 'perm-1',
            toolName: 'Edit',
            input: {
              file_path: '/tmp/example.ts',
              old_string: 'const count = 1',
              new_string: 'const count = 2',
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

    const { container } = render(
      <PermissionDialog
        requestId="perm-1"
        toolName="Edit"
        input={{
          file_path: '/tmp/example.ts',
          old_string: 'const count = 1',
          new_string: 'const count = 2',
        }}
      />,
    )

    expect(container.textContent).toContain('/tmp/example.ts')
    expect(container.textContent).toContain('Allow')
    // react-diff-viewer-continued uses styled-components tables that don't
    // fully render in jsdom, so we verify the DiffViewer wrapper is mounted
    expect(container.querySelector('[class*="rounded-[var(--radius-lg)]"]')).toBeTruthy()
  })
})
