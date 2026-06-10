import type { LLMAdapter } from './llm-adapter'
import type { ToolDefinition, EngineTurnEvent, EngineResult, EngineOptions, ContentBlock, HumanMessageQueueLike, ToolPermissionConfig } from './types'
import type { AgentTrace, WorkerAgentContext } from '../types'
import type { TraceStore } from '../core/trace-store'
import { runEngine } from './query-loop'
import { resolveImageFromPaths } from '../agent/media-resolver'
import { formatSupplementForSubAgent } from '../agent/subagent-prompts'
import { HumanMessageQueue } from './human-message-queue'
import { spawnPersistentAgent } from './bg-entities/bg-agent'
import { isPersistentMode } from './bg-entities/permission'
import type { BgEntityRegistry } from './bg-entities/registry'
import type { BgEntityOwner } from './bg-entities/types'
import { BG_ENTITY_LIMIT_PER_OWNER } from './bg-entities/types'
import type { BgEntityTraceContext } from './bg-entities/trace'

// --- Fork Engine ---

export interface ForkEngineParams {
  /** Task description for the sub-agent (string or content blocks with images) */
  readonly prompt: string | ReadonlyArray<ContentBlock>
  /** LLM adapter (can be same or different from parent) */
  readonly adapter: LLMAdapter
  /** Model to use (can be lighter model for cost savings) */
  readonly model: string
  /** System prompt for the sub-agent */
  readonly systemPrompt: string
  /** Tools available to the sub-agent (subset of parent's tools) */
  readonly tools: ReadonlyArray<ToolDefinition>
  /** Max turns for sub-agent (default: 20, lower than parent) */
  readonly maxTurns?: number
  /** Per-call max output tokens；缺省时让 adapter 走默认行为 */
  readonly maxTokens?: number
  /** Optional: parent context to share (recent messages summary) */
  readonly parentContext?: string
  /** Abort signal (linked to parent) */
  readonly abortSignal?: AbortSignal
  /** Callback for sub-agent turns */
  readonly onTurn?: (event: EngineTurnEvent) => void
  /** Per-LLM-call full prompt dump callback；调用方通常包到 TraceStore.appendPromptDump 落盘 prompts-*.jsonl */
  readonly onPromptDump?: EngineOptions['onPromptDump']
  /** Whether the sub-agent's model supports vision (image inputs) */
  readonly supportsVision?: boolean
  readonly humanMessageQueue?: HumanMessageQueueLike
  readonly hookRegistry?: import('../hooks/hook-registry').HookRegistry
  readonly lspManager?: import('../hooks/types').LspManagerLike
  /** 继承自父（Worker）的 permissionConfig；sub-agent 使用的工具子集仍需遵循相同权限策略 */
  readonly permissionConfig?: ToolPermissionConfig
}

export interface ForkEngineResult {
  /** Sub-agent's final output text */
  readonly output: string
  /** Outcome */
  readonly outcome: EngineResult['outcome']
  /** Token usage */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
  /** Number of turns used */
  readonly totalTurns: number
  /** Error message (when outcome is 'failed') */
  readonly error?: string
  /** 早退工具（exitsLoop=true）触发时的 tool name + input。
   *  例：goal_audit 路径 auditor 调 submit_audit_result 时，input 是
   *  schema-enforced 的 {pass, failed_criteria, evidence}，caller 直接拿
   *  结构化结果，不必 regex parse free text。 */
  readonly exitToolCall?: { readonly name: string; readonly input: Record<string, unknown> }
}

// 兜底值——subagent 都该在 builtin-subagents.ts 显式设 max_turns；这里只防"忘配"。
// 参考：Claude Code 的隐式 fork 是 200 turns，显式 subagent 默认无限制（靠 frontmatter）。
// Crabot 保持有上限（防失控），但提到 50 减少"忘配 + 触顶"事故。
const DEFAULT_SUB_AGENT_MAX_TURNS = 50

export async function forkEngine(params: ForkEngineParams): Promise<ForkEngineResult> {
  let prompt: string | ReadonlyArray<ContentBlock>
  if (params.parentContext) {
    if (typeof params.prompt === 'string') {
      prompt = `## Parent Context\n${params.parentContext}\n\n## Your Task\n${params.prompt}`
    } else {
      prompt = [
        { type: 'text' as const, text: `## Parent Context\n${params.parentContext}\n\n## Your Task\n` },
        ...params.prompt,
      ]
    }
  } else {
    prompt = params.prompt
  }

  const result = await runEngine({
    prompt: typeof prompt === 'string' ? prompt : [...prompt],
    adapter: params.adapter,
    options: {
      systemPrompt: params.systemPrompt,
      tools: [...params.tools],
      model: params.model,
      maxTurns: params.maxTurns ?? DEFAULT_SUB_AGENT_MAX_TURNS,
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
      abortSignal: params.abortSignal,
      onTurn: params.onTurn,
      ...(params.onPromptDump ? { onPromptDump: params.onPromptDump } : {}),
      supportsVision: params.supportsVision,
      humanMessageQueue: params.humanMessageQueue,
      hookRegistry: params.hookRegistry,
      lspManager: params.lspManager,
      permissionConfig: params.permissionConfig,
      // subagent 内禁用 compaction：靠 maxTurns 控规模，避免父侧无感知的隐式压缩 +
      // 嵌套 LLM call。详见 EngineOptions.disableCompaction 注释。
      disableCompaction: true,
    },
  })

  return {
    output: result.finalText,
    outcome: result.outcome,
    usage: result.usage,
    totalTurns: result.totalTurns,
    error: result.error,
    ...(result.exitToolCall ? { exitToolCall: result.exitToolCall } : {}),
  }
}

// --- Sub-Agent Trace Config ---

export interface SubAgentTraceConfig {
  readonly traceStore: TraceStore
  readonly parentTraceId: string
  readonly parentSpanId?: string
  readonly relatedTaskId?: string
}

// --- Sub-Agent Tool ---

/**
 * Background context for sub-agent. When provided, the tool exposes
 * the `run_in_background` input parameter. Parallel to BashBgContext.
 */
export interface SubAgentBgContext {
  readonly registry: BgEntityRegistry
  readonly workerContext: WorkerAgentContext
  readonly owner: BgEntityOwner
  readonly spawned_by_task_id: string
  readonly abortControllers: Map<string, AbortController>
  readonly traceContext?: BgEntityTraceContext
  /** Push notification sink — sub-agent loop 自然结束 / 失败时调；worker 排到下一次 task 的 prompt */
  readonly onAgentExit?: (info: {
    entity_id: string
    task_description: string
    status: 'completed' | 'failed'
    exit_code: number
    runtime_ms: number
    spawned_at: string
    result_file: string | null
  }) => void
}

export interface SubAgentToolConfig {
  /** Tool name (e.g., 'research_agent', 'code_review_agent') */
  readonly name: string
  readonly description: string
  readonly adapter: LLMAdapter
  readonly model: string
  readonly systemPrompt: string
  /** Tools available to the sub-agent */
  readonly subTools: ReadonlyArray<ToolDefinition>
  readonly maxTurns?: number
  /** Per-call max output tokens；缺省时让 adapter 走默认行为 */
  readonly maxTokens?: number
  readonly supportsVision?: boolean
  readonly parentHumanQueue?: HumanMessageQueue
  readonly traceConfig?: SubAgentTraceConfig
  readonly hookRegistry?: import('../hooks/hook-registry').HookRegistry
  readonly lspManager?: import('../hooks/types').LspManagerLike
  /** 从父 Worker 继承的 permissionConfig；sub-agent 的工具执行也需遵守同一 session 的权限策略 */
  readonly permissionConfig?: ToolPermissionConfig
  /** Optional bg-entities deps. 提供时本工具支持 run_in_background 入参 */
  readonly bgContext?: SubAgentBgContext
}

export function createSubAgentTool(config: SubAgentToolConfig): ToolDefinition {
  const properties: Record<string, unknown> = {
    task: { type: 'string', description: 'Task description for the sub-agent' },
    context: { type: 'string', description: 'Optional parent context to share with the sub-agent' },
  }
  if (config.supportsVision) {
    properties.image_paths = {
      type: 'array',
      items: { type: 'string' },
      description: 'Local file paths of images to pass to the sub-agent for visual analysis',
    }
  }
  if (config.bgContext) {
    properties.run_in_background = {
      type: 'boolean',
      description:
        'Spawn sub-agent asynchronously and return agent_id immediately. 仅 master 私聊场景生效（持久化 + survive worker 重启）；其他场景被静默忽略并改为同步执行。',
    }
  }

  return {
    name: config.name,
    description: config.description,
    isReadOnly: true,
    inputSchema: {
      type: 'object',
      properties,
      required: ['task'],
    },
    call: async (input, callContext) => {
      const bgRequested = input.run_in_background === true

      if (bgRequested && config.bgContext) {
        const persistent = isPersistentMode(config.bgContext.workerContext)
        if (persistent) {
          const count = await config.bgContext.registry.countActiveByOwner(
            config.bgContext.owner.friend_id,
          )
          if (count >= BG_ENTITY_LIMIT_PER_OWNER) {
            return {
              output: `已达 ${BG_ENTITY_LIMIT_PER_OWNER} 个 bg entity 上限，请先 ListEntities + Kill 清理。`,
              isError: true,
            }
          }

          const agent_id = await spawnPersistentAgent({
            prompt: String(input.task),
            task_description: String(input.task),
            tools: config.subTools,
            ...(config.permissionConfig ? { permissionConfig: config.permissionConfig } : {}),
            systemPrompt: config.systemPrompt,
            model: config.model,
            ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
            adapter: config.adapter,
            owner: config.bgContext.owner,
            spawned_by_task_id: config.bgContext.spawned_by_task_id,
            registry: config.bgContext.registry,
            abortControllers: config.bgContext.abortControllers,
            traceContext: config.bgContext.traceContext,
            onExit: config.bgContext.onAgentExit,
          })
          return {
            output: `Sub-agent spawned (persistent): ${agent_id}\nUse Output("${agent_id}") to poll, Kill("${agent_id}") to terminate.`,
            isError: false,
          }
        }
        // 非持久场景（群聊 / 非 master）：bg 入参静默忽略，fall through 到同步路径
      }

      let childQueue: HumanMessageQueue | undefined
      if (config.parentHumanQueue) {
        childQueue = config.parentHumanQueue.createChild((content) => {
          const text = typeof content === 'string' ? content : '[多媒体纠偏消息]'
          return formatSupplementForSubAgent(text)
        })
      }

      // Create sub-agent independent trace
      const tc = config.traceConfig
      let subTrace: AgentTrace | undefined
      let subTraceCallback: ((event: EngineTurnEvent) => void) | undefined
      let subPromptDump: EngineOptions['onPromptDump']

      if (tc) {
        subTrace = tc.traceStore.startTrace({
          module_id: 'sub-agent',
          trigger: {
            type: 'sub_agent_call',
            summary: String(input.task).slice(0, 200),
          },
          parent_trace_id: tc.parentTraceId,
          parent_span_id: tc.parentSpanId,
          related_task_id: tc.relatedTaskId,
        })
        subPromptDump = (event) => {
          tc.traceStore.appendPromptDump({
            trace_id: subTrace!.trace_id,
            iteration: event.turn,
            source: 'subagent',
            model: event.model,
            system_prompt: event.systemPrompt,
            messages: event.messages,
          })
        }

        // onTurn fires post-hoc (after LLM + tools), so back-date span timestamps
        // with engine-measured ms to keep the waterfall accurate.
        subTraceCallback = (event: EngineTurnEvent) => {
          const llmEndedAtMs = event.llmStartedAtMs !== undefined && event.llmCallMs !== undefined
            ? event.llmStartedAtMs + event.llmCallMs
            : undefined

          const llmSpan = tc.traceStore.startSpan(subTrace!.trace_id, {
            type: 'llm_call',
            details: {
              iteration: event.turnNumber,
              input_summary: `turn ${event.turnNumber}`,
            },
            ...(event.llmStartedAtMs !== undefined ? { started_at_ms: event.llmStartedAtMs } : {}),
          })

          for (const toolCall of event.toolCalls) {
            const toolEndedAtMs = toolCall.startedAtMs !== undefined && toolCall.durationMs !== undefined
              ? toolCall.startedAtMs + toolCall.durationMs
              : undefined

            const toolSpan = tc.traceStore.startSpan(subTrace!.trace_id, {
              type: 'tool_call',
              parent_span_id: llmSpan.span_id,
              details: {
                tool_name: toolCall.name,
                input_summary: JSON.stringify(toolCall.input ?? {}).slice(0, 200),
              },
              ...(toolCall.startedAtMs !== undefined ? { started_at_ms: toolCall.startedAtMs } : {}),
            })
            tc.traceStore.endSpan(
              subTrace!.trace_id,
              toolSpan.span_id,
              toolCall.isError ? 'failed' : 'completed',
              {
                output_summary: String(toolCall.output).slice(0, 500),
                error: toolCall.isError ? String(toolCall.output) : undefined,
              },
              toolEndedAtMs,
            )
          }

          tc.traceStore.endSpan(
            subTrace!.trace_id,
            llmSpan.span_id,
            'completed',
            {
              stop_reason: event.stopReason ?? undefined,
              output_summary: event.assistantText.slice(0, 200) || undefined,
              tool_calls_count: event.toolCalls.length > 0 ? event.toolCalls.length : undefined,
            },
            llmEndedAtMs,
          )
        }
      }

      try {
        let prompt: string | ReadonlyArray<ContentBlock> = String(input.task)
        const imagePaths = input.image_paths as string[] | undefined
        if (config.supportsVision && imagePaths?.length) {
          const imageBlocks = await resolveImageFromPaths(imagePaths)
          if (imageBlocks.length > 0) {
            prompt = [
              { type: 'text' as const, text: String(input.task) },
              ...imageBlocks,
            ]
          }
        }

        const result = await forkEngine({
          prompt,
          adapter: config.adapter,
          model: config.model,
          systemPrompt: config.systemPrompt,
          tools: config.subTools,
          maxTurns: config.maxTurns,
          ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
          parentContext: input.context !== undefined ? String(input.context) : undefined,
          abortSignal: callContext.abortSignal,
          onTurn: subTraceCallback,
          ...(subPromptDump ? { onPromptDump: subPromptDump } : {}),
          supportsVision: config.supportsVision,
          humanMessageQueue: childQueue,
          hookRegistry: config.hookRegistry,
          lspManager: config.lspManager,
          permissionConfig: config.permissionConfig,
        })

        // exitToolCall 触发的早退视为业务完成；其余 'failed' / 'max_turns' 都是异常退出。
        const isAbnormalExit =
          (result.outcome === 'failed' || result.outcome === 'max_turns') &&
          result.exitToolCall === undefined

        if (subTrace && tc) {
          const traceSummary = result.output.slice(0, 200) || result.error?.slice(0, 200) || ''
          // max_turns 元信息独立 prefix，防被 partial output 覆盖（见 agent-handler.ts 同一处注释）。
          const maxTurnsTag = result.outcome === 'max_turns'
            ? `[max_turns reached after ${result.totalTurns} turns]`
            : ''
          const baseError = isAbnormalExit
            ? (result.error?.slice(0, 200) || result.output.slice(0, 200) || undefined)
            : undefined
          const errorWithTag = maxTurnsTag
            ? (baseError ? `${maxTurnsTag} ${baseError}` : maxTurnsTag)
            : baseError
          tc.traceStore.endTrace(subTrace.trace_id, isAbnormalExit ? 'failed' : 'completed', {
            summary: traceSummary,
            error: errorWithTag,
          })
        }

        const truncated = result.outcome === 'max_turns'
        return {
          output: JSON.stringify({
            output: result.output,
            outcome: result.outcome,
            // 顶层 stop_reason + truncated 让父 LLM 不用解 outcome 枚举
            stop_reason: truncated ? 'max_turns' : (result.outcome === 'failed' ? 'failed' : 'end_turn'),
            truncated,
            totalTurns: result.totalTurns,
            child_trace_id: subTrace?.trace_id,
            ...(result.error ? { error: result.error } : {}),
          }),
          isError: isAbnormalExit,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (subTrace && tc) {
          tc.traceStore.endTrace(subTrace.trace_id, 'failed', { summary: message, error: message })
        }
        return {
          output: `Sub-agent error: ${message}`,
          isError: true,
        }
      } finally {
        if (childQueue && config.parentHumanQueue) {
          config.parentHumanQueue.removeChild(childQueue)
        }
      }
    },
  }
}
