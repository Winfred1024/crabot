import { resolve, isAbsolute, relative } from 'path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'
import { runRipgrep, DEFAULT_EXCLUDE_GLOBS } from './ripgrep-helper'

const MAX_RESULTS = 200

/**
 * Glob tool — 走 ripgrep `--files --glob`，把目录扫描丢给 rg 子进程。
 *
 * 旧实现用 fast-glob (纯 JS 全 walk)，跟旧 grep-tool 的 walkDirectory 同款隐患——
 * 大仓里可能把几万个文件路径全拉进 JS 堆。rg --files 把扫描留在 rg 进程内部，
 * 流式吐出来 + 应用层 MAX_RESULTS 截断，agent 堆只承担最多 200 个路径字符串。
 */
export function createGlobTool(cwd: string): ToolDefinition {
  return defineTool({
    name: 'glob',
    category: 'file_io',
    description: 'Fast file pattern matching (powered by ripgrep). Returns matching file paths sorted alphabetically.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files (e.g., "**/*.ts")' },
        path: { type: 'string', description: 'Base directory to search in. Defaults to working directory.' },
      },
      required: ['pattern'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    call: async (input) => {
      const pattern = input.pattern as string
      const pathInput = input.path as string | undefined

      const resolvedPath = pathInput
        ? (isAbsolute(pathInput) ? pathInput : resolve(cwd, pathInput))
        : cwd

      const args: string[] = [
        '--no-config',
        '--no-ignore',
        '--hidden',
        '--files',
        '--no-messages',
      ]
      // ripgrep glob 按顺序应用、**最后匹配胜出**：用户 pattern 必须在排除 glob
      // 之前 push，否则像 `**/*` 这种广模式会把 !node_modules / !.git 反向包含进来。
      args.push('--glob', pattern)
      for (const g of DEFAULT_EXCLUDE_GLOBS) {
        args.push('--glob', g)
      }
      args.push(resolvedPath)

      let rg
      try {
        rg = await runRipgrep(args)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { output: `Glob error: ${message}`, isError: true }
      }

      if (rg.exitCode === 2) {
        const msg = (rg.stderr || '').trim() || 'ripgrep exited with code 2'
        return { output: `Glob error: ${msg}`, isError: true }
      }

      // rg --files 输出绝对路径（因为传了绝对路径作为 search root），
      // 旧契约（fast-glob）返回的是相对 resolvedPath 的路径，这里 normalize 回去。
      const allEntries: string[] = []
      for (const line of rg.stdout.split('\n')) {
        if (!line) continue
        const rel = relative(resolvedPath, line)
        // relative 可能输出空字符串（path === resolvedPath，理论不会出现在 --files 输出里），跳过
        if (rel) allEntries.push(rel)
      }

      const sorted = [...allEntries].sort()

      if (sorted.length === 0) {
        return { output: `No files found matching pattern: ${pattern}`, isError: false }
      }

      const truncated = sorted.length > MAX_RESULTS
      const displayed = truncated ? sorted.slice(0, MAX_RESULTS) : sorted
      const lines = truncated
        ? [...displayed, `[...${sorted.length - MAX_RESULTS} more results truncated]`]
        : displayed

      return { output: lines.join('\n'), isError: false }
    },
  })
}
