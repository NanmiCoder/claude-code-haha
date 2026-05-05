import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

type Bucket = {
  files: number
  lines: number
  nonBlankLines: number
}

type FileStat = Bucket & {
  path: string
  extension: string
}

const root = process.cwd()

const targetRoots = ['adapters', 'runtime', 'src/server']

const codeExtensions = new Set([
  '.css',
  '.cjs',
  '.html',
  '.js',
  '.jsx',
  '.mjs',
  '.nsh',
  '.ps1',
  '.py',
  '.rs',
  '.sh',
  '.ts',
  '.tsx',
])

const excludedDirectoryNames = new Set([
  '.cache',
  '.git',
  '.next',
  '.nuxt',
  '.omx',
  '.parcel-cache',
  '.svelte-kit',
  '.tauri',
  '.turbo',
  '.vite',
  '.vite-temp',
  '__pycache__',
  'build',
  'build-artifacts',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
])

const excludedRelativePaths = new Set<string>()

const files: FileStat[] = []

function emptyBucket(): Bucket {
  return {
    files: 0,
    lines: 0,
    nonBlankLines: 0,
  }
}

function addToBucket(bucket: Bucket, file: FileStat) {
  bucket.files += file.files
  bucket.lines += file.lines
  bucket.nonBlankLines += file.nonBlankLines
}

function shouldSkipDirectory(path: string) {
  const name = path.split(sep).at(-1)
  const normalized = relative(root, path).split(sep).join('/')

  return (
    Boolean(name && excludedDirectoryNames.has(name)) ||
    excludedRelativePaths.has(normalized)
  )
}

function countFile(path: string): FileStat | null {
  const extension = extname(path)

  if (!codeExtensions.has(extension)) {
    return null
  }

  const content = readFileSync(path, 'utf8')
  const newlineCount = content.match(/\r\n|\r|\n/g)?.length ?? 0
  const lines =
    content.length === 0 || content.endsWith('\n') || content.endsWith('\r')
      ? newlineCount
      : newlineCount + 1
  const nonBlankLines = content
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim().length > 0).length

  return {
    files: 1,
    lines,
    nonBlankLines,
    path: relative(root, path).split(sep).join('/'),
    extension,
  }
}

function walk(path: string) {
  const stat = statSync(path)

  if (stat.isDirectory()) {
    if (shouldSkipDirectory(path)) {
      return
    }

    for (const entry of readdirSync(path)) {
      walk(join(path, entry))
    }

    return
  }

  if (!stat.isFile()) {
    return
  }

  const result = countFile(path)
  if (result) {
    files.push(result)
  }
}

function formatNumber(value: number) {
  return value.toLocaleString('en-US')
}

function printTable(
  title: string,
  rows: Array<{ name: string } & Bucket>,
  nameHeader = 'Group',
) {
  console.log(`\n${title}`)
  console.log(`${nameHeader.padEnd(28)} ${'Files'.padStart(7)} ${'Lines'.padStart(9)} ${'Nonblank'.padStart(9)}`)
  console.log(`${'-'.repeat(28)} ${'-'.repeat(7)} ${'-'.repeat(9)} ${'-'.repeat(9)}`)

  for (const row of rows) {
    console.log(
      `${row.name.padEnd(28)} ${formatNumber(row.files).padStart(7)} ${formatNumber(row.lines).padStart(9)} ${formatNumber(row.nonBlankLines).padStart(9)}`,
    )
  }
}

function groupBy<T extends string>(getKey: (file: FileStat) => T) {
  const result = new Map<T, Bucket>()

  for (const file of files) {
    const key = getKey(file)
    const bucket = result.get(key) ?? emptyBucket()
    addToBucket(bucket, file)
    result.set(key, bucket)
  }

  return [...result.entries()]
    .map(([name, bucket]) => ({ name, ...bucket }))
    .sort((left, right) => right.lines - left.lines)
}

function areaForPath(path: string) {
  if (path.startsWith('src/server/')) {
    return 'server'
  }

  if (path.startsWith('adapters/')) {
    return 'adapters'
  }

  if (path.startsWith('runtime/')) {
    return 'runtime'
  }

  return 'other'
}

function purposeForPath(path: string) {
  const fileName = path.split('/').at(-1) ?? ''

  if (
    path.includes('/__tests__/') ||
    path.includes('/fixtures/') ||
    fileName.startsWith('test_') ||
    /\.test\.[cm]?[jt]sx?$/.test(path) ||
    /\.spec\.[cm]?[jt]sx?$/.test(path)
  ) {
    return 'tests and fixtures'
  }

  return 'product source'
}

for (const targetRoot of targetRoots) {
  walk(join(root, targetRoot))
}

const total = emptyBucket()
for (const file of files) {
  addToBucket(total, file)
}

const sortedByPath = [...files].sort((left, right) =>
  left.path.localeCompare(right.path),
)

console.log('Application source line count')
console.log('')
console.log(`Targets: ${targetRoots.join(', ')}`)
console.log(`Included extensions: ${[...codeExtensions].sort().join(', ')}`)
console.log(
  `Excluded directories: ${[...excludedDirectoryNames].sort().join(', ')}`,
)
console.log(`Excluded paths: ${[...excludedRelativePaths].sort().join(', ')}`)

printTable('By area', groupBy((file) => areaForPath(file.path)))
printTable('By purpose', groupBy((file) => purposeForPath(file.path)))
printTable('By top-level target', groupBy((file) => file.path.split('/')[0]))
printTable('By extension', groupBy((file) => file.extension), 'Extension')

console.log('\nTotal')
console.log(`Files: ${formatNumber(total.files)}`)
console.log(`Lines: ${formatNumber(total.lines)}`)
console.log(`Nonblank lines: ${formatNumber(total.nonBlankLines)}`)

if (process.argv.includes('--files')) {
  printTable(
    'By file',
    sortedByPath.map((file) => ({ name: file.path, ...file })),
    'File',
  )
}
