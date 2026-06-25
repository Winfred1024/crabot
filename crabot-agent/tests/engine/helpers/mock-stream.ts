import type { StreamChunk, LLMTokenUsage } from '../../../src/engine/types.js'

/**
 * 把"complete 风格"的 content blocks 展开成等价的流式 chunk 序列。
 *
 * 统一流式后（2026-06 移除 adapter.complete()），engine 只走 stream()，所以测试里
 * 原本 `complete: vi.fn(async () => ({ content, stopReason, usage }))` 的 mock 改成
 * `stream: vi.fn(async function*(){ yield* chunksFromContent(content, stopReason, usage) })`。
 * chunk 词汇与各 adapter streamOnce 一致，经 StreamProcessor 还原出同样的 content。
 */
export async function* chunksFromContent(
  content: ReadonlyArray<unknown>,
  stopReason: string | null,
  usage?: LLMTokenUsage,
): AsyncGenerator<StreamChunk> {
  yield { type: 'message_start', messageId: 'msg_mock' }
  for (const raw of content) {
    const b = raw as { type: string; text?: string; data?: Record<string, unknown>; id?: string; name?: string; input?: Record<string, unknown> }
    if (b.type === 'raw_reasoning') {
      yield { type: 'raw_reasoning', data: b.data ?? {} }
    } else if (b.type === 'text') {
      yield { type: 'text_delta', text: b.text ?? '' }
    } else if (b.type === 'tool_use') {
      yield { type: 'tool_use_start', id: b.id ?? '', name: b.name ?? '' }
      yield { type: 'tool_use_delta', id: b.id ?? '', inputJson: JSON.stringify(b.input ?? {}) }
      yield { type: 'tool_use_end', id: b.id ?? '' }
    }
  }
  yield { type: 'message_end', stopReason, ...(usage ? { usage } : {}) }
}
