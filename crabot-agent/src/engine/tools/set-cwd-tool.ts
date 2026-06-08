import { promises as fs, constants as fsConstants } from 'node:fs'
import * as path from 'node:path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition, ToolCallResult } from '../types'

const MAX_DOC_BYTES = 100 * 1024 // 100KB per file

export interface SetCwdContext {
  /** 当前 cwd getter（用于解析相对路径） */
  getCwd: () => string
  /** cwd setter（改 task-scoped state） */
  setCwd: (newCwd: string) => void
}

async function readProjectDoc(absDir: string, fileName: string): Promise<string> {
  const filePath = path.join(absDir, fileName)
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) {
      return '(not a file)'
    }
    const buf = await fs.readFile(filePath)
    if (buf.byteLength > MAX_DOC_BYTES) {
      const truncated = buf.subarray(0, MAX_DOC_BYTES).toString('utf-8')
      return `${truncated}\n\n[truncated, ${MAX_DOC_BYTES} of ${buf.byteLength} bytes]`
    }
    return buf.toString('utf-8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      return '(not found)'
    }
    return `(read failed: ${e.code ?? e.message})`
  }
}

export function createSetCwdTool(ctx: SetCwdContext): ToolDefinition {
  return defineTool({
    name: 'set_cwd',
    category: 'file_io',
    description:
      '把当前 task 的工作目录（cwd）切到指定项目根。' +
      '后续 Bash / Read / Grep / Glob / Write / Edit 都在新 cwd 下跑；' +
      '派出的 subagent 也自动继承此 cwd。\n' +
      '同时自动加载项目根的 CLAUDE.md 和 AGENTS.md 内容并返回给你做项目背景。\n' +
      '使用时机：识别到任务关联具体项目（用户提到的项目名 / 已知代码库）时。' +
      '先用 search_memory 找项目目录路径，找到后调用本工具锚定。' +
      '本 task 内只在初次锚定时调用一次；不需要反复切换。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '项目根目录的绝对路径，或相对当前 cwd 的相对路径（会自动解析为绝对）',
        },
      },
      required: ['path'],
    },
    isReadOnly: false,
    permissionLevel: 'safe',
    async call(input: Record<string, unknown>): Promise<ToolCallResult> {
      const inputPath = input.path as string
      const absPath = path.isAbsolute(inputPath)
        ? inputPath
        : path.resolve(ctx.getCwd(), inputPath)

      // 1) 校验：路径必须存在、是目录、可读
      try {
        const stat = await fs.stat(absPath)
        if (!stat.isDirectory()) {
          return {
            output: `set_cwd failed: ${absPath} 不是目录`,
            isError: true,
          }
        }
        await fs.access(absPath, fsConstants.R_OK)
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        const reason = e.code === 'ENOENT' ? '路径不存在' : `无法访问 (${e.code ?? e.message})`
        return {
          output: `set_cwd failed: ${absPath} ${reason}`,
          isError: true,
        }
      }

      // 2) 改 cwd state
      ctx.setCwd(absPath)

      // 3) 读 CLAUDE.md 和 AGENTS.md
      const [claudeMd, agentsMd] = await Promise.all([
        readProjectDoc(absPath, 'CLAUDE.md'),
        readProjectDoc(absPath, 'AGENTS.md'),
      ])

      // 4) 拼装 tool result
      const lines = [
        `cwd 已切到 ${absPath}`,
        '',
        '--- CLAUDE.md ---',
        claudeMd,
        '',
        '--- AGENTS.md ---',
        agentsMd,
        '',
        `后续 Bash / Read / Grep / Glob / Write / Edit 都在 ${absPath} 下跑；派出的 subagent 也继承此 cwd。`,
      ]

      return {
        output: lines.join('\n'),
        isError: false,
      }
    },
  })
}
