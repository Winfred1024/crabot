import * as fs from 'fs'
import * as path from 'path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'
import { byteLength } from '../byte-cap'

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', '.next', '.cache'])

const BINARY_CHECK_BYTES = 512

// Grep 输出按 UTF-8 字节累加上限。命中行内容很长（K 线 / CSV / JSON 单行数 KB～MB）时，
// 仅靠 head_limit（行数）无法兜住——必须按字节裁剪，否则会塞 N MB 进 toolResult。
const MAX_OUTPUT_BYTES = 200_000

function truncationHint(): string {
  return (
    `\n[truncated: hit ${MAX_OUTPUT_BYTES} byte cap. ` +
    `用 glob 收窄文件类型 / 用 path 缩小搜索目录 / 降低 head_limit / 改用 count 模式。]`
  )
}

/**
 * 按 UTF-8 字节累加把 lines 收集成单字符串，超出 MAX_OUTPUT_BYTES / headLimit 即停。
 * 三个 output_mode formatter 共用，确保截断行为一致。
 */
function joinWithCap(lines: Iterable<string>, headLimit: number): string {
  const collected: string[] = []
  let bytes = 0
  let truncated = false

  for (const line of lines) {
    if (collected.length >= headLimit) break
    const lineBytes = byteLength(line) + 1 // +1 for join newline
    if (bytes + lineBytes > MAX_OUTPUT_BYTES) {
      truncated = true
      break
    }
    collected.push(line)
    bytes += lineBytes
  }

  if (collected.length === 0) return 'No matches found'
  const joined = collected.join('\n')
  return truncated ? joined + truncationHint() : joined
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_BYTES)
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}

function matchesGlob(filePath: string, glob: string): boolean {
  // Simple glob: *.ext or **/*.ext
  const pattern = glob.replace(/\./g, '\\.').replace(/\*\*/g, '{{GLOBSTAR}}').replace(/\*/g, '[^/]*').replace(/\{\{GLOBSTAR\}\}/g, '.*')
  const regex = new RegExp(`(^|/)${pattern}$`)
  return regex.test(filePath)
}

function walkDirectory(dir: string, basePath: string, glob: string | undefined): ReadonlyArray<string> {
  const results: string[] = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue
      }
      const subResults = walkDirectory(path.join(dir, entry.name), basePath, glob)
      results.push(...subResults)
    } else if (entry.isFile()) {
      const fullPath = path.join(dir, entry.name)
      if (glob !== undefined) {
        const relativePath = path.relative(basePath, fullPath)
        if (!matchesGlob(relativePath, glob)) {
          continue
        }
      }
      results.push(fullPath)
    }
  }

  return results
}

function readFileIfText(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r')
    const headerBuf = Buffer.alloc(BINARY_CHECK_BYTES)
    const bytesRead = fs.readSync(fd, headerBuf, 0, BINARY_CHECK_BYTES, 0)
    fs.closeSync(fd)

    if (isBinaryBuffer(headerBuf.subarray(0, bytesRead))) {
      return null
    }

    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

interface MatchResult {
  readonly filePath: string
  readonly lineNumber: number
  readonly lineContent: string
}

function searchFile(filePath: string, regex: RegExp): ReadonlyArray<MatchResult> {
  const content = readFileIfText(filePath)
  if (content === null) {
    return []
  }

  const lines = content.split('\n')
  const matches: MatchResult[] = []

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matches.push({
        filePath,
        lineNumber: i + 1,
        lineContent: lines[i],
      })
    }
  }

  return matches
}

function* uniqueFilePaths(
  allMatches: ReadonlyArray<ReadonlyArray<MatchResult>>,
): Generator<string> {
  const seen = new Set<string>()
  for (const fileMatches of allMatches) {
    if (fileMatches.length === 0) continue
    const fp = fileMatches[0].filePath
    if (seen.has(fp)) continue
    seen.add(fp)
    yield fp
  }
}

function formatFilesWithMatches(
  allMatches: ReadonlyArray<ReadonlyArray<MatchResult>>,
  headLimit: number,
): string {
  return joinWithCap(uniqueFilePaths(allMatches), headLimit)
}

function* contentLines(
  allMatches: ReadonlyArray<ReadonlyArray<MatchResult>>,
  contextLines: number,
): Generator<string> {
  for (const fileMatches of allMatches) {
    if (fileMatches.length === 0) continue

    const filePath = fileMatches[0].filePath
    const content = readFileIfText(filePath)
    if (content === null) continue

    const lines = content.split('\n')
    const matchLineNumbers = new Set(fileMatches.map((m) => m.lineNumber))

    const displayLines = new Set<number>()
    for (const lineNum of matchLineNumbers) {
      const start = Math.max(1, lineNum - contextLines)
      const end = Math.min(lines.length, lineNum + contextLines)
      for (let i = start; i <= end; i++) {
        displayLines.add(i)
      }
    }

    const sortedLineNumbers = [...displayLines].sort((a, b) => a - b)
    for (const lineNum of sortedLineNumbers) {
      const separator = matchLineNumbers.has(lineNum) ? ':' : '-'
      yield `${filePath}${separator}${lineNum}${separator}${lines[lineNum - 1]}`
    }
  }
}

function formatContent(
  allMatches: ReadonlyArray<ReadonlyArray<MatchResult>>,
  contextLines: number,
  headLimit: number,
): string {
  return joinWithCap(contentLines(allMatches, contextLines), headLimit)
}

function* countLines(
  allMatches: ReadonlyArray<ReadonlyArray<MatchResult>>,
): Generator<string> {
  for (const fileMatches of allMatches) {
    if (fileMatches.length === 0) continue
    yield `${fileMatches[0].filePath}:${fileMatches.length}`
  }
}

function formatCount(
  allMatches: ReadonlyArray<ReadonlyArray<MatchResult>>,
  headLimit: number,
): string {
  return joinWithCap(countLines(allMatches), headLimit)
}

export function createGrepTool(cwd: string): ToolDefinition {
  return defineTool({
    name: 'Grep',
    category: 'file_io',
    description: 'Search for regex patterns in files recursively. Supports glob filtering, context lines, and multiple output modes.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for',
        },
        path: {
          type: 'string',
          description: 'Directory to search in (default: working directory)',
        },
        glob: {
          type: 'string',
          description: 'File filter pattern (e.g., "*.ts")',
        },
        output_mode: {
          type: 'string',
          enum: ['files_with_matches', 'content', 'count'],
          description: 'Output format (default: files_with_matches)',
        },
        context: {
          type: 'number',
          description: 'Lines of context before/after match (content mode only)',
        },
        head_limit: {
          type: 'number',
          description: 'Maximum number of results (default: 250)',
        },
      },
      required: ['pattern'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    call: async (input) => {
      const pattern = input.pattern as string
      const searchPath = (input.path as string | undefined) ?? cwd
      const glob = input.glob as string | undefined
      const outputMode = (input.output_mode as string | undefined) ?? 'files_with_matches'
      const contextLines = (input.context as number | undefined) ?? 0
      const headLimit = (input.head_limit as number | undefined) ?? 250

      let regex: RegExp
      try {
        regex = new RegExp(pattern)
      } catch (err) {
        return {
          output: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }

      const files = walkDirectory(searchPath, searchPath, glob)
      const allMatches = files.map((file) => searchFile(file, regex))

      let output: string
      switch (outputMode) {
        case 'content':
          output = formatContent(allMatches, contextLines, headLimit)
          break
        case 'count':
          output = formatCount(allMatches, headLimit)
          break
        default:
          output = formatFilesWithMatches(allMatches, headLimit)
          break
      }

      return { output, isError: false }
    },
  })
}
