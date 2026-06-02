/**
 * Multi-turn LLM harness — 完整跑一遍 agent 处理 13:58 现场的 worker loop。
 *
 * 跟单轮 harness 的本质区别：本 runner 自己跑 turn loop，工具调用结果用 fixture
 * 回灌进 messages，再喂下一 turn，直到 agent 自然停止（end_turn）或调 send_message。
 *
 * **为什么不直接复用 AgentHandler？** 完整 AgentHandler 依赖 admin/memory/channel
 * 三个外部模块的 RPC，构造 deps 链非常重。这里只关心 "LLM 接到工具结果后会怎么决策"
 * 这一条链路，自己写一个简化 loop 更可控。assemble prompt / tool schema / 工具结果
 * 格式都跟生产对齐，但调用层用 fake。
 */

import OpenAI from 'openai'

export type ToolName = string

export interface ToolCallRecord {
  readonly id: string
  readonly name: ToolName
  readonly args: Record<string, unknown>
  readonly result: string
  readonly isError: boolean
}

export interface TurnRecord {
  readonly turn: number
  readonly assistantText: string
  readonly toolCalls: ReadonlyArray<ToolCallRecord>
  readonly elapsedMs: number
  readonly usage?: { prompt: number; completion: number; total: number }
}

export interface RunResult {
  readonly turns: ReadonlyArray<TurnRecord>
  readonly finalText: string
  readonly stoppedReason: 'no_tool_call' | 'sent_message' | 'max_turns' | 'error'
  readonly errorMessage?: string
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<{ result: string; isError: boolean }>

export interface MultiTurnRunnerInput {
  readonly client: OpenAI
  readonly model: string
  readonly systemPrompt: string
  readonly initialUserPrompt: string
  readonly tools: ReadonlyArray<OpenAI.Chat.Completions.ChatCompletionTool>
  /** 工具名 → 处理器映射；未注册的工具调用会以 error 形式回灌 */
  readonly toolHandlers: Record<ToolName, ToolHandler>
  readonly maxTurns?: number
  /** 出现 send_message 调用时是否停 loop（默认 true：模拟用户回话前 worker 不再 turn） */
  readonly stopOnSendMessage?: boolean
}

export async function runMultiTurn(input: MultiTurnRunnerInput): Promise<RunResult> {
  const {
    client,
    model,
    systemPrompt,
    initialUserPrompt,
    tools,
    toolHandlers,
    maxTurns = 10,
    stopOnSendMessage = true,
  } = input

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialUserPrompt },
  ]

  const turns: TurnRecord[] = []

  for (let turn = 1; turn <= maxTurns; turn++) {
    const startedAt = Date.now()
    let response: OpenAI.Chat.Completions.ChatCompletion
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools: [...tools],
        tool_choice: 'auto',
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      return {
        turns,
        finalText: '',
        stoppedReason: 'error',
        errorMessage: errMsg,
      }
    }
    const elapsedMs = Date.now() - startedAt

    const msg = response.choices[0].message
    const assistantText = msg.content ?? ''
    const rawToolCalls = msg.tool_calls ?? []

    // 把 assistant message 加进历史
    messages.push({
      role: 'assistant',
      content: assistantText || null,
      ...(rawToolCalls.length > 0 ? { tool_calls: rawToolCalls } : {}),
    } as OpenAI.Chat.Completions.ChatCompletionMessageParam)

    // 处理 tool_calls：调对应 handler 拿结果，塞 tool 角色回去
    const records: ToolCallRecord[] = []
    let hitSendMessage = false
    for (const tc of rawToolCalls) {
      if (tc.type !== 'function') continue
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.function.arguments)
      } catch {
        args = { __raw: tc.function.arguments }
      }

      const handler = toolHandlers[tc.function.name]
      let result: string
      let isError: boolean
      if (handler) {
        try {
          const r = await handler(args)
          result = r.result
          isError = r.isError
        } catch (err) {
          result = `Handler crashed: ${err instanceof Error ? err.message : String(err)}`
          isError = true
        }
      } else {
        result = `Tool "${tc.function.name}" 在 harness 里没注册处理器（fixture 未覆盖该工具）`
        isError = true
      }

      records.push({ id: tc.id, name: tc.function.name, args, result, isError })

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      } as OpenAI.Chat.Completions.ChatCompletionMessageParam)

      if (tc.function.name === 'send_message') hitSendMessage = true
    }

    turns.push({
      turn,
      assistantText,
      toolCalls: records,
      elapsedMs,
      usage: response.usage
        ? {
            prompt: response.usage.prompt_tokens,
            completion: response.usage.completion_tokens,
            total: response.usage.total_tokens,
          }
        : undefined,
    })

    // 退出条件
    if (rawToolCalls.length === 0) {
      return { turns, finalText: assistantText, stoppedReason: 'no_tool_call' }
    }
    if (stopOnSendMessage && hitSendMessage) {
      return { turns, finalText: assistantText, stoppedReason: 'sent_message' }
    }
  }

  return { turns, finalText: '', stoppedReason: 'max_turns' }
}

// ---------------------------------------------------------------------------
// Pretty-print helpers
// ---------------------------------------------------------------------------

function indent(text: string, prefix: string = '    '): string {
  return text.split('\n').map((l) => prefix + l).join('\n')
}

export function formatRunResult(result: RunResult): string {
  const lines: string[] = []
  lines.push(`=== Conversation (${result.turns.length} turns, stopped: ${result.stoppedReason}) ===\n`)
  for (const turn of result.turns) {
    lines.push(`────────── Turn ${turn.turn} (${turn.elapsedMs}ms${turn.usage ? `, ${turn.usage.total} tok` : ''}) ──────────`)
    if (turn.assistantText) {
      lines.push('Assistant text:')
      lines.push(indent(turn.assistantText))
    }
    if (turn.toolCalls.length === 0) {
      lines.push('(no tool_calls — natural end_turn)')
    } else {
      for (let i = 0; i < turn.toolCalls.length; i++) {
        const tc = turn.toolCalls[i]
        lines.push(`Tool call [${i + 1}] ${tc.name}${tc.isError ? ' [ERROR result]' : ''}`)
        lines.push('  args:')
        lines.push(indent(JSON.stringify(tc.args, null, 2), '    '))
        const trimResult = tc.result.length > 800 ? tc.result.slice(0, 800) + `\n... [+${tc.result.length - 800} 字符]` : tc.result
        lines.push('  result:')
        lines.push(indent(trimResult, '    '))
      }
    }
    lines.push('')
  }
  if (result.errorMessage) {
    lines.push(`!! Error: ${result.errorMessage}`)
  }
  return lines.join('\n')
}
