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
      '**作用**：把当前 task 的工作目录（cwd）改成 path。' +
      '调用后，本 task 后续的 Bash / Read / Grep / Glob / Write / Edit 工具，' +
      '以及通过 delegate_task 派出的所有 subagent，都自动用 path 作为工作目录' +
      '——你不需要在每次工具调用里写绝对路径。\n' +
      '未调用时 cwd 默认是 agent 进程启动目录（通常是 home），不一定是用户期望的项目根。\n\n' +
      '**何时调**：任务关联一个具体代码项目时调。' +
      '典型流程：search_memory 查到项目目录 → set_cwd(/path)。' +
      '本 task 内一次就够，不需要反复切。\n\n' +
      '**何时不调**：任务跟具体项目无关（讨论 / 闲聊 / 通用问答 / 纯配置问题）。\n\n' +
      '**不做的事**：本工具不读 CLAUDE.md / AGENTS.md，' +
      '也不改变你的工作流节奏。项目背景文档由调查方（research_collector）' +
      '/ 规划方（code_planner）在自己流程里按需 Read。',
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
