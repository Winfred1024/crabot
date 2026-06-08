/**
 * Anthropic LLM Adapter
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  MessageParam,
  Tool as AnthropicTool,
  ImageBlockParam,
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import { proxyManager } from 'crabot-shared'
import type { LLMAdapter, LLMAdapterConfig, LLMStreamParams, LLMCallResponse } from './llm-adapter-types.js'
import { streamWithRetry, withRetry } from './retry-utils.js'
import { isToolResultMessage, mergeConsecutiveUserMessages, wrapOnRetry, capToolResultForLLM } from './llm-adapter-types.js'
import { isMaterialChunk } from './stream-processor.js'
import type { EngineMessage, ToolDefinition, StreamChunk, ContentBlock, LLMTokenUsage } from './types.js'

// --- Default max_tokens by model family ---
// Anthropic SDK 强制要求 max_tokens；当上游（admin provider config）没配时，
// 按模型家族选一个不会被 API 拒绝且能容纳 reasoning + 实际产出的值。
// 用户可在 Admin Web 模型设置里覆盖。
function defaultAnthropicMaxTokens(model: string): number {
  const m = model.toLowerCase()
  // claude-3 / claude-3-5 / claude-3-7 系列 API 上限多为 8192
  if (m.includes('claude-3')) return 8192
  // claude-4 / claude-opus-4 / claude-sonnet-4 / claude-haiku-4 起，上限 32K-64K
  // 32K 是各档位都能接受的安全值（够 reasoning + 长响应）；想跑更长由用户在 admin 上调
  return 32768
}

// --- Anthropic Message Normalization ---

export function normalizeMessagesForAnthropic(messages: ReadonlyArray<EngineMessage>): MessageParam[] {
  const raw = messages.map((msg): MessageParam => {
    if (isToolResultMessage(msg)) {
      return {
        role: 'user',
        content: msg.toolResults.map((tr) => {
          const capped = capToolResultForLLM(tr.content)
          if (tr.images?.length) {
            return {
              type: 'tool_result' as const,
              tool_use_id: tr.tool_use_id,
              is_error: tr.is_error,
              content: [
                ...(capped ? [{ type: 'text' as const, text: capped }] : []),
                ...tr.images.map((img) => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: img.media_type as 'image/png',
                    data: img.data,
                  },
                })),
              ],
            }
          }
          return {
            type: 'tool_result' as const,
            tool_use_id: tr.tool_use_id,
            content: capped,
            is_error: tr.is_error,
          }
        }),
      }
    }

    if (msg.role === 'assistant') {
      return {
        role: 'assistant',
        content: msg.content.map((block) => {
          switch (block.type) {
            case 'text':
              return { type: 'text' as const, text: block.text }
            case 'tool_use':
              return {
                type: 'tool_use' as const,
                id: block.id,
                name: block.name,
                input: block.input,
              }
            default:
              return { type: 'text' as const, text: '' }
          }
        }),
      }
    }

    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content }
    }

    const content: Array<TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam> =
      msg.content.map((block): TextBlockParam | ImageBlockParam => {
        if (block.type === 'image') {
          return {
            type: 'image',
            source: {
              type: block.source.type as 'base64',
              media_type: block.source.media_type as ImageBlockParam.Source['media_type'],
              data: block.source.data,
            },
          }
        }
        return { type: 'text', text: block.type === 'text' ? block.text : '' }
      })

    return { role: 'user', content }
  })

  return mergeConsecutiveUserMessages(raw, (content) =>
    Array.isArray(content) ? content : [{ type: 'text' as const, text: content as string }],
  )
}

// --- Anthropic Adapter ---

export class AnthropicAdapter implements LLMAdapter {
  private client: Anthropic
  private config: LLMAdapterConfig

  constructor(config: LLMAdapterConfig) {
    this.config = config
    this.client = this.createClient(config)
  }

  private createClient(config: LLMAdapterConfig): Anthropic {
    return new Anthropic({
      baseURL: config.endpoint,
      apiKey: config.apikey,
      httpAgent: proxyManager.getHttpsAgent(),
      // Retries are handled by streamWithRetry() at the adapter layer.
      maxRetries: 0,
    })
  }

  static toAnthropicTool(tool: ToolDefinition): AnthropicTool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as AnthropicTool.InputSchema,
    }
  }

  updateConfig(config: Partial<LLMAdapterConfig>): void {
    const newConfig: LLMAdapterConfig = {
      endpoint: config.endpoint ?? this.config.endpoint,
      apikey: config.apikey ?? this.config.apikey,
    }

    const changed =
      newConfig.endpoint !== this.config.endpoint ||
      newConfig.apikey !== this.config.apikey

    this.config = newConfig

    if (changed) {
      this.client = this.createClient(newConfig)
    }
  }

  async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    yield* streamWithRetry(
      'anthropic-adapter',
      () => this.streamOnce(params),
      {
        abortSignal: params.signal,
        isMaterial: isMaterialChunk,
        onRetry: wrapOnRetry(params.onRetry, 'pre-stream'),
      },
    )
  }

  async complete(params: LLMStreamParams): Promise<LLMCallResponse> {
    const messages = normalizeMessagesForAnthropic(params.messages)
    const tools = params.tools.map(AnthropicAdapter.toAnthropicTool)

    const response = await withRetry(
      'anthropic-adapter',
      () =>
        this.client.messages.create({
          model: params.model,
          max_tokens: params.maxTokens ?? defaultAnthropicMaxTokens(params.model),
          system: params.systemPrompt,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
        }, { signal: params.signal }),
      {
        abortSignal: params.signal,
        onRetry: wrapOnRetry(params.onRetry, 'complete'),
      },
    )

    const content: ContentBlock[] = []
    for (const block of response.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        })
      }
      // thinking / other block types: ignored (Anthropic doesn't require replay)
    }

    return {
      content,
      stopReason: response.stop_reason ?? null,
      usage: extractAnthropicUsage(response.usage),
    }
  }

  private async *streamOnce(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    const messages = normalizeMessagesForAnthropic(params.messages)
    const tools = params.tools.map(AnthropicAdapter.toAnthropicTool)

    const stream = this.client.messages.stream({
      model: params.model,
      max_tokens: params.maxTokens ?? defaultAnthropicMaxTokens(params.model),
      system: params.systemPrompt,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
    })

    // signal 通常是 task 级长寿命的（一个 task 内每个 turn 都共用）。如果只 addEventListener
    // 不 removeEventListener，每次 LLM call 都会在 signal 上挂一个 onAbort 闭包，闭包又
    // retain 完整的 stream 对象（含 TLS / Zlib / 累积 Buffer，多在 native heap），长跑后
    // RSS 可飙到 10GB+ 量级。详见 2026-06-06 kernel watchdog panic 复盘。
    let onAbort: (() => void) | null = null
    if (params.signal) {
      onAbort = () => stream.abort()
      params.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      let currentToolId: string | null = null

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            yield { type: 'message_start', messageId: event.message.id }
            break

          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              currentToolId = event.content_block.id
              yield {
                type: 'tool_use_start',
                id: event.content_block.id,
                name: event.content_block.name,
              }
            }
            break

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { type: 'text_delta', text: event.delta.text }
            } else if (event.delta.type === 'input_json_delta') {
              yield {
                type: 'tool_use_delta',
                id: currentToolId ?? '',
                inputJson: event.delta.partial_json,
              }
            }
            break

          case 'content_block_stop':
            if (currentToolId !== null) {
              yield { type: 'tool_use_end', id: currentToolId }
              currentToolId = null
            }
            break

          case 'message_delta':
            break
        }
      }

      const finalMessage = await stream.finalMessage()
      yield {
        type: 'message_end',
        stopReason: finalMessage.stop_reason ?? null,
        usage: extractAnthropicUsage(finalMessage.usage),
      }
    } finally {
      if (params.signal && onAbort) {
        params.signal.removeEventListener('abort', onAbort)
      }
    }
  }
}

/**
 * Anthropic SDK Stable Usage 类型只暴露 input/output_tokens，
 * 但 prompt caching 启用时 response payload 实际带 cache_creation_input_tokens
 * 和 cache_read_input_tokens（Beta 类型已有，stable 没同步）。这里宽松读取。
 */
function extractAnthropicUsage(raw: { input_tokens: number; output_tokens: number }): LLMTokenUsage {
  const extra = raw as { cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }
  const cacheCreation = typeof extra.cache_creation_input_tokens === 'number' ? extra.cache_creation_input_tokens : undefined
  const cacheRead = typeof extra.cache_read_input_tokens === 'number' ? extra.cache_read_input_tokens : undefined
  return {
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
  }
}
