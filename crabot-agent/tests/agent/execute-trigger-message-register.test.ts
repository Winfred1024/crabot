/**
 * executeTriggerMessage 超期时 fire-and-forget 调 admin create_task 注册的单测。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-18-unified-loop-cleanup-design.md §4.2 / §4.4
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type { ExecuteTriggerMessageParams } from '../../src/agent/agent-handler.js'
import type { FrontAgentContext } from '../../src/types.js'

// Mock the engine so we can control overdueConfig triggering
vi.mock('../../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    runEngine: vi.fn(),
  }
})

import { runEngine } from '../../src/engine/index.js'
const mockRunEngine = vi.mocked(runEngine)

// Helper: base engine result (end_turn, no overdue)
function makeEngineResult(overrides?: Partial<{
  overdueInjected: boolean
  outcome: 'completed' | 'failed' | 'max_turns' | 'aborted'
  exitToolCall?: { name: string; input: Record<string, unknown> }
}>) {
  return {
    outcome: (overrides?.outcome ?? 'completed') as 'completed' | 'failed' | 'max_turns' | 'aborted',
    finalText: 'done',
    totalTurns: 1,
    overdueInjected: overrides?.overdueInjected ?? false,
    usage: { inputTokens: 10, outputTokens: 5 },
    finalMessages: [] as readonly never[],
    ...(overrides?.exitToolCall ? { exitToolCall: overrides.exitToolCall } : {}),
  }
}

// Helper: engine result that simulates overdue being triggered
// The mock calls overdueConfig.onOverdue() before resolving, mimicking what the real engine does
function makeOverdueEngineResult() {
  return {
    outcome: 'completed' as const,
    finalText: 'done (overdue)',
    totalTurns: 3,
    overdueInjected: true,
    usage: { inputTokens: 100, outputTokens: 50 },
    finalMessages: [] as readonly never[],
  }
}

function makeSdkEnv() {
  return {
    modelId: 'test-model',
    format: 'anthropic' as const,
    env: {
      ANTHROPIC_BASE_URL: 'http://localhost:4000',
      ANTHROPIC_API_KEY: 'test-key',
    },
  }
}

function makeFriend(id = 'friend-1', displayName = 'Test User'): ExecuteTriggerMessageParams['senderFriend'] {
  return {
    id,
    display_name: displayName,
    permission: 'normal',
    channel_identities: [],
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  }
}

function makeFrontContext(): FrontAgentContext {
  return {
    sender_friend: makeFriend(),
    recent_messages: [],
    short_term_memories: [],
    active_tasks: [],
    available_tools: [],
    time_windows: {
      recent_messages_window_hours: 4,
      short_term_memory_window_hours: 12,
    },
  }
}

function makeTriggerParams(overrides?: Partial<ExecuteTriggerMessageParams>): ExecuteTriggerMessageParams {
  return {
    messages: [{
      content: { type: 'text', text: '帮我查一下进度' },
      session: { session_id: 'sess-1', channel_id: 'ch-1', type: 'private' as const },
      sender: { friend_id: 'friend-1', platform_user_id: 'u1', platform_display_name: 'Test User' },
      platform_message_id: 'msg-1',
      features: { is_mention_crab: false },
      platform_timestamp: new Date().toISOString(),
    }],
    activeTasks: [],
    isGroup: false,
    senderFriend: makeFriend(),
    triggerArrivedAtMs: Date.now(),
    timeoutMs: 30_000,
    overdueReminderEnabled: true,
    memoryPermissions: { write_visibility: 'private', write_scopes: [] },
    resolvedPermissions: {} as ExecuteTriggerMessageParams['resolvedPermissions'],
    channelId: 'ch-test-1',
    sessionId: 'sess-test-1',
    frontContext: makeFrontContext(),
    ...overrides,
  }
}

describe('executeTriggerMessage 超期注册到 admin', () => {
  let handler: AgentHandler
  let mockRpcCall: ReturnType<typeof vi.fn>
  let mockGetAdminPort: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()

    mockRpcCall = vi.fn().mockResolvedValue({})
    mockGetAdminPort = vi.fn().mockResolvedValue(3001)

    handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'You are a test agent.' }, {
      deps: {
        rpcClient: { call: mockRpcCall } as any,
        moduleId: 'agent-test',
        resolveChannelPort: async () => 3003,
        getMemoryPort: async () => 3002,
        getAdminPort: mockGetAdminPort,
      },
    })
  })

  afterEach(() => {
    handler.dispose()
  })

  it('30s 内自然 end_turn 不触发 admin create_task', async () => {
    // Engine resolves immediately without triggering overdueConfig.onOverdue()
    mockRunEngine.mockImplementation(async (_opts) => {
      // Do NOT call overdueConfig.onOverdue() — normal fast completion path
      return makeEngineResult({ overdueInjected: false })
    })

    const params = makeTriggerParams()
    const result = await handler.executeTriggerMessage(params)

    expect(result.outcome).toBe('completed')

    // No create_task should have been called
    const createTaskCalls = mockRpcCall.mock.calls.filter(
      (call: unknown[]) => call[1] === 'create_task',
    )
    expect(createTaskCalls).toHaveLength(0)
  })

  it('超期时 fire-and-forget 调 admin create_task，id=syntheticTaskId，source.trigger_type=message', async () => {
    // Engine triggers overdueConfig.onOverdue() before resolving, simulating overdue
    let capturedSyntheticTaskId: string | undefined

    mockRunEngine.mockImplementation(async (opts) => {
      // Trigger the overdue callback (as the real engine would when elapsed > timeoutMs)
      if (opts.options?.overdueConfig?.onOverdue) {
        opts.options.overdueConfig.onOverdue()
      }
      // Give the fire-and-forget a tick to register before we check
      await new Promise(r => setImmediate(r))
      return makeOverdueEngineResult()
    })

    // Capture the syntheticTaskId from the create_task call
    mockRpcCall.mockImplementation(async (_port: number, method: string, params: Record<string, unknown>) => {
      if (method === 'create_task') {
        capturedSyntheticTaskId = params.id as string
      }
      return {}
    })

    const triggerParams = makeTriggerParams({
      channelId: 'ch-verify-1',
      sessionId: 'sess-verify-1',
    })
    const result = await handler.executeTriggerMessage(triggerParams)

    expect(result.outcome).toBe('completed')
    expect(result.overdueInjected).toBe(true)

    // Wait for fire-and-forget to complete
    await new Promise(r => setImmediate(r))
    await new Promise(r => setTimeout(r, 10))

    // Verify create_task was called
    const createTaskCalls = mockRpcCall.mock.calls.filter(
      (call: unknown[]) => call[1] === 'create_task',
    )
    expect(createTaskCalls.length).toBeGreaterThanOrEqual(1)

    const [_port, _method, ctParams] = createTaskCalls[0] as [number, string, Record<string, unknown>]

    // id must start with 'trigger-'
    expect(typeof ctParams.id).toBe('string')
    expect((ctParams.id as string).startsWith('trigger-')).toBe(true)

    // Must match capturedSyntheticTaskId
    expect(capturedSyntheticTaskId).toBeDefined()
    expect(ctParams.id).toBe(capturedSyntheticTaskId)

    // source fields
    const source = ctParams.source as Record<string, unknown>
    expect(source.trigger_type).toBe('message')
    expect(source.channel_id).toBe('ch-verify-1')
    expect(source.session_id).toBe('sess-verify-1')
    expect(source.origin).toBe('human')
  })

  it('admin create_task 失败时 fire-and-forget 不阻塞主 loop，executeTriggerMessage 正常 resolve', async () => {
    // Engine triggers overdueConfig.onOverdue()
    mockRunEngine.mockImplementation(async (opts) => {
      if (opts.options?.overdueConfig?.onOverdue) {
        opts.options.overdueConfig.onOverdue()
      }
      await new Promise(r => setImmediate(r))
      return makeOverdueEngineResult()
    })

    // create_task RPC fails
    mockRpcCall.mockImplementation(async (_port: number, method: string) => {
      if (method === 'create_task') {
        throw new Error('admin RPC unavailable')
      }
      return {}
    })

    const params = makeTriggerParams()

    // Should not throw even when admin create_task fails
    let result: Awaited<ReturnType<typeof handler.executeTriggerMessage>> | undefined
    await expect(async () => {
      result = await handler.executeTriggerMessage(params)
    }).not.toThrow()

    // Wait for fire-and-forget to complete (and fail silently)
    await new Promise(r => setTimeout(r, 20))

    // Result should still be valid
    expect(result).toBeDefined()
    expect(result!.outcome).toBe('completed')
    expect(result!.overdueInjected).toBe(true)
  })

  it('onOverdue 被多次调用时 create_task 只触发一次（registerTriggered flag 防重）', async () => {
    // Engine calls onOverdue twice (edge case: timer fires multiple times)
    mockRunEngine.mockImplementation(async (opts) => {
      if (opts.options?.overdueConfig?.onOverdue) {
        opts.options.overdueConfig.onOverdue()
        opts.options.overdueConfig.onOverdue() // second call — should be no-op
      }
      await new Promise(r => setImmediate(r))
      return makeOverdueEngineResult()
    })

    const params = makeTriggerParams()
    await handler.executeTriggerMessage(params)

    // Wait for all fire-and-forget promises
    await new Promise(r => setTimeout(r, 20))

    const createTaskCalls = mockRpcCall.mock.calls.filter(
      (call: unknown[]) => call[1] === 'create_task',
    )
    // Must be exactly 1, not 2
    expect(createTaskCalls).toHaveLength(1)
  })
})
