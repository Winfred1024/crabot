/**
 * Worker Handler v3 - 任务执行处理器（self-built engine）
 *
 * 使用自建 engine 替代 claude-agent-sdk 的 query()：
 * - runEngine() + AnthropicAdapter 驱动 LLM 循环
 * - ToolDefinition[] 统一工具注册
 * - humanMessageQueue 注入纠偏消息
 * - AbortController 取消任务
 * - MCP Server 工具自动转换为 ToolDefinition
 */

import {
  runEngine,
  createAdapter,
  createUserMessage,
  getConfiguredBuiltinTools,
  ProgressDigest,
  filterToolsByPermission,
} from '../engine/index.js'
import { BgEntityRegistry } from '../engine/bg-entities/registry.js'
import { TransientShellRegistry } from '../engine/bg-entities/bg-shell.js'
import type { BgEntityOwner, BgEntityRecord, BgEntityStatus, BgEntityType } from '../engine/bg-entities/types.js'
import type { BashBgContext } from '../engine/tools/index.js'
import type { BgToolDeps } from '../engine/tools/index.js'
import type { TaskContext } from '../mcp/crab-messaging.js'
import type { BgEntityTraceContext } from '../engine/bg-entities/trace.js'
import type {
  ToolDefinition,
  EngineTurnEvent,
  EngineResult,
  ContentBlock,
  EngineMessage,
  ProgressDigestConfig,
  ProgressDigestDeps,
  ToolPermissionConfig,
  LiveProgressEvent,
} from '../engine/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MemoryWriter } from '../orchestration/memory-writer.js'
import type {
  ExecuteTaskParams,
  ExecuteTaskResult,
  WorkerAgentContext,
  FrontAgentContext,
  WorkerTaskState,
  TaskId,
  TaskOrigin,
  ChannelMessage,
  TraceCallback,
  SkillConfig,
  BuiltinToolConfig,
  LiveTaskSnapshot,
  LiveToolCall,
  LiveCompletedTool,
  ResolvedPermissions,
  Friend,
  TaskSummary,
  MemoryPermissions,
  RuntimeSceneProfile,
  AgentTrace,
} from '../types.js'
import type { RpcClient } from 'crabot-shared'
import { createCrabMemoryServer } from '../mcp/crab-memory.js'
import type { MemoryTaskContext } from '../mcp/crab-memory.js'
import { mcpServerToToolDefinitions } from './mcp-tool-bridge.js'
import { formatMessageContent, resolveImageBlocks, EMPTY_MESSAGE_PLACEHOLDER } from './media-resolver.js'
import type { McpConnector } from './mcp-connector.js'
import { forkEngine } from '../engine/sub-agent.js'
import type { SubAgentTraceConfig } from '../engine/sub-agent.js'
import { createDelegateTaskTool } from './delegate-task-tool.js'
import type { RunSubAgentFn, RunSubAgentInput } from './delegate-task-tool.js'
import { createSubagentCoordinatorTools } from './subagent-coordinator-tools.js'
import { buildSubAgentFailureOutput } from './subagent-error-classifier.js'
import { filterToolsForSubAgent } from './subagent-tool-filter.js'
import { assembleSubAgentPrompt } from './subagent-prompt-assembler.js'
import type { SubAgentConfig } from '../types.js'
import { HumanMessageQueue } from '../engine/human-message-queue.js'
import { createCodingExpertHookRegistry, createCliPermissionHook } from '../hooks/defaults.js'
import { HookRegistry } from '../hooks/hook-registry.js'
import type { ContentReviewer } from '../hooks/types.js'
import { reviewCliContent } from './cli-content-reviewer.js'
import { PromptManager, formatChannelMessageLine, formatShortTermMemoryLine } from '../prompt-manager.js'
import { resolveSenderIdentity } from '../utils/sender-identity.js'
import { formatNow, formatChannelMessageTime, formatTaskCreatedAt, resolveTimezone, formatRuntimeMs } from '../utils/time.js'
import { getInstanceSkillsDir } from '../core/data-paths.js'
import { llmUsageToTrace } from '../core/trace-usage.js'
import { TodoStore } from './worker-todo-store.js'
import { createTodoTool } from './worker-todo-tool.js'
import { createSetTaskGoalTool } from './goal-tools.js'
import {
  buildAuditPrompt,
  buildAuditVerdictSummary,
  buildHumanQueueReport,
  resolveAuditJudgment,
  type AuditResult,
  type GoalAuditTaskGoal,
} from './goal-audit.js'
import { createSubmitAuditResultTool } from './goal-auditor-tools.js'

import { reflectStructuredOutcome } from '../orchestration/structured-outcome-reflector.js'

import * as fs from 'fs'
import * as path from 'path'
import { createHash, randomBytes, randomUUID } from 'crypto'
import * as os from 'os'

/**
 * 从 tool 输出 JSON 中提取 `child_trace_id`。
 * delegate_task 等派生子 trace 的工具会在返回 JSON 里带 `child_trace_id`，
 * 抓出来挂在 tool_call span.details 上，让 Admin UI 能内联展开子 trace。
 * 非 JSON / 无该字段 → 返回 undefined。
 * @internal exported for testing
 */
export function extractChildTraceIdFromOutput(output: string | undefined): string | undefined {
  if (!output) return undefined
  try {
    const parsed = JSON.parse(output) as { child_trace_id?: unknown }
    if (typeof parsed.child_trace_id === 'string' && parsed.child_trace_id.length > 0) {
      return parsed.child_trace_id
    }
  } catch {
    // 非 JSON output（如普通文本工具返回），忽略
  }
  return undefined
}

/** 已过时长的中文格式化（用于 trigger prompt 活跃任务渲染） */
function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分${sec % 60}秒`
  const hr = Math.floor(min / 60)
  return `${hr}小时${min % 60}分`
}

type ProgressReportMode = 'silent' | 'text_forward' | 'digest'

function getReportMode(
  sessionType: 'private' | 'group' | undefined,
  isMasterPrivate: boolean,
  extra: Record<string, unknown>,
): ProgressReportMode {
  const raw = sessionType === 'group'
    ? extra.progress_report_group
    : isMasterPrivate
      ? extra.progress_report_master_private
      : extra.progress_report_other_private
  if (raw === 'silent' || raw === 'text_forward' || raw === 'digest') return raw
  return 'digest'
}

const LOG_FILE = path.join(process.cwd(), '../data/agent-handler-debug.log')

function log(msg: string) {
  const ts = new Date().toISOString()
  try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`) } catch { /* ignore */ }
}

export interface AgentHandlerConfig {
  /**
   * Admin personality（system_prompt）。仅承载 personality，不再包含 skill listing。
   * skillListing 通过 `updateSkills` 维护，由 agent-handler 内 buildSkillListingSnapshot 即时拼装。
   */
  systemPrompt: string
  extra?: Record<string, unknown>
  /** 解析已校验的 IANA 时区，用于 prompt 时间感知。每次 LLM 调用 / 工具执行前重新读取，反映 admin 配置热更新 */
  getTimezone?: () => string
}

export interface AgentHandlerDeps {
  rpcClient: RpcClient
  moduleId: string
  resolveChannelPort: (channelId: string) => Promise<number>
  getMemoryPort: () => Promise<number>
  /** Admin RPC 端口解析（get_task_details 工具用） */
  getAdminPort?: () => Promise<number>
  /**
   * 返回当前 task 的 permissionConfig（基于 task 自带的 resolved_permissions，
   * 缺省时回退到全局/会话级解析或 FAIL_CLOSED 兜底）。
   * 把 resolvedPerms 显式传入而不是读 UnifiedAgent 上的全局字段，是为了避免并发任务串改。
   */
  getPermissionConfig?: (
    tools: ReadonlyArray<ToolDefinition>,
    resolvedPerms?: ResolvedPermissions,
  ) => ToolPermissionConfig
  /** 反思补轮注入接口（测试用）。生产路径走默认 reflectStructuredOutcome。 */
  reflectFn?: typeof reflectStructuredOutcome
}

import type { LLMFormat } from '../engine/llm-adapter'

export interface WorkerTraceContext {
  traceStore: import('../core/trace-store').TraceStore
  traceId: string
  relatedTaskId?: string
}

// ============================================================================
// runWorkerLoop shared types
// ============================================================================

export interface RunWorkerLoopOptions {
  /** Override the initial user prompt sent to LLM. Default: taskMessage built from task. */
  readonly initialPrompt?: string | ContentBlock[]
  /**
   * 从已有消息历史恢复，跳过 buildTaskMessage + 初始 createUserMessage。
   * waiting → executing 续跑路径使用：传入上一轮 finalMessages + 通知消息。
   */
  readonly initialMessages?: ReadonlyArray<EngineMessage>
  /**
   * 跳过 finally 中的 humanQueues / activeTasks / liveSnapshots 清理。
   * waiting 循环续跑时由 executeTask 统一负责清理。
   */
  readonly skipCleanup?: boolean
  /**
   * 复用已有的 HumanMessageQueue（waiting → executing 续跑时传入）。
   * 若未提供，runWorkerLoop 会新建一个。
   */
  readonly providedHumanQueue?: HumanMessageQueue
  /** Extra tools appended to the dynamic tool list (e.g., exit tools for trigger flow). */
  readonly extraTools?: ReadonlyArray<ToolDefinition>
  /**
   * Overdue config passed straight to runEngine — 让 engine 在主 loop 内同步注入
   * user msg 提示 worker。这条路径会污染主 loop 上下文，**默认不用**；保留供
   * 极少数需要"超期强制 worker 中断去汇报"的场景。
   *
   * 一般诉求（用户超期想看到进度）走 `digestOverdueMs` —— 旁路 fork 一次发用户，
   * 不污染主 loop。
   */
  readonly overdueConfig?: import('../engine/types.js').OverdueConfig
  /**
   * 超期触发 ProgressDigest 单次 fork-and-send 的延迟（毫秒，相对于 worker
   * 启动时刻）。是 `overdueConfig` 的旁路替代：不注入主 loop，仅通过 digest 通道
   * fork 一次发用户。reportMode='digest' 时生效；其他 reportMode 下被静默忽略
   * （silent/text_forward 本来就不该被超期打扰）。
   */
  readonly digestOverdueMs?: number
  /** Called once per turn AFTER traceCallback wiring, with the toolCalls of that turn.
   *  Used by trigger flow to detect send_message. */
  readonly onAfterTurn?: (event: EngineTurnEvent) => void
  /** 抑制 forced_summary 注入。详见 EngineOptions.suppressForcedSummary。
   *  unified loop 传 `() => finalSent` 让 silent end_turn 视为完成。 */
  readonly suppressForcedSummary?: () => boolean
}

export interface RunWorkerLoopResult {
  readonly engineResult: EngineResult
  readonly taskState: WorkerTaskState
  readonly humanQueue: HumanMessageQueue
  readonly digest: ProgressDigest | undefined
  readonly loopSpanId: string | undefined
}

export interface SdkEnvConfig {
  modelId: string
  format: LLMFormat
  supportsVision?: boolean
  /** Provider 配置的 max_output_tokens；未配置时 adapter 走各自的处理策略 */
  maxTokens?: number
  env: Record<string, string>
}

export function adapterFromSdkEnv(sdkEnv: SdkEnvConfig) {
  return createAdapter({
    endpoint: sdkEnv.env.LLM_BASE_URL ?? '',
    apikey: sdkEnv.env.LLM_API_KEY ?? '',
    format: sdkEnv.format,
    ...(sdkEnv.env.LLM_ACCOUNT_ID ? { accountId: sdkEnv.env.LLM_ACCOUNT_ID } : {}),
  })
}

/** 给 skills 列表算一个内容 hash 用于 dedupe；name + content + skill_dir 三元组决定身份 */
function computeSkillsHash(skills: ReadonlyArray<SkillConfig>): string {
  const h = createHash('sha256')
  for (const s of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(s.name)
    h.update('\0')
    h.update(s.content)
    h.update('\0')
    h.update(s.skill_dir ?? '')
    h.update('\0')
  }
  return h.digest('hex')
}


// ============================================================================
// AgentHandler
// ============================================================================

export interface AgentHandlerOptions {
  mcpConfigFactory?: (taskCtx: TaskContext) => Record<string, McpServer>
  deps?: AgentHandlerDeps
  builtinToolConfig?: BuiltinToolConfig
  mcpConnector?: McpConnector
  digestSdkEnv?: SdkEnvConfig
  subAgents?: ReadonlyArray<SubAgentConfig>
  skills?: ReadonlyArray<SkillConfig>
  lspManager?: import('../lsp/lsp-manager').LSPManager
  memoryWriter?: MemoryWriter
  /**
   * Prompt 装配器。Worker 在每轮 LLM 调用前用它把 personality + skill listing + sub-agent
   * 重新拼成 system prompt，以便 updateSkills / updateSystemPrompt 即时生效。
   */
  promptManager?: PromptManager
}

export interface ExecuteTriggerMessageParams {
  /** 触发消息列表（已合并：多条相邻同 sender 消息可能合一） */
  readonly messages: ReadonlyArray<ChannelMessage>
  /** 当前活跃任务摘要 */
  readonly activeTasks: ReadonlyArray<TaskSummary>
  /** 是否群聊 */
  readonly isGroup: boolean
  /** 当前场景画像（私聊也可能有） */
  readonly sceneProfile?: RuntimeSceneProfile
  /** 触发消息发送者 friend 信息 */
  readonly senderFriend: Friend
  /** 触发消息进入 agent 的时刻（用于 overdue 计算） */
  readonly triggerArrivedAtMs: number
  /** 超期阈值（毫秒）；默认 30_000 */
  readonly timeoutMs?: number
  /**
   * 是否启用超期提醒；默认 true。
   *
   * 启用后超期时通过 ProgressDigest 旁路 fork 一次主 loop messages 生成汇报发
   * 给用户，不污染主 loop。仅在 reportMode='digest' 下生效（silent / text_forward
   * 模式用户已经主动选择了别的汇报形式）。
   *
   * 历史：早期实现是 engine 同步向主 loop 注入 user msg 提示 worker 主动 send_message，
   * 代价是焦点漂移 + token 永久占据。现已统一走 digest 旁路通道。
   */
  readonly overdueReminderEnabled?: boolean
  /** 内存权限 */
  readonly memoryPermissions: MemoryPermissions
  /** 解析后的发送者权限 */
  readonly resolvedPermissions: ResolvedPermissions
  /** Channel / session 标识 */
  readonly channelId: string
  readonly sessionId: string
  /**
   * Dispatch LLM 生成的任务摘要（dispatchAction.text）。
   * 用作 task title / description；缺省时回退到 triggerSummary（原始消息切片）。
   * 仅影响 task 元数据展示（Admin UI / Front supplement_task 决策清单 / Worker prompt 任务信息段），
   * worker 拿到的 trigger_messages 仍是原始保真消息。
   */
  readonly dispatchActionText?: string
  /**
   * 完整的 Front Agent context（由 unified-agent 在调用 executeTriggerMessage 前装配）。
   * 包含 recent_messages / time_windows / active_tasks / sender_friend / scene_profile / crab_display_name 等，
   * 用于构造 worker 风格的 user prompt（含 channel/session/聊天历史/活跃任务）。
   */
  readonly frontContext: FrontAgentContext
}

export interface ExecuteTriggerMessageResult {
  /** Engine 结束原因 */
  readonly outcome: 'completed' | 'failed' | 'max_turns' | 'aborted'
  /** 最终 assistant 文本（未必是发给用户的——可能仍是内部 reasoning） */
  readonly finalText: string
  /** 早退工具调用（supplement_task / stay_silent）。若 loop 自然结束则 undefined */
  readonly exitToolCall?: { readonly name: string; readonly input: Record<string, unknown> }
  /** 是否触发过超期注入 */
  readonly overdueInjected: boolean
  /** loop 内是否调过 send_message（任一 messaging tool） */
  readonly sentMessage: boolean
  /** Engine 错误信息（outcome=failed 时填） */
  readonly error?: string
  /** Trace ID（供 caller 关联） */
  readonly traceId?: string
}

export class AgentHandler {
  private sdkEnv: SdkEnvConfig
  private systemPrompt: string
  private activeTasks: Map<TaskId, WorkerTaskState> = new Map()
  /** Human message queues for active tasks */
  private humanQueues: Map<TaskId, HumanMessageQueue> = new Map()
  /**
   * 飞行中任务的实时快照：current_turn / 上一轮模型话 / active_tools / 最近完成的工具。
   * 由 onLiveProgress 回调维护；executeTask 完成时清理。
   * ContextAssembler 同进程同步读取（getLiveSnapshot）以注入 Front prompt。
   */
  private liveSnapshots: Map<TaskId, LiveTaskSnapshot> = new Map()
  /** recent_completed 保留的最大条数 */
  private static readonly RECENT_COMPLETED_LIMIT = 5
  private mcpConfigFactory: ((taskCtx: TaskContext) => Record<string, McpServer>) | undefined
  private deps?: AgentHandlerDeps
  private builtinToolConfig?: BuiltinToolConfig
  private mcpConnector?: McpConnector
  private extra: Record<string, unknown>
  private digestSdkEnv?: SdkEnvConfig
  /**
   * 当前 subagent 列表（可被 updateSubagents 热更新）。
   * 注意：in-flight worker loop 启动时 snapshot 这个引用，loop 内不再读 this.subAgents——
   * 见 runWorkerLoop 顶部 `const subAgentsSnapshot = this.subAgents`。
   */
  private subAgents: ReadonlyArray<SubAgentConfig>
  private skills: ReadonlyArray<SkillConfig>
  private readonly lspManager?: import('../lsp/lsp-manager').LSPManager
  private memoryWriter?: MemoryWriter
  private readonly promptManager?: PromptManager
  private readonly getTimezone: () => string
  /** Worker-singleton bg entity registry (persistent, disk-backed) */
  private readonly bgRegistry = new BgEntityRegistry()
  /** Worker-singleton transient shell registry (in-memory, task-bound) */
  private readonly transientShells = new TransientShellRegistry()
  /** Per-task output cursor map: key = `${taskId}:${entityId}` → byte offset */
  private readonly bgCursorMap = new Map<string, number>()
  /** AbortControllers for running bg sub-agents (key=entity_id); shared with BgToolDeps + SubAgentBgContext */
  private readonly agentAbortControllers = new Map<string, AbortController>()
  /** Skills 写盘的串行化 + 内容指纹去重；防止 admin 启动期多个 trigger 并发推送时的写盘竞态 */
  private skillsWritePromise: Promise<void> = Promise.resolve()
  private lastSkillsHash: string = ''
  /**
   * Bg entity exit / 重要事件的待发通知队列。key 是 address——
   *   - `friend:<friend_id>`：持久 entity 的 owner，下一次该 friend 任意 task 启动时收到
   *   - `task:<task_id>`：transient entity（task 内事件），下一轮 agent loop 收到（待 Phase 2，本期未实现）
   * 参 Claude Code enqueueShellNotification + LocalAgentTask.enqueueAgentNotification 设计。
   */
  private readonly pendingBgNotifications = new Map<string, string[]>()
  /** Interval handle for periodic 24h GC of dead entities */
  private gcIntervalHandle?: NodeJS.Timeout

  constructor(
    sdkEnv: SdkEnvConfig,
    config: AgentHandlerConfig,
    options?: AgentHandlerOptions,
  ) {
    this.sdkEnv = sdkEnv
    this.mcpConfigFactory = options?.mcpConfigFactory
    this.deps = options?.deps
    this.systemPrompt = config.systemPrompt
    this.builtinToolConfig = options?.builtinToolConfig
    this.mcpConnector = options?.mcpConnector
    this.extra = config.extra ?? {}
    this.digestSdkEnv = options?.digestSdkEnv
    this.subAgents = options?.subAgents ?? []
    this.skills = options?.skills ?? []
    this.lspManager = options?.lspManager
    this.memoryWriter = options?.memoryWriter
    this.promptManager = options?.promptManager
    this.getTimezone = config.getTimezone ?? (() => resolveTimezone(undefined))

    // 确保 instance skills 目录存在；实际内容靠 admin 的 update_config 推送
    // （admin 在 module_started 事件后 1s 内必推一次），不在 ctor 里 fire-and-forget 写盘
    // 避免与 admin push 撞 race（启动期 admin 多个 trigger 可能并发触发 updateSkills）
    fs.mkdirSync(getInstanceSkillsDir(), { recursive: true })

    // Startup: recover persistent bg entities (mark dead shells as failed, stalled agents)
    void this.bgRegistry.recoverPersistent().catch((err) => {
      console.error('[AgentHandler] bg-entities recovery failed:', err)
    })

    // Startup: GC dead entities older than 7 days
    void this.bgRegistry.gcDeadEntities(new Date()).catch((err) => {
      console.error('[AgentHandler] bg-entities gc failed:', err)
    })

    // Periodic 24h GC — .unref() so it does not block process exit
    this.gcIntervalHandle = setInterval(() => {
      void this.bgRegistry.gcDeadEntities(new Date()).catch((err) => {
        console.error('[AgentHandler] periodic gc failed:', err)
      })
    }, 24 * 60 * 60 * 1000)
    this.gcIntervalHandle.unref()
  }

  /**
   * Release resources (clears the periodic GC interval).
   * Call this in tests and when the worker is being shut down to avoid timer leaks.
   */
  dispose(): void {
    if (this.gcIntervalHandle) {
      clearInterval(this.gcIntervalHandle)
      this.gcIntervalHandle = undefined
    }
  }

  /**
   * 把一条 bg entity 通知挂到队列，下一次匹配 addressKey 的 task 启动时被 drain 出来
   * 拼到 user message 头部（参 Claude Code enqueueShellNotification 设计）。
   *
   * addressKey 形式：
   *   - `friend:<friend_id>`：跨 task 持久通知（持久 entity 的 owner_friend）
   *   - `task:<task_id>`：仅当前 task 内通知（transient entity；当前 phase 未实现 mid-task 注入）
   */
  enqueueBgNotification(addressKey: string, message: string): void {
    const list = this.pendingBgNotifications.get(addressKey) ?? []
    list.push(message)
    this.pendingBgNotifications.set(addressKey, list)
  }

  /** Drain 并返回 wrapped 的 <bg-notification> 块（已包标签）。无则返回空串。 */
  private drainBgNotifications(addressKey: string): string {
    const list = this.pendingBgNotifications.get(addressKey)
    if (!list || list.length === 0) return ''
    this.pendingBgNotifications.delete(addressKey)
    return list
      .map((m) => `<bg-notification>\n${m}\n</bg-notification>`)
      .join('\n')
  }

  /**
   * 热加载：更新 skills 列表 + atomic write 到 instance 级目录。
   * - 先同步更新 this.skills（保证后续 buildSystemPrompt / Skill 工具读到最新 list）
   * - 串行化磁盘写：所有写盘排队执行，进入临界区时读最新 this.skills snapshot；
   *   即使 admin 启动期多个 trigger 并发推送，最终落盘的也是最后一次的内容
   * - 内容指纹去重：连续同样内容的 push 跳过 IO
   */
  updateSkills(newSkills: ReadonlyArray<SkillConfig>): void {
    this.skills = newSkills
    void this.scheduleSkillsDiskSync()
  }

  /** 把"写最新 this.skills 到 disk"排到串行队列尾部 */
  private scheduleSkillsDiskSync(): void {
    this.skillsWritePromise = this.skillsWritePromise
      .then(() => this.writeSkillsToInstancePath())
      .catch((err) => {
        console.error('[AgentHandler] skills disk write failed:', err)
      })
  }

  private async writeSkillsToInstancePath(): Promise<void> {
    // 进入临界区时读最新 snapshot——保证最后排队的写赢，且内容是最新
    const snapshot = this.skills
    const hash = computeSkillsHash(snapshot)
    if (hash === this.lastSkillsHash) {
      // 内容未变化，跳过 IO（启动期 admin 多个 trigger 推同样 config 的常见场景）
      return
    }

    const skillsRoot = getInstanceSkillsDir()
    // tmpDir 加 8 字节随机后缀防同 ms 撞名（若 mutex 被绕过也安全）
    const tmpDir = `${skillsRoot}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`
    await fs.promises.mkdir(tmpDir, { recursive: true })
    for (const skill of snapshot) {
      const skillDir = path.join(tmpDir, skill.name)
      await fs.promises.mkdir(skillDir, { recursive: true })
      await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), skill.content, 'utf-8')
      if (skill.skill_dir) {
        await fs.promises.writeFile(path.join(skillDir, '.skill_dir'), skill.skill_dir, 'utf-8')
      }
    }
    // POSIX atomic swap：先删旧 + rename tmp → 目标
    await fs.promises.rm(skillsRoot, { recursive: true, force: true })
    await fs.promises.mkdir(path.dirname(skillsRoot), { recursive: true })
    await fs.promises.rename(tmpDir, skillsRoot)
    this.lastSkillsHash = hash
  }

  /**
   * 热加载：更新 base system prompt（admin personality）。下次 LLM 调用时生效。
   *
   * `undefined` 表示"不变"，保留当前值；caller 想清空 personality 应明确传 `''`。
   * 这与 handleUpdateConfig 的 `!== undefined` 守卫语义一致：
   * undefined 是 "字段未改动"，空字符串是 "明确设为空"。
   */
  updateSystemPrompt(newPrompt: string | undefined): void {
    if (newPrompt === undefined) return
    this.systemPrompt = newPrompt
  }

  /**
   * 热加载：更新 subagent 列表。
   *
   * 设计与 skills 的区别：subagents 用 snapshot 模式，**不影响 in-flight loop**。
   * runWorkerLoop 顶部把 this.subAgents 快照进闭包，loop 内 buildToolsDynamic /
   * buildSystemPrompt 走快照，避免任务中途换 subagent 配置打乱推理。
   * 下次新 worker loop 启动时拿到最新列表。
   */
  updateSubagents(newList: ReadonlyArray<SubAgentConfig>): void {
    this.subAgents = newList
  }

  /**
   * 热加载：更新主 LLM sdkEnv（model_config 变更时调）。
   *
   * 与 updateSubagents 同样走 snapshot 模式：runWorkerLoop 启动时已 capture
   * adapter / modelId，in-flight loop 继续用旧 adapter；下次 loop 用新。
   *
   * digestSdkEnv 单独可选；不传时保留旧值（与 updateSystemPrompt 同语义）。
   */
  updateSdkEnv(sdkEnv: SdkEnvConfig, digestSdkEnv?: SdkEnvConfig): void {
    this.sdkEnv = sdkEnv
    if (digestSdkEnv !== undefined) {
      this.digestSdkEnv = digestSdkEnv
    }
  }

  /** 暴露 subagents 当前值的只读快照（测试 / 诊断用，不应在 hot loop 中调）。 */
  getSubagentsSnapshot(): ReadonlyArray<SubAgentConfig> {
    return this.subAgents
  }

  /** 暴露 sdkEnv 当前值（测试 / 诊断用）。 */
  getSdkEnvSnapshot(): SdkEnvConfig {
    return this.sdkEnv
  }

  /** 暴露 digestSdkEnv 当前值（测试 / 诊断用）；未配置返回 undefined。 */
  getDigestSdkEnvSnapshot(): SdkEnvConfig | undefined {
    return this.digestSdkEnv
  }

  /**
   * 热加载：更新 extra（progress_digest_interval_seconds 等）。
   * 下次 executeTask 构造 ProgressDigest 时会读到新值。
   */
  updateExtra(extra: Record<string, unknown>): void {
    this.extra = { ...this.extra, ...extra }
  }

  async executeTask(
    params: ExecuteTaskParams,
    traceCallback?: TraceCallback,
    traceContext?: WorkerTraceContext,
  ): Promise<ExecuteTaskResult> {
    const { task, context } = params

    // waiting 循环：loop 结束后检查异步子 agent，若有则等通知再续跑
    let loopResult: RunWorkerLoopResult | undefined
    let currentInitialMessages: ReadonlyArray<EngineMessage> | undefined
    let currentHumanQueue: HumanMessageQueue | undefined

    while (true) {
      try {
        loopResult = await this.runWorkerLoop(task, context, traceCallback, traceContext, {
          skipCleanup: true,
          ...(currentHumanQueue ? { providedHumanQueue: currentHumanQueue } : {}),
          ...(currentInitialMessages ? { initialMessages: currentInitialMessages } : {}),
        })
      } catch (error) {
        this.cleanupWorkerLoopResources(task.task_id)
        const errorMessage = error instanceof Error ? error.message : String(error)
        log(`Worker error: ${errorMessage}`)
        return { task_id: task.task_id, outcome: 'failed', error: `执行失败: ${errorMessage}` }
      }

      const { engineResult, taskState, humanQueue } = loopResult
      currentHumanQueue = humanQueue

      // failed 或被 abort：直接退出，不进 waiting
      if (engineResult.outcome === 'failed' || taskState.abortController.signal.aborted) {
        break
      }

      // 检查本 task 派出的、仍在运行的异步 bg-agent
      const pendingChildren = await this.bgRegistry.list({ spawned_by_task_id: task.task_id, status: ['running'] })

      if (pendingChildren.length === 0) {
        break  // 无异步子 agent：正常完成路径
      }

      // 有 pending children → 进 waiting 态
      log(`Task ${task.task_id}: waiting for ${pendingChildren.length} async child agent(s)`)
      try {
        if (this.deps?.getAdminPort && this.deps.rpcClient) {
          const adminPort = await this.deps.getAdminPort()
          await this.deps.rpcClient.call(adminPort, 'update_task_status', {
            task_id: task.task_id,
            status: 'waiting',
          }, this.deps.moduleId)
        }
      } catch (err) {
        log(`Failed to set task ${task.task_id} to waiting: ${err}`)
      }

      // 等待 humanQueue 有新内容（子 agent 通知 或 用户 supplement）
      await humanQueue.waitForPush(taskState.abortController.signal as AbortSignal)

      if (taskState.abortController.signal.aborted) {
        break
      }

      // 恢复 executing
      try {
        if (this.deps?.getAdminPort && this.deps.rpcClient) {
          const adminPort = await this.deps.getAdminPort()
          await this.deps.rpcClient.call(adminPort, 'update_task_status', {
            task_id: task.task_id,
            status: 'executing',
          }, this.deps.moduleId)
        }
      } catch (err) {
        log(`Failed to resume task ${task.task_id} to executing: ${err}`)
      }

      // 拉走所有 pending 通知，拼成新一轮的首条 user message
      const pendingNotifs = humanQueue.drainPending()
      const notifText = pendingNotifs
        .map((m) => (typeof m === 'string' ? m : '[media]'))
        .join('\n')

      // 下一轮 loop 从上一轮 finalMessages + 通知消息继续
      currentInitialMessages = [
        ...engineResult.finalMessages,
        createUserMessage(notifText),
      ]
    }

    // 清理（统一由 executeTask 处理，runWorkerLoop skipCleanup=true 跳过了）
    this.cleanupWorkerLoopResources(task.task_id)

    if (!loopResult) {
      return { task_id: task.task_id, outcome: 'failed', error: '无循环结果' }
    }

    const { engineResult, taskState } = loopResult

    if (engineResult.error) {
      log(`Engine error (outcome=${engineResult.outcome}, turns=${engineResult.totalTurns}): ${engineResult.error}`)
    }

    // 8. Failed outcomes: surface the engine error as the summary.
    let finalEngineResult = engineResult
    const isError = engineResult.outcome === 'failed'
    if (isError && engineResult.error) {
      finalEngineResult = { ...engineResult, finalText: `执行失败 (${engineResult.totalTurns}轮后): ${engineResult.error}` }
    }

    // Check if task was aborted
    if (taskState.abortController.signal.aborted) {
      return { task_id: task.task_id, outcome: 'failed', error: '任务被取消' }
    }

    // 8.5 Finalize: update admin task status + run structured reflection + memory write
    await this.finalizeTask(task.task_id, finalEngineResult, context)

    // 9. Map EngineResult → ExecuteTaskResult
    return this.mapEngineResult(task.task_id, finalEngineResult)
  }

  /**
   * 共享 worker loop：构造适配器、工具集、system prompt，运行 runEngine，
   * 返回原始结果供 executeTask（完整任务）和 executeTriggerMessage（trigger 流）分别处理收尾。
   *
   * opts 允许 trigger 流注入 extraTools（exit 工具）、initialPrompt（user 侧 trigger prompt）、
   * overdueConfig（超期提醒），以及 onAfterTurn 回调（检测 send_message 工具调用）。
   *
   * 注意：try/finally 清理（activeTasks / humanQueues / liveSnapshots / transientShells / bgCursorMap）
   * 在本方法内完成，对 executeTask 和 executeTriggerMessage 两个 caller 均透明。
   */
  private async runWorkerLoop(
    task: ExecuteTaskParams['task'],
    context: WorkerAgentContext,
    traceCallback?: TraceCallback,
    traceContext?: WorkerTraceContext,
    opts?: RunWorkerLoopOptions,
  ): Promise<RunWorkerLoopResult> {
    // idempotent：trigger 路径已由 registerTriggerAndActivate 提前 set；
    // executeTask 路径仍由本方法新建。
    let taskState = this.activeTasks.get(task.task_id)
    if (!taskState) {
      taskState = {
        taskId: task.task_id,
        status: 'executing',
        startedAt: new Date().toISOString(),
        title: task.task_title,
        triggerType: task.source?.trigger_type === 'scheduled' ? 'scheduled' : 'message',
        abortController: new AbortController(),
        pendingHumanMessages: [],
        taskOrigin: context.task_origin,
        todoStore: new TodoStore(),
      }
      this.activeTasks.set(task.task_id, taskState)
    }

    // Init live snapshot（query-loop 的 onLiveProgress 会逐步填充）
    this.liveSnapshots.set(task.task_id, {
      task_id: task.task_id,
      current_turn: 0,
      started_at: Date.now(),
      active_tools: [],
      recent_completed: [],
    })

    // Create human message queue for this task（waiting 续跑时复用已有 queue）
    const humanQueue = opts?.providedHumanQueue ?? new HumanMessageQueue()
    this.humanQueues.set(task.task_id, humanQueue)

    let digest: ProgressDigest | undefined
    let loopSpanId: string | undefined

    try {
      // skillsDir 在 worker init / updateSkills 时已经写好（instance-level），这里不再 per-task 写盘

      // Snapshot subagents at loop start. updateSubagents（admin 改 subagents 或 model_config 触发）
      // 走 hot-update 改 this.subAgents，但 in-flight loop 必须用 snapshot：避免中途换 subagent
      // 列表后，LLM 看到的 system prompt 列表 / delegate_task 工具 enum 跟它之前的推理矛盾。
      // 下次新 loop 启动时取最新 this.subAgents。
      const subAgentsSnapshot = this.subAgents

      // Build tools — adapter / sub-agent trace config 等无依赖项先行构造
      const adapter = adapterFromSdkEnv(this.sdkEnv)
      const subAgentTraceConfig = traceContext ? {
        traceStore: traceContext.traceStore,
        parentTraceId: traceContext.traceId,
        relatedTaskId: traceContext.relatedTaskId,
      } : undefined

      // Trace search tool (异步 import，提前加载，lambda 内只用同步引用)
      const traceSearchTool = traceContext
        ? (await import('./trace-search-tool.js')).createSearchTracesTool(traceContext.traceStore)
        : undefined

      // Goal mode：worker 启动时拍当前 task.goal 状态快照，构造同步 getter
      // spec: 2026-05-23-goal-mode-design.md §7.5
      //
      // hasGoal 在 crab-messaging TaskContext 和 todo 工具 deps 中都是同步 getter，
      // 但 admin RPC 是 async。折中：启动时 query 一次拍快照到 goalSetCache，
      // 之后 worker 调 set_task_goal 工具时由 callAdminRpc 包装层同步更新 cache，
      // 后续 turn 的 todo / send_message 检查 cache 立即生效，免去重复 RPC。
      const goalModeEnabled = this.extra?.goal_mode_enabled !== false && task.source?.trigger_type !== 'scheduled'
      let goalSetCache = false
      if (goalModeEnabled && this.deps?.getAdminPort && this.deps.rpcClient) {
        try {
          const adminPort = await this.deps.getAdminPort()
          const resp = await this.deps.rpcClient.call<
            { task_id: string },
            { task: { goal?: unknown } }
          >(adminPort, 'get_task', { task_id: task.task_id }, this.deps.moduleId)
          goalSetCache = resp.task.goal !== undefined
        } catch {
          // admin 不可用：保持 backward-compat，等同 no goal（audit gate 透明放行）
        }
      }

      // get_task_details 工具：让 worker 能查任意历史任务的完整执行复盘（用于"继续上次"场景）
      // digest LLM 用于超阈值时压缩；缺省则只截断
      const digestAdapterForTool = this.digestSdkEnv ? adapterFromSdkEnv(this.digestSdkEnv) : undefined
      const getTaskDetailsTool = (traceContext && this.deps?.getAdminPort)
        ? (await import('./get-task-details-tool.js')).createGetTaskDetailsTool({
            rpcClient: this.deps.rpcClient,
            moduleId: this.deps.moduleId,
            getAdminPort: this.deps.getAdminPort,
            traceStore: traceContext.traceStore,
            digestAdapter: digestAdapterForTool,
            digestModelId: this.digestSdkEnv?.modelId,
          })
        : undefined

      // bg-entities trace context: attach to current task's agent_loop trace.
      const bgTraceCtx: BgEntityTraceContext | undefined = traceContext
        ? { traceStore: traceContext.traceStore, traceId: traceContext.traceId }
        : undefined

      // 工具列表构造改为 callback 形式：每轮 LLM 调用前由 query-loop 重新 resolve，
      // 让 admin push config（updateSkills / updateSystemPrompt）能在同一 task 内热生效。
      // 注意：lambda 内捕获 taskState / context / humanQueue 等闭包变量，
      // 行为与原一次性构造等价。
      const buildToolsDynamic = (): ReadonlyArray<ToolDefinition> => {
        const tools: ToolDefinition[] = []

        // 3. crab-memory MCP server tools
        const memoryTaskCtx: MemoryTaskContext = {
          taskId: task.task_id,
          channelId: context.task_origin?.channel_id,
          sessionId: context.task_origin?.session_id,
          visibility: context.memory_permissions?.write_visibility ?? 'public',
          scopes: context.memory_permissions?.write_scopes ?? [],
          sourceType: context.task_origin ? 'conversation' : 'system',
          sessionType: context.task_origin?.session_type,
          senderFriendId: context.sender_friend?.id,
        }
        if (this.deps?.getMemoryPort) {
          const crabMemoryServer = createCrabMemoryServer({
            rpcClient: this.deps.rpcClient,
            moduleId: this.deps.moduleId,
            getMemoryPort: this.deps.getMemoryPort,
          }, memoryTaskCtx)
          tools.push(...mcpServerToToolDefinitions(crabMemoryServer, 'crab-memory'))
        }

        // baseTools / baseToolsPermissionConfig 是后面（line ~860+）才构造的；这里用 outer let
        // 提前声明，让 mcpConfigFactory 通过 getter 拿到 audit 用的 worker baseTools +
        // permissionConfig（auditor 调 dangerous 工具如 Bash 时 runtime permission check 才能放行）。
        // spec: 2026-05-23-goal-mode-design.md §6 / §7.2（auditor 工具来源）
        let auditBaseTools: ReadonlyArray<ToolDefinition> = []
        let auditPermissionCfg: ToolPermissionConfig | undefined

        // 3c. External MCP server tools (crab-messaging, etc.)
        const externalMcpServers = this.mcpConfigFactory?.({
          taskId: task.task_id,
          humanQueue,
          triggerType: task.source?.trigger_type === 'scheduled' ? 'scheduled' : 'message',
          // 用 getter 形式封装本地 cache，worker 中途 set_task_goal 后下一轮工具调用立即生效。
          hasGoal: () => goalSetCache,
          // 透传 sub-agent trace 上下文：让 audit gate 触发的 audit subagent
          // 产生的 sub_agent_call span 挂到主 worker trace 下，admin UI 能渲染。
          // spec: 2026-05-23-goal-mode-design.md §4.2
          ...(subAgentTraceConfig ? { traceConfig: subAgentTraceConfig } : {}),
          // getter 形式 forward-reference：baseTools 在下方 ~line 860 构造，
          // audit gate 真正触发时 baseTools / permissionConfig 已就位。
          auditParentTools: () => auditBaseTools,
          auditPermissionConfig: () => auditPermissionCfg,
        }) ?? {}
        for (const [serverName, server] of Object.entries(externalMcpServers)) {
          tools.push(...mcpServerToToolDefinitions(server, serverName))
        }

        // 3d. External MCP tools (from Admin-managed servers via McpConnector)
        if (this.mcpConnector) {
          const externalTools = this.mcpConnector.getAllTools()
          tools.push(...externalTools)
        }

        // 3e. Built-in file/shell tools (filtered by Admin config)
        const skillsSnapshot = this.skills
        const bgOwner: BgEntityOwner = {
          friend_id: context.sender_friend?.id ?? `__system_${context.task_origin?.session_id ?? 'unknown'}`,
          session_id: context.task_origin?.session_id,
          channel_id: context.task_origin?.channel_id,
        }
        // push notification 接线：bg shell 自然 exit 时排到该 friend 的下一次 task prompt
        // 仅持久（master 私聊）路径有意义；transient 在 task 结束被 kill，agent 此时也不在了
        const onShellExit: BashBgContext['onShellExit'] = (info) => {
          if (info.mode !== 'persistent') return
          const runtimeStr = formatRuntimeMs(info.runtime_ms)
          const message =
            `Background shell ${info.entity_id} 已退出。\n` +
            `状态: ${info.status} (exit_code=${info.exit_code})\n` +
            `运行时长: ${runtimeStr}\n` +
            `命令: ${info.command.slice(0, 200)}${info.command.length > 200 ? '...' : ''}\n` +
            `提示: 用 Output("${info.entity_id}") 读完整输出，确认后用 Kill 清理（即使已 exit 也建议清以防混淆）`
          this.enqueueBgNotification(`friend:${bgOwner.friend_id}`, message)
        }
        const bgEntityCtx: BashBgContext = {
          registry: this.bgRegistry,
          transient: this.transientShells,
          workerContext: context,
          owner: bgOwner,
          taskId: task.task_id,
          traceContext: bgTraceCtx,
          onShellExit,
        }
        const bgToolDeps: BgToolDeps = {
          registry: this.bgRegistry,
          transient: this.transientShells,
          cursorMap: this.bgCursorMap,
          taskId: task.task_id,
          ownerFriendId: bgOwner.friend_id,
          agentAbortControllers: this.agentAbortControllers,
        }
        tools.push(...getConfiguredBuiltinTools(
          os.homedir(),
          this.builtinToolConfig,
          {
            skillsDir: skillsSnapshot.length > 0 ? getInstanceSkillsDir() : undefined,
            bgEntityCtx,
            bgToolDeps,
          },
        ))

        // 3f. delegate_task 工具（单一入口；sub-agent 按 subagent_type 路由）
        // baseToolsPermissionConfig 仅基于 base 工具集，给 sub-agent 用：
        //   sub-agent 内部只能见 baseTools，所以它的 permissionConfig 也只需覆盖 base 工具命名。
        const baseToolsRaw = [...tools]
        const baseToolsPermissionConfig: ToolPermissionConfig =
          this.deps?.getPermissionConfig?.(baseToolsRaw, context.resolved_permissions) ?? { mode: 'bypass' }
        // baseTools 构造后立刻把 outer auditBaseTools 接上，给 audit gate 的 getter 用。
        // 见 mcpConfigFactory 上方的 outer let 声明。
        const baseTools = filterToolsByPermission(baseToolsRaw, baseToolsPermissionConfig)
        // 把 baseTools / baseToolsPermissionConfig 接到 outer，audit gate getter 用。
        auditBaseTools = baseTools
        auditPermissionCfg = baseToolsPermissionConfig

        if (subAgentsSnapshot.length > 0) {
          tools.push(createDelegateTaskTool({
            subAgents: subAgentsSnapshot,
            runSubAgent: this.makeRunSubAgent({
              parentTools: baseTools,
              parentTaskId: task.task_id,
              callerLabel: 'main worker',
              humanQueue,
              permissionConfig: baseToolsPermissionConfig,
              traceConfig: subAgentTraceConfig,
              asyncEnabled: isMasterPrivate,
              asyncCtx: {
                owner: {
                  friend_id: context.sender_friend?.id ?? `__system_${context.task_origin?.session_id ?? 'unknown'}`,
                  session_id: context.task_origin?.session_id,
                  channel_id: context.task_origin?.channel_id,
                },
                adapter,
              },
            }),
          }))
        }

        // 3h. Trace search tool
        if (traceSearchTool) {
          tools.push(traceSearchTool)
        }

        // 3i. get_task_details tool（人话化的任务复盘）
        if (getTaskDetailsTool) {
          tools.push(getTaskDetailsTool)
        }

        // 3j. todo tool — per-task mutable plan
        // hasGoal 门控：复杂任务必须先 set_task_goal 才能 todo 写模式（goal mode 关闭时透明放行）
        // spec: 2026-05-23-goal-mode-design.md §5
        tools.push(createTodoTool(taskState.todoStore, { hasGoal: goalModeEnabled ? () => goalSetCache : () => true }))

        // 3j2. set_task_goal tool — worker 写下完成承诺，触发 audit gate + todo 门控解锁
        // goal mode 关闭时不注入，agent 无法设定目标，audit gate 透明放行
        // spec: 2026-05-23-goal-mode-design.md §7.3
        if (goalModeEnabled && this.deps?.getAdminPort && this.deps.rpcClient) {
          const adminDeps = this.deps
          tools.push(createSetTaskGoalTool({
            taskId: task.task_id,
            callAdminRpc: async <T = unknown>(method: string, params: unknown) => {
              const adminPort = await adminDeps.getAdminPort!()
              const result = await adminDeps.rpcClient.call<unknown, T>(adminPort, method, params, adminDeps.moduleId)
              if (method === 'set_task_goal') {
                // RPC 成功 → 同步更新本地 cache，让后续 todo 写模式 / audit gate 立即解锁
                goalSetCache = true
              }
              return result
            },
          }))
        }

        // 3k. Subagent coordinator tools（async 路径：list_active_subagents / get_subagent_output / stop_subagent）
        // 仅在 asyncEnabled（master + 私聊）时注入，其他场景 subagent 是同步的，无需协调工具
        if (isMasterPrivate) {
          tools.push(...createSubagentCoordinatorTools({
            taskId: task.task_id,
            bgRegistry: this.bgRegistry,
            killBgEntity: (entity_id) => this.killBgEntity(entity_id),
          }))
        }

        // 3l. Extra tools from opts (e.g., exit tools for trigger flow)
        if (opts?.extraTools) {
          tools.push(...opts.extraTools)
        }

        // 最终过滤：用「完整 tools 集合」重算 permissionConfig，
        // 否则 delegate_*/trace_search 等后注入的工具因不在 baseToolsPermissionConfig 的 denyList 里而漏过 filter，
        // 导致 LLM 看见但 runEngine 用 initialPermissionConfig 又拒绝（违反「无权限工具不注入 prompt」）。
        const fullPermissionConfig: ToolPermissionConfig =
          this.deps?.getPermissionConfig?.(tools, context.resolved_permissions) ?? { mode: 'bypass' }
        return filterToolsByPermission(tools, fullPermissionConfig)
      }

      // System prompt 也改为 callback：admin push config 触发 updateSystemPrompt 后下一轮生效。
      const buildSystemPromptDynamic = (): string => this.buildSystemPrompt(context, subAgentsSnapshot)

      // 5. Build task message（一次性，task 启动后用户请求/记忆等不变）
      // 若 opts 提供了 initialPrompt，跳过 buildTaskMessage（trigger 流自己构造 prompt）。
      let taskMessage: string | ContentBlock[]
      if (opts?.initialPrompt !== undefined) {
        taskMessage = opts.initialPrompt
      } else {
        // 拼接 bg-notification：上一次该 friend 留下的 bg entity exit 等事件
        taskMessage = await this.buildTaskMessage(task, context)
        const ownerFriendId = context.sender_friend?.id
          ?? `__system_${context.task_origin?.session_id ?? 'unknown'}`
        const bgNotifBlock = this.drainBgNotifications(`friend:${ownerFriendId}`)
        if (bgNotifBlock) {
          if (typeof taskMessage === 'string') {
            taskMessage = `${bgNotifBlock}\n\n${taskMessage}`
          } else {
            // ContentBlock[] 形式：在最前面加一个 text block
            taskMessage = [{ type: 'text', text: `${bgNotifBlock}\n\n` }, ...taskMessage]
          }
        }
      }

      // 6. Set up trace and progress tracking
      // senderIsMaster：master 在任何 session（私聊/群聊）都享受 CLI 全权（cli-permission-gate 短路依据）
      // 注意 isMasterPrivate（master + 私聊）保留给 progress digest / bg entity persistence 等独立语义
      const senderIsMaster = context.sender_friend?.permission === 'master'
      const isMasterPrivate =
        senderIsMaster
        && context.task_origin?.session_type === 'private'

      const taskOrigin = context.task_origin

      // 初始 snapshot：用于 trace 记录 + 给 runEngine 的 permissionConfig option（兜底）。
      // runEngine 内部会在每轮调用 buildToolsDynamic 重新拿最新工具列表。
      const initialTools = buildToolsDynamic()
      const initialPermissionConfig: ToolPermissionConfig =
        this.deps?.getPermissionConfig?.(initialTools, context.resolved_permissions) ?? { mode: 'bypass' }

      log(`Starting worker engine: model=${this.sdkEnv.modelId}, task=${task.task_title}, tools=${initialTools.length}`)

      // Start loop span — loop_label='task'（旧值 'worker' 由 UI agentLoopLabel 兼容映射）
      loopSpanId = traceCallback?.onLoopStart('task', {
        system_prompt: undefined,
        model: this.sdkEnv.modelId,
        tools: initialTools.map(t => t.name),
      })

      // 主 loop messages 的只读 holder —— engine 在每 turn 后浅拷贝刷新 current；
      // ProgressDigest 定时从这里 fork 一份做摘要，主 loop 不感知。
      // 总是创建：即使本任务不启用 digest（silent / text_forward），engine 维护
      // 它无副作用，留出钩子方便日后其他 observer 复用。
      const messagesRef: { current: ReadonlyArray<EngineMessage> } = { current: [] }

      // 创建进度汇报（根据会话场景分支）
      let textForwardMode = false
      if (taskOrigin && this.deps) {
        const reportMode = getReportMode(
          taskOrigin.session_type,
          isMasterPrivate,
          this.extra,
        )

        if (reportMode === 'digest') {
          const ex = this.extra
          const intervalSec = typeof ex.progress_digest_interval_seconds === 'number'
            ? ex.progress_digest_interval_seconds
            : 120

          const digestConfig: ProgressDigestConfig = {
            intervalMs: intervalSec * 1000,
            ...(opts?.digestOverdueMs !== undefined && opts.digestOverdueMs > 0
              ? { overdueMs: opts.digestOverdueMs }
              : {}),
            isMasterPrivate,
            // trace span：让 admin UI 上能看到 digest 在哪个时刻被触发以及由谁触发
            // （定时 / 超期 / ask_human）。span 命名沿用 `__system_*__` 内部 span 风格。
            ...(traceCallback ? {
              onTraceStart: (reason) =>
                traceCallback.onToolCallStart('__system_progress_digest__', `reason=${reason}`),
              onTraceEnd: (spanId, status, details) =>
                traceCallback.onToolCallEnd(
                  spanId,
                  typeof details?.output_summary === 'string' ? details.output_summary : '(no output)',
                  status === 'failed' && typeof details?.error === 'string' ? details.error : undefined,
                ),
            } : {}),
          }

          const digestDeps: ProgressDigestDeps = {
            sendToUser: (text: string) => this.sendToUser(taskOrigin, text),
            adapter,
            modelId: this.sdkEnv.modelId,
            ...(this.sdkEnv.maxTokens !== undefined ? { maxTokens: this.sdkEnv.maxTokens } : {}),
            messagesRef,
          }

          digest = new ProgressDigest(digestConfig, digestDeps)
        } else if (reportMode === 'text_forward') {
          textForwardMode = true
        }
        // reportMode === 'silent' → no digest, no text forward
      }

      // 6b. CLI 权限闸：所有场景都注册，hook 内按 resolvedPermissions/cli_access 判定放行/拒绝
      // （历史：原本只在非 master 私聊注册 — 现已改为按 effective permissions 统一闸，
      //  isMasterPrivate 仅保留给 progress digest / bg entity persistence 等独立语义）
      const workerHookRegistry: HookRegistry = new HookRegistry()
      workerHookRegistry.register(createCliPermissionHook())

      // 6c. 注入 CLI 环境变量（CRABOT_TOKEN + CRABOT_ACTOR）
      // 总是注入（不论 isMasterPrivate）—— token 只是让子进程能调 CLI；
      // 真正的权限边界在 cli-permission-gate hook（按 effective cli_access 判定）。
      // 不注入会让群聊/非 master 任务的 read 类 CLI（如 'crabot mcp list'）也跑不起来。
      if (!process.env.CRABOT_TOKEN) {
        const dataDir = process.env.DATA_DIR ?? './data'
        const tokenPath = path.join(dataDir, 'admin', 'internal-token')
        try {
          const token = fs.readFileSync(tokenPath, 'utf-8').trim()
          process.env.CRABOT_TOKEN = token
        } catch {
          // internal-token 不存在时不注入，CLI 命令将报错
        }
      }
      // CRABOT_ACTOR 让 CLI undo log / audit log 把 worker 子进程的写操作正确记为 'agent'
      // 而不是默认的 'human'。
      process.env.CRABOT_ACTOR = 'agent'

      // CRABOT_TASK_FRIEND_ID：当前 task 关联的 friend（master 私聊 = master id；定时任务 = 空）。
      // CLI write 命令（如 `crabot schedule add`）从这里读取并填到请求体的 creator_friend_id，
      // **不通过 CLI flag 传**，避免 LLM 通过命令行参数伪造身份。
      // 真正的写权限闸由 cli-permission-gate hook 按 effective cli_access[domain] + 内容审核判定；
      // 这里 friend_id 来自 task_origin，可能是 master / 普通 friend / 系统 schedule（空）。
      const taskFriendId = context.task_origin?.friend_id
      if (taskFriendId) {
        process.env.CRABOT_TASK_FRIEND_ID = taskFriendId
      } else {
        delete process.env.CRABOT_TASK_FRIEND_ID
      }

      // 7. Run engine — systemPrompt 和 tools 传 lambda，每轮 LLM 调用前 query-loop 重新 resolve
      // maxTurns: 主任务允许长时间执行（探索类任务可能跑 1000+ turn）；context-manager 在
      // 80% 窗口时自动 compaction 兜底。真正死循环可通过 supplement_task 或 abort 中断。
      let compactionSpanId: string | undefined = undefined
      let compactionStartedAtMs: number | undefined = undefined
      const engineResult = await runEngine({
        prompt: taskMessage,
        adapter,
        ...(opts?.initialMessages ? { initialMessages: [...opts.initialMessages] } : {}),
        options: {
          systemPrompt: buildSystemPromptDynamic,
          tools: buildToolsDynamic,
          model: this.sdkEnv.modelId,
          ...(this.sdkEnv.maxTokens !== undefined ? { maxTokens: this.sdkEnv.maxTokens } : {}),
          maxTurns: 2000,
          supportsVision: this.sdkEnv.supportsVision,
          permissionConfig: initialPermissionConfig,
          timezone: this.getTimezone(),
          abortSignal: taskState.abortController.signal as AbortSignal,
          humanMessageQueue: humanQueue,
          messagesRef,
          onAfterCompaction: (messages) => {
            const injection = taskState.todoStore.formatForInjection()
            if (!injection) return messages
            return [createUserMessage(injection), ...messages]
          },
          hookRegistry: workerHookRegistry,
          senderIsMaster,
          ...(context.resolved_permissions ? { resolvedPermissions: context.resolved_permissions } : {}),
          contentReviewer: this.buildContentReviewer(),
          ...(opts?.overdueConfig ? { overdueConfig: opts.overdueConfig } : {}),
          ...(opts?.suppressForcedSummary ? { suppressForcedSummary: opts.suppressForcedSummary } : {}),
          onSystemInjection: (event) => {
            // 系统注入（supplement / overdue / forced_summary / stop_hook）作为 trace 上的 tool-call 风格 span 暴露
            const label = `__system_${event.type}__`
            const inputSummary = event.text.slice(0, 200)
            const spanId = traceCallback?.onToolCallStart(label, inputSummary, event.injectedAtMs)
            if (spanId) {
              traceCallback?.onToolCallEnd(spanId, '(engine injected user message)', undefined, event.injectedAtMs)
            }
          },
          onCompactionStart: () => {
            // 上下文压缩开始——开个 __compaction__ span，结束时填入压缩前后消息数和耗时
            compactionStartedAtMs = Date.now()
            compactionSpanId = traceCallback?.onToolCallStart('__compaction__', 'context compaction', compactionStartedAtMs)
          },
          onCompactionEnd: (info) => {
            if (compactionSpanId) {
              const endedAtMs = (compactionStartedAtMs ?? Date.now()) + info.durationMs
              traceCallback?.onToolCallEnd(
                compactionSpanId,
                `compacted ${info.beforeCount} → ${info.afterCount} msgs in ${info.durationMs}ms`,
                undefined,
                endedAtMs,
              )
              compactionSpanId = undefined
              compactionStartedAtMs = undefined
            }
          },
          onLiveProgress: (event: LiveProgressEvent) => {
            // Update in-memory snapshot so ContextAssembler can read it.
            // 容错：如果任务已被清理（极端情况下 abort 后还有 in-flight 回调），略过。
            if (!this.liveSnapshots.has(task.task_id)) return
            switch (event.type) {
              case 'turn_assistant':
                this.updateLiveSnapshot(task.task_id, prev => {
                  const next = {
                    ...prev,
                    current_turn: event.turn,
                    last_assistant_text: event.text.slice(0, 400),
                  }
                  // LLM 成功返回了，清掉 retry 状态（仅当之前真有 retry 才更新，避免无谓的 store 通知）
                  return prev.llm_retry ? { ...next, llm_retry: undefined } : next
                })
                break
              case 'tools_start': {
                const now = Date.now()
                const active: LiveToolCall[] = event.tools.map(t => ({
                  name: t.name,
                  input_summary: t.input_summary,
                  started_at: now,
                }))
                this.updateLiveSnapshot(task.task_id, prev => ({ ...prev, active_tools: active }))
                break
              }
              case 'tools_end': {
                const now = Date.now()
                const completed: LiveCompletedTool[] = event.results.map(r => ({
                  name: r.name,
                  input_summary: r.input_summary,
                  is_error: r.is_error,
                  ended_at: now,
                }))
                this.updateLiveSnapshot(task.task_id, prev => {
                  const merged = [...prev.recent_completed, ...completed]
                  const trimmed = merged.length > AgentHandler.RECENT_COMPLETED_LIMIT
                    ? merged.slice(merged.length - AgentHandler.RECENT_COMPLETED_LIMIT)
                    : merged
                  // 工具完成时清掉 llm_retry 状态（之前的 retry 已经过去）
                  const next = { ...prev, active_tools: [], recent_completed: trimmed }
                  if (prev.llm_retry) {
                    return { ...next, llm_retry: undefined }
                  }
                  return next
                })
                break
              }
              case 'llm_retry': {
                this.updateLiveSnapshot(task.task_id, prev => ({
                  ...prev,
                  llm_retry: {
                    attempt: event.attempt,
                    max_attempts: event.maxAttempts,
                    source: event.source,
                    last_error: event.error.slice(0, 200),
                    since: Date.now(),
                  },
                }))
                break
              }
            }
          },
          onTurn: (event: EngineTurnEvent) => {
            // onTurn fires after LLM + tools complete; back-date spans with engine timings.
            const inputSummary = event.turnNumber === 1
              ? task.task_title.slice(0, 150)
              : `(turn ${event.turnNumber})`
            const llmEndedAtMs = event.llmStartedAtMs !== undefined && event.llmCallMs !== undefined
              ? event.llmStartedAtMs + event.llmCallMs
              : undefined
            const llmSpanId = traceCallback?.onLlmCallStart(event.turnNumber, inputSummary, undefined, event.llmStartedAtMs)

            for (const tc of event.toolCalls) {
              const toolEndedAtMs = tc.startedAtMs !== undefined && tc.durationMs !== undefined
                ? tc.startedAtMs + tc.durationMs
                : undefined
              const toolSpanId = traceCallback?.onToolCallStart(
                tc.name,
                JSON.stringify(tc.input ?? {}).slice(0, 200),
                tc.startedAtMs,
              )
              if (toolSpanId) {
                // tool 若返回 JSON 且含 child_trace_id（如 delegate_task），抓出来挂到 span.details
                // 让 Admin UI 能从这个 tool_call span 内联展开子 trace。
                const childTraceId = extractChildTraceIdFromOutput(tc.output)
                traceCallback?.onToolCallEnd(
                  toolSpanId,
                  tc.output?.slice(0, 500) || '(no output)',
                  tc.isError ? tc.output : undefined,
                  toolEndedAtMs,
                  childTraceId,
                )
              }
            }

            if (llmSpanId) {
              traceCallback?.onLlmCallEnd(
                llmSpanId,
                {
                  stopReason: event.stopReason ?? undefined,
                  outputSummary: event.assistantText.slice(0, 200) || undefined,
                  toolCallsCount: event.toolCalls.length > 0 ? event.toolCalls.length : undefined,
                  ...(event.forcedSummaryAttempt !== undefined ? { forcedSummaryAttempt: event.forcedSummaryAttempt } : {}),
                  ...(event.usage ? { usage: llmUsageToTrace(event.usage) } : {}),
                },
                llmEndedAtMs,
              )
            }

            // Progress: delegate based on report mode
            if (!humanQueue.hasPending) {
              if (digest) {
                digest.ingest(event)
              } else if (textForwardMode && taskOrigin) {
                const text = event.assistantText.trim()
                if (text.length > 0) {
                  this.sendToUser(taskOrigin, text).catch(() => {})
                }
              }
            }

            // Caller hook: trigger flow uses this to detect send_message
            opts?.onAfterTurn?.(event)
          },
        },
      })

      // Dispose ProgressDigest (also in finally block as safety net)
      digest?.dispose()

      // End loop span
      const isError = engineResult.outcome === 'failed'
      if (loopSpanId) {
        traceCallback?.onLoopEnd(loopSpanId, isError ? 'failed' : 'completed', engineResult.totalTurns)
      }

      return {
        engineResult,
        taskState,
        humanQueue,
        digest,
        loopSpanId,
      }

    } finally {
      digest?.dispose()
      if (!opts?.skipCleanup) {
        this.humanQueues.get(task.task_id)?.clearBarrier()
        this.humanQueues.delete(task.task_id)
        this.activeTasks.delete(task.task_id)
        this.liveSnapshots.delete(task.task_id)
        // Kill all transient shells owned by this task (persistent shells survive)
        this.transientShells.killAllOwnedBy(task.task_id)
        // Clean up cursor map entries for this task to avoid memory leak
        for (const key of this.bgCursorMap.keys()) {
          if (key.startsWith(`${task.task_id}:`)) {
            this.bgCursorMap.delete(key)
          }
        }
      }
    }
  }

  /**
   * 清理 runWorkerLoop 在 skipCleanup=true 模式下跳过的资源。
   * 由 executeTask 等待循环结束后调用。
   */
  private cleanupWorkerLoopResources(taskId: string): void {
    this.humanQueues.get(taskId)?.clearBarrier()
    this.humanQueues.delete(taskId)
    this.activeTasks.delete(taskId)
    this.liveSnapshots.delete(taskId)
    this.transientShells.killAllOwnedBy(taskId)
    for (const key of this.bgCursorMap.keys()) {
      if (key.startsWith(`${taskId}:`)) {
        this.bgCursorMap.delete(key)
      }
    }
  }

  /**
   * 构造 cli-permission-gate hook 用的内容审核器。
   *
   * 复用 worker 自身 LLM adapter / model（fast 档暂未单独配置）。schedule add 频率低，
   * 性能不敏感；后续若需独立 review slot，加新 sdkEnv 字段即可，不影响调用 site。
   */
  private buildContentReviewer(): ContentReviewer {
    const adapter = adapterFromSdkEnv(this.sdkEnv)
    const modelId = this.sdkEnv.modelId
    return async ({ effectivePermissions, commandText }) =>
      reviewCliContent({ effectivePermissions, commandText, adapter, modelId })
  }

  /**
   * Trigger 流的同步段：生成 taskId → register admin → activeTasks.set。
   * 返回后下一批 dispatcher 的 fetchActiveTasks 必然能拉到这个 task，
   * SessionLane handler 可以解锁处理下一批。
   *
   * 与 runTriggerWorkerLoop 配对使用。executeTriggerMessage 是两者的薄壳。
   *
   * ⚠️ 调用方必须在 await 后立即调 runTriggerWorkerLoop（或在自身 try/catch 异常时
   * `this.activeTasks.delete(pre.taskId)`），否则 register 成功但 run 未启动会留下
   * phantom 条目，下次 dispatcher 看到错位的 activeTasks。
   *
   * Spec: 2026-05-20-session-lane-dispatcher-design.md §3.3
   */
  async registerTriggerAndActivate(
    params: ExecuteTriggerMessageParams,
  ): Promise<{
    taskId: TaskId
    registered: boolean
    task: ExecuteTaskParams['task']
    context: WorkerAgentContext
    /**
     * Task 的标题 / 触发摘要。优先用 dispatch LLM 生成的 actionText（清晰任务化），
     * 缺省回退到 messages 最后一条切 100 字。同时作为 task_title / task_description /
     * activeTasks.title / task trace.trigger.summary 使用。
     */
    taskTitle: string
  }> {
    const { messages, isGroup, senderFriend, memoryPermissions, resolvedPermissions,
      channelId, sessionId, frontContext, dispatchActionText } = params

    // Fallback 路径：dispatchActionText 缺省时从原始消息切片。
    // 注意 caller 传进来的 messages 通常已经是 history + 当前 trigger 批次合并后的数组
    // （worker 需要完整消息上下文），从头切容易切到历史最早的一条无关消息——所以这里
    // **取最后一条**作为 trigger 摘要（最新一条 ≈ 当前触发批次的尾部，与历史无关）。
    const lastMsg = messages[messages.length - 1]
    const lastMsgText = lastMsg?.content.type === 'text' ? (lastMsg.content.text ?? '') : '[非文本]'
    const triggerSummary = lastMsgText.slice(0, 100)
    // 优先用 Dispatch LLM 生成的任务摘要（清晰、抽象到任务层面），缺省时才回退到原始消息切片。
    // Spec: title 不只是 UI 展示——Front 在做 supplement_task 决策时活跃任务清单里展示的就是它。
    const taskTitle = (dispatchActionText && dispatchActionText.trim().length > 0)
      ? dispatchActionText.slice(0, 200)
      : triggerSummary
    const syntheticTaskId = `trigger-${randomUUID()}` as TaskId

    let registered = false
    try {
      await this.registerTriggerTaskToAdmin({
        syntheticTaskId,
        taskTitle,
        channelId,
        sessionId,
        senderFriendId: senderFriend.id,
      })
      registered = true
    } catch (err) {
      log(`registerTriggerAndActivate: registerToAdmin failed (continuing) syntheticTaskId=${syntheticTaskId}: ${err instanceof Error ? err.message : String(err)}`)
    }

    const task: ExecuteTaskParams['task'] = {
      task_id: syntheticTaskId,
      task_title: taskTitle,
      task_description: taskTitle,
      priority: 'normal',
    }

    const taskOrigin: TaskOrigin = {
      channel_id: channelId,
      session_id: sessionId,
      friend_id: senderFriend.id,
      session_type: isGroup ? 'group' : 'private',
    }

    const placeholderEndpoint = { module_id: '', port: 0, host: 'localhost' }
    const context: WorkerAgentContext = {
      task_origin: taskOrigin,
      sender_friend: senderFriend,
      memory_permissions: memoryPermissions,
      resolved_permissions: resolvedPermissions,
      trigger_messages: messages as ChannelMessage[],
      recent_messages: frontContext.recent_messages ?? [],
      short_term_memories: [],
      long_term_memories: [],
      available_tools: [],
      admin_endpoint: placeholderEndpoint,
      memory_endpoint: placeholderEndpoint,
      channel_endpoints: [],
      time_windows: frontContext.time_windows,
      scene_profile: frontContext.scene_profile,
    }

    // 提前 set 到 activeTasks —— 让下一批 dispatcher fetchActiveTasks 立即可见。
    // runWorkerLoop 入口已 idempotent，会复用本 taskState。
    this.activeTasks.set(syntheticTaskId, {
      taskId: syntheticTaskId,
      status: 'executing',
      startedAt: new Date().toISOString(),
      title: taskTitle,
      triggerType: 'message',
      abortController: new AbortController(),
      pendingHumanMessages: [],
      taskOrigin,
      todoStore: new TodoStore(),
    })

    return { taskId: syntheticTaskId, registered, task, context, taskTitle }
  }

  /**
   * Trigger 流的异步段：buildTriggerUserPrompt → runWorkerLoop → finalizeTask。
   * 由 SessionLane handler 调 spawn 时 void 化（fire-and-forget）。
   * 内部已 try/catch，异常自己写 trace + log，不抛回上游。
   *
   * Spec: 2026-05-20-session-lane-dispatcher-design.md §3.3
   */
  async runTriggerWorkerLoop(
    params: ExecuteTriggerMessageParams,
    pre: Awaited<ReturnType<AgentHandler['registerTriggerAndActivate']>>,
    traceCallback?: TraceCallback,
    traceContext?: WorkerTraceContext,
  ): Promise<ExecuteTriggerMessageResult> {
    const { triggerArrivedAtMs, timeoutMs = 30_000, overdueReminderEnabled = true } = params
    const { taskId, registered, task, context } = pre

    const triggerPrompt = this.buildTriggerUserPrompt(params)

    let sentMessage = false
    let finalSent = false

    // 超期提醒走 ProgressDigest 旁路：到时 fork 主 loop 生成一份汇报发给用户，
    // 不污染主 loop 上下文。digestOverdueMs 是相对于 worker 启动时刻的延迟，
    // 减去 trigger 抵达到 worker 启动之间的时间，让总等待对齐 timeoutMs。
    const elapsedSinceTrigger = Math.max(0, Date.now() - triggerArrivedAtMs)
    const digestOverdueMs = overdueReminderEnabled
      ? Math.max(1_000, timeoutMs - elapsedSinceTrigger)
      : undefined

    let loopResult: RunWorkerLoopResult
    try {
      loopResult = await this.runWorkerLoop(task, context, traceCallback, traceContext, {
        initialPrompt: triggerPrompt,
        extraTools: [],
        ...(digestOverdueMs !== undefined ? { digestOverdueMs } : {}),
        suppressForcedSummary: () => finalSent,
        onAfterTurn: (event) => {
          for (const tc of event.toolCalls) {
            const bare = tc.name.replace(/^mcp__[^_]+__/, '')
            if (bare === 'send_message' || bare === 'send_private_message') {
              const intent = (tc.input as { intent?: string } | undefined)?.intent
              // sentMessage 严格追踪"消息成功发送"——失败不算
              if (!tc.isError) sentMessage = true
              // finalSent 追踪"worker 已表达交付意图"——只要调了 intent='final'，
              // 不论 audit 是否通过都算（避免 audit fail → silent end_turn →
              // forced_summary 反复轰炸的死循环）。audit fail 路径的 humanQueue
              // 报告会驱动 worker 续作或 ask_human；worker 若 silent end_turn 视为
              // 主动放弃，不再被 forced_summary 拦截。
              if (intent === 'final') finalSent = true
            }
          }
        },
      })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      // 清理 activeTasks（runWorkerLoop 通常自己清，但本路径异常时兜底）
      this.activeTasks.delete(taskId)
      return {
        outcome: 'failed' as const,
        finalText: '',
        sentMessage,
        overdueInjected: false,
        error: errMsg,
      }
    }

    const { engineResult } = loopResult

    if (registered) {
      const skipReflection = !engineResult.overdueInjected || !!engineResult.exitToolCall
      await this.finalizeTask(taskId, engineResult, context, { skipReflection })
    }

    return {
      outcome: engineResult.outcome,
      finalText: engineResult.finalText ?? '',
      sentMessage,
      overdueInjected: engineResult.overdueInjected,
      ...(engineResult.exitToolCall ? { exitToolCall: engineResult.exitToolCall } : {}),
      ...(engineResult.error ? { error: engineResult.error } : {}),
    }
  }

  /**
   * 薄壳兼容入口：内部顺序调 registerTriggerAndActivate + runTriggerWorkerLoop。
   *
   * 与 executeTask 的区别：
   * - executeTask 处理 admin 已注册的 task（带 task_id）
   * - executeTriggerMessage 处理新触发消息，可能早退（supplement/silent），可能自然结束
   *
   * Caller（unified-agent）根据 result.exitToolCall 自行 dispatch：
   * - exitToolCall.name === 'supplement_task' → 路由 supplement_text 到目标 task
   * - exitToolCall.name === 'stay_silent' → 忽略
   * - undefined → loop 自然结束（agent 已通过 send_message 工具回复人类，或没回复）
   *
   * 新代码（SessionLane handler）应直接调 register + run 分步接口。
   * Spec: 2026-05-20-session-lane-dispatcher-design.md §3.3 §7
   *
   * @deprecated 调用方应直接调 registerTriggerAndActivate + runTriggerWorkerLoop。
   *             本薄壳仅为过渡兼容，预计在 SessionLane 完整落地后（Task 7/8）删除。
   */
  async executeTriggerMessage(
    params: ExecuteTriggerMessageParams,
    traceCallback?: TraceCallback,
    traceContext?: WorkerTraceContext,
  ): Promise<ExecuteTriggerMessageResult> {
    const pre = await this.registerTriggerAndActivate(params)
    return this.runTriggerWorkerLoop(params, pre, traceCallback, traceContext)
  }

  /**
   * 构造 trigger 场景的 user prompt。
   *
   * - 删除群聊决策提示（trigger loop 用 send_message + stay_silent + supplement_task）
   * - 删除末尾 "## 指令" 段（工具 schema 自解释）
   * - 新增尾部提醒：用 send_message 工具回复（含 channel_id / session_id）
   * - 场景画像从 frontContext 读取（已在 system prompt 里，此处不再重复渲染）
   */
  private buildTriggerUserPrompt(params: ExecuteTriggerMessageParams): string {
    const { messages, activeTasks, isGroup, senderFriend, channelId, sessionId, frontContext } = params
    const parts: string[] = []
    const timezone = this.getTimezone()
    const now = new Date()

    parts.push(`当前时间: ${formatNow(timezone, now)}`)
    parts.push('')

    // ── 对话场景 ──
    parts.push('## 对话场景')
    if (isGroup) {
      const session = messages[0]?.session
      parts.push(`- 类型: 群聊`)
      parts.push(`- 对话对象: ${session?.session_id ?? sessionId}`)
      parts.push(`- 对话对象 ID: group:${session?.channel_id ?? channelId}:${session?.session_id ?? sessionId}`)
    } else {
      parts.push(`- 类型: 私聊`)
      parts.push(`- 对话对象: ${senderFriend.display_name}`)
      parts.push(`- 对话对象 ID: friend:${senderFriend.id}`)
      parts.push(`- 对话对象身份: ${senderFriend.permission}`)
    }

    // ── IM 渠道（send_message 工具需要这些 ID）──
    parts.push('\n## IM 渠道')
    parts.push(`- channel: ${channelId}`)
    parts.push(`- session: ${sessionId}`)
    if (frontContext.crab_display_name) {
      parts.push(`- 你在该渠道的昵称: ${frontContext.crab_display_name}`)
    }

    // ── 活跃任务（三分类）──
    if (activeTasks.length > 0) {
      const currentChannel = messages[0]?.session?.channel_id ?? channelId
      const currentSession = messages[0]?.session?.session_id ?? sessionId
      const isMaster = senderFriend.permission === 'master'

      const currentTasks: typeof activeTasks[number][] = []
      const otherTasks: typeof activeTasks[number][] = []
      const scheduledTasks: typeof activeTasks[number][] = []

      for (const t of activeTasks) {
        if (t.trigger_type === 'scheduled') scheduledTasks.push(t)
        else if (t.source_session_id === currentSession && t.source_channel_id === currentChannel) currentTasks.push(t)
        else otherTasks.push(t)
      }

      const renderTask = (t: typeof activeTasks[number], includeSource: boolean = false): string[] => {
        const lines: string[] = []
        const tag = t.trigger_type === 'scheduled' ? ' [定时/巡检任务，禁止 supplement]' : ''
        const src = includeSource && t.source_channel_id ? ` [来源: ${t.source_channel_id}:${t.source_session_id}]` : ''
        lines.push(`- [${t.task_id}] "${t.title}" (status: ${t.status})${tag}${src}`)
        if (t.latest_progress) lines.push(`  最近进度（事后摘要）: ${t.latest_progress}`)
        const live = t.live
        if (t.status === 'waiting_human' && t.pending_question) {
          lines.push(`  正在等待人类回答的问题:`)
          const qLines = t.pending_question.split('\n')
          for (const ql of qLines) {
            lines.push(`  > ${ql}`)
          }
        }
        if (live) {
          lines.push(`  创建于 ${formatTaskCreatedAt(live.started_at, timezone, now)} / 第 ${live.current_turn} 轮`)
          if (live.last_assistant_text) {
            const tt = live.last_assistant_text.trim()
            if (tt.length > 0) lines.push(`  上轮模型说: ${tt.slice(0, 200)}${tt.length > 200 ? '…' : ''}`)
          }
          if (live.active_tools.length > 0) {
            for (const at of live.active_tools) {
              const elapsed = formatElapsedMs(Date.now() - at.started_at)
              lines.push(`  正在跑工具: ${at.name}（已 ${elapsed}）— ${at.input_summary}`)
            }
          }
          if (live.recent_completed.length > 0) {
            const tail = live.recent_completed.slice(-3).map(c => `${c.name}${c.is_error ? '(失败)' : ''}`).join(' / ')
            lines.push(`  最近完成: ${tail}`)
          }
          if (live.llm_retry) {
            const r = live.llm_retry
            const elapsed = formatElapsedMs(Date.now() - r.since)
            lines.push(`  LLM 调用 retry 中: ${r.attempt}/${r.max_attempts} (${r.source})，已 ${elapsed}，原因: ${r.last_error}`)
          }
        }
        return lines
      }

      parts.push('\n## 活跃任务')

      if (currentTasks.length > 0) {
        parts.push(`\n### 当前对话对象的任务（${currentTasks.length} 条）`)
        for (const t of currentTasks) parts.push(...renderTask(t))
      }

      if (isMaster && otherTasks.length > 0) {
        parts.push(`\n### 其他对话场景的任务（${otherTasks.length} 条）`)
        for (const t of otherTasks) parts.push(...renderTask(t, true))
      }

      if (isMaster && scheduledTasks.length > 0) {
        parts.push(`\n### schedule 触发任务（${scheduledTasks.length} 条）`)
        for (const t of scheduledTasks) parts.push(...renderTask(t))
      }

      parts.push('\n当消息可能是对某个任务的纠偏/补充时，使用 supplement_task 工具。')
      parts.push('**带 [定时/巡检任务，禁止 supplement] 标签的任务一律不可作为 supplement 目标**。')
    }

    // ── 聊天历史（当前 session）──
    const recentHours = frontContext.time_windows.recent_messages_window_hours
    const recentSinceLabel = formatChannelMessageTime(
      new Date(now.getTime() - recentHours * 3600 * 1000).toISOString(),
      timezone,
      now,
    )
    const recentMessages = frontContext.recent_messages ?? []
    parts.push(`\n## 聊天历史（当前 session，最近 ${recentHours} 小时 = ${recentSinceLabel} 之后，${recentMessages.length} 条）`)
    parts.push(`summary: ${recentSinceLabel} 之前的本会话历史不在此上下文里。`)
    if (recentMessages.length > 0) {
      const total = recentMessages.length
      for (let i = 0; i < total; i++) {
        const distFromEnd = total - 1 - i
        const maxLen = distFromEnd < 3 ? 2000 : distFromEnd < 10 ? 600 : 300
        const msg = recentMessages[i]
        const identity = resolveSenderIdentity({
          msg,
          senderFriend,
          crabDisplayName: frontContext.crab_display_name,
          isGroup,
        })
        parts.push(formatChannelMessageLine(msg, { timezone, now, maxLen, identity }))
      }
    } else {
      parts.push(`此窗口（${recentSinceLabel} 之后）本会话无消息。`)
    }

    // ── 当前消息 ──
    parts.push(`\n## 当前消息`)
    for (const msg of messages) {
      const identity = resolveSenderIdentity({
        msg,
        senderFriend,
        crabDisplayName: frontContext.crab_display_name,
        isGroup,
      })
      parts.push(formatChannelMessageLine(msg, { timezone, now, maxLen: 2000, identity }))
    }

    // ── 行动提醒 ──
    parts.push(`\n## 行动提醒`)
    parts.push(`- 给人类回复用 \`send_message\` 工具（channel_id="${channelId}"，session_id="${sessionId}"）；最终交付用 intent="final"。`)
    if (isGroup) {
      parts.push(`- 若本批消息与你无关（群成员之间的讨论），调 \`stay_silent\` 退出 loop。`)
    }
    parts.push(`- 若本消息是对某个活跃任务的纠偏/补充，turn 0 调 \`supplement_task\` 退出 loop。`)

    return parts.join('\n')
  }

  /**
   * trigger 路径超期那一刻把任务注册到 admin task 表，让后续 trigger 能通过
   * list_tasks 拿到这条 in-flight 任务、走 supplement 通道。
   *
   * 失败 best-effort：admin 不可用时 log + 继续，本 trigger 期间 supplement 通道失效，
   * 主流程继续。finalize 时调 update_task_status / update_task_outcome 会拿到
   * NOT_FOUND，由 bestEffortRpc 吞掉，不需要 register-success flag。
   *
   * Spec: crabot-docs/superpowers/specs/2026-05-18-unified-loop-cleanup-design.md §4
   */
  private async registerTriggerTaskToAdmin(params: {
    syntheticTaskId: string
    taskTitle: string
    channelId: string
    sessionId: string
    senderFriendId: string
  }): Promise<void> {
    if (!this.deps?.getAdminPort || !this.deps.rpcClient) {
      log(`registerTriggerTaskToAdmin: deps missing, skipping`)
      return
    }
    const adminPort = await this.deps.getAdminPort()
    await this.deps.rpcClient.call(adminPort, 'create_task', {
      id: params.syntheticTaskId,
      title: params.taskTitle,
      source: {
        origin: 'human',
        channel_id: params.channelId,
        session_id: params.sessionId,
        friend_id: params.senderFriendId,
        trigger_type: 'message',
      },
      priority: 'normal',
    }, this.deps.moduleId)

    // create_task 默认建在 pending；trigger 路径必须立即推到 executing 与 worker 内存状态对齐：
    // ① 让后续 ask_human 的 executing→waiting_human transition 合法（否则 admin 状态机拒）
    // ② 让 finalizeTask 的 executing→completed/failed transition 合法（否则 bestEffortRpc 静默吞错、admin 任务永远 pending → phantom 累积）
    // 两步 transition 是 best-effort：失败只 log 不抛，主流程继续——task 已存在不必回滚 create。
    for (const status of ['planning', 'executing'] as const) {
      try {
        await this.deps.rpcClient.call(adminPort, 'update_task_status', {
          task_id: params.syntheticTaskId,
          status,
        }, this.deps.moduleId)
      } catch (err) {
        log(`registerTriggerTaskToAdmin: transition to ${status} failed (continuing): ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
  }

  /**
   * Engine 主 loop 结束后的收尾。对用户面"任务结束"瞬间 = update_task_status('completed')
   * 落盘那一刻；之后跑反思补轮（对 supplement 通道关闭）；最后写短期 + 长期记忆。
   *
   * 失败容忍：reflector / memory 任一步抛错都不回滚 task 状态——用户视角下任务已完成，
   * lesson 质量降级是可接受的二阶损失。
   *
   * opts.skipReflection（快答 / 早退路径）：跳过 reflectFn 的 LLM 调用，用 finalText 兜底
   * 当 outcome_brief；但 status 切换 / humanQueue drain / outcome 落地仍然要做——不可省，
   * 否则 admin task 永远 pending 变 phantom（这是 register/finalize 不配对 bug 的修复点）。
   */
  private async finalizeTask(
    taskId: TaskId,
    engineResult: EngineResult,
    context: import('../types.js').WorkerAgentContext,
    opts: { skipReflection?: boolean } = {},
  ): Promise<void> {
    if (!this.deps?.getAdminPort) {
      log(`finalize: getAdminPort missing, skipping admin patch + reflector`)
      return
    }
    const adminPort = await this.deps.getAdminPort()
    // 只有 outcome='completed' 才算"任务正常结束"，其他（failed/max_turns/aborted）均归入 'failed'。
    const finalStatus = engineResult.outcome === 'completed' ? 'completed' : 'failed'
    const finishedAt = new Date().toISOString()

    await this.bestEffortRpc(adminPort, 'update_task_status', {
      task_id: taskId,
      status: finalStatus,
      result: { outcome: finalStatus, finished_at: finishedAt },
    }, 'update_task_status')

    const humanQueue = this.humanQueues.get(taskId)
    if (humanQueue) {
      humanQueue.drainPending()
      humanQueue.clearBarrier()
    }

    // 失败路径：跳过反思补轮（LLM 已脱轨，再让它反思价值低且容易乱编），用 engine.error 当兜底 brief
    if (finalStatus === 'failed') {
      // max_turns 元信息独立 prefix，防被 finalText（可能是中途产出的几百字）覆盖——
      // 与 subagent trace tag 同 pattern；admin UI / master 通知都要能一眼看出"是触顶不是异常"。
      const maxTurnsTag = engineResult.outcome === 'max_turns'
        ? `[max_turns reached after ${engineResult.totalTurns} turns]`
        : ''
      const baseBrief = (engineResult.error ?? engineResult.finalText ?? '任务失败').slice(0, 200)
      const failureBrief = maxTurnsTag
        ? `${maxTurnsTag} ${baseBrief}`.slice(0, 400)
        : baseBrief
      await this.writeOutcome(taskId, adminPort, 'failed', failureBrief, [], context)
      // 通知 master 的两类 case：
      // 1) engine 主动抛错（outcome='failed' + error）：原样回传接口错
      // 2) max_turns 触顶：告知任务因轮次上限被截断，让 master 决定是否拆任务 / 调整
      //    （此前 max_turns 沉默失败，master 只能去 admin UI 才能看到，体验差）
      const shouldNotify = context.task_origin && context.sender_friend
      if (shouldNotify && engineResult.outcome === 'failed' && engineResult.error) {
        const text = `大模型接口出错：${engineResult.error}`.slice(0, 1500)
        await this.sendToUser(context.task_origin!, text)
      } else if (shouldNotify && engineResult.outcome === 'max_turns') {
        const tail = engineResult.finalText ? `\n\n最后一段输出：${engineResult.finalText.slice(0, 300)}` : ''
        const text = `任务因 max_turns 截断（跑了 ${engineResult.totalTurns} 轮仍未完成）。` +
          `建议把任务拆小后再派，或在 admin UI 调高该任务对应 worker 的 max_turns。${tail}`
        await this.sendToUser(context.task_origin!, text.slice(0, 1500))
      }
      return
    }

    // completed 路径：reflectFn 内部已有 retry + fallback 不抛错；这层 try 兜的是 LLM 不可达
    // / adapter 异常等外层错误，构造 fallback 反思继续写入，保证 outcome_brief 不留空。
    //
    // skipReflection：快答 / 早退路径跳过 reflectFn 的 LLM 调用（spec §2.4 不反思），
    // 但仍走 writeOutcome 把 finalText 当 brief 写入——保留 outcome 落地与 status 配对。
    let reflection: Awaited<ReturnType<typeof reflectStructuredOutcome>>
    if (opts.skipReflection) {
      reflection = {
        outcome_brief: engineResult.finalText.slice(0, 200),
        process_highlights: [],
        retries: 0,
        fellBackToLastText: true,
      }
      log(`finalize: skipReflection (快答/早退) — using lastAssistantText brief`)
    } else {
      try {
        const reflectFn = this.deps.reflectFn ?? reflectStructuredOutcome
        reflection = await reflectFn({
          messages: engineResult.finalMessages,
          adapter: adapterFromSdkEnv(this.sdkEnv),
          model: this.sdkEnv.modelId,
          lastAssistantText: engineResult.finalText,
        })
        log(`finalize: reflection produced (retries=${reflection.retries}, fallback=${reflection.fellBackToLastText})`)
      } catch (err) {
        log(`finalize: reflectFn threw, using lastAssistantText fallback: ${err instanceof Error ? err.message : String(err)}`)
        reflection = {
          outcome_brief: engineResult.finalText.slice(0, 200),
          process_highlights: [],
          retries: 0,
          fellBackToLastText: true,
        }
      }
    }

    await this.writeOutcome(taskId, adminPort, 'completed', reflection.outcome_brief, reflection.process_highlights, context)
  }

  /**
   * 把 outcome_brief / process_highlights 同时落到 admin（update_task_outcome）和短期/长期记忆。
   * RPC 失败 best-effort（log + 继续）；memory write 在 finalizeMemoryWrite 里也是 fire-and-forget。
   */
  private async writeOutcome(
    taskId: TaskId,
    adminPort: number,
    outcome: 'completed' | 'failed',
    outcomeBrief: string,
    processHighlights: readonly string[],
    context: import('../types.js').WorkerAgentContext,
  ): Promise<void> {
    await this.bestEffortRpc(adminPort, 'update_task_outcome', {
      task_id: taskId,
      outcome_brief: outcomeBrief,
      process_highlights: processHighlights,
    }, 'update_task_outcome')
    this.finalizeMemoryWrite(taskId, { outcome, outcome_brief: outcomeBrief, process_highlights: processHighlights }, context)
  }

  /** finalize 阶段调 admin RPC 的 best-effort 包装：失败只 log 不抛，让后续步骤继续跑。 */
  private async bestEffortRpc(
    port: number,
    method: string,
    params: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    if (!this.deps) return
    try {
      await this.deps.rpcClient.call(port, method, params, this.deps.moduleId)
    } catch (err) {
      log(`finalize: ${label} failed (continuing): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 任务结束（成功 / 失败）后写短期记忆 + 长期记忆候选。
   * - completed：reflection 来自 reflectFn 的真实总结
   * - failed：reflection 来自 engine.error 截断兜底
   * 两个写入均 fire-and-forget：失败只打日志，不影响 task 状态。
   */
  private finalizeMemoryWrite(
    taskId: TaskId,
    reflection: {
      outcome: 'completed' | 'failed'
      outcome_brief: string
      process_highlights: readonly string[]
    },
    context: import('../types.js').WorkerAgentContext,
  ): void {
    if (!this.memoryWriter) return

    const taskOrigin = context.task_origin
    const channelId = taskOrigin?.channel_id ?? ''
    const sessionId = taskOrigin?.session_id ?? ''
    const friendName = context.sender_friend?.display_name ?? 'system'
    const friendId = context.sender_friend?.id ?? ''
    const visibility = context.memory_permissions?.write_visibility ?? 'internal'
    const scopes = context.memory_permissions?.write_scopes ?? []

    const taskTitle = this.activeTasks.get(taskId)?.title ?? taskId
    const outcomeLabel = reflection.outcome === 'completed' ? '完成' : '失败'

    this.memoryWriter.writeTaskFinished({
      task_id: taskId,
      task_title: taskTitle,
      outcome: reflection.outcome,
      outcome_brief: reflection.outcome_brief,
      process_highlights: [...reflection.process_highlights],
      friend_name: friendName,
      friend_id: friendId,
      channel_id: channelId,
      session_id: sessionId,
      visibility,
      scopes,
    }).catch((err) => {
      log(`finalizeMemoryWrite: writeTaskFinished failed: ${err instanceof Error ? err.message : String(err)}`)
    })

    this.memoryWriter.quickCapture({
      type: 'lesson',
      brief: `${taskTitle} → ${reflection.outcome_brief}`.slice(0, 80),
      content: `任务 ${taskId}（${taskTitle}）${outcomeLabel}：${reflection.outcome_brief}`,
      source_ref: { type: 'conversation', task_id: taskId, channel_id: channelId, session_id: sessionId },
      entities: [],
      tags: [`task_outcome:${reflection.outcome}`],
      importance_factors: {
        proximity: 0.6,
        surprisal: reflection.outcome === 'failed' ? 0.8 : 0.4,
        entity_priority: 0.5,
        unambiguity: 0.6,
      },
    }).catch(() => undefined)
  }

  /**
   * Map EngineResult to ExecuteTaskResult.
   *
   * 任务完成内容已由 worker 通过 send_message 主动发出，且 outcome_brief / process_highlights
   * 已写入 admin（update_task_outcome）。dispatcher 不再需要 summary / final_reply。
   */
  private mapEngineResult(
    taskId: TaskId,
    result: EngineResult,
  ): ExecuteTaskResult {
    if (result.outcome === 'aborted') {
      return { task_id: taskId, outcome: 'failed', error: '任务被取消' }
    }
    if (result.outcome === 'failed' || result.outcome === 'max_turns') {
      return { task_id: taskId, outcome: 'failed', error: result.error ?? 'unknown' }
    }
    return { task_id: taskId, outcome: 'completed' }
  }

  deliverHumanResponse(taskId: TaskId, messages: ChannelMessage[]): void {
    const taskState = this.activeTasks.get(taskId)
    if (!taskState) {
      log(`[supplement] deliverHumanResponse: task ${taskId} NOT FOUND. activeTasks keys: [${Array.from(this.activeTasks.keys()).join(', ')}]`)
      throw new Error(`Task not found: ${taskId}`)
    }

    log(`[supplement] deliverHumanResponse: queued ${messages.length} messages for task ${taskId} (status: ${taskState.status})`)

    // 渲染含媒体的消息（文件名 / 图片 url）—— 与 dispatcher buildUserPrompt 对齐
    const supplement = messages
      .map(m => formatMessageContent(m))
      .filter(t => t !== EMPTY_MESSAGE_PLACEHOLDER)
      .join('\n')

    if (supplement) {
      const humanQueue = this.humanQueues.get(taskId)
      if (humanQueue) {
        humanQueue.push(
          `[实时纠偏 - 来自用户]\n` +
          `用户在任务执行期间发来了补充指示：\n\n` +
          `"${supplement}"\n\n` +
          `请结合当前任务进展，调整你的执行方向。`,
        )
        log(`[supplement] pushed to humanMessageQueue for task ${taskId}`)
      }
    }

    // Also store in pendingHumanMessages for backward compat with task state
    taskState.pendingHumanMessages.push(...messages)
    taskState.status = 'executing'
  }

  cancelTask(taskId: TaskId, _reason: string): void {
    const taskState = this.activeTasks.get(taskId)
    if (taskState) {
      taskState.abortController.abort()
      taskState.status = 'cancelled'
    }
  }

  getActiveTaskCount(): number { return this.activeTasks.size }

  hasActiveTask(taskId: TaskId): boolean {
    return this.activeTasks.has(taskId)
  }

  setBarrierForTask(taskId: TaskId, timeoutMs: number): boolean {
    const queue = this.humanQueues.get(taskId)
    if (!queue) return false
    queue.setBarrier(timeoutMs)
    return true
  }

  clearBarrierForTask(taskId: TaskId): void {
    const queue = this.humanQueues.get(taskId)
    queue?.clearBarrier()
  }

  /**
   * 同进程同步读取某个任务的实时执行快照。
   * 仅当任务正在 worker engine 内执行时才有值；任务结束（成功/失败/中止）后即被清理。
   */
  getLiveSnapshot(taskId: TaskId): LiveTaskSnapshot | undefined {
    return this.liveSnapshots.get(taskId)
  }

  private updateLiveSnapshot(taskId: TaskId, mutate: (prev: LiveTaskSnapshot) => LiveTaskSnapshot): void {
    const prev = this.liveSnapshots.get(taskId)
    if (!prev) return
    this.liveSnapshots.set(taskId, mutate(prev))
  }

  getActiveTasksByOrigin(channelId: string, sessionId: string): TaskId[] {
    const result: TaskId[] = []
    for (const [taskId, state] of this.activeTasks) {
      if (
        state.taskOrigin?.channel_id === channelId &&
        state.taskOrigin?.session_id === sessionId
      ) {
        result.push(taskId)
      }
    }
    return result
  }

  getActiveTasksForQuery(): Array<{ task_id: string; status: string; started_at: string; title?: string }> {
    return Array.from(this.activeTasks.values()).map(t => ({
      task_id: t.taskId,
      status: t.status,
      started_at: t.startedAt,
      title: t.title,
    }))
  }

  /**
   * 返回 agent 进程内 in-flight task 的轻量 summary，供 context-assembler union。
   * 携带 taskOrigin（channel_id / session_id）让调用方按 spec §3.2 做 session 过滤
   * （"当前 session 的活跃任务"——protocol-agent-v2.md §5.1 line 329）。
   * Spec: 2026-05-19-prefront-dispatcher-design.md §3.2
   */
  getInflightSnapshot(): ReadonlyArray<{
    task_id: string
    title: string
    trigger_type: 'message' | 'scheduled'
    source_channel_id?: string
    source_session_id?: string
  }> {
    const result: Array<{
      task_id: string
      title: string
      trigger_type: 'message' | 'scheduled'
      source_channel_id?: string
      source_session_id?: string
    }> = []
    for (const [taskId, state] of this.activeTasks) {
      result.push({
        task_id: taskId,
        title: state.title ?? taskId,
        trigger_type: state.triggerType ?? 'message',
        source_channel_id: state.taskOrigin?.channel_id,
        source_session_id: state.taskOrigin?.session_id,
      })
    }
    return result
  }

  /**
   * 从 this.skills 实时拼装 worker skill listing 段落。
   * updateSkills 改 this.skills 后，下一轮 buildSystemPrompt 自动反映新列表。
   */
  private buildSkillListingSnapshot(): string | undefined {
    if (!this.skills || this.skills.length === 0) return undefined
    const intro =
      '\n\n以下技能为特定任务提供专业指引。当任务匹配某个技能的描述时，' +
      '必须先调用 Skill 工具（输入技能名称）加载完整指引，然后按指引操作。' +
      '这是强制要求——先加载技能，再执行任务。'
    const body = this.skills.map((s) => {
      const desc = s.description || s.name
      return `<skill>\n<name>${s.name}</name>\n<description>${desc}</description>\n</skill>`
    }).join('\n')
    return `${intro}\n\n<available_skills>\n${body}\n</available_skills>`
  }

  /**
   * 直接执行 subagent 的核心 helper，被 makeRunSubAgent（delegate_task 路径）
   * 和 goal audit gate 路径（Task 7 引入的 runGoalAudit）共用。
   *
   * 与 makeRunSubAgent 的关系：makeRunSubAgent 只是把 deps 闭包包成 RunSubAgentFn 薄壳，
   * 实际执行（tool filter → prompt 装配 → adapter → sub-trace → forkEngine → 错误包装）
   * 全在这里。goal audit gate 可通过 traceSummaryPrefix/traceTaskType 定制 trace 显示
   * 而不需要复制粘贴这段逻辑。
   *
   * 返回值额外带 traceId，方便上层（如 goal audit）记录子 trace ID。
   * makeRunSubAgent 会把 traceId 摘掉再返回（RunSubAgentFn 类型不含此字段）。
   */
  private async runSubAgentDirect(
    subagent: SubAgentConfig,
    input: import('./delegate-task-tool.js').RunSubAgentInput,
    ctx: import('../engine/types.js').ToolCallContext,
    deps: {
      readonly parentTools: ReadonlyArray<import('../engine/types.js').ToolDefinition>
      readonly parentTaskId: string
      readonly callerLabel: string
      readonly humanQueue?: import('../engine/human-message-queue.js').HumanMessageQueue
      readonly permissionConfig?: import('../engine/types.js').ToolPermissionConfig
      readonly traceConfig?: SubAgentTraceConfig
      /** trace summary 前缀；缺省 `[${subagent.name}]`。goal_audit 路径传 `'[goal_audit]'`。 */
      readonly traceSummaryPrefix?: string
      /** trigger.task_type；缺省不设。goal_audit 路径传 `'goal_audit'`，Admin UI 用来标特殊样式。 */
      readonly traceTaskType?: string
      /** caller 注入的专属工具（如 audit 路径的 submit_audit_result），
       *  在 capability filter **之后** concat 进 subTools。这些工具不走 capability 体系，
       *  专属用法不污染通用过滤逻辑。 */
      readonly extraTools?: ReadonlyArray<import('../engine/types.js').ToolDefinition>
    },
  ): Promise<import('../engine/types.js').ToolCallResult & {
    readonly traceId?: string
    /** auditor 等系统侧 caller 用的 raw subagent output（裸 finalText，不被 JSON 包裹）。
     *  delegate_task 工具路径继续用 output（JSON 包了元信息）；runGoalAudit 等不要解 JSON。 */
    readonly rawOutput?: string
    /** exitsLoop 工具触发的早退判决：tool name + schema-enforced input。
     *  例：audit subagent 调 submit_audit_result(pass, failed_criteria, evidence)
     *  时直接拿到结构化判决，不必 regex parse free text。 */
    readonly exitToolCall?: { readonly name: string; readonly input: Record<string, unknown> }
    /** ForkEngineResult.outcome 顶层透出，让系统侧 caller（如 runGoalAudit）能
     *  在 isError=true 之外进一步区分 max_turns（截断）与 failed（异常）。
     *  catch 抛错路径不填（属于纯异常，按 unknown 走）。 */
    readonly outcome?: import('../engine/types.js').EngineResult['outcome']
  }> {
    // 1. filter parent tools by subagent capabilities (delegate_task always excluded by filter)
    const filteredSubTools = filterToolsForSubAgent(
      deps.parentTools,
      subagent.builtin_capabilities,
      subagent.allowed_mcp_server_ids,
      subagent.allowed_skill_ids,
    )
    // caller 注入的专属工具（如 audit 的 submit_audit_result）在 capability filter
    // 之后 concat，绕开 filter 的 unknown-default-deny 逻辑（这些工具不属于任何
    // capability group，本来就会被剔除）。
    const subTools = deps.extraTools
      ? [...filteredSubTools, ...deps.extraTools]
      : filteredSubTools

    // 2. assemble 5-section system prompt
    const systemPrompt = assembleSubAgentPrompt(subagent, {
      parentTaskId: deps.parentTaskId,
      callerLabel: deps.callerLabel,
    })

    // 3. build adapter from subagent's resolved model
    const subAdapter = createAdapter({
      endpoint: subagent.model.endpoint,
      apikey: subagent.model.apikey,
      format: subagent.model.format,
      ...(subagent.model.account_id ? { accountId: subagent.model.account_id } : {}),
    })

    // 4. resolve hook registry based on hook_preset
    const hookRegistry = subagent.hook_preset === 'coding_expert'
      ? createCodingExpertHookRegistry()
      : undefined
    const lspManager = hookRegistry ? this.lspManager : undefined

    // 5. trace stitching: create sub-trace linked to parent trace
    const tc = deps.traceConfig
    let subTrace: AgentTrace | undefined
    let subTraceCallback: ((event: EngineTurnEvent) => void) | undefined

    if (tc) {
      // summary 前缀带 subagent name，让 Admin Traces 列表展开行一眼看出
      // "这是谁派的子任务" — 否则只能看见 task prompt 内容，分不清是哪个 subagent。
      // goal_audit 等定制路径可通过 deps.traceSummaryPrefix 覆盖。
      const taskPrompt = String(input.task).slice(0, 180)
      const summaryPrefix = deps.traceSummaryPrefix ?? `[${subagent.name}]`
      subTrace = tc.traceStore.startTrace({
        module_id: 'sub-agent',
        trigger: {
          type: 'sub_agent_call',
          summary: `${summaryPrefix} ${taskPrompt}`,
          ...(deps.traceTaskType ? { task_type: deps.traceTaskType } : {}),
        },
        parent_trace_id: tc.parentTraceId,
        parent_span_id: tc.parentSpanId,
        related_task_id: tc.relatedTaskId,
      })

      // onTurn fires post-hoc (after LLM + tools); back-date span timestamps
      // with engine-measured ms to keep the waterfall accurate.
      subTraceCallback = (event: EngineTurnEvent) => {
        const llmEndedAtMs =
          event.llmStartedAtMs !== undefined && event.llmCallMs !== undefined
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
          const toolEndedAtMs =
            toolCall.startedAtMs !== undefined && toolCall.durationMs !== undefined
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

    // TODO(phase-2b): image_paths support for vision subagents
    try {
      const result = await forkEngine({
        prompt: input.task,
        adapter: subAdapter,
        model: subagent.model.model_id,
        systemPrompt,
        tools: subTools,
        maxTurns: subagent.max_turns,
        ...(subagent.model.max_tokens !== undefined ? { maxTokens: subagent.model.max_tokens } : {}),
        ...(input.context ? { parentContext: input.context } : {}),
        abortSignal: ctx.abortSignal,
        onTurn: subTraceCallback,
        supportsVision: subagent.model.supports_vision,
        hookRegistry,
        lspManager,
        permissionConfig: deps.permissionConfig,
      })

      // outcome 一并视为"非完成"的两个 case：failed（异常）+ max_turns（截断）。
      // exitToolCall 触发（exitsLoop 工具被调）= 业务终态，按 completed 处理。
      const isAbnormalExit =
        (result.outcome === 'failed' || result.outcome === 'max_turns') &&
        result.exitToolCall === undefined

      if (subTrace && tc) {
        const traceSummary = result.output.slice(0, 200) || result.error?.slice(0, 200) || ''
        // max_turns 的元信息独立维护，不被 partial output 覆盖——partial 可能有几十
        // turn 累出的文本，会顶掉 "max_turns reached" 字符串导致 trace 里分不清失败原因。
        const maxTurnsTag = result.outcome === 'max_turns'
          ? `[max_turns reached after ${result.totalTurns} turns]`
          : ''
        const baseError = isAbnormalExit
          ? (result.error?.slice(0, 200) || result.output.slice(0, 200) || undefined)
          : undefined
        const errorWithTag = maxTurnsTag
          ? (baseError ? `${maxTurnsTag} ${baseError}` : maxTurnsTag)
          : baseError
        tc.traceStore.endTrace(
          subTrace.trace_id,
          isAbnormalExit ? 'failed' : 'completed',
          {
            summary: traceSummary,
            error: errorWithTag,
          },
        )
      }

      if (isAbnormalExit) {
        const isMaxTurns = result.outcome === 'max_turns'
        const errSrc = result.error || (isMaxTurns ? undefined : result.output) || 'subagent failed without error message'
        const failure = buildSubAgentFailureOutput({
          errorSource: isMaxTurns ? new Error(`max_turns reached (${result.totalTurns} turns)`) : new Error(errSrc),
          subagentName: subagent.name,
          providerEndpoint: subagent.model.endpoint,
          model: subagent.model.model_id,
          ...(result.output ? { partialOutput: result.output } : {}),
          totalTurns: result.totalTurns,
          ...(subTrace ? { childTraceId: subTrace.trace_id } : {}),
          ...(isMaxTurns ? { kindOverride: 'max_turns' as const, stopReason: 'max_turns' as const } : { stopReason: 'failed' as const }),
        })
        return {
          output: JSON.stringify(failure),
          rawOutput: result.output,
          isError: true,
          outcome: result.outcome,
          ...(subTrace ? { traceId: subTrace.trace_id } : {}),
          ...(result.exitToolCall ? { exitToolCall: result.exitToolCall } : {}),
        }
      }

      return {
        // output 给 delegate_task 工具 caller (worker LLM) 看：JSON 包了 child_trace_id 等
        // 元信息，便于 worker 拼下一轮 prompt 追溯
        output: JSON.stringify({
          output: result.output,
          outcome: result.outcome,
          totalTurns: result.totalTurns,
          child_trace_id: subTrace?.trace_id,
        }),
        // rawOutput 给系统侧 caller（如 runGoalAudit）解 auditor 原始文本，不要解 JSON
        rawOutput: result.output,
        isError: false,
        outcome: result.outcome,
        ...(subTrace ? { traceId: subTrace.trace_id } : {}),
        // exitToolCall：sub-agent 通过 exitsLoop 工具早退时的结构化判决（如 audit
        // 的 submit_audit_result）。caller 优先用它而不是 parse free text。
        ...(result.exitToolCall ? { exitToolCall: result.exitToolCall } : {}),
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (subTrace && tc) {
        tc.traceStore.endTrace(subTrace.trace_id, 'failed', { summary: msg, error: msg })
      }
      const failure = buildSubAgentFailureOutput({
        errorSource: err,
        subagentName: subagent.name,
        providerEndpoint: subagent.model.endpoint,
        model: subagent.model.model_id,
        ...(subTrace ? { childTraceId: subTrace.trace_id } : {}),
      })
      return {
        output: JSON.stringify(failure),
        isError: true,
        ...(subTrace ? { traceId: subTrace.trace_id } : {}),
      }
    }
  }

  /**
   * Goal audit gate 入口：crab-messaging send_message(intent='final') 拦截时调用。
   *
   * 流程：
   *  1. 拿 admin task → 验证 task.goal 存在
   *  2. 查 goal_auditor builtin from this.subAgents snapshot
   *  3. 用 buildAuditPrompt 拼输入（worker 不参与）
   *  4. 调 runSubAgentDirect 跑 auditor（独立 trace, task_type='goal_audit'）
   *  5. parseAuditReport 解析输出
   *  6. admin RPC append_task_goal_audit_entry 写历史
   *  7. pass → admin RPC complete_task_goal 同步标 complete
   *  8. 返回 AuditResult
   *
   * 注意：parentTools 传空 array——auditor 不继承 worker 工具集，
   * filterToolsForSubAgent 走 auditor 自己的 capability 过滤。
   * 没传 humanQueue / permissionConfig：auditor 是只读，不通讯。
   *
   * traceConfig 可选：caller（Task 8 crab-messaging）能拿到自己的 traceContext 时透传，
   * 让 audit subtree 挂到 worker 主 trace 下；缺省则跑无父 trace 的 standalone subagent，
   * auditTraceId 为空串。
   *
   * spec: 2026-05-23-goal-mode-design.md §7.2
   */
  async runGoalAudit(params: {
    readonly taskId: string
    readonly pendingContent: string
    readonly traceConfig?: SubAgentTraceConfig
    readonly abortSignal?: AbortSignal
    /** worker baseTools；auditor 的 capability filter（file_system+shell）在其上筛子集。
     *  缺省/空数组 = auditor 没有 Bash/Read/Grep 等工具，实测会回"环境没有工具"导致永远 fail。 */
    readonly parentTools?: ReadonlyArray<import('../engine/types.js').ToolDefinition>
    /** worker permissionConfig；缺省时 auditor 调 dangerous 工具（如 Bash）会被拒。 */
    readonly permissionConfig?: import('../engine/types.js').ToolPermissionConfig
  }): Promise<AuditResult> {
    if (!this.deps?.getAdminPort || !this.deps.rpcClient) {
      throw new Error('runGoalAudit: getAdminPort/rpcClient deps 缺失')
    }
    const adminPort = await this.deps.getAdminPort()
    const moduleId = this.deps.moduleId

    // 1. 拿 task + goal（用现有 RPC pattern）
    const taskResp = await this.deps.rpcClient.call<
      { task_id: string },
      { task: { id: string; goal?: GoalAuditTaskGoal } }
    >(adminPort, 'get_task', { task_id: params.taskId }, moduleId)
    const task = taskResp.task
    if (!task.goal) {
      throw new Error(
        `runGoalAudit: task ${params.taskId} has no goal; audit should not be triggered`,
      )
    }
    const goal = task.goal

    // 2. 拿 auditor 配置（snapshot 风格的 in-flight 不变 reference）
    const auditor = this.subAgents.find((s) => s.id === 'builtin-goal-auditor')
    if (!auditor) {
      throw new Error('runGoalAudit: goal_auditor subagent not configured')
    }

    // 3. 装输入（系统拼，worker 不插手）
    const promptText = buildAuditPrompt({
      goal,
      pendingContent: params.pendingContent,
      cwd: process.cwd(),
    })

    // 4. 跑 subagent（独立 trace, task_type='goal_audit'），注入 submit_audit_result 工具。
    const result = await this.runSubAgentDirect(
      auditor,
      {
        subagent_type: 'goal_auditor',
        task: promptText,
      },
      { ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}) },
      {
        // parentTools: 来自 worker baseTools（capability filter 会在其上筛 file_system+shell）；
        // 缺省 [] 是历史 bug，会让 auditor 没工具可用、根本无法验证任何 criterion。
        parentTools: params.parentTools ?? [],
        parentTaskId: params.taskId,
        callerLabel: 'goal_audit',
        // permissionConfig: 同样必须透传，否则 runtime check 用 dangerous 工具默认拒绝逻辑，
        // auditor 调 Bash 等会被拦回"Permission denied"。
        ...(params.permissionConfig ? { permissionConfig: params.permissionConfig } : {}),
        ...(params.traceConfig ? { traceConfig: params.traceConfig } : {}),
        traceSummaryPrefix: '[goal_audit]',
        traceTaskType: 'goal_audit',
        // submit_audit_result 是 audit 专属 exitsLoop 工具，capability filter 之后注入。
        // auditor 调它即结束，input 直接是 schema-enforced {pass, failed_criteria, evidence}。
        extraTools: [createSubmitAuditResultTool()],
      },
    )

    // 5. 解析判决（优先 tool call → max_turns/failed/aborted 直接 sentinel → fallback parseAuditReport → fallback sentinel）
    const parsed = resolveAuditJudgment(result)

    // 5b. 把 verdict 回写到 audit trace 顶层 summary，让 admin UI 直接可见
    //     (spec 2026-05-26-goal-audit-loop-completion §2.1.2)
    const auditTraceId = result.traceId ?? ''
    if (auditTraceId && params.traceConfig?.traceStore) {
      const verdictSummary = buildAuditVerdictSummary(parsed, goal)
      params.traceConfig.traceStore.appendTraceOutcome(auditTraceId, verdictSummary)
    }

    // 6. 写 audit_history
    await this.deps.rpcClient.call<unknown, unknown>(
      adminPort,
      'append_task_goal_audit_entry',
      {
        task_id: params.taskId,
        entry: {
          at: new Date().toISOString(),
          pass: parsed.pass,
          failed_criteria: [...parsed.failedCriteria],
          audit_trace_id: auditTraceId,
        },
      },
      moduleId,
    )

    // 7. pass 路径同步把 goal 切 complete
    if (parsed.pass) {
      await this.deps.rpcClient.call<unknown, unknown>(
        adminPort,
        'complete_task_goal',
        { task_id: params.taskId },
        moduleId,
      )
    }

    return {
      pass: parsed.pass,
      failedCriteria: parsed.failedCriteria,
      detailedReport: buildHumanQueueReport(parsed, goal),
      auditTraceId,
    }
  }

  /**
   * 构造 RunSubAgentFn，注入到 delegate_task 工具。
   * 每次 createWorkerHandler 时调用，deps 绑定当次任务的 humanQueue / permissionConfig 等上下文。
   *
   * 同步路径（sync=true 或非 persistent 模式）：转发到 runSubAgentDirect。
   * 异步路径（默认）：走 spawnPersistentAgent，工具立即返回 launched，完成时通过 humanQueue 通知。
   */
  private makeRunSubAgent(deps: {
    readonly parentTools: ReadonlyArray<import('../engine/types.js').ToolDefinition>
    readonly parentTaskId: string
    readonly callerLabel: string
    readonly humanQueue?: import('../engine/human-message-queue.js').HumanMessageQueue
    readonly permissionConfig?: import('../engine/types.js').ToolPermissionConfig
    readonly traceConfig?: SubAgentTraceConfig
    /** 是否允许异步派发（master + 私聊 session）。false 时总走同步。 */
    readonly asyncEnabled?: boolean
    /** 异步派发时的 subagent 上下文（owner 信息、adapter） */
    readonly asyncCtx?: {
      readonly owner: import('../engine/bg-entities/types.js').BgEntityOwner
      readonly adapter: import('../engine/llm-adapter.js').LLMAdapter
    }
  }): RunSubAgentFn {
    return async (subagent, input, ctx) => {
      const typedInput = input as RunSubAgentInput & { sync?: boolean }

      // 异步路径：asyncEnabled + 没有显式 sync=true
      if (deps.asyncEnabled && !typedInput.sync && deps.asyncCtx && deps.humanQueue) {
        return this.runSubAgentAsync(subagent, typedInput, deps.asyncCtx, deps)
      }

      // 同步路径（默认 fallback / 显式 sync=true）
      const { traceId: _traceId, ...result } = await this.runSubAgentDirect(subagent, input, ctx, deps)
      return result
    }
  }

  /** 异步派发 subagent：via spawnPersistentAgent，工具立即返回，完成时通知父 humanQueue。 */
  private async runSubAgentAsync(
    subagent: SubAgentConfig,
    input: RunSubAgentInput & { sync?: boolean },
    asyncCtx: {
      readonly owner: import('../engine/bg-entities/types.js').BgEntityOwner
      readonly adapter: import('../engine/llm-adapter.js').LLMAdapter
    },
    deps: {
      readonly parentTools: ReadonlyArray<import('../engine/types.js').ToolDefinition>
      readonly parentTaskId: string
      readonly humanQueue?: import('../engine/human-message-queue.js').HumanMessageQueue
      readonly traceConfig?: SubAgentTraceConfig
    },
  ): Promise<import('../engine/types.js').ToolCallResult> {
    const { spawnPersistentAgent } = await import('../engine/bg-entities/bg-agent.js')

    const subModel = subagent.model
    const subAdapter = asyncCtx.adapter

    // 子 agent 工具集：从父工具里过滤（同 runSubAgentDirect 路径）
    const subTools = filterToolsForSubAgent(
      [...deps.parentTools],
      subagent.builtin_capabilities,
      subagent.allowed_mcp_server_ids,
      subagent.allowed_skill_ids,
    )

    const finalSystemPrompt = assembleSubAgentPrompt(subagent, {
      parentTaskId: deps.parentTaskId,
      callerLabel: 'main worker (async)',
    })

    const bgTraceCtx = deps.traceConfig
      ? { traceStore: deps.traceConfig.traceStore, traceId: deps.traceConfig.parentTraceId }
      : undefined

    const entity_id = await spawnPersistentAgent({
      task_description: input.task,
      tools: subTools,
      systemPrompt: finalSystemPrompt,
      model: subModel.model_id,
      ...(subModel.max_tokens !== undefined ? { maxTokens: subModel.max_tokens } : {}),
      adapter: subAdapter,
      owner: asyncCtx.owner,
      spawned_by_task_id: deps.parentTaskId,
      registry: this.bgRegistry,
      abortControllers: this.agentAbortControllers,
      ...(bgTraceCtx ? { traceContext: bgTraceCtx } : {}),
      onExit: (info) => {
        if (!deps.humanQueue) return
        const notification = [
          '<sub_agent_notification>',
          `<agent_id>${info.entity_id}</agent_id>`,
          `<description>${info.task_description.slice(0, 200)}</description>`,
          `<status>${info.status}</status>`,
          `<runtime_ms>${info.runtime_ms}</runtime_ms>`,
          info.result_file ? `<output_file>${info.result_file}</output_file>` : '',
          '</sub_agent_notification>',
        ].filter(Boolean).join('\n')
        deps.humanQueue.push(notification)
      },
    })

    return {
      output: JSON.stringify({ agent_id: entity_id, status: 'launched', output_file: null }),
      isError: false,
    }
  }

  private buildSystemPrompt(
    context: WorkerAgentContext,
    subAgentsOverride?: ReadonlyArray<SubAgentConfig>,
  ): string {
    // unified loop spec §3.1：使用 assembleAgentPrompt（12 段统一模板）。
    // isGroup 从 task_origin.session_type 推断；scheduled task 无 session 时默认 false。
    const isGroup = context.task_origin?.session_type === 'group'
    const sceneProfile = context.scene_profile
      ? { label: context.scene_profile.label, content: context.scene_profile.content }
      : undefined
    // subAgentsOverride 由 runWorkerLoop 在 loop 启动时 snapshot 后传入，
    // 防止 in-flight loop 中 admin 改 subagents 后 system prompt 列表跳变。
    const subAgentsSource = subAgentsOverride ?? this.subAgents
    const availableSubAgents = subAgentsSource.map((s) => ({
      toolName: s.name,
      workerHint: s.when_to_use.split('\n')[0] || s.description || s.name,
    }))
    const baseAssembled = this.promptManager
      ? this.promptManager.assembleAgentPrompt({
        isGroup,
        adminPersonality: this.systemPrompt || undefined,
        skillListing: this.buildSkillListingSnapshot(),
        availableSubAgents: availableSubAgents.length > 0 ? availableSubAgents : undefined,
        ...(sceneProfile ? { sceneProfile } : {}),
      })
      : this.systemPrompt
    const parts: string[] = [baseAssembled]
    if (context.available_tools.length > 0) {
      parts.push('\n## 可用工具')
      for (const t of context.available_tools) { parts.push(`- ${t.name}: ${t.description}`) }
    }
    if (context.sandbox_path_mappings && context.sandbox_path_mappings.length > 0) {
      parts.push('\n## 文件访问路径')
      for (const m of context.sandbox_path_mappings) {
        parts.push(`- ${m.sandbox_path} -> ${m.host_path} (${m.read_only ? '只读' : '读写'})`)
      }
    }
    return parts.join('\n')
  }

  private async buildTaskMessage(task: ExecuteTaskParams['task'], context: WorkerAgentContext): Promise<string | ContentBlock[]> {
    const parts: string[] = []
    const now = new Date()
    const timezone = this.getTimezone()

    parts.push(`当前时间: ${formatNow(timezone, now)}`)
    parts.push('')

    if (context.scene_profile) {
      const escaped = context.scene_profile.content.replace(/<\/scene_profile>/g, '&lt;/scene_profile&gt;')
      parts.push('## 场景画像')
      parts.push(`<scene_profile label="${context.scene_profile.label}">`)
      parts.push(escaped)
      parts.push('</scene_profile>')
      parts.push('')
    }
    parts.push('## 任务信息')
    parts.push(`- 标题: ${task.task_title}`)
    parts.push(`- 优先级: ${task.priority}`)
    if (task.plan) { parts.push(`- 计划: ${task.plan}`) }

    // trigger_messages: 用户的原始请求（核心内容）
    // 多行格式保留：trigger 可能含完整的用户原文，单行渲染会强制截断
    if (context.trigger_messages && context.trigger_messages.length > 0) {
      parts.push(`\n## 用户请求（共 ${context.trigger_messages.length} 条消息）`)
      for (const msg of context.trigger_messages) {
        const time = msg.platform_timestamp ? formatChannelMessageTime(msg.platform_timestamp, timezone, now) : ''
        const stamp = time ? ` [${time}]` : ''
        parts.push(`\n### ${msg.sender.platform_display_name}${stamp}`)
        // 当前消息携带引用锚点时显式列出，worker 可直接 mcp__crab-messaging__get_message 拉原消息
        const refMsgId = msg.features.reply_to_message_id ?? msg.features.quote_message_id
        if (refMsgId) {
          parts.push(`引用消息 ID: ${refMsgId}（可用 \`mcp__crab-messaging__get_message\` 查完整原文与对应 task 详情）`)
        }
        parts.push(formatMessageContent(msg))
      }
      if (task.task_description) {
        parts.push(`\n## 任务分类\n${task.task_description}`)
      }
    } else {
      // 无 trigger_messages（如定时任务），回退到 task_description
      parts.push(`\n## 任务描述\n${task.task_description}`)
    }

    if (context.sender_friend) {
      parts.push(`\n## 发送者信息`)
      parts.push(`- 名称: ${context.sender_friend.display_name}`)
      parts.push(`- 权限: ${context.sender_friend.permission}`)
    }

    if (context.task_origin) {
      parts.push('\n## 任务来源（crab-messaging 工具请使用这些 ID）')
      parts.push(`- Channel ID: ${context.task_origin.channel_id}`)
      parts.push(`- Session ID: ${context.task_origin.session_id}`)
    }
    const shortTermHours = context.time_windows.short_term_memory_window_hours
    const recentHours = context.time_windows.recent_messages_window_hours

    parts.push('\n## 记忆系统')

    // 短期记忆（跨 channel/session 流水账）：解决跨 session 指代漂移的核心数据来源
    parts.push(`\n### 短期记忆（跨所有 channel/session 的近期事件流水，最近 ${shortTermHours} 小时，${context.short_term_memories.length} 条）`)
    if (context.short_term_memories.length > 0) {
      parts.push('当任务描述含跨 session 指代（"刚才那个 X"/"上次"/"接着之前的"）时，先看这里再行动——条目带 channel/session/task 锚点。')
      for (const mem of context.short_term_memories) {
        parts.push(formatShortTermMemoryLine(mem, { timezone, now, maxLen: 500 }))
      }
    } else {
      parts.push(`过去 ${shortTermHours} 小时内无短期记忆。需要更早的事件流水时主动调 \`crab-memory.search_short_term\`（传 query/time_range）。`)
    }

    parts.push('\n### 长期记忆')
    parts.push('长期记忆（用户偏好 / 项目事实 / 历史教训 / 概念定义）**永不预填**到上下文。任何涉及')
    parts.push('"用户的稳定偏好 / 之前做过的类似事 / 过往踩过的坑 / 项目背景事实"的判断，')
    parts.push('都必须先调 `crab-memory.search_long_term`（传 query 按主题精准检索），必要时再用 `crab-memory.get_memory_detail` 取详情。')
    parts.push('禁止凭印象或常识回答此类问题——上下文里没有相关记忆 ≠ 用户没有相关偏好。')

    // 最近消息（仅当前 session）：本 session 本地历史，回答跨 session 指代请看上方"短期记忆"
    parts.push(`\n## 最近相关消息（当前 session，最近 ${recentHours} 小时，${context.recent_messages?.length ?? 0} 条）`)
    if (context.recent_messages && context.recent_messages.length > 0) {
      for (const m of context.recent_messages) {
        const identity = resolveSenderIdentity({ msg: m })
        parts.push(formatChannelMessageLine(m, { timezone, now, maxLen: 500, identity }))
      }
    } else {
      parts.push(`过去 ${recentHours} 小时本会话无消息。如需更早的本会话历史，调 \`get_history\` 工具。`)
    }

    // Front immediate reply — tell Worker what was already said to avoid repetition
    if (context.front_immediate_reply) {
      parts.push('\n## 已发送的即时回复')
      parts.push(`你已经向用户发送了："${context.front_immediate_reply}"`)
      parts.push('不要重复类似的确认或复述，直接开始执行任务。')
    }

    // front_context from forced Front termination
    const taskWithContext = task as { front_context?: Array<{ tool_name: string; output_summary: string }> }
    if (taskWithContext.front_context && Array.isArray(taskWithContext.front_context)) {
      parts.push('\n## Front Agent 已完成的工作')
      parts.push('（以下信息已获取，请直接使用，不要重复查询）')
      for (const entry of taskWithContext.front_context) {
        parts.push(`- ${entry.tool_name}: ${entry.output_summary}`)
      }
    }

    const textContent = parts.join('\n')

    // VLM Worker: resolve images from trigger messages into ContentBlock[]
    if (this.sdkEnv.supportsVision && context.trigger_messages?.length) {
      const imageBlocks = await resolveImageBlocks(context.trigger_messages)
      if (imageBlocks.length > 0) {
        return [
          { type: 'text' as const, text: textContent },
          ...imageBlocks,
        ]
      }
    }

    return textContent
  }

  /**
   * Send a message to the user during task execution.
   */
  private async sendToUser(
    taskOrigin: TaskOrigin,
    text: string,
  ): Promise<void> {
    if (!this.deps) return
    try {
      const channelPort = await this.deps.resolveChannelPort(taskOrigin.channel_id)
      await this.deps.rpcClient.call(channelPort, 'send_message', {
        session_id: taskOrigin.session_id,
        content: { type: 'text', text },
      }, this.deps.moduleId)
    } catch { /* ignore send failures */ }
  }

  // ============================================================================
  // Bg-entity admin RPC methods (Plan 3 Task 1)
  // ============================================================================

  async listBgEntities(opts?: {
    owner_friend_id?: string
    status?: BgEntityStatus[]
    type?: BgEntityType
  }): Promise<BgEntityRecord[]> {
    return this.bgRegistry.list(opts)
  }

  async killBgEntity(entity_id: string): Promise<{ ok: boolean; message?: string }> {
    if (entity_id.startsWith('shell_')) {
      // Try transient shell first
      const transientState = this.transientShells.get(entity_id)
      if (transientState) {
        this.transientShells.kill(entity_id)
        return { ok: true }
      }
      // Persistent shell
      const rec = await this.bgRegistry.get(entity_id)
      if (!rec) return { ok: false, message: 'Entity not found' }
      if (rec.status !== 'running') return { ok: false, message: `Already ${rec.status}` }
      if (rec.type !== 'shell') return { ok: false, message: 'Mismatched type' }
      try {
        process.kill(-rec.pgid, 'SIGTERM')
        setTimeout(() => {
          try { process.kill(-rec.pgid, 'SIGKILL') } catch { /* already dead */ }
        }, 3000).unref()
      } catch { /* already dead */ }
      await this.bgRegistry.update(entity_id, {
        status: 'killed',
        ended_at: new Date().toISOString(),
      })
      return { ok: true }
    }
    if (entity_id.startsWith('agent_')) {
      const rec = await this.bgRegistry.get(entity_id)
      if (!rec) return { ok: false, message: 'Entity not found' }
      if (rec.status !== 'running') return { ok: false, message: `Already ${rec.status}` }
      const controller = this.agentAbortControllers.get(entity_id)
      if (controller) controller.abort()
      await this.bgRegistry.update(entity_id, {
        status: 'killed',
        ended_at: new Date().toISOString(),
      })
      return { ok: true }
    }
    return { ok: false, message: `Invalid entity_id: ${entity_id}` }
  }

  async getBgEntityLog(
    entity_id: string,
    opts?: { from_offset?: number; max_bytes?: number },
  ): Promise<{
    content: string
    new_offset: number
    status: BgEntityStatus
    type: BgEntityType
  }> {
    const fromOffset = opts?.from_offset ?? 0
    const maxBytes = opts?.max_bytes ?? 100_000

    // Check transient shell first
    const transientState = this.transientShells.get(entity_id)
    if (transientState) {
      return {
        content: transientState.ringBuffer,
        new_offset: transientState.ringBuffer.length,
        status: transientState.status,
        type: 'shell',
      }
    }

    const rec = await this.bgRegistry.get(entity_id)
    if (!rec) throw new Error(`Entity not found: ${entity_id}`)

    let logFile: string
    if (rec.type === 'shell') {
      logFile = rec.log_file
    } else {
      // agent: completed → result_file; otherwise messages_log_file
      if (rec.status === 'completed' && rec.result_file) {
        const content = await fs.promises.readFile(rec.result_file, 'utf-8')
        return { content, new_offset: content.length, status: rec.status, type: 'agent' }
      }
      logFile = rec.messages_log_file
    }

    // Incremental log read
    try {
      const stat = await fs.promises.stat(logFile)
      const start = Math.min(fromOffset, stat.size)
      const length = Math.min(maxBytes, stat.size - start)
      if (length <= 0) {
        return { content: '', new_offset: stat.size, status: rec.status, type: rec.type }
      }
      const fd = await fs.promises.open(logFile, 'r')
      try {
        const buf = Buffer.alloc(length)
        await fd.read(buf, 0, length, start)
        return {
          content: buf.toString('utf-8'),
          new_offset: start + length,
          status: rec.status,
          type: rec.type,
        }
      } finally {
        await fd.close()
      }
    } catch {
      return { content: '', new_offset: 0, status: rec.status, type: rec.type }
    }
  }

}
