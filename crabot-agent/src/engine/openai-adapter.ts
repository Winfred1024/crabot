/**
 * OpenAI Chat Completions LLM Adapter
 */

import type { LLMAdapter, LLMAdapterConfig, LLMStreamParams, LLMCallResponse } from './llm-adapter-types.js'
import { isToolResultMessage, extractText, buildImageUrl, readSSELines, mergeConsecutiveUserMessages, wrapOnRetry, capToolResultForLLM } from './llm-adapter-types.js'
import type { EngineMessage, ToolDefinition, StreamChunk, ContentBlock, LLMTokenUsage } from './types.js'
import { HttpResponseError, streamWithRetry, withRetry } from './retry-utils.js'
import { isMaterialChunk, parseToolInput } from './stream-processor.js'

// --- OpenAI Message Types ---

interface OpenAITextContent {
  readonly type: 'text'
  readonly text: string
}

interface OpenAIImageUrlContent {
  readonly type: 'image_url'
  readonly image_url: { readonly url: string }
}

type OpenAIContentPart = OpenAITextContent | OpenAIImageUrlContent

interface OpenAIToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly arguments: string
  }
}

interface OpenAIAssistantMessage {
  readonly role: 'assistant'
  readonly content: string | null
  readonly tool_calls?: OpenAIToolCall[]
  // DeepSeek thinking mode 扩展字段；tool-use loop 中必须原样回传，其它 OpenAI 兼容 endpoint 忽略
  readonly reasoning_content?: string
}

interface OpenAIToolMessage {
  readonly role: 'tool'
  readonly tool_call_id: string
  readonly content: string
}

type OpenAIMessage =
  | { readonly role: 'user'; readonly content: string | OpenAIContentPart[] }
  | OpenAIAssistantMessage
  | OpenAIToolMessage
  | { readonly role: 'system'; readonly content: string }

interface OpenAITool {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

// --- OpenAI Message Normalization ---

export function normalizeMessagesForOpenAI(messages: ReadonlyArray<EngineMessage>): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  for (const msg of messages) {
    if (isToolResultMessage(msg)) {
      for (const tr of msg.toolResults) {
        result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: capToolResultForLLM(tr.content) })
      }
      continue
    }

    if (msg.role === 'assistant') {
      const textContent = extractText(msg.content)
      const toolUseParts = msg.content.filter((b) => b.type === 'tool_use')

      const toolCalls: OpenAIToolCall[] = toolUseParts.map((b) => {
        const tu = b as { id: string; name: string; input: Record<string, unknown> }
        return {
          id: tu.id,
          type: 'function' as const,
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        }
      })

      // DeepSeek thinking mode 契约：tool-use loop 中 assistant 消息必须把 reasoning_content
      // 原样回传，否则 400。其它 OpenAI 兼容 endpoint 会把这个字段当 unknown 字段忽略。
      const reasoningContent = msg.content
        .filter((b): b is { type: 'raw_reasoning'; data: Record<string, unknown> } => b.type === 'raw_reasoning')
        .map((b) => (typeof b.data.reasoning_content === 'string' ? b.data.reasoning_content : ''))
        .join('')

      result.push({
        role: 'assistant',
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      } as OpenAIAssistantMessage)
      continue
    }

    if (typeof msg.content === 'string') {
      result.push({ role: 'user', content: msg.content })
      continue
    }

    const contentParts: OpenAIContentPart[] = msg.content.map((block: ContentBlock): OpenAIContentPart => {
      if (block.type === 'image') {
        return { type: 'image_url', image_url: { url: buildImageUrl(block.source) } }
      }
      return { type: 'text', text: block.type === 'text' ? block.text : '' }
    })

    result.push({ role: 'user', content: contentParts })
  }

  return mergeConsecutiveUserMessages(result, (content) =>
    Array.isArray(content) ? content : [{ type: 'text' as const, text: content as string } as OpenAITextContent],
  )
}

// --- OpenAI Tool Conversion ---

export function toOpenAITool(tool: ToolDefinition): OpenAITool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }
}

type OpenAIFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'function_call'
type EngineStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null

function mapOpenAIFinishReason(raw: string | null | undefined): EngineStopReason {
  switch (raw as OpenAIFinishReason | null | undefined) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return null
  }
}

// --- OpenAI Adapter ---

export class OpenAIAdapter implements LLMAdapter {
  private config: LLMAdapterConfig

  constructor(config: LLMAdapterConfig) {
    this.config = config
  }

  updateConfig(config: Partial<LLMAdapterConfig>): void {
    this.config = {
      endpoint: config.endpoint ?? this.config.endpoint,
      apikey: config.apikey ?? this.config.apikey,
    }
  }

  async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    yield* streamWithRetry(
      'openai-adapter',
      () => this.streamOnce(params),
      {
        abortSignal: params.signal,
        isMaterial: isMaterialChunk,
        onRetry: wrapOnRetry(params.onRetry, 'pre-stream'),
      },
    )
  }

  async complete(params: LLMStreamParams): Promise<LLMCallResponse> {
    const messages = normalizeMessagesForOpenAI(params.messages)
    const tools = params.tools.map(toOpenAITool)

    const body: Record<string, unknown> = {
      model: params.model,
      ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
      messages: [{ role: 'system', content: params.systemPrompt }, ...messages],
      stream: false,
    }
    if (tools.length > 0) {
      body.tools = tools
    }

    const data = await withRetry(
      'openai-adapter',
      async () => {
        const response = await fetch(`${this.config.endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apikey}`,
          },
          body: JSON.stringify(body),
          signal: params.signal,
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new HttpResponseError(response.status, errorText, 'openai-adapter')
        }
        return response.json() as Promise<{
          choices?: Array<{
            message?: {
              content?: string | null
              reasoning_content?: string | null
              tool_calls?: Array<{
                id: string
                function?: { name?: string; arguments?: string }
              }>
            }
            finish_reason?: string | null
          }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }>
      },
      {
        abortSignal: params.signal,
        onRetry: wrapOnRetry(params.onRetry, 'complete'),
      },
    )

    const choice = data.choices?.[0]
    const msg = choice?.message
    const content: ContentBlock[] = []

    // DeepSeek thinking mode：reasoning_content 必须放在 text 之前（buildAssistantContent 依赖此顺序）
    if (msg?.reasoning_content) {
      content.push({ type: 'raw_reasoning', data: { reasoning_content: msg.reasoning_content } })
    }
    if (msg?.content) {
      content.push({ type: 'text', text: msg.content })
    }
    if (msg?.tool_calls) {
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name ?? '',
          input: parseToolInput(tc.function?.arguments ?? ''),
        })
      }
    }

    const stopReason = mapOpenAIFinishReason(choice?.finish_reason ?? null)
    const usage = extractOpenAIUsage(data.usage)
    if (!usage) {
      // 第三方 OpenAI 代理（mirror、sub2api 等）有时 stream:false 不回 usage——
      // 让运维能从日志确认是上游问题，不是 trace 漏埋点
      const dataKeys = data && typeof data === 'object' ? Object.keys(data as object).join(',') : 'non-object'
      console.warn(`[openai-adapter] complete: response missing usage (model=${params.model}, endpoint=${this.config.endpoint}, top-level keys=[${dataKeys}])`)
    }
    return {
      content,
      stopReason,
      ...(usage ? { usage } : {}),
    }
  }

  private async *streamOnce(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    const messages = normalizeMessagesForOpenAI(params.messages)
    const tools = params.tools.map(toOpenAITool)

    const body: Record<string, unknown> = {
      model: params.model,
      ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
      messages: [{ role: 'system', content: params.systemPrompt }, ...messages],
      stream: true,
      stream_options: { include_usage: true },
    }

    if (tools.length > 0) {
      body.tools = tools
    }

    const response = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apikey}`,
      },
      body: JSON.stringify(body),
      signal: params.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new HttpResponseError(response.status, errorText, 'openai-adapter')
    }

    if (!response.body) {
      throw new Error('openai-adapter: no response body received')
    }

    let messageStarted = false
    const activeToolCalls = new Map<number, string>()
    // response.body 是 ReadableStream。提前 break（[DONE]）或异常退出时不显式 cancel，
    // undici 在 keep-alive 路径下可能晚释放 socket / decompressor（这块是 native heap，
    // V8 看不见）。详见 2026-06-06 kernel watchdog panic 复盘 —— anthropic-adapter 是
    // 主因，这里属同类防御。
    const sseBody = response.body
    try {
    for await (const line of readSSELines(sseBody)) {
      if (line === '[DONE]') break

      let data: Record<string, unknown>
      try {
        data = JSON.parse(line)
      } catch {
        continue
      }

      if (!messageStarted) {
        messageStarted = true
        yield { type: 'message_start', messageId: (data as { id?: string }).id ?? 'msg_openai' }
      }

      const usage = extractOpenAIUsage(data.usage)
      const choices = data.choices as Array<{
        delta?: {
          content?: string | null
          reasoning_content?: string | null
          tool_calls?: Array<{
            index: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
        finish_reason?: string | null
      }> | undefined

      if (choices && choices.length > 0) {
        const choice = choices[0]
        const delta = choice.delta

        if (delta) {
          // DeepSeek thinking mode：reasoning_content fragment 先发，保证 reasoning → text → tool_use
          // 的顺序（query-loop.buildAssistantContent 依赖 raw_reasoning 在前）
          if (delta.reasoning_content) {
            yield { type: 'raw_reasoning', data: { reasoning_content: delta.reasoning_content } }
          }

          if (delta.content) {
            yield { type: 'text_delta', text: delta.content }
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.id) {
                activeToolCalls.set(tc.index, tc.id)
                yield { type: 'tool_use_start', id: tc.id, name: tc.function?.name ?? '' }
              }
              if (tc.function?.arguments) {
                yield { type: 'tool_use_delta', id: activeToolCalls.get(tc.index) ?? '', inputJson: tc.function.arguments }
              }
            }
          }
        }

        const stopReason = mapOpenAIFinishReason(choice.finish_reason)
        if (stopReason !== null) {
          if (choice.finish_reason === 'tool_calls') {
            for (const [, id] of activeToolCalls) {
              yield { type: 'tool_use_end', id }
            }
            activeToolCalls.clear()
          }
          yield {
            type: 'message_end',
            stopReason,
            ...(usage ? { usage } : {}),
          }
        }
      }

      if (usage && (!choices || choices.length === 0)) {
        yield {
          type: 'message_end',
          stopReason: null,
          usage,
        }
      }
    }
    } finally {
      try { await sseBody.cancel() } catch { /* already drained / errored */ }
    }
  }
}

/**
 * 从 OpenAI Chat Completions usage 提取 token。
 *
 * 语义对齐（关键）：OpenAI 原生 `prompt_tokens` 是"全量输入（含 cached）"，
 * 而 Anthropic 原生 `input_tokens` 是"未命中缓存的输入"。这里把 OpenAI 拍成
 * Anthropic 语义——`inputTokens = prompt_tokens - cached_tokens`，让全链路统一：
 *   inputTokens         = 未命中缓存的输入（实际计费的 prompt 部分）
 *   cacheReadTokens     = 命中缓存读取的部分（享受折扣价）
 *   cacheCreationTokens = 写入缓存的部分（Anthropic 专属，OpenAI 缺省）
 *   全量 prompt size    = inputTokens + cacheReadTokens + cacheCreationTokens
 */
function extractOpenAIUsage(raw: unknown): LLMTokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  if (typeof u.prompt_tokens !== 'number' && typeof u.completion_tokens !== 'number') return undefined
  const promptTokens = u.prompt_tokens ?? 0
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0
  const uncached = Math.max(0, promptTokens - cached)
  return {
    inputTokens: uncached,
    outputTokens: u.completion_tokens ?? 0,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}
