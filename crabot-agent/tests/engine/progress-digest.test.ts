import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProgressDigest } from '../../src/engine/progress-digest'
import type { ProgressDigestConfig, ProgressDigestDeps } from '../../src/engine/progress-digest'
import type { EngineMessage, EngineTurnEvent } from '../../src/engine/types'
import type { LLMAdapter, LLMCallResponse, LLMStreamParams } from '../../src/engine/llm-adapter'
import { createUserMessage } from '../../src/engine/types'

const FAKE_DIGEST = '正在 grep 关键字定位错误位置；下一步看 stack trace 决定改哪一行。'

function makeAdapter(reply: string = FAKE_DIGEST) {
  const complete = vi.fn().mockImplementation(
    async (_p: LLMStreamParams): Promise<LLMCallResponse> => ({
      content: [{ type: 'text', text: reply }],
      stopReason: 'end_turn',
    }),
  )
  const adapter: LLMAdapter = {
    stream: async function* () { /* unused */ },
    complete,
    updateConfig() { /* noop */ },
  }
  return { adapter, complete }
}

function makeDeps(opts: {
  sendToUser?: (text: string) => Promise<void>
  messagesRef: { current: ReadonlyArray<EngineMessage> }
  adapter: LLMAdapter
}): ProgressDigestDeps {
  return {
    sendToUser: opts.sendToUser ?? (async () => { /* noop */ }),
    adapter: opts.adapter,
    modelId: 'test-model',
    messagesRef: opts.messagesRef,
  }
}

function makeEvent(overrides: Partial<EngineTurnEvent> = {}): EngineTurnEvent {
  return {
    turnNumber: 1,
    assistantText: '处理中',
    toolCalls: [],
    stopReason: 'end_turn',
    ...overrides,
  }
}

function makeToolCall(
  overrides: Partial<{ id: string; name: string; input: Record<string, unknown>; output: string; isError: boolean }> = {},
) {
  return {
    id: 'tool-1',
    name: 'Read',
    input: {},
    output: 'ok',
    isError: false,
    ...overrides,
  }
}

describe('ProgressDigest fork mode', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('interval flush fetches messagesRef snapshot, asks LLM, sends result', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const { adapter, complete } = makeAdapter()
    const messagesRef = { current: [createUserMessage('帮我改个 bug')] as ReadonlyArray<EngineMessage> }
    const config: ProgressDigestConfig = { intervalMs: 1_000, isMasterPrivate: true }
    const digest = new ProgressDigest(config, makeDeps({ sendToUser, messagesRef, adapter }))

    await vi.advanceTimersByTimeAsync(1_000)
    // 让 microtask 排空
    await Promise.resolve()
    await Promise.resolve()

    expect(complete).toHaveBeenCalledTimes(1)
    const params = complete.mock.calls[0][0] as LLMStreamParams
    // fork 调用：messages 是 snapshot + 一条 user "请汇报"
    expect(params.messages.length).toBe(2)
    expect(params.tools).toEqual([])
    expect(params.model).toBe('test-model')

    expect(sendToUser).toHaveBeenCalledWith(FAKE_DIGEST)
    digest.dispose()
  })

  it('empty messagesRef skips flush — no LLM call, no sendToUser', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const { adapter, complete } = makeAdapter()
    const messagesRef = { current: [] as ReadonlyArray<EngineMessage> }
    const config: ProgressDigestConfig = { intervalMs: 1_000, isMasterPrivate: true }
    const digest = new ProgressDigest(config, makeDeps({ sendToUser, messagesRef, adapter }))

    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()

    expect(complete).not.toHaveBeenCalled()
    expect(sendToUser).not.toHaveBeenCalled()
    digest.dispose()
  })

  it('snapshot unchanged across two intervals → only one flush', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const { adapter, complete } = makeAdapter()
    const messagesRef = { current: [createUserMessage('go')] as ReadonlyArray<EngineMessage> }
    const config: ProgressDigestConfig = { intervalMs: 1_000, isMasterPrivate: true }
    const digest = new ProgressDigest(config, makeDeps({ sendToUser, messagesRef, adapter }))

    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(complete).toHaveBeenCalledTimes(1)
    expect(sendToUser).toHaveBeenCalledTimes(1)
    digest.dispose()
  })

  it('ask_human tool call triggers immediate flush', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const { adapter, complete } = makeAdapter()
    const messagesRef = { current: [createUserMessage('confirm?')] as ReadonlyArray<EngineMessage> }
    const config: ProgressDigestConfig = { intervalMs: 1_800_000, isMasterPrivate: true }
    const digest = new ProgressDigest(config, makeDeps({ sendToUser, messagesRef, adapter }))

    digest.ingest(makeEvent({
      assistantText: '请确认',
      toolCalls: [makeToolCall({
        name: 'mcp__crab-messaging__send_message',
        input: { content: '你要 A 还是 B?', intent: 'ask_human' },
      })],
    }))

    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve()
    await Promise.resolve()

    expect(complete).toHaveBeenCalledTimes(1)
    expect(sendToUser).toHaveBeenCalledTimes(1)
    digest.dispose()
  })

  it('non-ask_human send_message does NOT immediate flush', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const { adapter, complete } = makeAdapter()
    const messagesRef = { current: [createUserMessage('go')] as ReadonlyArray<EngineMessage> }
    const config: ProgressDigestConfig = { intervalMs: 1_800_000, isMasterPrivate: true }
    const digest = new ProgressDigest(config, makeDeps({ sendToUser, messagesRef, adapter }))

    digest.ingest(makeEvent({
      assistantText: 'ack',
      toolCalls: [makeToolCall({
        name: 'mcp__crab-messaging__send_message',
        input: { content: 'ack', intent: 'normal' },
      })],
    }))

    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()

    expect(complete).not.toHaveBeenCalled()
    expect(sendToUser).not.toHaveBeenCalled()
    digest.dispose()
  })

  it('non-master session injects path-redaction rule into prompt', async () => {
    const { adapter, complete } = makeAdapter()
    const messagesRef = { current: [createUserMessage('test')] as ReadonlyArray<EngineMessage> }
    const config: ProgressDigestConfig = { intervalMs: 1_000, isMasterPrivate: false }
    const digest = new ProgressDigest(config, makeDeps({ messagesRef, adapter }))

    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(complete).toHaveBeenCalledTimes(1)
    const params = complete.mock.calls[0][0] as LLMStreamParams
    // 最后一条 user msg 的文本里要带"basename"约束
    const text = JSON.stringify(params.messages[params.messages.length - 1])
    expect(text).toContain('basename')
    digest.dispose()
  })

  it('adapter throw is swallowed, no sendToUser', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const complete = vi.fn(async (): Promise<LLMCallResponse> => { throw new Error('boom') })
    const adapter: LLMAdapter = {
      stream: async function* () { /* unused */ },
      complete,
      updateConfig() { /* noop */ },
    }
    const messagesRef = { current: [createUserMessage('go')] as ReadonlyArray<EngineMessage> }
    const config: ProgressDigestConfig = { intervalMs: 1_000, isMasterPrivate: true }
    const digest = new ProgressDigest(config, makeDeps({ sendToUser, messagesRef, adapter }))

    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(complete).toHaveBeenCalledTimes(1)
    expect(sendToUser).not.toHaveBeenCalled()
    digest.dispose()
  })
})
