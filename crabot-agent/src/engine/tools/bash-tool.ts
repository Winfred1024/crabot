import { execFile } from 'child_process'
import { defineTool } from '../tool-framework'
import type { ToolDefinition, ToolCallContext, ToolCallResult } from '../types'
import type { BgEntityRegistry } from '../bg-entities/registry.js'
import type { TransientShellRegistry } from '../bg-entities/bg-shell.js'
import type { BgEntityOwner } from '../bg-entities/types.js'
import type { BgEntityTraceContext } from '../bg-entities/trace.js'
import type { WorkerAgentContext } from '../../types.js'
import { spawnPersistentShell } from '../bg-entities/bg-shell.js'
import { isPersistentMode } from '../bg-entities/permission.js'
import { BG_ENTITY_LIMIT_PER_OWNER } from '../bg-entities/types.js'

const MAX_OUTPUT_LENGTH = 100000
const DEFAULT_TIMEOUT_MS = 120000
export const MAX_FOREGROUND_TIMEOUT_MS = 600_000
/**
 * 显式 timeout 超过此阈值时，工具层自动把同步调用转为 background 模式，
 * 避免 agent loop 被堵几十秒。与 prompt-manager.ts 「长任务的处理」段
 * "≥1 分钟必须 run_in_background=true" 的语义边界对齐。
 *
 * 判定条件刻意只覆盖**显式给出 timeout > 60s 的同步调用**——LLM 不传 timeout
 * 时不预先转换（不破坏短命令体验），让默认 120s 兜底。
 */
export const AUTO_BG_TIMEOUT_THRESHOLD_MS = 60_000

/**
 * 自动转 bg 后建议给 LLM 的 Output(block=true, timeout_ms=...) 上限。
 * 防止 LLM 给 timeout=600000+ 的同步 Bash 被转 bg 后，下一步直接用同样大的
 * timeout_ms 调 Output(block=true)——那等于换种方式同步堵 agent loop。
 * 120s 是 prompt L351 示例值。
 */
export const AUTO_BG_OUTPUT_BLOCK_CAP_MS = 120_000

export interface BashBgContext {
  readonly registry: BgEntityRegistry
  readonly transient: TransientShellRegistry
  readonly workerContext: WorkerAgentContext
  readonly owner: BgEntityOwner
  readonly taskId: string
  readonly traceContext?: BgEntityTraceContext
  /** Push notification sink — bg entity exit / 重要事件触发后调，由 worker 排到下一次 task 的 prompt */
  readonly onShellExit?: (info: {
    entity_id: string
    command: string
    status: 'completed' | 'failed' | 'killed'
    exit_code: number
    runtime_ms: number
    spawned_at: string
    mode: 'persistent' | 'transient'
  }) => void
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return output
  }
  const halfLimit = Math.floor((MAX_OUTPUT_LENGTH - 20) / 2)
  return `${output.slice(0, halfLimit)}\n[...truncated...]\n${output.slice(-halfLimit)}`
}

function execCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ToolCallResult> {
  return new Promise((resolve) => {
    const child = execFile(
      '/bin/sh',
      ['-c', command],
      {
        cwd,
        timeout: timeoutMs,
        signal,
        maxBuffer: 10 * 1024 * 1024,
        // 显式透传父进程 env，确保 CRABOT_TOKEN / DATA_DIR 等环境变量进入子 shell。
        // execFile 默认 inherit 但显式传更稳定。
        env: process.env,
      },
      (error, stdout, stderr) => {
        const stderrTrimmed = stderr.trim()
        const stdoutTrimmed = stdout ?? ''

        if (error !== null) {
          // Timeout
          if (error.killed && (error as NodeJS.ErrnoException).code === undefined) {
            resolve({
              output: `Command timed out after ${timeoutMs}ms`,
              isError: true,
            })
            return
          }

          // Abort
          if (error.name === 'AbortError' || signal?.aborted === true) {
            resolve({
              output: 'Command aborted',
              isError: true,
            })
            return
          }

          // Command failure
          const parts: string[] = []
          if (error.message) {
            parts.push(error.message)
          }
          if (stdoutTrimmed) {
            parts.push(stdoutTrimmed)
          }
          if (stderrTrimmed) {
            parts.push(`stderr: ${stderrTrimmed}`)
          }
          resolve({
            output: truncateOutput(parts.join('\n') || 'Command failed'),
            isError: true,
          })
          return
        }

        // Success
        const outputParts: string[] = [stdoutTrimmed]
        if (stderrTrimmed) {
          outputParts.push(`stderr: ${stderrTrimmed}`)
        }
        resolve({
          output: truncateOutput(outputParts.join('\n')),
          isError: false,
        })
      },
    )

    // If signal is already aborted, kill the child
    if (signal?.aborted === true) {
      child.kill()
    }
  })
}

async function runBg(command: string, bgCtx: BashBgContext): Promise<ToolCallResult> {
  const persistent = isPersistentMode(bgCtx.workerContext)

  // 资源上限检查（仅持久路径，临时路径生命周期受 task 约束不会堆）
  if (persistent && bgCtx.owner.friend_id) {
    const count = await bgCtx.registry.countActiveByOwner(bgCtx.owner.friend_id)
    if (count >= BG_ENTITY_LIMIT_PER_OWNER) {
      return {
        output: `已达 ${BG_ENTITY_LIMIT_PER_OWNER} 个上限，请先 ListEntities + Kill 清理。`,
        isError: true,
      }
    }
  }

  if (persistent) {
    const id = await spawnPersistentShell({
      command,
      owner: bgCtx.owner,
      spawned_by_task_id: bgCtx.taskId,
      registry: bgCtx.registry,
      traceContext: bgCtx.traceContext,
      onExit: bgCtx.onShellExit
        ? (info) => bgCtx.onShellExit!({ ...info, mode: 'persistent' })
        : undefined,
    })
    return {
      output: `Shell spawned (persistent): ${id}\nUse Output("${id}") to poll, Kill("${id}") to terminate.`,
      isError: false,
    }
  } else {
    const id = bgCtx.transient.spawn({
      command,
      owner: bgCtx.owner,
      spawned_by_task_id: bgCtx.taskId,
      traceContext: bgCtx.traceContext,
      onExit: bgCtx.onShellExit
        ? (info) => bgCtx.onShellExit!({ ...info, mode: 'transient' })
        : undefined,
    })
    return {
      output: `Shell spawned (transient, dies with task): ${id}\nUse Output("${id}") to poll, Kill("${id}") to terminate.`,
      isError: false,
    }
  }
}

const SENSITIVE_CMD_RE = /channel-configs[/\\]/

function containsSensitivePath(command: string): boolean {
  return SENSITIVE_CMD_RE.test(command)
}

export function createBashTool(cwd: string, defaultTimeout?: number, bgCtx?: BashBgContext): ToolDefinition {
  const effectiveDefault = defaultTimeout ?? DEFAULT_TIMEOUT_MS
  return defineTool({
    name: 'Bash',
    category: 'shell',
    description: 'Executes a bash command in the working directory and returns its output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: {
          type: 'number',
          description: `Foreground timeout in ms (default ${effectiveDefault}, max ${MAX_FOREGROUND_TIMEOUT_MS}). 超过会被 cap。**显式给出 > ${AUTO_BG_TIMEOUT_THRESHOLD_MS}ms 的 timeout 会被工具层自动改写为 run_in_background=true**——预估超 1 分钟的命令请直接用 run_in_background=true，不要靠 timeout 撑长同步等。run_in_background=true 时此参数无效。`,
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Spawn in background and return entity_id immediately. master 私聊场景持久化（survive worker 重启）；其他场景仅 task 内活，task 结束自动 kill。',
        },
      },
      required: ['command'],
    },
    isReadOnly: false,
    permissionLevel: 'dangerous',
    call: async (input: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> => {
      const command = input.command as string

      // 軟攔截：命令中直接引用 channel-configs 路徑
      if (containsSensitivePath(command)) {
        return {
          output: '命令引用了渠道憑證路徑（channel-configs/），禁止直接訪問。要讀取飛書文檔請使用 read_feishu_document 工具。',
          isError: true,
        }
      }

      const bg = input.run_in_background === true

      if (bg) {
        if (!bgCtx) {
          // 没传 bgCtx 说明 Bash 在 legacy 模式（如 sub-agent 内可能没接 bg）
          return {
            output: 'Background mode unavailable in this context. Run synchronously instead.',
            isError: true,
          }
        }
        return runBg(command, bgCtx)
      }

      // 自动转 bg：显式 timeout > 60s 且 bgCtx 可用 → 改写为 background 调用
      // 这样 LLM 即使没遵守 prompt「≥1 分钟必须 bg」规则，工具层也会强制治理，
      // 避免 agent loop 被堵到 timeout cap。tool_result 明确告知行为 + 拼真实
      // shell_id + cap Output block 时间，让 LLM 不能变相同步等。
      const explicitTimeout = typeof input.timeout === 'number' ? input.timeout : null
      if (
        explicitTimeout !== null &&
        explicitTimeout > AUTO_BG_TIMEOUT_THRESHOLD_MS &&
        bgCtx !== undefined
      ) {
        const bgResult = await runBg(command, bgCtx)
        if (bgResult.isError) {
          return bgResult
        }
        // 从 bgResult.output 提取 shell_id（runBg 返回格式："Shell spawned (...): shell_xxx\n..."）
        const idMatch = bgResult.output.match(/shell_[0-9a-f]+/)
        const shellId = idMatch ? idMatch[0] : '<shell_id>'
        // cap Output block 时间，防止 LLM 给 timeout=600000+ 时下一步 Output(block=true) 又堵 agent loop
        const suggestedBlockMs = Math.min(explicitTimeout, AUTO_BG_OUTPUT_BLOCK_CAP_MS)
        return {
          output: [
            `[auto-converted to background]`,
            `你给的 timeout=${explicitTimeout}ms 超过 ${AUTO_BG_TIMEOUT_THRESHOLD_MS}ms 阈值——工具层把它改写成了 run_in_background=true。`,
            `（下次预估超 1 分钟的命令请直接传 run_in_background=true）`,
            ``,
            `Shell spawned: ${shellId}`,
            ``,
            `下一步（三选一）：`,
            `  • 想等结果 → Output("${shellId}", block=true, timeout_ms=${suggestedBlockMs})`,
            `  • 想做别的 → 现在就去做，bg 完成时下次 task prompt 头部会有 <bg-notification> 通知`,
            `  • 想终止 → Kill("${shellId}")`,
            `命令已在后台启动，不要重发同一命令。`,
          ].join('\n'),
          isError: false,
        }
      }

      // 前台路径：cap timeout（静默，不报错）
      const requested = explicitTimeout ?? effectiveDefault
      const timeoutMs = Math.min(requested, MAX_FOREGROUND_TIMEOUT_MS)
      return execCommand(command, cwd, timeoutMs, context.abortSignal)
    },
  })
}
