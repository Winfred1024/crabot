/**
 * send_message audit gate 集成测试。
 * spec: 2026-05-23-goal-mode-design.md §4
 */

import { describe, it, expect, vi } from 'vitest'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import { buildMessagingTools } from '../../src/mcp/crab-messaging.js'
import type {
  CrabMessagingDeps,
  AuditResult,
  TaskContext,
  MessagingTool,
} from '../../src/mcp/crab-messaging.js'

interface DepsOverrides {
  runGoalAudit?: CrabMessagingDeps['runGoalAudit']
  /** undefined = 用默认 taskCtx；null = 模拟 front 路径无 taskCtx；其他 = 显式传入 */
  taskCtx?: TaskContext | null
  channelOk?: boolean
}

function makeDeps(overrides: DepsOverrides = {}): CrabMessagingDeps {
  const rpcCall = vi.fn().mockImplementation(async (_port: number, method: string) => {
    if (method === 'send_message') {
      if (overrides.channelOk === false) throw new Error('channel down')
      return { platform_message_id: 'msg-1', sent_at: '2026-05-23T00:00:00.000Z' }
    }
    if (method === 'update_task_status') return { task: {} }
    return {}
  })
  const defaultTaskCtx: TaskContext = {
    taskId: 't1',
    humanQueue: new HumanMessageQueue(),
    triggerType: 'message',
    hasGoal: () => false,
  }
  const taskCtx = overrides.taskCtx === undefined ? defaultTaskCtx : overrides.taskCtx
  return {
    rpcClient: { call: rpcCall } as never,
    moduleId: 'worker-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: async () => 19009,
    getTaskContext: () => taskCtx,
    ...(overrides.runGoalAudit ? { runGoalAudit: overrides.runGoalAudit } : {}),
  }
}

function findSendMessage(tools: MessagingTool[]): MessagingTool {
  const tool = tools.find(t => t.name === 'send_message')
  if (!tool) throw new Error('send_message tool not found')
  return tool
}

async function callSendMessage(tools: MessagingTool[], args: Record<string, unknown>): Promise<{ output: string; isError?: boolean }> {
  const tool = findSendMessage(tools)
  const result = await tool.handler(args)
  return {
    output: result.content?.[0]?.text ?? '',
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  }
}

describe('send_message audit gate', () => {
  const baseArgs = {
    channel_id: 'ch1',
    session_id: 's1',
    content: 'final delivery',
  }

  it('hasGoal=false → 跳过 audit，正常发送', async () => {
    const runGoalAudit = vi.fn()
    const deps = makeDeps({
      runGoalAudit,
      taskCtx: { taskId: 't1', humanQueue: new HumanMessageQueue(), triggerType: 'message', hasGoal: () => false },
    })
    const tools = buildMessagingTools(deps)
    const result = await callSendMessage(tools, { ...baseArgs, intent: 'final' })
    expect(result.isError).toBeFalsy()
    expect(runGoalAudit).not.toHaveBeenCalled()
  })

  it('intent=info 即使 hasGoal=true 也不触发 audit', async () => {
    const runGoalAudit = vi.fn()
    const deps = makeDeps({
      runGoalAudit,
      taskCtx: { taskId: 't1', humanQueue: new HumanMessageQueue(), triggerType: 'message', hasGoal: () => true },
    })
    const tools = buildMessagingTools(deps)
    await callSendMessage(tools, { ...baseArgs, intent: 'info' })
    expect(runGoalAudit).not.toHaveBeenCalled()
  })

  it('hasGoal=true + audit pass → 消息发出去，runGoalAudit 被调一次', async () => {
    const runGoalAudit = vi.fn().mockResolvedValue({
      pass: true,
      failedCriteria: [],
      detailedReport: '审计通过。',
      auditTraceId: 'tr-pass',
    } satisfies AuditResult)
    const deps = makeDeps({
      runGoalAudit,
      taskCtx: { taskId: 't1', humanQueue: new HumanMessageQueue(), triggerType: 'message', hasGoal: () => true },
    })
    const tools = buildMessagingTools(deps)
    const result = await callSendMessage(tools, { ...baseArgs, intent: 'final' })
    expect(runGoalAudit).toHaveBeenCalledTimes(1)
    expect(runGoalAudit).toHaveBeenCalledWith({ taskId: 't1', pendingContent: 'final delivery' })
    expect(result.isError).toBeFalsy()
  })

  it('hasGoal=true + audit fail → 消息不发，humanQueue 注入详细报告，工具返回错误', async () => {
    const humanQueue = new HumanMessageQueue()
    const pushSpy = vi.spyOn(humanQueue, 'push')
    const runGoalAudit = vi.fn().mockResolvedValue({
      pass: false,
      failedCriteria: ['c1', 'c2'],
      detailedReport: '审计未通过：c1 没过 typecheck',
      auditTraceId: 'tr-fail',
    } satisfies AuditResult)
    const deps = makeDeps({
      runGoalAudit,
      taskCtx: { taskId: 't1', humanQueue, triggerType: 'message', hasGoal: () => true },
    })
    const rpcSpy = deps.rpcClient.call as ReturnType<typeof vi.fn>
    const tools = buildMessagingTools(deps)
    const result = await callSendMessage(tools, { ...baseArgs, intent: 'final' })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/audit_trace_id: tr-fail/)
    expect(result.output).toMatch(/2 条不达标/)
    expect(pushSpy).toHaveBeenCalledWith('审计未通过：c1 没过 typecheck')
    // 不应有 channel send_message RPC 调用
    const channelSendCalls = rpcSpy.mock.calls.filter(c => c[1] === 'send_message')
    expect(channelSendCalls).toHaveLength(0)
  })

  it('runGoalAudit 抛错 → 失败开放，消息照发，结果含 audit_warning', async () => {
    const runGoalAudit = vi.fn().mockRejectedValue(new Error('auditor crashed'))
    const deps = makeDeps({
      runGoalAudit,
      taskCtx: { taskId: 't1', humanQueue: new HumanMessageQueue(), triggerType: 'message', hasGoal: () => true },
    })
    const tools = buildMessagingTools(deps)
    const result = await callSendMessage(tools, { ...baseArgs, intent: 'final' })
    expect(result.isError).toBeFalsy()
    // 输出应含 audit_warning（透传给 master 兜底）
    expect(result.output).toMatch(/audit_warning|auditor crashed/)
  })

  it('worker 路径无 task context（getTaskContext 返回 null） → 跳过 audit', async () => {
    const runGoalAudit = vi.fn()
    const deps = makeDeps({
      runGoalAudit,
      taskCtx: null,
    })
    const tools = buildMessagingTools(deps)
    await callSendMessage(tools, { ...baseArgs, intent: 'final' })
    expect(runGoalAudit).not.toHaveBeenCalled()
  })

  it('deps.runGoalAudit 未注入时 → 即使 hasGoal=true 也不触发（向后兼容）', async () => {
    // 不传 runGoalAudit；hasGoal=true 但 deps.runGoalAudit 是 undefined，应 short-circuit
    const deps = makeDeps({
      taskCtx: { taskId: 't1', humanQueue: new HumanMessageQueue(), triggerType: 'message', hasGoal: () => true },
    })
    const tools = buildMessagingTools(deps)
    const result = await callSendMessage(tools, { ...baseArgs, intent: 'final' })
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/platform_message_id/)
  })
})
