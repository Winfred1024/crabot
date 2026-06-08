/**
 * end-turn-gate.ts — createAsyncAuditEndTurnGate 闭包行为单测。
 *
 * 不跑完整 runWorkerLoop，只测闭包：
 *  - empty outboundBuffer → null（passthrough，不 spawn）
 *  - goalSetCache=false → null（worker 没 set_task_goal）
 *  - 非空 buffer + goal 存在 → spawn audit + 设 activeAuditId + 返回 [audit_pending] marker
 *  - get_task RPC 抛错 → null（fail-open）
 *  - task.goal 缺失 → null
 *  - spawn 抛错 → null（fail-open，console.warn）
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsyncAuditEndTurnGate, type AsyncAuditEndTurnGateDeps } from '../../src/agent/end-turn-gate'
import { parseSystemMarker } from '../../src/agent/audit-result-marker'
import type { WorkerTaskState } from '../../src/types'
import type { GoalAuditTaskGoal } from '../../src/agent/goal-audit'
import type { OutboundBufferEntry } from '../../src/agent/outbound-flush'
import type { SpawnAuditSubagentDeps } from '../../src/agent/audit-spawn'
import { TodoStore } from '../../src/agent/worker-todo-store'

function makeGoal(): GoalAuditTaskGoal {
  return {
    objective: '把 audit 异步化',
    acceptance_criteria: [
      { id: 'c-1', kind: 'semantic', spec: 'main loop 不阻塞', rationale: 'audit 不卡 LLM 续作' },
    ],
  }
}

function makeBufferEntry(): OutboundBufferEntry {
  return {
    channel_id: 'wechat:bot:1',
    session_id: 's-1',
    content: 'final delivery',
    intent: 'info',
    sent_at_attempt_ms: Date.now(),
  }
}

function makeTaskState(overrides: Partial<WorkerTaskState> = {}): WorkerTaskState {
  return {
    taskId: 'task-1',
    status: 'executing',
    startedAt: new Date().toISOString(),
    abortController: { signal: { aborted: false }, abort: () => {} },
    pendingHumanMessages: [],
    todoStore: new TodoStore(),
    outboundBuffer: [],
    activeAuditId: undefined,
    activeAsyncSubagentIds: new Set<string>(),
    ...overrides,
  }
}

interface Harness {
  readonly deps: AsyncAuditEndTurnGateDeps
  readonly taskState: WorkerTaskState
  readonly rpcCall: ReturnType<typeof vi.fn>
  readonly spawnFn: ReturnType<typeof vi.fn>
  readonly buildSpawnDeps: ReturnType<typeof vi.fn>
}

function makeHarness(opts: {
  goalSetCache?: boolean
  /** 不传 → 默认有 goal；显式传 null → 模拟 task.goal 缺失 */
  goal?: GoalAuditTaskGoal | null
  bufferEntries?: ReadonlyArray<OutboundBufferEntry>
  rpcCallOverride?: ReturnType<typeof vi.fn>
  spawnReturn?: string | Promise<string>
  spawnThrows?: Error
} = {}): Harness {
  const goal: GoalAuditTaskGoal | undefined =
    opts.goal === null ? undefined : opts.goal ?? makeGoal()
  const rpcCall = opts.rpcCallOverride ?? vi.fn(async () => {
    return { task: { id: 'task-1', goal } }
  })

  const taskState = makeTaskState({
    outboundBuffer: [...(opts.bufferEntries ?? [makeBufferEntry()])],
  })

  const spawnFn = vi.fn(async () => {
    if (opts.spawnThrows) throw opts.spawnThrows
    return opts.spawnReturn ?? 'audit-test-xyz'
  })

  const buildSpawnDeps = vi.fn((g: GoalAuditTaskGoal): SpawnAuditSubagentDeps => ({
    goal: g,
    conversationLog: [],
    cwd: '/tmp/workspace',
    parentTaskId: 'task-1',
    auditor: {} as never,
    parentTools: [],
    adapter: {} as never,
    owner: { friend_id: 'f1' },
    registry: {} as never,
    abortControllers: new Map(),
    humanQueue: {} as never,
  }))

  return {
    deps: {
      taskId: 'task-1',
      taskState,
      goalSetCacheGetter: () => opts.goalSetCache ?? true,
      rpcClient: { call: rpcCall } as never,
      moduleId: 'agent-test',
      getAdminPort: async () => 19000,
      buildSpawnDeps,
      spawnAuditSubagentFn: spawnFn as never,
    },
    taskState,
    rpcCall,
    spawnFn,
    buildSpawnDeps,
  }
}

describe('createAsyncAuditEndTurnGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('empty outboundBuffer → returns null (passthrough; spawn 不被调用)', async () => {
    const h = makeHarness({ bufferEntries: [] })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.rpcCall).not.toHaveBeenCalled()
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect(h.taskState.activeAuditId).toBeUndefined()
  })

  it('goalSetCache=false（worker 尚未 set_task_goal）→ returns null; 不 RPC、不 spawn', async () => {
    const h = makeHarness({ goalSetCache: false })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.rpcCall).not.toHaveBeenCalled()
    expect(h.spawnFn).not.toHaveBeenCalled()
  })

  it('非空 buffer + goal 存在 → spawn audit + 设 activeAuditId + 返回 [audit_pending] marker', async () => {
    const h = makeHarness({ spawnReturn: 'audit-test-xyz' })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    // RPC + spawn 都被调用
    expect(h.rpcCall).toHaveBeenCalledOnce()
    expect(h.rpcCall.mock.calls[0][1]).toBe('get_task')
    expect(h.spawnFn).toHaveBeenCalledOnce()

    // activeAuditId 落位
    expect(h.taskState.activeAuditId).toBe('audit-test-xyz')

    // 返回的 marker 是 audit_pending
    expect(result).toBeTruthy()
    const parsed = parseSystemMarker(result!)
    expect(parsed?.type).toBe('audit_pending')
    if (parsed?.type !== 'audit_pending') throw new Error('marker type mismatch')
    expect(parsed.auditId).toBe('audit-test-xyz')

    // buildSpawnDeps 收到 RPC 拿回的 goal
    expect(h.buildSpawnDeps).toHaveBeenCalledOnce()
    expect(h.buildSpawnDeps.mock.calls[0][0].objective).toBe('把 audit 异步化')
  })

  it('get_task RPC 抛错 → returns null (fail-open)，spawn 不调，activeAuditId 不变', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rpcCall = vi.fn(async () => { throw new Error('rpc network down') })
    const h = makeHarness({ rpcCallOverride: rpcCall })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect(h.taskState.activeAuditId).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('task.goal 缺失 → returns null, spawn 不调用', async () => {
    const h = makeHarness({ goal: null })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.rpcCall).toHaveBeenCalledOnce()
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect(h.taskState.activeAuditId).toBeUndefined()
  })

  it('spawn 抛错 → returns null (fail-open)，activeAuditId 不变，console.warn 被调', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = makeHarness({ spawnThrows: new Error('spawn failed: registry full') })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.spawnFn).toHaveBeenCalledOnce()
    expect(h.taskState.activeAuditId).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('builtin-goal-auditor 缺失场景（buildSpawnDeps 抛错）→ returns null (fail-open)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = makeHarness()
    // 真实路径下 buildSpawnDeps 在没 auditor 时 throw —— 这里直接 mock 抛错验证 fail-open
    h.buildSpawnDeps.mockImplementation(() => {
      throw new Error('builtin-goal-auditor subagent not configured')
    })
    // 这种情况 spawn 会被调（spawnFn 接收 buildSpawnDeps 的返回值；抛错时整个 spawn 路径都挂）
    // —— 闭包应该把这个错也归到 spawn 抛错分支
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.taskState.activeAuditId).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})
