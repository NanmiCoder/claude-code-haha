import { createHash } from 'node:crypto'
import { readFile, mkdir, access, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../../..')

// All runtime state lives in ~/.claude/.runtime. The setup API (or
// ensureRuntimeFiles below) populates requirements.txt and mac_helper.py here.
const runtimeStateRoot = path.join(getClaudeConfigHomeDir(), '.runtime')
const venvRoot = path.join(runtimeStateRoot, 'venv')
const installStampPath = path.join(runtimeStateRoot, 'requirements.sha256')

const PIP_INDEX_URL = 'https://pypi.tuna.tsinghua.edu.cn/simple/'
const PIP_TRUSTED_HOST = 'pypi.tuna.tsinghua.edu.cn'

const isWindows = process.platform === 'win32'

// Always read from ~/.claude/.runtime/ — works in both dev and bundled mode.
const requirementsPath = path.join(runtimeStateRoot, 'requirements.txt')
const helperFileName = isWindows ? 'win_helper.py' : 'mac_helper.py'
const helperPath = path.join(runtimeStateRoot, helperFileName)

let bootstrapPromise: Promise<void> | undefined

function getPythonCommandEnv(): NodeJS.ProcessEnv | undefined {
  if (!isWindows) return undefined
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  }
}

function pythonBinPath(): string {
  return isWindows
    ? path.join(venvRoot, 'Scripts', 'python.exe')
    : path.join(venvRoot, 'bin', 'python3')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function runOrThrow(file: string, args: string[], label: string): Promise<string> {
  const { code, stdout, stderr } = await execFileNoThrow(file, args, { useCwd: false })
  if (code !== 0) {
    throw new Error(`${label} failed with code ${code}: ${stderr || stdout || 'unknown error'}`)
  }
  return stdout
}

/**
 * Ensure runtime source files exist in ~/.claude/.runtime/.
 * In dev mode, copies from the project's runtime/ directory on first run.
 * In bundled mode, these must have been placed there by the settings setup API.
 */
async function ensureRuntimeFiles(): Promise<void> {
  await mkdir(runtimeStateRoot, { recursive: true })

  const devReqFile = isWindows ? 'requirements-win.txt' : 'requirements.txt'
  const devRequirements = path.join(projectRoot, 'runtime', devReqFile)
  const devHelper = path.join(projectRoot, 'runtime', helperFileName)

  // Always sync from dev runtime/ so source changes are reflected immediately.
  // Previously this only copied when the dest was missing, causing stale files
  // to persist after source updates — breaking mouse/keyboard actions if the
  // cached copy was from an older version.
  if (await pathExists(devRequirements)) {
    await writeFile(requirementsPath, await readFile(devRequirements, 'utf8'), 'utf8')
  }
  if (await pathExists(devHelper)) {
    await writeFile(helperPath, await readFile(devHelper, 'utf8'), 'utf8')
  }
}

export async function ensureBootstrapped(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise
  bootstrapPromise = (async () => {
    // Extract runtime files (requirements.txt, mac_helper.py) to state dir
    await ensureRuntimeFiles()

    if (!(await pathExists(pythonBinPath()))) {
      logForDebugging('creating runtime venv at %s', { level: 'debug' })
      const pythonCmd = isWindows ? 'python' : 'python3'
      await runOrThrow(pythonCmd, ['-m', 'venv', venvRoot], 'python venv creation')
    }

    const pipBin = isWindows
      ? path.join(venvRoot, 'Scripts', 'pip.exe')
      : path.join(venvRoot, 'bin', 'pip')
    if (!(await pathExists(pipBin))) {
      logForDebugging('bootstrapping pip with ensurepip', { level: 'debug' })
      await runOrThrow(pythonBinPath(), ['-m', 'ensurepip', '--upgrade'], 'ensurepip')
    }

    const requirements = await readFile(requirementsPath, 'utf8')
    const digest = createHash('sha256').update(requirements).digest('hex')
    let installedDigest = ''
    try {
      installedDigest = (await readFile(installStampPath, 'utf8')).trim()
    } catch {}

    if (installedDigest !== digest) {
      logForDebugging('installing python runtime dependencies', { level: 'debug' })
      await runOrThrow(pythonBinPath(), [
        '-m', 'pip', 'install', '--upgrade', 'pip',
        '-i', PIP_INDEX_URL, '--trusted-host', PIP_TRUSTED_HOST,
      ], 'pip upgrade')
      await runOrThrow(
        pythonBinPath(),
        ['-m', 'pip', 'install', '-r', requirementsPath,
         '-i', PIP_INDEX_URL, '--trusted-host', PIP_TRUSTED_HOST],
        'python dependency install',
      )
      await writeFile(installStampPath, `${digest}\n`, 'utf8')
    }
  })()

  try {
    await bootstrapPromise
  } catch (error) {
    bootstrapPromise = undefined
    throw error
  }
}

export async function callPythonHelper<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  await ensureBootstrapped()
  const { code, stdout, stderr } = await execFileNoThrow(
    pythonBinPath(),
    [helperPath, command, '--payload', JSON.stringify(payload)],
    { useCwd: false, env: getPythonCommandEnv() },
  )

  if (code !== 0 && !stdout.trim()) {
    throw new Error(stderr || `Python helper ${command} failed with code ${code}`)
  }

  let parsed: { ok: boolean; result?: T; error?: { message?: string } }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(stderr || stdout || `Python helper ${command} returned invalid JSON`)
  }

  if (!parsed.ok) {
    throw new Error(parsed.error?.message || `Python helper ${command} failed`)
  }

  return parsed.result as T
}

export function getRuntimePaths(): { projectRoot: string; runtimeStateRoot: string; venvRoot: string } {
  return { projectRoot, runtimeStateRoot, venvRoot }
}
