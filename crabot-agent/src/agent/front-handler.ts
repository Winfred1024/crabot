/**
 * Front Handler v2 - Fast triage using engine LLM adapter
 *
 * Replaces SDK-based implementation. Zero cold-start, ~10 controlled tools,
 * structured tool_use decisions via reply/create_task/supplement_task/stay_silent.
 */

import type { LLMAdapter } from '../engine/llm-adapter.js'
import type { ContentBlock, ToolDefinition } from '../engine/types.js'
import { ToolExecutor, type ToolExecutorDeps } from './tool-executor.js'
import { runFrontLoop } from './front-loop.js'
import { mcpServerToToolDefinitions } from './mcp-tool-bridge.js'
import { resolveImageBlocks } from './media-resolver.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  ChannelMessage,
  FrontAgentContext,
  HandleMessageParams,
  HandleMessageResult,
  TaskSummary,
  TraceCallback,
} from '../types.js'
import { formatNow, formatTaskCreatedAt } from '../utils/time.js'
import { resolveSenderIdentity } from '../utils/sender-identity.js'
import { formatChannelMessageLine, formatShortTermMemoryLine } from '../prompt-manager.js'

export type UserMessageContent = string | ContentBlock[]

export interface FrontHandlerConfig {
  getSystemPrompt: (isGroup: boolean) => string
  /**
   * 工厂返回 MCP server 实例集合（与 Worker 同款）。Front 启动每次 handleMessage 前调用，
   * 把这些 server 转成 ToolDefinition[] 拼到 Front 工具集中。messaging 工具在此注入，
   * 无需在 front-tools.ts 重新声明。
   */
  mcpConfigFactory: () => Record<string, McpServer>
  /** 已解析的 IANA 时区名（如 "Asia/Shanghai"），用于 prompt 时间渲染 */
  getTimezone: () => string
}

export interface FrontHandlerLlmConfig {
  readonly adapter: LLMAdapter
  readonly model: string
  readonly supportsVision?: boolean
}


export class FrontHandler {
  private adapter: LLMAdapter
  private model: string
  private supportsVision: boolean
  private toolExecutor: ToolExecutor
  private getSystemPrompt: (isGroup: boolean) => string
  private mcpConfigFactory: () => Record<string, McpServer>
  private getTimezone: () => string

  constructor(
    llmConfig: FrontHandlerLlmConfig,
    toolExecutorDeps: ToolExecutorDeps,
    config: FrontHandlerConfig,
  ) {
    this.adapter = llmConfig.adapter
    this.model = llmConfig.model
    this.supportsVision = llmConfig.supportsVision === true
    this.toolExecutor = new ToolExecutor(toolExecutorDeps)
    this.getSystemPrompt = config.getSystemPrompt
    this.mcpConfigFactory = config.mcpConfigFactory
    this.getTimezone = config.getTimezone
  }

  async handleMessage(
    params: HandleMessageParams,
    traceCallback?: TraceCallback,
  ): Promise<HandleMessageResult> {
    const { messages, context } = params
    const isGroup = messages[0]?.session?.type === 'group'
    const hasMention = messages.some(m => m.features.is_mention_crab)
    // silent 仅在群聊且未被 @ 时可用
    const allowSilent = isGroup && !hasMention
    // 仅当 Front 模型支持视觉时才把图片 base64 化注入 LLM；否则只在 prompt 里加文字提示，
    // 让 Front 知道"用户发了图片但本模型读不了"，从而可以路由到 vision slot 处理。
    const imageMessageCount = messages.filter((m) => m.content.type === 'image').length
    const imageBlocks = this.supportsVision && imageMessageCount > 0
      ? await resolveImageBlocks(messages)
      : []
    const unresolvedImageCount = !this.supportsVision ? imageMessageCount : 0
    const timezone = this.getTimezone()
    const userMessage = buildUserMessage(messages, context, imageBlocks, timezone, unresolvedImageCount)
    const rawUserText = messages.map(m => m.content.text ?? '').join('\n').trim()

    // 装配 messaging 工具（来自 crab-messaging MCP；与 Worker 同一份实现）
    const mcpServers = this.mcpConfigFactory()
    const messagingTools: ToolDefinition[] = []
    for (const [serverName, server] of Object.entries(mcpServers)) {
      messagingTools.push(...mcpServerToToolDefinitions(server, serverName))
    }

    try {
      // supplement_task 候选集只装"非 scheduled"任务的 ID。
      // 巡检/定时任务由调度引擎自主跑，用户即使主题相关也应走 create_task 开新任务，
      // 而不是 supplement 覆盖它本职。从源头把这类 task_id 排除出 enum，比靠
      // prompt 提醒 + engine 兜底更稳——LLM 选择面里根本没有它们。
      // active_tasks 全集仍照常进 prompt 渲染，让 LLM 能回答"巡检在干嘛"。
      const supplementableTaskIds = context.active_tasks
        .filter(t => t.trigger_type !== 'scheduled')
        .map(t => t.task_id)

      const result = await runFrontLoop({
        systemPrompt: this.getSystemPrompt(isGroup),
        userMessage,
        rawUserText,
        allowSilent,
        activeTaskIds: supplementableTaskIds,
        adapter: this.adapter,
        model: this.model,
        toolExecutor: this.toolExecutor,
        messagingTools,
        timezone,
        traceCallback,
      })

      return { decisions: [result.decision] }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const isGroup = messages[0]?.session?.type === 'group'
      if (isGroup) {
        return { decisions: [{ type: 'silent' }] }
      }
      return {
        decisions: [{ type: 'direct_reply', reply: { type: 'text', text: `AI 服务异常：${msg}` } }],
      }
    }
  }

  updateLlmConfig(config: {
    endpoint?: string
    apikey?: string
    accountId?: string
    model?: string
    supportsVision?: boolean
  }): void {
    if (config.endpoint !== undefined || config.apikey !== undefined || config.accountId !== undefined) {
      this.adapter.updateConfig({
        ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
        ...(config.apikey !== undefined ? { apikey: config.apikey } : {}),
        ...(config.accountId !== undefined ? { accountId: config.accountId } : {}),
      })
    }
    if (config.model !== undefined) {
      this.model = config.model
    }
    if (config.supportsVision !== undefined) {
      this.supportsVision = config.supportsVision
    }
  }
}

/** 把毫秒时长格式化为"X分Y秒"或"X小时Y分"，给 LLM 看的人话 */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分${sec % 60}秒`
  const hr = Math.floor(min / 60)
  return `${hr}小时${min % 60}分`
}

/**
 * 构建 Front Handler 发给 LLM 的 user message
 *
 * 将当前消息、上下文（recent_messages / short_term_memories / active_tasks）
 * 组装为结构化的 prompt 文本。
 */
export function buildUserMessage(
  messages: ChannelMessage[],
  context: FrontAgentContext,
  imageBlocks?: Array<{ type: 'image'; source: { type: 'base64' | 'url'; media_type: string; data: string } }>,
  timezone: string = 'UTC',
  /** 用户发了图片但当前 Front 模型无视觉能力时的图片张数；>0 时会在 prompt 里加文字提示 */
  unresolvedImageCount: number = 0,
): UserMessageContent {
  const parts: string[] = []
  const isGroup = messages[0]?.session?.type === 'group'
  const hasMention = messages.some(m => m.features.is_mention_crab)
  const now = new Date()

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

  // ── 对话场景 ──
  parts.push('## 对话场景')
  if (isGroup) {
    const session = messages[0].session
    parts.push(`- 类型: 群聊`)
    parts.push(`- 对话对象: ${session.session_id}`)
    parts.push(`- 对话对象 ID: group:${session.channel_id}:${session.session_id}`)
  } else {
    const f = context.sender_friend
    parts.push(`- 类型: 私聊`)
    parts.push(`- 对话对象: ${f.display_name}`)
    parts.push(`- 对话对象 ID: friend:${f.id}`)
    parts.push(`- 对话对象身份: ${f.permission}`)
  }

  // ── IM 渠道 ──
  if (messages.length > 0) {
    const session = messages[0].session
    parts.push('\n## IM 渠道')
    parts.push(`- channel: ${session.channel_id}`)
    parts.push(`- session: ${session.session_id}`)
    if (context.crab_display_name) {
      parts.push(`- 你在该渠道的昵称: ${context.crab_display_name}`)
    }
  }

  // ── 活跃任务（三分类 + master 权限过滤）──
  if (context.active_tasks.length > 0) {
    const currentChannel = messages[0]?.session.channel_id
    const currentSession = messages[0]?.session.session_id
    const isMaster = context.sender_friend.permission === 'master'

    const currentTasks: TaskSummary[] = []
    const otherTasks: TaskSummary[] = []
    const scheduledTasks: TaskSummary[] = []

    for (const t of context.active_tasks) {
      if (t.trigger_type === 'scheduled') scheduledTasks.push(t)
      else if (t.source_session_id === currentSession && t.source_channel_id === currentChannel) currentTasks.push(t)
      else otherTasks.push(t)
    }

    const renderTask = (t: TaskSummary, includeSource: boolean = false): string[] => {
      const lines: string[] = []
      const tag = t.trigger_type === 'scheduled' ? ' [定时/巡检任务，禁止 supplement]' : ''
      const src = includeSource && t.source_channel_id ? ` [来源: ${t.source_channel_id}:${t.source_session_id}]` : ''
      lines.push(`- [${t.task_id}] "${t.title}" (status: ${t.status})${tag}${src}`)
      if (t.latest_progress) lines.push(`  最近进度（事后摘要）: ${t.latest_progress}`)
      const live = t.live
      if (live) {
        lines.push(`  创建于 ${formatTaskCreatedAt(live.started_at, timezone, now)} / 第 ${live.current_turn} 轮`)
        if (live.last_assistant_text) {
          const tt = live.last_assistant_text.trim()
          if (tt.length > 0) lines.push(`  上轮模型说: ${tt.slice(0, 200)}${tt.length > 200 ? '…' : ''}`)
        }
        if (live.active_tools.length > 0) {
          for (const at of live.active_tools) {
            lines.push(`  正在跑工具: ${at.name}（已 ${formatElapsed(Date.now() - at.started_at)}）— ${at.input_summary}`)
          }
        }
        if (live.recent_completed.length > 0) {
          const tail = live.recent_completed.slice(-3).map(c => `${c.name}${c.is_error ? '(失败)' : ''}`).join(' / ')
          lines.push(`  最近完成: ${tail}`)
        }
        if (live.llm_retry) {
          const r = live.llm_retry
          const elapsed = formatElapsed(Date.now() - r.since)
          lines.push(`  ⚠️ LLM 调用 retry 中: ${r.attempt}/${r.max_attempts} (${r.source})，已 ${elapsed}，原因: ${r.last_error}`)
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

    parts.push('\n当用户消息可能是对某个任务的纠偏/补充时，使用 supplement_task 决策。')
    parts.push('纠偏判断优先匹配「当前对话对象的任务」段。')
    parts.push('**带 [定时/巡检任务，禁止 supplement] 标签的任务一律不可作为 supplement 目标**：用户的新需求即使主题相关，也必须 create_task。')
  }


  const shortTermHours = context.time_windows.short_term_memory_window_hours
  const recentHours = context.time_windows.recent_messages_window_hours

  // ── 短期记忆（跨 channel/session 流水账，时窗内全量内容） ──
  // 设计目的：解决跨 session 续话的指代漂移（"刚才那个群" / "上次那个" 指向另一 session 的事件）。
  // recent_messages 只盖当前 session，跨 session 的锚点必须靠这一段提供。
  parts.push(`\n## 短期记忆（跨所有 channel/session 的近期事件流水，最近 ${shortTermHours} 小时，${context.short_term_memories.length} 条）`)
  if (context.short_term_memories.length > 0) {
    parts.push('当用户用代词指代过去事件（"刚才那个 X"/"上次"/"接着之前的"）时，先看这里再做决策——条目带 channel/session/task 锚点，可直接 cite。')
    for (const mem of context.short_term_memories) {
      parts.push(formatShortTermMemoryLine(mem, { timezone, now, maxLen: 500 }))
    }
  } else {
    parts.push(`过去 ${shortTermHours} 小时内无相关短期记忆。如需更早的事件流水，可在 create_task 的 description 里说明，让 worker 调 \`crab-memory.search_short_term\` 查。`)
  }

  // ── 聊天历史（仅当前 session，时窗内全量；XML tag 包裹避免 markdown 嵌套污染）──
  // 越靠近当前消息越重要，给更大的字符预算，保留完整的行动 offer / 决策上下文。
  // 注意：本段只反映当前 session 的本地历史，回答跨 session 指代必须看上方"短期记忆"段。
  parts.push(`\n## 聊天历史（当前 session，最近 ${recentHours} 小时，${context.recent_messages.length} 条）`)
  if (context.recent_messages.length > 0) {
    const total = context.recent_messages.length
    for (let i = 0; i < total; i++) {
      const distFromEnd = total - 1 - i
      const maxLen = distFromEnd < 3 ? 2000 : distFromEnd < 10 ? 600 : 300
      const msg = context.recent_messages[i]
      const identity = resolveSenderIdentity({
        msg,
        senderFriend: context.sender_friend,
        crabDisplayName: context.crab_display_name,
        isGroup,
      })
      parts.push(formatChannelMessageLine(msg, { timezone, now, maxLen, identity }))
    }
  } else {
    parts.push(`过去 ${recentHours} 小时本会话无消息。如需更早的本会话历史，调 \`get_history\` 工具。`)
  }

  // ── 当前消息（XML 包裹）──
  if (isGroup) {
    parts.push(`\n## 当前群聊消息批次（共 ${messages.length} 条）`)
    parts.push(`- 是否 @你: ${hasMention ? '是' : '否'}`)
    for (const msg of messages) {
      const identity = resolveSenderIdentity({
        msg,
        senderFriend: context.sender_friend,
        crabDisplayName: context.crab_display_name,
        isGroup: true,
      })
      parts.push(formatChannelMessageLine(msg, { timezone, now, maxLen: 2000, mentionMark: true, identity }))
    }

    if (hasMention) {
      parts.push('\n## 群聊决策提示')
      parts.push('本批次消息 @了你，你必须回复（reply 或 create_task），禁止选择 stay_silent。')
    } else {
      // 检测对话延续性：recent_messages 中 bot 近期是否参与过对话
      const crabName = context.crab_display_name
      const botRecentlyActive = crabName
        ? context.recent_messages.some(m => m.sender.platform_display_name === crabName)
        : false

      // 检测引用回复：当前消息是否引用了 bot 的消息
      const quotedBotMessage = crabName
        ? messages.some(m => {
            const quoteId = m.features.quote_message_id ?? m.features.reply_to_message_id
            if (!quoteId) return false
            return context.recent_messages.some(
              rm => rm.platform_message_id === quoteId && rm.sender.platform_display_name === crabName
            )
          })
        : false

      parts.push('\n## 群聊决策提示')
      if (quotedBotMessage) {
        parts.push('本批次消息引用了你之前的回复，你应该回复（reply 或 create_task），禁止选择 stay_silent。')
      } else if (botRecentlyActive) {
        parts.push('本批次消息没有 @你，但你近期在群中参与过对话。如果本条消息与你之前的回复相关（如追问、延续讨论），你应该回复（reply）。')
        parts.push('如果消息明显与你无关（群成员之间的独立讨论、转换了话题），则选择 stay_silent。')
      } else {
        parts.push('本批次消息没有 @你。群成员之间的讨论（即使涉及技术/代码话题）不算向你提问。')
        parts.push('除非有人明确叫你名字或话题中没有其他对话对象且明显在向你求助，否则默认选择 stay_silent。')
      }
    }
  } else {
    parts.push('\n## 当前消息')
    for (const msg of messages) {
      const identity = resolveSenderIdentity({
        msg,
        senderFriend: context.sender_friend,
        crabDisplayName: context.crab_display_name,
        isGroup: false,
      })
      parts.push(formatChannelMessageLine(msg, { timezone, now, maxLen: 2000, identity }))
    }
  }

  if (unresolvedImageCount > 0) {
    parts.push('')
    parts.push(`> 注意：用户附带了 ${unresolvedImageCount} 张图片，但当前 Front 模型不具备视觉能力，无法识别图片内容。如果用户的意图依赖图片，请 create_task 交给 Worker（Worker 可调用 vision sub-agent 解析），不要凭文字猜测图片内容。`)
  }

  parts.push('\n## 指令')
  parts.push('请分析上述消息并调用决策工具（reply / create_task / supplement_task / stay_silent）。')

  const textPrompt = parts.join('\n')

  // 如果有图片内容，返回 ContentBlock[]（text + image blocks）
  if (imageBlocks && imageBlocks.length > 0) {
    return [
      { type: 'text' as const, text: textPrompt },
      ...imageBlocks,
    ]
  }

  return textPrompt
}
