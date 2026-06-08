import { promises as fs, constants as fsConstants } from 'node:fs'
import * as path from 'node:path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition, ToolCallResult } from '../types'

export interface SetCwdContext {
  /** 当前 cwd getter（用于解析相对路径） */
  getCwd: () => string
  /** cwd setter（改 task-scoped state） */
  setCwd: (newCwd: string) => void
}

export function createSetCwdTool(ctx: SetCwdContext): ToolDefinition {
  return defineTool({
    name: 'set_cwd',
    category: 'file_io',
    description:
      '把当前 task 的工作目录（cwd）切到指定项目根。' +
      '后续工具调用和派出的 subagent 都自动用新 cwd。\n' +
      '使用时机：任务关联具体项目时，先用 search_memory 找项目目录，' +
      '找到后调本工具切过去。本 task 内一次就够，不需要反复切换。\n' +
      '切完继续按主工作流推进（[意图澄清] / [目标承诺] / [规划与执行]）——' +
      '本工具只切 cwd 不改流程节奏。项目背景文档（CLAUDE.md / AGENTS.md）' +
      '由调查方按需 Read，本工具不读。',
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

      // 校验：路径必须存在、是目录、可读
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

      // 改 cwd state
      ctx.setCwd(absPath)

      return {
        output: `cwd 已切到 ${absPath}。后续工具调用和派出的 subagent 都自动用新 cwd。`,
        isError: false,
      }
    },
  })
}
