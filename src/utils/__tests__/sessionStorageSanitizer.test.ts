import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  enqueueSessionEntryAfterPendingForTesting,
  flushSessionStorage,
  resetProjectForTesting,
} from '../sessionStorage.js'
import type { CustomTitleMessage } from '../../types/logs.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `session-storage-flush-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe('sessionStorage flush', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetProjectForTesting()
  })

  afterEach(async () => {
    resetProjectForTesting()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('drains writes that are queued by pending operations during flush', async () => {
    const transcriptPath = path.join(tmpDir, 'late-enqueue.jsonl')
    const entry: CustomTitleMessage = {
      type: 'custom-title',
      customTitle: 'late enqueue',
      sessionId: '11111111-1111-4111-8111-111111111111',
    }
    const writePromise = enqueueSessionEntryAfterPendingForTesting(
      transcriptPath,
      entry,
      10,
    )

    await flushSessionStorage()
    await writePromise

    const content = await fs.readFile(transcriptPath, 'utf-8')
    expect(content).toContain('"customTitle":"late enqueue"')
  })
})

describe('sanitizeJsonlReplacer', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetProjectForTesting()
  })

  afterEach(async () => {
    resetProjectForTesting()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('removes null bytes from tool output', async () => {
    const transcriptPath = path.join(tmpDir, 'sanitize-null.jsonl')
    // Simulate a tool_result with embedded null bytes (like cat /usr/bin/ls)
    const entry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: {
              command: 'cat /usr/bin/ls',
              stdout: '\x00\x00\x00ELF\x00\x00\x01\x02\x00',
              stderr: '',
            },
          },
        ],
      },
      sessionId: '22222222-2222-4222-8222-222222222222',
      timestamp: new Date().toISOString(),
      version: 'test',
    }
    const writePromise = enqueueSessionEntryAfterPendingForTesting(
      transcriptPath,
      entry,
      10,
    )
    await flushSessionStorage()
    await writePromise

    // Read the file as raw bytes
    const raw = await fs.readFile(transcriptPath, 'utf-8')
    expect(raw).not.toContain('\x00')

    // Verify the line is valid JSON
    const line = raw.trim()
    const parsed = JSON.parse(line)
    expect(parsed.message.content[0].input.stdout).toContain('[U+0000]')
    expect(parsed.message.content[0].input.stdout).toContain('ELF')
  })

  it('preserves newlines, carriage returns, and tabs', async () => {
    const transcriptPath = path.join(tmpDir, 'sanitize-preserve.jsonl')
    const entry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: {
              stdout: 'line1\nline2\r\nline3\ttabbed',
            },
          },
        ],
      },
      sessionId: '33333333-3333-4333-8333-333333333333',
      timestamp: new Date().toISOString(),
      version: 'test',
    }
    const writePromise = enqueueSessionEntryAfterPendingForTesting(
      transcriptPath,
      entry,
      10,
    )
    await flushSessionStorage()
    await writePromise

    const raw = await fs.readFile(transcriptPath, 'utf-8')
    const parsed = JSON.parse(raw.trim())
    expect(parsed.message.content[0].input.stdout).toBe(
      'line1\nline2\r\nline3\ttabbed',
    )
  })

  it('handles mixed control characters', async () => {
    const transcriptPath = path.join(tmpDir, 'sanitize-mixed.jsonl')
    const entry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: {
              stdout: 'Hello\x00World\x01\x02\x03OK\nEnd',
            },
          },
        ],
      },
      sessionId: '44444444-4444-4444-8444-444444444444',
      timestamp: new Date().toISOString(),
      version: 'test',
    }
    const writePromise = enqueueSessionEntryAfterPendingForTesting(
      transcriptPath,
      entry,
      10,
    )
    await flushSessionStorage()
    await writePromise

    const raw = await fs.readFile(transcriptPath, 'utf-8')
    expect(raw).not.toContain('\x00')
    expect(raw).not.toContain('\x01')
    expect(raw).not.toContain('\x02')
    expect(raw).not.toContain('\x03')

    const parsed = JSON.parse(raw.trim())
    expect(parsed.message.content[0].input.stdout).toContain('[U+0000]')
    expect(parsed.message.content[0].input.stdout).toContain('[U+0001]')
    expect(parsed.message.content[0].input.stdout).toContain('[U+0002]')
    expect(parsed.message.content[0].input.stdout).toContain('[U+0003]')
    // Newline should be preserved
    expect(parsed.message.content[0].input.stdout).toContain('\n')
  })

  it('handles real ELF binary output', async () => {
    // Read an actual binary file and inject it
    const elfRaw = await fs.readFile('/usr/bin/ls')
    const elfStr = elfRaw.toString('binary') // Convert to string preserving all bytes

    const transcriptPath = path.join(tmpDir, 'sanitize-elf.jsonl')
    const entry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: {
              command: 'cat /usr/bin/ls',
              stdout: elfStr,
              stderr: '',
            },
          },
        ],
      },
      sessionId: '55555555-5555-4555-8555-555555555555',
      timestamp: new Date().toISOString(),
      version: 'test',
    }
    const writePromise = enqueueSessionEntryAfterPendingForTesting(
      transcriptPath,
      entry,
      10,
    )
    await flushSessionStorage()
    await writePromise

    // Verify no null bytes in output file
    const raw = await fs.readFile(transcriptPath)
    expect(raw.includes(Buffer.from('\x00'))).toBe(false)

    // Verify the line is valid JSON
    const rawStr = raw.toString('utf-8')
    expect(() => JSON.parse(rawStr.trim())).not.toThrow()
  })
})
