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
import { resolveBashPath, BASH_NOT_FOUND_MESSAGE } from '../../utils/resolve-bash-path.js'

const MAX_OUTPUT_LENGTH = 100000
const DEFAULT_TIMEOUT_MS = 120000
/** 无 bgCtx（legacy / subagent 未接 bg）时退回旧同步前台执行的 timeout 上限。 */
export const MAX_FOREGROUND_TIMEOUT_MS = 600_000

/**
 * 前台宽限期：默认路径（非 run_in_background）的命令先前台运行这么久。
 * 期内退出 → 同步内联返回（等同普通同步调用）；超过仍在跑 → 转后台（命令不中断）+
 * 引导 agent 用 wait_for_signal 挂起等待。取代旧的「显式 timeout>60s 直接转 bg」破坏性逻辑。
 */
export const FOREGROUND_GRACE_PERIOD_MS = 10_000

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
  const bashPath = resolveBashPath()
  if (bashPath === null) {
    return Promise.resolve({ output: BASH_NOT_FOUND_MESSAGE, isError: true })
  }
  return new Promise((resolve) => {
    const child = execFile(
      bashPath,
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

async function runBg(command: string, bgCtx: BashBgContext, cwd: string): Promise<ToolCallResult> {
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
      cwd,
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
      cwd,
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

// exit 分支只需退出码 + 状态来格式化内联返回；完整 info 由 onExit（转后台时）转给 onShellExit。
type GraceOutcome =
  | { kind: 'exit'; exitCode: number; status: 'completed' | 'failed' | 'killed' }
  | { kind: 'grace' }
  | { kind: 'abort' }

/**
 * 默认前台执行：把命令 spawn 成 transient shell，前台宽限 FOREGROUND_GRACE_PERIOD_MS。
 * - 宽限期内退出：读输出同步内联返回（等同一次普通同步调用），清理 shell。
 * - 超过宽限期仍在跑：转入后台（命令**不中断**），返回 entity_id + 引导 wait_for_signal。
 *   届时 shell 退出会经 onShellExit push 到本 task humanQueue，唤醒挂起的 worker。
 * - 期间 abort：kill shell，返回 aborted。
 *
 * onExit 的 `backgrounded` 门控解决冗余通知：宽限期内退出（backgrounded=false）→ 不 push、
 * 内联返回；超期后退出（backgrounded=true）→ push 唤醒。grace 定时器**同步**置 backgrounded=true
 * 后再 resolve race，杜绝「超期瞬间退出但漏 push 导致 worker 永久挂起」的竞态。
 */
async function runForegroundWithGrace(
  command: string,
  bgCtx: BashBgContext,
  cwd: string,
  signal: AbortSignal | undefined,
  gracePeriodMs: number,
): Promise<ToolCallResult> {
  let backgrounded = false
  // definite-assignment：executor 同步执行，resolveRace 在任何使用前必被赋值。
  // 不用 `| null`，避免 TS 把它误窄化为 never；重复 resolve 由 Promise 幂等兜底（no-op）。
  let resolveRace!: (o: GraceOutcome) => void
  const racePromise = new Promise<GraceOutcome>((resolve) => {
    resolveRace = resolve
  })

  const graceTimer = setTimeout(() => {
    backgrounded = true
    resolveRace({ kind: 'grace' })
  }, gracePeriodMs)
  graceTimer.unref?.()

  const onAbort = () => resolveRace({ kind: 'abort' })
  if (signal) {
    // 已 abort 的 signal 不会再派发 'abort' 事件，故需主动判一次；否则挂监听器。
    if (signal.aborted) {
      resolveRace({ kind: 'abort' })
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }
  const cleanup = () => {
    clearTimeout(graceTimer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  let entityId: string
  try {
    entityId = bgCtx.transient.spawn({
      command,
      owner: bgCtx.owner,
      spawned_by_task_id: bgCtx.taskId,
      traceContext: bgCtx.traceContext,
      cwd,
      onExit: (info) => {
        if (backgrounded) {
          bgCtx.onShellExit?.({ ...info, mode: 'transient' })
        } else {
          resolveRace({ kind: 'exit', exitCode: info.exit_code, status: info.status })
        }
      },
    })
  } catch (err) {
    cleanup()
    return { output: err instanceof Error ? err.message : String(err), isError: true }
  }

  const outcome = await racePromise
  cleanup()

  if (outcome.kind === 'abort') {
    bgCtx.transient.kill(entityId)
    return { output: 'Command aborted', isError: true }
  }

  if (outcome.kind === 'grace') {
    const sec = Math.round(gracePeriodMs / 1000)
    return {
      output:
        `命令运行已超过 ${sec}s，转入后台继续运行（entity_id: ${entityId}）——命令未中断。\n` +
        `若你还有别的事可做，现在就去做；若没有，调 wait_for_signal(reason="等 ${command.slice(0, 40)}") 挂起，` +
        `该命令退出时会自动唤醒你，届时用 Output("${entityId}") 读取完整输出。`,
      isError: false,
    }
  }

  // outcome.kind === 'exit'：宽限期内完成，读最终输出（含移除）后内联同步返回。
  const snap = bgCtx.transient.takeFinalOutput(entityId)
  const body = truncateOutput((snap?.output ?? '').replace(/\n$/, ''))
  const prefix = snap?.dropped ? '[earlier output dropped from ring buffer]\n' : ''
  const suffix =
    outcome.exitCode === 0 && outcome.status === 'completed'
      ? ''
      : `\n[command exited with code ${outcome.exitCode}]`
  return { output: `${prefix}${body}${suffix}`.trim(), isError: suffix !== '' }
}

const SENSITIVE_CMD_RE = /channel-configs[/\\]/

function containsSensitivePath(command: string): boolean {
  return SENSITIVE_CMD_RE.test(command)
}

export function createBashTool(
  getCwd: () => string,
  defaultTimeout?: number,
  bgCtx?: BashBgContext,
  /** 前台宽限期（ms）。默认 FOREGROUND_GRACE_PERIOD_MS；仅测试需要注入短值快速覆盖慢路径。 */
  gracePeriodMs: number = FOREGROUND_GRACE_PERIOD_MS,
): ToolDefinition {
  const effectiveDefault = defaultTimeout ?? DEFAULT_TIMEOUT_MS
  return defineTool({
    name: 'Bash',
    category: 'shell',
    description:
      'Executes a bash command and returns its output. ' +
      `命令默认前台运行；若运行超过 ${Math.round(FOREGROUND_GRACE_PERIOD_MS / 1000)}s，自动转入后台并返回 entity_id（命令**继续运行、不中断**），` +
      '随后你可继续做别的，或调 wait_for_signal 挂起等待其退出（退出会自动唤醒你）。' +
      'run_in_background=true 则立即转后台返回 handle，不在前台等待。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
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
        return runBg(command, bgCtx, getCwd())
      }

      // 默认路径：前台宽限期内完成则同步内联返回；超期仍在跑则转后台 + 引导 wait_for_signal。
      if (bgCtx) {
        return runForegroundWithGrace(command, bgCtx, getCwd(), context.abortSignal, gracePeriodMs)
      }

      // 无 bgCtx（legacy / subagent 未接 bg）：退回旧同步前台执行，默认 timeout 兜底。
      const timeoutMs = Math.min(effectiveDefault, MAX_FOREGROUND_TIMEOUT_MS)
      return execCommand(command, getCwd(), timeoutMs, context.abortSignal)
    },
  })
}
