/**
 * 端到端集成测试：复现 2026-05-17 事故场景，验证 supplement 通道接通。
 *
 * 场景：
 *   f8fa6ded（Mr.Wu）: trigger 1 进入 executeTriggerMessage → 超过 30s 仍在跑 → onOverdue
 *   b5c3345f（FuFu）:  trigger 2 进入 → supplement_task 工具 enum 应包含 trigger 1 的 task_id
 *
 * 修复前的空洞：
 *   trigger 1 的 syntheticTaskId 只存在于 agent 进程内 Map，从未注册到 admin task 表。
 *   trigger 2 的 list_tasks 返回空 → activeTaskIds.length===0 → supplement_task 工具不注入。
 *
 * 修复后验证的链路（Step A-E）：
 *   A. trigger 1 onOverdue 时 fire-and-forget 调 admin create_task（id=syntheticTaskId-1）
 *   B. 共享 admin tasks Map 里能找到 syntheticTaskId-1
 *   C. 模拟 trigger 2 fetchActiveTasks: list_tasks 返回包含 syntheticTaskId-1
 *   D. getAgentExitTools({ isGroup, activeTaskIds: [syntheticTaskId-1] }) 注入 supplement_task 工具
 *   E. supplement_task.inputSchema.properties.target_task_id.enum 含 syntheticTaskId-1
 *
 * Step F（trigger 2 实际调 supplement → handleLocalSupplement 路由）因需要 mock unified-agent
 * caller 侧的全量上下文（channel / context-assembler / session routing），复杂度超出范围。
 * 按 plan §11.1 允许的 fallback：F 拆为独立小测验证 supplement_task 工具 schema 的正确性，
 * 主测试覆盖 A-E，确认 supplement 通道接通的关键环节全部就绪。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-18-unified-loop-cleanup-design.md §5.3
 * Plan: crabot-docs/superpowers/plans/2026-05-18-unified-loop-cleanup.md Task 11
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type { ExecuteTriggerMessageParams } from '../../src/agent/agent-handler.js'
import { getAgentExitTools } from '../../src/agent/agent-exit-tools.js'
import type { FrontAgentContext } from '../../src/types.js'

// ─── Engine mock ─────────────────────────────────────────────────────────────

vi.mock('../../src/engine/index.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    runEngine: vi.fn(),
  }
})

import { runEngine } from '../../src/engine/index.js'
const mockRunEngine = vi.mocked(runEngine)

// ─── Admin task store (shared across both trigger invocations) ────────────────

type AdminTask = {
  id: string
  title: string
  status: string
  source: {
    trigger_type: string
    channel_id: string
    session_id: string
    origin: string
    friend_id?: string
  }
}

function buildAdminTasksMap(): Map<string, AdminTask> {
  return new Map<string, AdminTask>()
}

function buildAdminRpcStub(adminTasks: Map<string, AdminTask>) {
  return vi.fn(async (_port: number, method: string, params: Record<string, unknown>) => {
    if (method === 'create_task') {
      const id = (params.id as string | undefined) ?? `gen-${adminTasks.size}`
      if (params.id && adminTasks.has(params.id as string)) {
        throw new Error('TASK_ALREADY_EXISTS')
      }
      const task: AdminTask = {
        id,
        title: (params.title as string | undefined) ?? '',
        status: 'executing',
        source: params.source as AdminTask['source'],
      }
      adminTasks.set(id, task)
      return { task }
    }

    if (method === 'list_tasks') {
      const filterStatuses = (
        (params.filter as { status?: string[] } | undefined)?.status ?? []
      )
      const items = Array.from(adminTasks.values()).filter(
        t => filterStatuses.length === 0 || filterStatuses.includes(t.status),
      )
      return { items, total: items.length }
    }

    if (method === 'update_task_status') {
      const taskId = params.task_id as string
      const task = adminTasks.get(taskId)
      if (task) {
        task.status = params.status as string
      }
      // bestEffortRpc: silently swallow NOT_FOUND if task doesn't exist
      return {}
    }

    return {}
  })
}

// ─── Test helpers ──────────────────────────────────────────────────────────────

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

function makeFriend(id = 'friend-wu', displayName = 'Mr.Wu'): ExecuteTriggerMessageParams['senderFriend'] {
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
      content: { type: 'text', text: '帮我改一下 src/index.ts 的逻辑' },
      session: { session_id: 'sess-group-1', channel_id: 'ch-group-1', type: 'group' as const },
      sender: { friend_id: 'friend-wu', platform_user_id: 'u-wu', platform_display_name: 'Mr.Wu' },
      platform_message_id: 'msg-wu-1',
      features: { is_mention_crab: true },
      platform_timestamp: new Date().toISOString(),
    }],
    activeTasks: [],
    isGroup: true,
    senderFriend: makeFriend(),
    triggerArrivedAtMs: Date.now(),
    timeoutMs: 30_000,
    overdueReminderEnabled: true,
    memoryPermissions: { write_visibility: 'private', write_scopes: [] },
    resolvedPermissions: {} as ExecuteTriggerMessageParams['resolvedPermissions'],
    channelId: 'ch-group-1',
    sessionId: 'sess-group-1',
    frontContext: makeFrontContext(),
    ...overrides,
  }
}

// ─── Step A-E: trigger 超期注册到 admin + supplement 工具注入 ─────────────────

describe('事故场景复现：trigger 超期后 supplement 通道接通（Step A-E）', () => {
  let adminTasks: Map<string, AdminTask>
  let adminRpcStub: ReturnType<typeof buildAdminRpcStub>
  let handler: AgentHandler

  beforeEach(() => {
    vi.clearAllMocks()
    adminTasks = buildAdminTasksMap()
    adminRpcStub = buildAdminRpcStub(adminTasks)

    handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'You are Crabot.' }, {
      deps: {
        rpcClient: { call: adminRpcStub } as any,
        moduleId: 'agent-integration-test',
        resolveChannelPort: async () => 3003,
        getMemoryPort: async () => 3002,
        getAdminPort: async () => 19001,
      },
    })
  })

  afterEach(() => {
    handler.dispose()
  })

  it('Step A-E: trigger 1 超期 → admin tasks Map 注册 → list_tasks 找到 → exit tools 含 syntheticTaskId-1', async () => {
    // ── Step A: mock engine 触发 onOverdue，模拟 trigger 1 超过 30s 后仍在跑 ──
    let capturedSyntheticTaskId: string | undefined

    mockRunEngine.mockImplementation(async (opts) => {
      // 模拟 engine 在 onOverdue 被触发后才 end_turn（对应 Mr.Wu 事故场景）
      if (opts.options?.overdueConfig?.onOverdue) {
        opts.options.overdueConfig.onOverdue()
      }
      // 给 fire-and-forget 一个 tick 让 create_task RPC 完成
      await new Promise(r => setImmediate(r))
      return {
        outcome: 'completed' as const,
        finalText: '已在处理，稍候',
        totalTurns: 4,
        overdueInjected: true,
        usage: { inputTokens: 200, outputTokens: 80 },
        finalMessages: [] as readonly never[],
      }
    })

    // Capture syntheticTaskId from create_task call
    const originalStub = adminRpcStub.getMockImplementation()!
    adminRpcStub.mockImplementation(async (port, method, params) => {
      if (method === 'create_task' && params.id) {
        capturedSyntheticTaskId = params.id as string
      }
      return originalStub(port, method, params)
    })

    // trigger 1: Mr.Wu 发的超期任务
    const trigger1Params = makeTriggerParams({
      messages: [{
        content: { type: 'text', text: '帮我改一下 src/index.ts 的逻辑，对代码做深入分析' },
        session: { session_id: 'sess-group-1', channel_id: 'ch-group-1', type: 'group' as const },
        sender: { friend_id: 'friend-wu', platform_user_id: 'u-wu', platform_display_name: 'Mr.Wu' },
        platform_message_id: 'msg-wu-1',
        features: { is_mention_crab: true },
        platform_timestamp: new Date().toISOString(),
      }],
      activeTasks: [], // trigger 1 进入时没有活跃任务
      isGroup: true,
      senderFriend: makeFriend('friend-wu', 'Mr.Wu'),
      channelId: 'ch-group-1',
      sessionId: 'sess-group-1',
    })

    const result1 = await handler.executeTriggerMessage(trigger1Params)

    // engine 结果正常
    expect(result1.outcome).toBe('completed')
    expect(result1.overdueInjected).toBe(true)

    // 等 fire-and-forget promise 完成
    await new Promise(r => setImmediate(r))
    await new Promise(r => setTimeout(r, 10))

    // ── Step B: admin tasks Map 应包含 syntheticTaskId-1 ────────────────────
    expect(capturedSyntheticTaskId).toBeDefined()
    expect(capturedSyntheticTaskId!.startsWith('trigger-')).toBe(true)

    const registeredTask = adminTasks.get(capturedSyntheticTaskId!)
    expect(registeredTask).toBeDefined()
    expect(registeredTask!.source.trigger_type).toBe('message')
    expect(registeredTask!.source.channel_id).toBe('ch-group-1')
    expect(registeredTask!.source.session_id).toBe('sess-group-1')
    expect(registeredTask!.source.origin).toBe('human')

    const trigger1TaskId = capturedSyntheticTaskId!

    // ── Step C: 模拟 trigger 2 的 fetchActiveTasks 调 list_tasks ────────────
    //
    // 真实事故场景：trigger 2 到达时 trigger 1 仍在 executing 状态（未 finalize）。
    // 集成测试中 executeTriggerMessage 已完成（含 finalizeTask 把 status 改为 completed），
    // 所以直接用 Map 验证注册存在，再用无状态过滤的 list_tasks 验证条目可达。
    //
    // 关键验证：create_task 落盘到 admin 后，list_tasks 能返回该条目——
    // 这是修复前的空洞所在（trigger 1 根本不在 admin tasks 表里）。
    const listedResult = await adminRpcStub(19001, 'list_tasks', {
      filter: { status: [] }, // 空 filter = 返回全部（验证注册存在，不依赖特定 status）
    })
    const listedItems = (listedResult as { items: Array<{ id: string }> }).items
    expect(listedItems.map(t => t.id)).toContain(trigger1TaskId)

    // ── Step D: getAgentExitTools 注入 supplement_task 工具 ─────────────────
    // 模拟 trigger 2 进来时 unified-agent 用 list_tasks 结果构建 activeTaskIds
    const trigger2ActiveTaskIds = listedItems.map(t => t.id)
    const exitTools = getAgentExitTools({
      isGroup: true, // group session
      activeTaskIds: trigger2ActiveTaskIds,
    })

    const supplementTool = exitTools.find(t => t.name === 'supplement_task')
    expect(supplementTool).toBeDefined()

    // ── Step E: supplement_task.enum 包含 trigger1TaskId ────────────────────
    const targetTaskIdProp = supplementTool!.inputSchema.properties as Record<
      string,
      { enum?: string[]; type?: string; description?: string }
    >
    expect(targetTaskIdProp.target_task_id.enum).toContain(trigger1TaskId)

    // 同时验证 stay_silent 也在 exit tools（group 场景）
    const staySilent = exitTools.find(t => t.name === 'stay_silent')
    expect(staySilent).toBeDefined()
  })

  it('trigger 1 未超期（30s 内 end_turn）→ 启动入口已注册 admin tasks → trigger 2 可用 supplement_task', async () => {
    // 快速 end_turn，不触发 onOverdue
    mockRunEngine.mockImplementation(async (_opts) => {
      // 不调 onOverdue
      return {
        outcome: 'completed' as const,
        finalText: '好的，完成了',
        totalTurns: 1,
        overdueInjected: false,
        usage: { inputTokens: 50, outputTokens: 20 },
        finalMessages: [] as readonly never[],
      }
    })

    const trigger1Params = makeTriggerParams({ activeTasks: [] })
    const result1 = await handler.executeTriggerMessage(trigger1Params)

    expect(result1.outcome).toBe('completed')
    expect(result1.overdueInjected).toBe(false)

    await new Promise(r => setTimeout(r, 10))

    // Task 6 变更：启动入口立即 register admin，无论是否超期
    // admin tasks Map 应有 1 条（startup register 注册）
    expect(adminTasks.size).toBeGreaterThanOrEqual(1)

    // create_task 至少被调用一次
    const createTaskCalls = adminRpcStub.mock.calls.filter(c => c[1] === 'create_task')
    expect(createTaskCalls.length).toBeGreaterThanOrEqual(1)

    // 注册后的 syntheticTaskId 以 'trigger-' 开头
    const [_port, _method, ctParams] = createTaskCalls[0] as [number, string, Record<string, unknown>]
    expect((ctParams.id as string).startsWith('trigger-')).toBe(true)

    // trigger 2 的 list_tasks 返回已注册的 task → supplement_task 工具注入
    const listedResult = await adminRpcStub(19001, 'list_tasks', {
      filter: { status: ['pending', 'planning', 'executing', 'waiting_human'] },
    })
    const listedItems = (listedResult as { items: unknown[] }).items
    // 注册后状态为 'executing'，被 list_tasks 过滤返回
    expect(listedItems.length).toBeGreaterThanOrEqual(1)

    // 用已注册的 task_id 构造 supplement_task 工具
    const registeredTaskId = ctParams.id as string
    const exitTools = getAgentExitTools({ isGroup: true, activeTaskIds: [registeredTaskId] })
    const supplementTool = exitTools.find(t => t.name === 'supplement_task')
    // 启动即注册 → supplement_task 工具存在
    expect(supplementTool).toBeDefined()
    // stay_silent 仍在（group 场景）
    const staySilent = exitTools.find(t => t.name === 'stay_silent')
    expect(staySilent).toBeDefined()
  })
})

// ─── Step F（独立小测）: supplement_task 工具 schema 内部 enum 的正确性 ─────────

describe('Step F（独立）: supplement_task 工具 schema 确保 syntheticTaskId 注入 enum', () => {
  it('trigger-style task_id 作为 activeTaskIds 传入 → enum 精确包含', () => {
    // 模拟从 admin list_tasks 拿到的 syntheticTaskId（trigger 超期注册后）
    const syntheticTaskId = 'trigger-550e8400-e29b-41d4-a716-446655440000'

    const exitTools = getAgentExitTools({
      isGroup: true,
      activeTaskIds: [syntheticTaskId],
    })

    const supplementTool = exitTools.find(t => t.name === 'supplement_task')
    expect(supplementTool).toBeDefined()

    const props = supplementTool!.inputSchema.properties as Record<
      string,
      { enum?: string[]; type?: string }
    >
    // enum 必须精确包含 syntheticTaskId，不多不少
    expect(props.target_task_id.enum).toEqual([syntheticTaskId])
  })

  it('多个活跃任务（mix of schedule + trigger）→ enum 全部包含', () => {
    const scheduleTaskId = 'task-abc123'
    const triggerTaskId = 'trigger-xyz789'

    const exitTools = getAgentExitTools({
      isGroup: false,
      activeTaskIds: [scheduleTaskId, triggerTaskId],
    })

    const supplementTool = exitTools.find(t => t.name === 'supplement_task')
    expect(supplementTool).toBeDefined()

    const props = supplementTool!.inputSchema.properties as Record<
      string,
      { enum?: string[] }
    >
    expect(props.target_task_id.enum).toContain(scheduleTaskId)
    expect(props.target_task_id.enum).toContain(triggerTaskId)

    // 私聊：没有 stay_silent
    const staySilent = exitTools.find(t => t.name === 'stay_silent')
    expect(staySilent).toBeUndefined()
  })

  it('trigger 超期注册的 task + supplement_task 调用契约：target_task_id + supplement_text 均为必填', () => {
    const triggerTaskId = 'trigger-accident-2026-05-17'
    const exitTools = getAgentExitTools({
      isGroup: true,
      activeTaskIds: [triggerTaskId],
    })

    const supplementTool = exitTools.find(t => t.name === 'supplement_task')
    expect(supplementTool).toBeDefined()
    expect(supplementTool!.inputSchema.required).toEqual(['target_task_id', 'supplement_text'])
    expect(supplementTool!.turnZeroOnly).toBe(true)
    expect(supplementTool!.exitsLoop).toBe(true)
  })
})
