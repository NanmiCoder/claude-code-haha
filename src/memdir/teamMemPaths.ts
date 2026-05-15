import { lstat, realpath } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getErrnoCode } from '../utils/errors.js'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'

/**
 * 当路径校验检测到路径穿越或注入尝试时抛出的错误。
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathTraversalError'
  }
}

/**
 * 通过拒绝危险模式来清理文件路径键。
 * 检查空字节、URL 编码的路径穿越以及其他注入向量。
 * 返回清理后的字符串，或抛出 PathTraversalError。
 */
function sanitizePathKey(key: string): string {
  // 空字节会在基于 C 的系统调用中截断路径
  if (key.includes('\0')) {
    throw new PathTraversalError(`Null byte in path key: "${key}"`)
  }
  // URL 编码的路径穿越（例如 %2e%2e%2f = ../）
  let decoded: string
  try {
    decoded = decodeURIComponent(key)
  } catch {
    // 百分号编码格式损坏（例如 %ZZ、单独的 %）——这不是合法的 URL 编码，
    // 因此不存在 URL 编码的穿越可能
    decoded = key
  }
  if (decoded !== key && (decoded.includes('..') || decoded.includes('/'))) {
    throw new PathTraversalError(`URL-encoded traversal in path key: "${key}"`)
  }
  // Unicode 规范化攻击：全角 ．．／（U+FF0E U+FF0F）在 NFKC 下会规范化
  // 为 ASCII 的 ../。虽然 path.resolve/fs.writeFile 会把它们当作
  // 字面字节（不是分隔符），下游层或文件系统仍可能做规范化——为纵深防御起见直接拒绝（PSR M22187 vector 4）。
  const normalized = key.normalize('NFKC')
  if (
    normalized !== key &&
    (normalized.includes('..') ||
      normalized.includes('/') ||
      normalized.includes('\\') ||
      normalized.includes('\0'))
  ) {
    throw new PathTraversalError(
      `Unicode-normalized traversal in path key: "${key}"`,
    )
  }
  // 拒绝反斜杠（Windows 路径分隔符可被用作穿越向量）
  if (key.includes('\\')) {
    throw new PathTraversalError(`Backslash in path key: "${key}"`)
  }
  // 拒绝绝对路径
  if (key.startsWith('/')) {
    throw new PathTraversalError(`Absolute path key: "${key}"`)
  }
  return key
}

/**
 * 是否启用 team memory 功能。
 * Team memory 是 auto memory 的子目录，因此要求 auto memory 已启用。
 * 这样可以让所有 team-memory 消费方（prompt、内容注入、sync watcher、
 * 文件检测）在通过环境变量或 settings 禁用 auto memory 时保持一致。
 */
export function isTeamMemoryEnabled(): boolean {
  if (!isAutoMemoryEnabled()) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', false)
}

/**
 * 返回 team memory 路径：<memoryBase>/projects/<sanitized-project-root>/memory/team/
 * 它作为 auto-memory 目录的子目录存在，并按项目做作用域隔离。
 */
export function getTeamMemPath(): string {
  return (join(getAutoMemPath(), 'team') + sep).normalize('NFC')
}

/**
 * 返回 team memory 入口文件：<memoryBase>/projects/<sanitized-project-root>/memory/team/MEMORY.md
 * 它作为 auto-memory 目录的子目录存在，并按项目做作用域隔离。
 */
export function getTeamMemEntrypoint(): string {
  return join(getAutoMemPath(), 'team', 'MEMORY.md')
}

/**
 * 为路径中最深的已存在祖先解析符号链接。
 * 目标文件可能尚不存在（我们可能正准备创建它），因此我们会沿目录树向上查找，
 * 直到 realpath() 成功，然后把不存在的尾部重新拼接到解析后的祖先上。
 *
 * SECURITY (PSR M22186)：path.resolve() 不会解析符号链接。攻击者如果能在
 * teamDir 内放置一个指向外部的符号链接（例如指向 ~/.ssh/authorized_keys），
 * 就能通过基于 resolve() 的包含关系检查。对最深的已存在祖先使用 realpath()
 * 可以确保我们比较的是实际文件系统位置，而不是符号路径。
 *
 */
async function realpathDeepestExisting(absolutePath: string): Promise<string> {
  const tail: string[] = []
  let current = absolutePath
  // 向上查找直到 realpath 成功。ENOENT 表示这个路径段还不存在；
  // 将其弹出到 tail 并尝试父目录。ENOTDIR 表示路径中间存在非目录组成部分；
  // 将其弹出后重试，这样我们就能对祖先做 realpath 以检测符号链接逃逸。
  // 当到达文件系统根目录时循环结束（dirname('/') === '/'）。
  for (
    let parent = dirname(current);
    current !== parent;
    parent = dirname(current)
  ) {
    try {
      const realCurrent = await realpath(current)
      // 按相反顺序重新拼接不存在的尾部（先拼接最深层、最先弹出的部分）
      return tail.length === 0
        ? realCurrent
        : join(realCurrent, ...tail.reverse())
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        // 这可能是真正不存在（可以安全继续向上），也可能是目标不存在的悬空符号链接。
        // 悬空符号链接是一种攻击向量：writeFile 会跟随该链接，在 teamDir 外部创建目标。
        // lstat 可以区分这两种情况：对悬空符号链接它会成功（链接项本身存在），
        // 而对真正不存在的路径则会返回 ENOENT。
        try {
          const st = await lstat(current)
          if (st.isSymbolicLink()) {
            throw new PathTraversalError(
              `Dangling symlink detected (target does not exist): "${current}"`,
            )
          }
          // lstat 成功但结果不是符号链接——说明 realpath 的 ENOENT 是由祖先路径中
          // 的悬空符号链接引起的。继续向上查找它。
        } catch (lstatErr: unknown) {
          if (lstatErr instanceof PathTraversalError) {
            throw lstatErr
          }
          // lstat 也失败了（确实不存在或无法访问）——可以安全继续向上。
        }
      } else if (code === 'ELOOP') {
        // 符号链接循环——文件系统状态已损坏或存在恶意构造。
        throw new PathTraversalError(
          `Symlink loop detected in path: "${current}"`,
        )
      } else if (code !== 'ENOTDIR' && code !== 'ENAMETOOLONG') {
        // EACCES、EIO 等——无法验证包含关系。通过包装成 PathTraversalError
        // 采取 fail closed，让调用方可以优雅地跳过这一项，
        // 而不是中止整个批次。
        throw new PathTraversalError(
          `Cannot verify path containment (${code}): "${current}"`,
        )
      }
      tail.push(current.slice(parent.length + sep.length))
      current = parent
    }
  }
  // 已到达文件系统根目录但仍未找到一个已存在的祖先（较少见——根目录通常存在）。
  // 回退到输入路径；后续包含关系检查会将其拒绝。
  return absolutePath
}

/**
 * 检查一个真实路径（已解析符号链接）是否位于真实的 team memory 目录内。
 * 两侧都会做 realpath，因此比较的是规范化后的文件系统位置。
 *
 * 如果 teamDir 不存在，则返回 true（跳过检查）。这仍然安全：
 * 符号链接逃逸要求在 teamDir 内预先存在一个符号链接，而这又要求 teamDir 已存在。
 * 如果目录都不存在，就不会有符号链接，第一遍基于字符串的包含关系检查就足够了。
 */
async function isRealPathWithinTeamDir(
  realCandidate: string,
): Promise<boolean> {
  let realTeamDir: string
  try {
    // getTeamMemPath() 自带尾部分隔符；先去掉它，因为某些平台上的
    // realpath() 会拒绝尾部分隔符。
    realTeamDir = await realpath(getTeamMemPath().replace(/[/\\]+$/, ''))
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Team 目录不存在——不可能发生符号链接逃逸，跳过检查。
      return true
    }
    // 意外错误（EACCES、EIO）——采取 fail closed。
    return false
  }
  if (realCandidate === realTeamDir) {
    return true
  }
  // 前缀攻击防护：要求前缀后面必须跟分隔符，这样
  // "/foo/team-evil" 就不会匹配 "/foo/team"。
  return realCandidate.startsWith(realTeamDir + sep)
}

/**
 * 检查解析后的绝对路径是否位于 team memory 目录内。
 * 使用 path.resolve() 将相对路径转为绝对路径，并消除路径穿越片段。
 * 不会解析符号链接——对于写入校验，请使用 validateTeamMemWritePath()
 * 或 validateTeamMemKey()，它们包含符号链接解析。
 */
export function isTeamMemPath(filePath: string): boolean {
  // SECURITY：resolve() 会把路径转成绝对路径并消除 .. 片段，
  // 从而防止路径穿越攻击（例如 "team/../../etc/passwd"）
  const resolvedPath = resolve(filePath)
  const teamDir = getTeamMemPath()
  return resolvedPath.startsWith(teamDir)
}

/**
 * 验证一个绝对文件路径对于写入 team memory 目录是否安全。
 * 如果有效，返回解析后的绝对路径。
 * 如果路径包含注入向量、通过 .. 片段逃逸目录，或通过符号链接逃逸（PSR M22186），
 * 则抛出 PathTraversalError。
 */
export async function validateTeamMemWritePath(
  filePath: string,
): Promise<string> {
  if (filePath.includes('\0')) {
    throw new PathTraversalError(`Null byte in path: "${filePath}"`)
  }
  // 第一遍：规范化 .. 片段并检查基于字符串的包含关系。
  // 这是在接触文件系统前，用于快速拒绝明显路径穿越尝试的检查。
  const resolvedPath = resolve(filePath)
  const teamDir = getTeamMemPath()
  // 前缀攻击防护：teamDir 已经以 sep 结尾（来自 getTeamMemPath()），
  // 所以 "team-evil/" 不会匹配 "team/"
  if (!resolvedPath.startsWith(teamDir)) {
    throw new PathTraversalError(
      `Path escapes team memory directory: "${filePath}"`,
    )
  }
  // 第二遍：解析最深已存在祖先上的符号链接，并验证真实路径仍然位于真实的 team dir 内。
  // 这可以捕获 path.resolve() 单独无法检测的基于符号链接的逃逸。
  const realPath = await realpathDeepestExisting(resolvedPath)
  if (!(await isRealPathWithinTeamDir(realPath))) {
    throw new PathTraversalError(
      `Path escapes team memory directory via symlink: "${filePath}"`,
    )
  }
  return resolvedPath
}

/**
 * 针对 team memory 目录校验来自服务端的相对路径键。
 * 它会清理该键，与 team dir 拼接，解析最深已存在祖先上的符号链接，
 * 并针对真实的 team dir 验证包含关系。
 * 返回解析后的绝对路径。
 * 如果该键具有恶意（PSR M22186），则抛出 PathTraversalError。
 */
export async function validateTeamMemKey(relativeKey: string): Promise<string> {
  sanitizePathKey(relativeKey)
  const teamDir = getTeamMemPath()
  const fullPath = join(teamDir, relativeKey)
  // 第一遍：规范化 .. 片段并检查基于字符串的包含关系。
  const resolvedPath = resolve(fullPath)
  if (!resolvedPath.startsWith(teamDir)) {
    throw new PathTraversalError(
      `Key escapes team memory directory: "${relativeKey}"`,
    )
  }
  // 第二遍：解析符号链接并验证真实包含关系。
  const realPath = await realpathDeepestExisting(resolvedPath)
  if (!(await isRealPathWithinTeamDir(realPath))) {
    throw new PathTraversalError(
      `Key escapes team memory directory via symlink: "${relativeKey}"`,
    )
  }
  return resolvedPath
}

/**
 * 检查文件路径是否位于 team memory 目录内，
 * 并且 team memory 已启用。
 */
export function isTeamMemFile(filePath: string): boolean {
  return isTeamMemoryEnabled() && isTeamMemPath(filePath)
}
