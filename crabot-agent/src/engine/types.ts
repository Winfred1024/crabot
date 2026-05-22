import { randomUUID } from 'crypto'

// --- Content Blocks ---

export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ImageBlock {
  readonly type: 'image'
  readonly source: {
    readonly type: 'base64' | 'url'
    readonly media_type: string
    readonly data: string
  }
}

export interface ToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}

export interface ToolResultBlock {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string
  readonly is_error: boolean
}

/**
 * Raw reasoning block for OpenAI Responses API (Codex backend).
 * Stores the full reasoning item JSON so it can be replayed back in subsequent turns.
 * Other adapters ignore this block type.
 */
export interface RawReasoningBlock {
  readonly type: 'raw_reasoning'
  readonly data: Record<string, unknown>
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | RawReasoningBlock

// --- Token Usage ---

/**
 * LLM 调用的 token 用量。adapter 透传，trace 持久化时聚合到 AgentTrace.total_usage。
 * cache 字段对齐 Anthropic prompt caching；OpenAI cached_tokens 归到 cacheReadTokens。
 */
export interface LLMTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheCreationTokens?: number
  readonly cacheReadTokens?: number
}

// --- Messages ---

export interface EngineUserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: string | ContentBlock[]
  readonly timestamp: number
}

export interface EngineAssistantMessage {
  readonly id: string
  readonly role: 'assistant'
  readonly content: ContentBlock[]
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null
  readonly timestamp: number
  readonly usage?: LLMTokenUsage
}

export interface EngineToolResultMessage {
  readonly id: string
  readonly role: 'user'
  readonly toolResults: ReadonlyArray<{
    readonly tool_use_id: string
    readonly content: string
    readonly images?: ReadonlyArray<{ readonly media_type: string; readonly data: string }>
    readonly is_error: boolean
  }>
  readonly timestamp: number
}

export type EngineMessage = EngineUserMessage | EngineAssistantMessage | EngineToolResultMessage

// --- Tool Permission ---

export type ToolPermissionLevel = 'safe' | 'normal' | 'dangerous'

export type ToolCategory =
  | 'memory'
  | 'messaging'
  | 'task'
  | 'mcp_skill'
  | 'file_io'
  | 'browser'
  | 'shell'
  | 'remote_exec'
  | 'desktop'

export type PermissionMode =
  | 'bypass'       // All tools allowed (for trusted contexts like admin chat)
  | 'allowList'    // Only listed tools allowed
  | 'denyList'     // All except listed tools allowed

export interface ToolPermissionConfig {
  readonly mode: PermissionMode
  /** Tool names for allowList/denyList */
  readonly toolNames?: ReadonlyArray<string>
  /** Optional callback for dynamic permission decisions */
  readonly checkPermission?: (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision>
}

export type PermissionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }

// --- Tool Definition ---

export interface ToolCallContext {
  readonly abortSignal?: AbortSignal
  readonly onProgress?: (message: string) => void
  /** IANA 时区名（如 "Asia/Shanghai"），用于 tool_result 时间戳渲染 */
  readonly timezone?: string
}

export interface ToolCallResult {
  readonly output: string
  readonly images?: ReadonlyArray<{ readonly media_type: string; readonly data: string }>
  readonly isError: boolean
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly isReadOnly: boolean
  readonly permissionLevel?: ToolPermissionLevel
  readonly category?: ToolCategory
  /**
   * 仅 turn 0 可调用。在 turn ≥ 1 调用此工具时，引擎不真正执行 `call`，
   * 而是返回 error 类工具结果（"Tool 'X' is only callable on turn 0..."），
   * 让 LLM 看到拒绝信号并自行调整。
   *
   * 用于 supplement_task / stay_silent 这类 turn 0 triage 决策工具。
   */
  readonly turnZeroOnly?: boolean
  /**
   * 调用后引擎立刻退出 loop，把工具调用信息（name + input）写入 EngineResult.exitToolCall。
   * 引擎不调用 `call` 函数（exit 工具本身无需执行），也不 push tool_result——
   * 直接 buildResult('completed', ...) 返回。
   *
   * 用于 supplement_task / stay_silent 这类"调完就走"的早退工具。
   */
  readonly exitsLoop?: boolean
  readonly call: (input: Record<string, unknown>, context: ToolCallContext) => Promise<ToolCallResult>
}

// --- Stream Chunks ---

export type StreamChunk =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_use_start'; readonly id: string; readonly name: string }
  | { readonly type: 'tool_use_delta'; readonly id: string; readonly inputJson: string }
  | { readonly type: 'tool_use_end'; readonly id: string }
  | { readonly type: 'raw_reasoning'; readonly data: Record<string, unknown> }
  | { readonly type: 'message_start'; readonly messageId: string }
  | { readonly type: 'message_end'; readonly stopReason: string | null; readonly usage?: LLMTokenUsage }
  | { readonly type: 'error'; readonly error: string }

// --- Engine Options & Result ---

export interface EngineTurnEvent {
  readonly turnNumber: number
  readonly assistantText: string
  readonly toolCalls: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly input: Record<string, unknown>
    readonly output: string
    readonly isError: boolean
    /** Per-tool wall-clock duration (ms) */
    readonly durationMs?: number
    /** Per-tool wall-clock start time (ms epoch) */
    readonly startedAtMs?: number
  }>
  readonly stopReason: EngineAssistantMessage['stopReason']
  /** LLM API call wall-clock time this turn (ms) */
  readonly llmCallMs?: number
  /** LLM API call start (ms epoch) */
  readonly llmStartedAtMs?: number
  /**
   * 当前轮是否由"沉默 end_turn 追问"机制触发（1-indexed）。
   * 未触发时 undefined。turnNumber 仍按全局 LLM 调用次数递增；该字段
   * 单独标识"这一轮 user msg 是 engine 注入的强制汇报追问"。
   */
  readonly forcedSummaryAttempt?: number
  /** 本轮 LLM 调用的 token 用量；adapter 透传，无则缺省 */
  readonly usage?: LLMTokenUsage
}

/** 既可传静态值也可传 callback（每轮 resolve） */
export type Resolvable<T> = T | (() => T)

/**
 * 实时进度事件（细粒度）。
 *
 * 与 `EngineTurnEvent` 的区别：onTurn 是事后回调（工具执行完才触发，所有 span
 * 一次性写入），而 `LiveProgressEvent` 在 LLM 返回 / 工具开始 / 工具结束三个时
 * 间点都会发送，让外部观察者能感知"飞行中"状态。
 */
export type LiveProgressEvent =
  | {
      readonly type: 'turn_assistant'
      readonly turn: number
      readonly text: string
    }
  | {
      readonly type: 'tools_start'
      readonly tools: ReadonlyArray<{ readonly name: string; readonly input_summary: string }>
    }
  | {
      readonly type: 'tools_end'
      readonly results: ReadonlyArray<{
        readonly name: string
        readonly input_summary: string
        readonly is_error: boolean
      }>
    }
  | {
      /** LLM 调用 mid-stream / pre-stream / complete 路径 retry 触发；用于 admin web 显示"正在重试"状态 */
      readonly type: 'llm_retry'
      readonly turn: number          // 当前正在尝试的 turn 编号
      readonly attempt: number       // 第几次失败 (1-indexed)
      readonly maxAttempts: number   // 总配额
      readonly source: 'pre-stream' | 'mid-stream' | 'complete'
      readonly error: string         // 触发 retry 的 error message（截断 200）
    }

export interface EngineOptions {
  readonly systemPrompt: Resolvable<string>
  readonly tools: Resolvable<ReadonlyArray<ToolDefinition>>
  readonly model: string
  readonly maxTurns?: number
  readonly maxTokens?: number
  readonly abortSignal?: AbortSignal
  readonly onTurn?: (event: EngineTurnEvent) => void
  /** 实时进度回调（fires LLM 返回 / 工具开始 / 工具结束三处）—— 见 LiveProgressEvent */
  readonly onLiveProgress?: (event: LiveProgressEvent) => void
  readonly permissionConfig?: ToolPermissionConfig
  readonly supportsVision?: boolean
  readonly humanMessageQueue?: HumanMessageQueueLike
  readonly hookRegistry?: import('../hooks/hook-registry').HookRegistry
  readonly lspManager?: import('../hooks/types').LspManagerLike
  /** IANA 时区名（如 "Asia/Shanghai"），用于 tool_result 时间戳渲染 */
  readonly timezone?: string
  /** 当前消息发起人是否 master——CLI permission gate hook 的 master 短路依据 */
  readonly senderIsMaster?: boolean
  /** 发起人 effective permissions（friend ∪ session 并集）——CLI permission gate hook 用 */
  readonly resolvedPermissions?: import('../types.js').ResolvedPermissions
  /** 内容审核器——CLI permission gate 在 schedule add 时调用 */
  readonly contentReviewer?: import('../hooks/types.js').ContentReviewer
  /**
   * 在 context-manager compaction 完成后回调，返回最终注入到 messages 的数组。
   * 用于在 compaction 边界注入 per-task 状态（如 worker 的 todo active list），
   * 注入到 user msg 而非 system prompt 以保护 prompt cache。
   * 不传时不做任何处理。
   */
  readonly onAfterCompaction?: (messages: ReadonlyArray<EngineMessage>) => ReadonlyArray<EngineMessage>
  /**
   * 外部只读访问当前 messages 数组的 holder。engine 在每个 turn 完成时浅拷贝赋值
   * `current`。用于 progress digest 等需要从主 loop 上下文 fork 出来做摘要但不能
   * 修改主 loop 的观察者。
   *
   * 不传时 engine 不更新；ref 对象由 caller 维护生命周期。`current` 字段可写但
   * 写入的数组本身是 ReadonlyArray —— 外部只读，不应原地修改。
   */
  readonly messagesRef?: { current: ReadonlyArray<EngineMessage> }
  /**
   * 引擎层主动向 loop 注入 user message 时触发（trace 可见性钩子）。
   *
   * 当前 4 类注入：
   * - `supplement` —— humanMessageQueue 实时纠偏注入
   * - `overdue_reminder` —— 超期辅助提醒注入（详见 overdueConfig）
   * - `forced_summary` —— silent end_turn 兜底要求模型重说
   * - `stop_hook` —— Stop hook block 后注入的引导文本
   *
   * caller 可把它接到 traceCallback / 日志 / metric——engine 自身不做任何 trace 写入。
   */
  readonly onSystemInjection?: (event: SystemInjectionEvent) => void
  /**
   * 抑制 forced_summary 注入的判定回调。返回 true → engine 跳过 silent end_turn 的
   * forced_summary 兜底机制，直接接受 silent end_turn 作为正常完成态。
   *
   * 设计动机：老 worker 路径下 finalText 是交付，silent end_turn 是异常→需要 forced_summary
   * 兜底。新 unified loop 下交付走 send_message 工具，silent end_turn 是设计预期。caller
   * （unified handler）传 `() => finalSent` 来表达"agent 已用 intent='final' 发过最终交付"。
   *
   * 不传时维持现有行为：始终启用 forced_summary。
   */
  readonly suppressForcedSummary?: () => boolean
  /**
   * 上下文压缩开始时触发（trace 可见性钩子）。
   * compaction 内部跑一次 LLM call 做摘要，可能耗时几秒——不接 trace 就是黑洞。
   */
  readonly onCompactionStart?: () => void
  /**
   * 上下文压缩完成时触发。`info` 含压缩前后消息数与耗时。
   */
  readonly onCompactionEnd?: (info: { readonly beforeCount: number; readonly afterCount: number; readonly durationMs: number }) => void
  /**
   * 超期检测配置。引擎在每个 turn 结束时测量从 `startedAtMs`（默认为 runEngine 入口时刻）
   * 到当前的 elapsed；超过 timeoutMs 且本 loop 内未注入过时，调 `onOverdue()` 询问注入文本。
   *
   * `onOverdue` 返回 `string` 则把该字符串作为 user message 注入并继续 loop（不结束）；
   * 返回 `null` 表示本次跳过（如 caller 判断已经 send_message 过，无需提醒）。
   *
   * 至多注入一次——即便条件继续满足也不会重复触发。
   *
   * 不传此字段则关闭超期机制。
   */
  readonly overdueConfig?: OverdueConfig
}

export interface HumanMessageQueueLike {
  readonly drainPending: () => Array<string | ContentBlock[]>
  readonly hasPending: boolean
  readonly hasBarrier: boolean
  readonly waitBarrier: (signal?: AbortSignal) => Promise<void>
  readonly clearBarrier: () => void
}

export interface OverdueConfig {
  /** Elapsed 阈值（毫秒）。命中后引擎询问 `onOverdue` 是否注入。 */
  readonly timeoutMs: number
  /** 自定义起始时刻；不传则用 runEngine 入口时刻（Date.now()）。 */
  readonly startedAtMs?: number
  /** 命中阈值后引擎调一次此回调。返回 string 注入；返回 null 跳过。引擎保证至多调用一次。 */
  readonly onOverdue: () => string | null
}

/**
 * 引擎主动注入 user message 时的事件描述。详见 EngineOptions.onSystemInjection。
 */
export interface SystemInjectionEvent {
  readonly type: 'supplement' | 'overdue_reminder' | 'forced_summary' | 'stop_hook'
  /** 注入的文本内容（不含 ContentBlock[] 形态——supplement 的 ContentBlock 注入退化为 type 字符串描述） */
  readonly text: string
  /** 注入发生时的 turn 序号（与 EngineTurnEvent.turnNumber 同口径） */
  readonly turnNumber: number
  /** 注入时刻的墙钟（毫秒） */
  readonly injectedAtMs: number
}

export interface EngineResult {
  readonly outcome: 'completed' | 'failed' | 'max_turns' | 'aborted'
  readonly finalText: string
  readonly totalTurns: number
  readonly usage: LLMTokenUsage
  readonly error?: string
  readonly finalMessages: ReadonlyArray<EngineMessage>
  /** 本次 run 是否触发过超期注入。未配置 overdueConfig 或未超期时为 false。 */
  readonly overdueInjected: boolean
  /**
   * 早退工具（`exitsLoop=true` 的工具）被调用时填入工具 name + 原始 input。
   * 未触发早退时为 undefined。
   */
  readonly exitToolCall?: { readonly name: string; readonly input: Record<string, unknown> }
}

// --- Factory Functions ---

export function createUserMessage(content: string | ContentBlock[]): EngineUserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content,
    timestamp: Date.now(),
  }
}

export function createAssistantMessage(
  content: ContentBlock[],
  stopReason: EngineAssistantMessage['stopReason'],
  usage?: LLMTokenUsage
): EngineAssistantMessage {
  return {
    id: randomUUID(),
    role: 'assistant',
    content,
    stopReason,
    timestamp: Date.now(),
    ...(usage !== undefined ? { usage } : {}),
  }
}

export function createToolResultMessage(
  toolUseId: string,
  content: string,
  isError: boolean,
  images?: ReadonlyArray<{ readonly media_type: string; readonly data: string }>,
): EngineToolResultMessage {
  return {
    id: randomUUID(),
    role: 'user',
    toolResults: [{
      tool_use_id: toolUseId,
      content,
      ...(images !== undefined ? { images } : {}),
      is_error: isError,
    }],
    timestamp: Date.now(),
  }
}

export function createBatchToolResultMessage(
  results: ReadonlyArray<{
    tool_use_id: string
    content: string
    images?: ReadonlyArray<{ readonly media_type: string; readonly data: string }>
    is_error: boolean
  }>
): EngineToolResultMessage {
  return {
    id: randomUUID(),
    role: 'user',
    toolResults: results,
    timestamp: Date.now(),
  }
}
