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

export interface ProgressDigestConfig {
  readonly intervalMs: number
  /** 主人私聊场景 —— 允许暴露完整路径；否则要求 LLM 用 basename 替代 */
  readonly isMasterPrivate: boolean
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
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private flushing = false
  /** 上次 flush 时观察到的 snapshot 长度 —— 没有新内容时跳过 flush */
  private lastFlushMessagesCount = 0

  constructor(config: ProgressDigestConfig, deps: ProgressDigestDeps) {
    this.config = config
    this.deps = deps
    this.startTimer()
  }

  /**
   * 入口仅保留 ask_human 立即 flush 一类的快速触发；
   * 普通 turn event 不进 buffer —— 现在的摘要直接读 messagesRef。
   */
  ingest(event: EngineTurnEvent): void {
    if (this.disposed) return
    const isAskHuman = event.toolCalls.some(tc => {
      if (tc.name === 'mcp__crab-messaging__send_message' || tc.name === 'send_message') {
        const input = tc.input as { intent?: string } | undefined
        return input?.intent === 'ask_human'
      }
      return false
    })
    if (isAskHuman) this.flushNow()
  }

  flushNow(): void {
    if (this.disposed) return
    this.doFlush().catch(() => {})
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      this.doFlush().catch(() => {})
    }, this.config.intervalMs)
  }

  private async doFlush(): Promise<void> {
    if (this.flushing) return
    const snapshot = this.deps.messagesRef.current
    if (snapshot.length === 0) return
    // 与上次相比没有新增 turn → 跳过（避免重复输出相同进度）
    if (snapshot.length <= this.lastFlushMessagesCount) return

    this.flushing = true
    const observedCount = snapshot.length

    try {
      const message = await this.generateDigest(snapshot)
      if (message.length > 0) {
        await this.deps.sendToUser(message)
        this.lastFlushMessagesCount = observedCount
      }
    } catch {
      // 摘要失败就静默 —— 发垃圾汇报比不发更糟
    } finally {
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
