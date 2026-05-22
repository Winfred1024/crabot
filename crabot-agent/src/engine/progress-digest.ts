import type { LLMAdapter } from './llm-adapter'
import { callNonStreaming } from './llm-adapter'
import type { EngineMessage, EngineTurnEvent } from './types'
import { createUserMessage } from './types'

/**
 * 进度汇报（fork 模式）。
 *
 * 思路：定时从主 loop 的 messages 数组 fork 一份只读副本，在末尾追加一条
 * "请汇报"user msg，调主 loop 自己的 adapter 跑一次非流式 LLM 调用，把
 * 输出转给用户。主 loop 完全不感知本次 fork——messages 是浅拷贝，主 loop
 * 的对话历史不会被污染。
 *
 * 为什么 fork 主 loop：摘要 LLM 需要看到任务上下文（user 的原始诉求、
 * 思考过程、工具调用 + 结果、todo 状态）才能写出有意义的汇报。旧实现
 * 只喂工具名计数，所以只能输出"做了 3 次 Glob、5 次 grep"这类废话。
 */

// --- Config & Deps ---

export type DigestReason = 'interval' | 'overdue' | 'ask_human'

export interface ProgressDigestConfig {
  /** 定时 flush 间隔（毫秒）；不传或 ≤0 表示不启用定时触发 */
  readonly intervalMs?: number
  /**
   * 超期触发延迟（毫秒，相对于 ProgressDigest 构造时刻）。
   * 不传表示不启用超期触发。启用后到时间会触发一次 fork-and-send，且只触发一次。
   * 跟 intervalMs 是两条独立触发条件，可以一起开 / 单独开 / 都不开。
   */
  readonly overdueMs?: number
  /** 主人私聊场景 —— 允许暴露完整路径；否则要求 LLM 用 basename 替代 */
  readonly isMasterPrivate: boolean
  /**
   * trace 写入回调：每次 fork-and-send 开始时调一次。
   * 不传则不写 trace；返回的 spanId 由调用方在 trace 结束时配合 onTraceEnd 关闭。
   */
  readonly onTraceStart?: (reason: DigestReason) => string | undefined
  /** 配合 onTraceStart 使用：fork-and-send 完成（含失败）时调一次。 */
  readonly onTraceEnd?: (spanId: string, status: 'completed' | 'failed', details?: Record<string, unknown>) => void
}

export interface ProgressDigestDeps {
  readonly sendToUser: (text: string) => Promise<void>
  /** 主 loop 自己的 adapter；fork 调用直接复用，省去额外配置 */
  readonly adapter: LLMAdapter
  /** 主 loop 自己的 model_id */
  readonly modelId: string
  /** 主 loop 的 maxTokens；不传则走 adapter 默认 */
  readonly maxTokens?: number
  /**
   * 主 loop messages 的只读 holder。engine 在每个 turn 完成时浅拷贝刷新
   * `current`。doFlush 时拿当前快照 fork 一份给摘要 LLM。
   */
  readonly messagesRef: { readonly current: ReadonlyArray<EngineMessage> }
}

// --- Prompts ---

const DIGEST_SYSTEM_PROMPT =
  '你是任务执行助手。根据完整对话历史向 master 汇报当前进度。' +
  '严格基于历史事实，不要推测、编造或虚构未发生的操作和结果。' +
  '不超过 80 字。'

const buildAskPrompt = (isMasterPrivate: boolean): string => {
  const base = '请用 1-2 句话汇报：你刚才在做什么（具体的、有意义的事），现在在做什么 / 卡在哪 / 下一步打算。\n' +
    '要求：\n' +
    '- 第一人称，像同事汇报\n' +
    '- 不要列工具名计数（如"调用 Bash 3 次"），说有意义的事\n' +
    '- 不要 markdown 格式\n' +
    '- 只输出汇报文本，不要"好的""汇报如下"这类前后缀'
  if (!isMasterPrivate) {
    return base + '\n- 不要泄露绝对路径，路径只说 basename（如 progress-digest.ts 而不是 /Users/xxx/.../progress-digest.ts）'
  }
  return base
}

// --- Class ---

export class ProgressDigest {
  private readonly config: ProgressDigestConfig
  private readonly deps: ProgressDigestDeps
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private overdueTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private flushing = false
  /** 上次 flush 时观察到的 snapshot 长度 —— 没有新内容时跳过 flush */
  private lastFlushMessagesCount = 0
  /**
   * agent 在本 loop 已经成功调过 send_message —— overdue 触发时用作"用户已知进度"
   * 的兜底判断：agent 主动说过话了就不再额外发 overdue digest，避免用户收两条
   * 相近的进度消息。interval 不受此影响（interval 是稳定节奏）。
   */
  private sentMessageSinceStart = false

  constructor(config: ProgressDigestConfig, deps: ProgressDigestDeps) {
    this.config = config
    this.deps = deps
    this.startTimers()
  }

  /**
   * 入口做两件事：
   * 1. 检测 send_message 调用 → 标记 sentMessageSinceStart（影响 overdue 是否触发）
   * 2. ask_human 立即 flush（用户必须立刻看到问题）
   */
  ingest(event: EngineTurnEvent): void {
    if (this.disposed) return
    let askHuman = false
    for (const tc of event.toolCalls) {
      const bare = tc.name.replace(/^mcp__[^_]+__/, '')
      const isSendMsg = bare === 'send_message' || bare === 'send_private_message'
      if (!isSendMsg || tc.isError) continue
      this.sentMessageSinceStart = true
      const intent = (tc.input as { intent?: string } | undefined)?.intent
      if (intent === 'ask_human') askHuman = true
    }
    if (askHuman) this.flushNow('ask_human')
  }

  flushNow(reason: DigestReason = 'ask_human'): void {
    if (this.disposed) return
    this.doFlush(reason).catch(() => {})
  }

  dispose(): void {
    this.disposed = true
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
    if (this.overdueTimer !== null) {
      clearTimeout(this.overdueTimer)
      this.overdueTimer = null
    }
  }

  private startTimers(): void {
    if (this.config.intervalMs !== undefined && this.config.intervalMs > 0) {
      this.intervalTimer = setInterval(() => {
        this.doFlush('interval').catch(() => {})
      }, this.config.intervalMs)
    }
    if (this.config.overdueMs !== undefined && this.config.overdueMs > 0) {
      this.overdueTimer = setTimeout(() => {
        this.overdueTimer = null
        this.doFlush('overdue').catch(() => {})
      }, this.config.overdueMs)
    }
  }

  private async doFlush(reason: DigestReason): Promise<void> {
    if (this.flushing) return
    // overdue 触发但 agent 已经 send_message 过 → 跳过：用户已经收到 agent 自己写的
    // 进度（带工作记忆 + 后续行动），再发一份 fork digest 是冗余。interval / ask_human
    // 不受此判断影响。
    if (reason === 'overdue' && this.sentMessageSinceStart) return
    const snapshot = this.deps.messagesRef.current
    if (snapshot.length === 0) return
    // 与上次相比没有新增 turn → 跳过（避免重复输出相同进度）
    if (snapshot.length <= this.lastFlushMessagesCount) return
    // 防御性检查：跳过尾部有"孤立 tool_use"（assistant 调了工具但 tool_result
    // 还没 push）的快照。OpenAI Responses / Anthropic 都严格要求 function_call
    // 配 output；race 窗口里 fork 这种半截 messages 会 400。
    if (hasDanglingToolUse(snapshot)) return

    this.flushing = true
    const observedCount = snapshot.length
    const spanId = this.config.onTraceStart?.(reason)
    let status: 'completed' | 'failed' = 'completed'
    let details: Record<string, unknown> | undefined

    try {
      const message = await this.generateDigest(snapshot)
      if (message.length > 0) {
        await this.deps.sendToUser(message)
        this.lastFlushMessagesCount = observedCount
        details = { output_summary: message.slice(0, 200), messages_count: observedCount }
      } else {
        details = { output_summary: '(empty)', messages_count: observedCount }
      }
    } catch (err) {
      status = 'failed'
      details = { error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (spanId !== undefined) {
        this.config.onTraceEnd?.(spanId, status, details)
      }
      this.flushing = false
    }
  }

  private async generateDigest(snapshot: ReadonlyArray<EngineMessage>): Promise<string> {
    const askPrompt = buildAskPrompt(this.config.isMasterPrivate)
    const forkMessages: EngineMessage[] = [...snapshot, createUserMessage(askPrompt)]

    const params = {
      messages: forkMessages,
      systemPrompt: DIGEST_SYSTEM_PROMPT,
      tools: [],
      model: this.deps.modelId,
      ...(this.deps.maxTokens !== undefined ? { maxTokens: this.deps.maxTokens } : {}),
    }
    const response = await callNonStreaming(this.deps.adapter, params)

    return response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()
  }
}

// --- Helpers ---

/**
 * 末尾是否有"孤立 tool_use"：最后一条 assistant 含 tool_use 块，但后面没有
 * 配对的 tool_result。LLM API 严格要求 function_call 配 output，否则 400。
 */
function hasDanglingToolUse(messages: ReadonlyArray<EngineMessage>): boolean {
  // 从尾向前找最后一条 assistant
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    // 找到最后一条 assistant：看它有没有 tool_use 块
    const hasToolUse = Array.isArray(m.content)
      && m.content.some((b) => (b as { type?: string }).type === 'tool_use')
    if (!hasToolUse) return false
    // 有 tool_use → 检查后面是否有 tool_result（用 toolResults 字段判定 EngineToolResultMessage）
    for (let j = i + 1; j < messages.length; j++) {
      const after = messages[j] as { toolResults?: unknown }
      if (Array.isArray(after.toolResults) && after.toolResults.length > 0) return false
    }
    return true
  }
  return false
}
