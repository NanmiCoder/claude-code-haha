/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

const BUN_VIRTUAL_PATH_MARKERS = ['/$bunfs/', '/~bun/']

export function isBunVirtualPath(candidatePath: string | null | undefined): boolean {
  if (!candidatePath) {
    return false
  }

  const normalized = candidatePath.replace(/\\/g, '/').toLowerCase()
  return BUN_VIRTUAL_PATH_MARKERS.some(marker => normalized.includes(marker))
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 * Bun compile loads the entry module from Bun's virtual filesystem
 * (`/$bunfs/...` on POSIX, `~BUN\\...` on Windows). `Bun.embeddedFiles`
 * alone is not sufficient because compiled binaries can still report an
 * empty embedded file list at runtime.
 */
export function isInBundledMode(): boolean {
  if (typeof Bun === 'undefined') {
    return false
  }

  return (
    isBunVirtualPath(process.argv[1]) ||
    (Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0)
  )
}
