import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { startServer } from '../src/server/index.js'

type ServerMsg = {
  type: string
  [key: string]: unknown
}

const modelId = process.env.REPRO_MODEL_ID || 'MiniMax-M3'
const port = Number(process.env.REPRO_SERVER_PORT || 19747)
const baseUrl = `http://127.0.0.1:${port}`
const wsUrl = `ws://127.0.0.1:${port}`
const turnCount = Number(process.env.REPRO_TURNS || 12)
const chunkChars = Number(process.env.REPRO_CHUNK_CHARS || 120_000)
const turnTimeoutMs = Number(process.env.REPRO_TURN_TIMEOUT_MS || 240_000)
const postErrorGraceMs = Number(process.env.REPRO_POST_ERROR_GRACE_MS || 1500)
const existingSessionId = process.env.REPRO_SESSION_ID || ''
const runPrewarm = process.env.REPRO_PREWARM === '1'
const keepWorkDir = process.env.REPRO_KEEP_WORKDIR === '1'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeLongPrompt(turn: number): string {
  const seed =
    `Issue 247 long-context reproduction turn ${turn}. ` +
    'Only answer with exactly "OK". Do not summarize or analyze the filler. '
  const filler = (
    'Long context filler for MiniMax desktop-session reproduction. ' +
    'This text is intentionally repetitive and contains no instructions. '
  ).repeat(Math.ceil(chunkChars / 104))
  return `${seed}\n\n${filler.slice(0, chunkChars)}`
}

function summarizeMessage(msg: ServerMsg): Record<string, unknown> {
  if (msg.type === 'content_delta') {
    return { type: msg.type, textLength: String(msg.text ?? '').length }
  }
  if (msg.type === 'error') {
    return {
      type: msg.type,
      code: msg.code,
      retryable: msg.retryable,
      message: String(msg.message ?? '').slice(0, 1200),
    }
  }
  if (msg.type === 'message_complete') {
    return { type: msg.type, usage: msg.usage }
  }
  if (msg.type === 'status') {
    return { type: msg.type, state: msg.state, verb: msg.verb }
  }
  if (msg.type === 'system_notification') {
    return { type: msg.type, subtype: msg.subtype, message: msg.message }
  }
  return { type: msg.type }
}

async function createSession(workDir: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workDir }),
  })
  if (!res.ok) {
    throw new Error(`create session failed: ${res.status} ${await res.text()}`)
  }
  const body = await res.json() as { sessionId: string }
  return body.sessionId
}

async function fetchDiagnostics(sessionId: string) {
  const res = await fetch(`${baseUrl}/api/diagnostics/events?limit=200`)
  if (!res.ok) return []
  const body = await res.json() as { events?: Array<Record<string, unknown>> }
  return (body.events ?? []).filter((event) => event.sessionId === sessionId)
}

async function resolveProviderId(): Promise<string> {
  if (process.env.REPRO_PROVIDER_ID) return process.env.REPRO_PROVIDER_ID

  const res = await fetch(`${baseUrl}/api/providers`)
  if (!res.ok) {
    throw new Error(`list providers failed: ${res.status} ${await res.text()}`)
  }
  const body = await res.json() as {
    providers?: Array<{ id: string; name: string; presetId?: string }>
  }
  const provider = (body.providers ?? []).find((entry) =>
    entry.presetId === 'minimax' ||
    entry.name.toLowerCase() === 'minimax' ||
    entry.name.toLowerCase().includes('minimax')
  )
  if (!provider) {
    throw new Error('MiniMax provider not found. Set REPRO_PROVIDER_ID to a configured provider id.')
  }
  return provider.id
}

async function connect(sessionId: string): Promise<{
  ws: WebSocket
  messages: ServerMsg[]
  waitForConnected: () => Promise<void>
  sendTurn: (content: string) => Promise<ServerMsg[]>
  collectSince: (index: number, waitMs: number) => Promise<ServerMsg[]>
  close: () => void
}> {
  const messages: ServerMsg[] = []
  let connectedResolve: (() => void) | null = null
  let connectedReject: ((err: Error) => void) | null = null
  let turnResolve: ((value: ServerMsg[]) => void) | null = null
  let turnReject: ((err: Error) => void) | null = null
  let turnStartIndex = 0
  let turnTimer: ReturnType<typeof setTimeout> | null = null

  const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as ServerMsg
    messages.push(msg)
    if (msg.type === 'connected') {
      connectedResolve?.()
      connectedResolve = null
    }
    if (turnResolve && (msg.type === 'message_complete' || msg.type === 'error')) {
      if (turnTimer) clearTimeout(turnTimer)
      const batch = messages.slice(turnStartIndex)
      const resolve = turnResolve
      turnResolve = null
      turnReject = null
      resolve(batch)
    }
  }
  ws.onerror = () => {
    const err = new Error(`WebSocket error for ${sessionId}`)
    connectedReject?.(err)
    turnReject?.(err)
  }
  ws.onclose = () => {
    if (turnResolve) {
      if (turnTimer) clearTimeout(turnTimer)
      const batch = messages.slice(turnStartIndex)
      const resolve = turnResolve
      turnResolve = null
      turnReject = null
      resolve(batch)
    }
  }

  return {
    ws,
    messages,
    waitForConnected() {
      if (messages.some((msg) => msg.type === 'connected')) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        connectedResolve = resolve
        connectedReject = reject
        setTimeout(() => reject(new Error(`Timed out waiting for connected ${sessionId}`)), 10_000)
      })
    },
    sendTurn(content: string) {
      if (turnResolve) throw new Error('turn already in flight')
      turnStartIndex = messages.length
      ws.send(JSON.stringify({ type: 'user_message', content }))
      return new Promise<ServerMsg[]>((resolve, reject) => {
        turnResolve = resolve
        turnReject = reject
        turnTimer = setTimeout(() => {
          turnResolve = null
          turnReject = null
          reject(new Error(`Timed out waiting for terminal turn event after ${turnTimeoutMs}ms`))
        }, turnTimeoutMs)
      })
    },
    async collectSince(index: number, waitMs: number) {
      await sleep(waitMs)
      return messages.slice(index)
    },
    close() {
      ws.close()
    },
  }
}

async function main() {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-issue-247-real-'))
  const server = startServer(port, '127.0.0.1')
  await sleep(500)

  try {
    const providerId = await resolveProviderId()
    const sessionId = existingSessionId || await createSession(workDir)
    console.log(JSON.stringify({
      event: 'start',
      sessionId,
      workDir,
      providerId,
      modelId,
      turnCount,
      chunkChars,
      disableCompact: process.env.DISABLE_COMPACT === '1',
      existingSession: Boolean(existingSessionId),
      runPrewarm,
      keepWorkDir,
    }))

    const client = await connect(sessionId)
    await client.waitForConnected()
    client.ws.send(JSON.stringify({ type: 'set_runtime_config', providerId, modelId }))
    await sleep(250)

    if (runPrewarm) {
      const startIndex = client.messages.length
      client.ws.send(JSON.stringify({ type: 'prewarm_session' }))
      const batch = await client.collectSince(startIndex, 5000)
      console.log(JSON.stringify({
        event: 'prewarm',
        messageTypes: batch.map((msg) => msg.type),
        messages: batch.map(summarizeMessage),
      }))
    }

    for (let turn = 1; !runPrewarm && turn <= turnCount; turn++) {
      const startedAt = Date.now()
      const batch = await client.sendTurn(makeLongPrompt(turn))
      const errors = batch.filter((msg) => msg.type === 'error')
      const completions = batch.filter((msg) => msg.type === 'message_complete')
      console.log(JSON.stringify({
        event: 'turn',
        turn,
        durationMs: Date.now() - startedAt,
        messageTypes: batch.map((msg) => msg.type),
        errors: errors.map(summarizeMessage),
        completions: completions.map(summarizeMessage),
      }))
      if (errors.length > 0) {
        await sleep(postErrorGraceMs)
        console.log(JSON.stringify({
          event: 'post_error_messages',
          turn,
          recent: client.messages.slice(-12).map(summarizeMessage),
        }))
        break
      }
    }

    client.close()
    await sleep(1000)

    const resumeClient = await connect(sessionId)
    await resumeClient.waitForConnected()
    resumeClient.ws.send(JSON.stringify({ type: 'set_runtime_config', providerId, modelId }))
    await sleep(250)
    try {
      const batch = await resumeClient.sendTurn('Continue with exactly "OK".')
      await sleep(postErrorGraceMs)
      console.log(JSON.stringify({
        event: 'resume_turn',
        messageTypes: resumeClient.messages.slice(1).map((msg) => msg.type),
        errors: resumeClient.messages.filter((msg) => msg.type === 'error').map(summarizeMessage),
        completions: resumeClient.messages.filter((msg) => msg.type === 'message_complete').map(summarizeMessage),
        recent: resumeClient.messages.slice(-12).map(summarizeMessage),
      }))
    } finally {
      resumeClient.close()
    }

    const diagnostics = await fetchDiagnostics(sessionId)
    console.log(JSON.stringify({
      event: 'diagnostics',
      count: diagnostics.length,
      events: diagnostics.map((event) => ({
        timestamp: event.timestamp,
        type: event.type,
        severity: event.severity,
        summary: String(event.summary ?? '').slice(0, 1200),
      })),
    }))
  } finally {
    server.stop(true)
    if (!keepWorkDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: 'fatal',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }))
  process.exit(1)
})
  .then(() => process.exit(0))
