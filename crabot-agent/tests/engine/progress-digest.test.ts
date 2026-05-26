import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ProgressDigest } from '../../src/engine/progress-digest'
import type { ProgressDigestConfig, ProgressDigestDeps } from '../../src/engine/progress-digest'
import type { EngineMessage, EngineTurnEvent } from '../../src/engine/types'
import type { LLMAdapter, LLMCallResponse, LLMStreamParams } from '../../src/engine/llm-adapter'
import { createUserMessage, createAssistantMessage, createToolResultMessage } from '../../src/engine/types'

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
        input: { content: 'ack', intent: 'info' },
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

  it('overdueMs triggers single fork-and-send at the deadline', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const { adapter, complete } = makeAdapter()
    const messagesRef = { current: [createUserMessage('begin')] as ReadonlyArray<EngineMessage> }
    // 只开 overdueMs，不开 intervalMs —— 验证 overdue 独立工作
    const config: ProgressDigestConfig = { overdueMs: 3_000, isMasterPrivate: true }
    const digest = new ProgressDigest(config, makeDeps({ sendToUser, messagesRef, adapter }))

    // 未到 overdueMs：不触发
    await vi.advanceTimersByTimeAsync(2_999)
    expect(complete).not.toHaveBeenCalled()

    // 越过 overdueMs：触发一次
    await vi.advanceTimersByTimeAsync(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(sendToUser).toHaveBeenCalledTimes(1)

    // 再过很久不再触发（单次）
    await vi.advanceTimersByTimeAsync(60_000)
    expect(complete).toHaveBeenCalledTimes(1)

    digest.dispose()
  })

  it('intervalMs and overdueMs can co-exist; both fire independently', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const { adapter, complete } = makeAdapter()
    const messagesRef = { current: [createUserMessage('begin')] as ReadonlyArray<EngineMessage> }
    const config: ProgressDigestConfig = { intervalMs: 2_000, overdueMs: 5_000, isMasterPrivate: true }
    const digest = new ProgressDigest(config, makeDeps({ sendToUser, messagesRef, adapter }))

    // 2s: interval 1
    await vi.advanceTimersByTimeAsync(2_000)
    await Promise.resolve(); await Promise.resolve()
    expect(complete).toHaveBeenCalledTimes(1)

    // snapshot 没新增 → interval 2 跳过
    await vi.advanceTimersByTimeAsync(2_000)
    expect(complete).toHaveBeenCalledTimes(1)

    // snapshot 增加；overdue 5s 触发
    messagesRef.current = [...messagesRef.current, createUserMessage('progress')]
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve(); await Promise.resolve()
    expect(complete).toHaveBeenCalledTimes(2)

    digest.dispose()
  })

  it('traces each flush via onTraceStart/onTraceEnd with reason', async () => {
    const { adapter } = makeAdapter()
    const messagesRef = { current: [createUserMessage('go')] as ReadonlyArray<EngineMessage> }
    const onTraceStart = vi.fn((_reason: string) => 'span-1')
    const onTraceEnd = vi.fn()
    const config: ProgressDigestConfig = {
      overdueMs: 1_000,
      isMasterPrivate: true,
      onTraceStart,
      onTraceEnd,
    }
    const digest = new ProgressDigest(config, makeDeps({ messagesRef, adapter }))

    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve(); await Promise.resolve()

    expect(onTraceStart).toHaveBeenCalledWith('overdue')
    expect(onTraceEnd).toHaveBeenCalledTimes(1)
    const [spanId, status, details] = onTraceEnd.mock.calls[0]
    expect(spanId).toBe('span-1')
    expect(status).toBe('completed')
    expect(details).toMatchObject({ output_summary: expect.any(String) })
    digest.dispose()
  })

  it('trace reports failure when adapter throws', async () => {
    const complete = vi.fn(async (): Promise<LLMCallResponse> => { throw new Error('boom') })
    const adapter: LLMAdapter = {
      stream: async function* () { /* unused */ },
      complete,
      updateConfig() { /* noop */ },
    }
    const messagesRef = { current: [createUserMessage('go')] as ReadonlyArray<EngineMessage> }
    const onTraceStart = vi.fn((_reason: string) => 'span-x')
    const onTraceEnd = vi.fn()
    const config: ProgressDigestConfig = {
      overdueMs: 500,
      isMasterPrivate: true,
      onTraceStart,
      onTraceEnd,
    }
    const digest = new ProgressDigest(config, makeDeps({ messagesRef, adapter }))

    await vi.advanceTimersByTimeAsync(500)
    await Promise.resolve(); await Promise.resolve()

    expect(onTraceEnd).toHaveBeenCalledTimes(1)
    const [, status, details] = onTraceEnd.mock.calls[0]
    expect(status).toBe('failed')
    expect(details).toMatchObject({ error: 'boom' })
    digest.dispose()
  })

  it('overdue is skipped after agent has sent a message; interval still fires', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const { adapter, complete } = makeAdapter()
    const messagesRef = { current: [createUserMessage('go')] as ReadonlyArray<EngineMessage> }
    const config: ProgressDigestConfig = {
      intervalMs: 2_000,
      overdueMs: 3_000,
      isMasterPrivate: true,
    }
    const digest = new ProgressDigest(config, makeDeps({ sendToUser, messagesRef, adapter }))

    // agent 在 1s 时主动 send_message（intent=info） → 应记录 sentMessageSinceStart
    digest.ingest(makeEvent({
      assistantText: '我先告诉你一下进度',
      toolCalls: [makeToolCall({
        name: 'mcp__crab-messaging__send_message',
        input: { content: '正在处理 X', intent: 'info' },
        isError: false,
      })],
    }))
    messagesRef.current = [...messagesRef.current, createUserMessage('(more progress)')]

    // 2s: interval 1 仍然 fire（interval 不受 sentMessage 影响）
    await vi.advanceTimersByTimeAsync(2_000)
    await Promise.resolve(); await Promise.resolve()
    expect(complete).toHaveBeenCalledTimes(1)

    // 3s: overdue 到时，但 sentMessage=true → 跳过
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve(); await Promise.resolve()
    expect(complete).toHaveBeenCalledTimes(1)

    digest.dispose()
  })

  it('overdue still fires when agent has only used non-send_message tools', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const { adapter, complete } = makeAdapter()
    const messagesRef = { current: [createUserMessage('go')] as ReadonlyArray<EngineMessage> }
    const config: ProgressDigestConfig = { overdueMs: 1_000, isMasterPrivate: true }
    const digest = new ProgressDigest(config, makeDeps({ sendToUser, messagesRef, adapter }))

    // agent 跑了 Bash / Read / Edit 等，但没 send_message
    digest.ingest(makeEvent({
      assistantText: '让我先看看',
      toolCalls: [
        makeToolCall({ name: 'Bash', input: { command: 'ls' } }),
        makeToolCall({ name: 'Read', input: { file_path: '/tmp/x' } }),
      ],
    }))

    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve(); await Promise.resolve()

    expect(complete).toHaveBeenCalledTimes(1)
    expect(sendToUser).toHaveBeenCalledTimes(1)
    digest.dispose()
  })

  it('errored send_message does NOT mark sentMessage; overdue still fires', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const { adapter, complete } = makeAdapter()
    const messagesRef = { current: [createUserMessage('go')] as ReadonlyArray<EngineMessage> }
    const config: ProgressDigestConfig = { overdueMs: 1_000, isMasterPrivate: true }
    const digest = new ProgressDigest(config, makeDeps({ sendToUser, messagesRef, adapter }))

    // send_message 失败（isError=true） → 用户没收到 → overdue 必须兜底
    digest.ingest(makeEvent({
      assistantText: '试图汇报',
      toolCalls: [makeToolCall({
        name: 'mcp__crab-messaging__send_message',
        input: { content: 'progress', intent: 'info' },
        isError: true,
        output: 'channel offline',
      })],
    }))

    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve(); await Promise.resolve()

    expect(complete).toHaveBeenCalledTimes(1)
    digest.dispose()
  })

  it('skips flush when snapshot ends with dangling tool_use (race-safety)', async () => {
    const sendToUser = vi.fn().mockResolvedValue(undefined)
    const { adapter, complete } = makeAdapter()
    // 模拟主 loop 半截状态：assistant(tool_use) 已 push，但 tool_result 还没
    const danglingAssistant = createAssistantMessage(
      [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } }],
      'tool_use',
    )
    const messagesRef = {
      current: [createUserMessage('do it'), danglingAssistant] as ReadonlyArray<EngineMessage>,
    }
    const config: ProgressDigestConfig = { intervalMs: 1_000, isMasterPrivate: true }
    const digest = new ProgressDigest(config, makeDeps({ sendToUser, messagesRef, adapter }))

    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve(); await Promise.resolve()

    // 跳过本次 flush —— 不应触发 LLM call、不应发用户
    expect(complete).not.toHaveBeenCalled()
    expect(sendToUser).not.toHaveBeenCalled()

    // 模拟 tool_result push 之后再触发：正常 fork
    messagesRef.current = [...messagesRef.current, createToolResultMessage('call-1', 'ok', false)]
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve(); await Promise.resolve()

    expect(complete).toHaveBeenCalledTimes(1)
    expect(sendToUser).toHaveBeenCalledTimes(1)
    digest.dispose()
  })
})
