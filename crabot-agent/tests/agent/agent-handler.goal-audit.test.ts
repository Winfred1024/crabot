/**
 * AgentHandler.runGoalAudit 单元测试。
 *
 * 覆盖：
 *  - pass 路径：调 complete_task_goal + 写 audit_history + 返回 pass=true
 *  - fail 路径：不调 complete_task_goal + 返回 pass=false + detailedReport 含未达成 criterion
 *  - traceSummaryPrefix='[goal_audit]' / traceTaskType='goal_audit' 透传到 runSubAgentDirect（M4）
 *  - task 没 goal → 抛 has no goal
 *  - subAgents 里没 goal_auditor → 抛 not configured
 *
 * 实现策略：覆盖私有 runSubAgentDirect（method 级 mock，不走 forkEngine / trace store 真实路径），
 * deps 只塞 rpcClient + getAdminPort + moduleId 三件套。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type { SubAgentConfig } from '../../src/types.js'
import type { GoalAuditTaskGoal } from '../../src/agent/goal-audit.js'

function sampleGoal(): GoalAuditTaskGoal {
  return {
    objective: '实现功能 X',
    acceptance_criteria: [
      { id: 'c1', kind: 'cmd', spec: 'pnpm typecheck', expect: { exit_code: 0 } },
    ],
  }
}

function makeAuditorConfig(): SubAgentConfig {
  return {
    id: 'builtin-goal-auditor',
    name: 'goal_auditor',
    description: 'Goal auditor',
    when_to_use: '内部触发',
    role: 'auditor',
    workflow: 'verify',
    deliverables: 'AUDIT_REPORT',
    model: {
      endpoint: 'http://localhost:4000',
      apikey: 'test-key',
      model_id: 'test-model',
      format: 'anthropic',
    },
    builtin_capabilities: {
      file_system: true,
      shell: true,
      task_intel: false,
      crab_memory: false,
      crab_messaging: false,
    },
    allowed_mcp_server_ids: [],
    allowed_skill_ids: [],
    max_turns: 10,
    system_only: true,
  }
}

function makeHandler(opts: {
  rpcCall: ReturnType<typeof vi.fn>
  runSubAgentDirect?: ReturnType<typeof vi.fn>
  subAgents?: SubAgentConfig[]
}): AgentHandler {
  const sdkEnv = {
    modelId: 'test-model',
    format: 'anthropic' as const,
    env: {
      ANTHROPIC_BASE_URL: 'http://localhost:4000',
      ANTHROPIC_API_KEY: 'test-key',
    },
  }
  const handler = new AgentHandler(
    sdkEnv,
    { systemPrompt: 'worker' },
    {
      deps: {
        rpcClient: { call: opts.rpcCall } as unknown as import('crabot-shared').RpcClient,
        moduleId: 'agent-test',
        resolveChannelPort: async () => 3003,
        getMemoryPort: async () => 3002,
        getAdminPort: async () => 19000,
      },
      subAgents: opts.subAgents ?? [makeAuditorConfig()],
    },
  )
  if (opts.runSubAgentDirect) {
    // 覆盖私有 method —— runGoalAudit 内部走 this.runSubAgentDirect
    ;(handler as unknown as { runSubAgentDirect: typeof opts.runSubAgentDirect }).runSubAgentDirect =
      opts.runSubAgentDirect
  }
  return handler
}

describe('AgentHandler.runGoalAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('audit pass → 调 append_task_goal_audit_entry + complete_task_goal + 返回 pass=true', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't1', goal: sampleGoal() } }) // get_task
      .mockResolvedValueOnce({}) // append_task_goal_audit_entry
      .mockResolvedValueOnce({}) // complete_task_goal
    const runSubAgentDirect = vi.fn().mockResolvedValue({
      output: 'AUDIT_RESULT: pass\nFAILED_CRITERIA: []\n\nAUDIT_REPORT_END',
      isError: false,
      traceId: 'trace-abc',
    })
    const handler = makeHandler({ rpcCall, runSubAgentDirect })
    try {
      const result = await handler.runGoalAudit({ taskId: 't1', pendingContent: '做完了' })
      expect(result.pass).toBe(true)
      expect(result.failedCriteria).toEqual([])
      expect(result.auditTraceId).toBe('trace-abc')

      // RPC 调用顺序验证
      expect(rpcCall).toHaveBeenCalledTimes(3)
      expect(rpcCall.mock.calls[0][1]).toBe('get_task')
      expect(rpcCall.mock.calls[1][1]).toBe('append_task_goal_audit_entry')
      expect(rpcCall.mock.calls[2][1]).toBe('complete_task_goal')

      // append_task_goal_audit_entry 内容
      expect(rpcCall.mock.calls[1][2]).toMatchObject({
        task_id: 't1',
        entry: expect.objectContaining({
          pass: true,
          failed_criteria: [],
          audit_trace_id: 'trace-abc',
        }),
      })

      // complete_task_goal payload
      expect(rpcCall.mock.calls[2][2]).toEqual({ task_id: 't1' })
    } finally {
      handler.dispose()
    }
  })

  it('audit fail → 不调 complete_task_goal + 返回 pass=false + detailedReport 含未达成 criterion', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't2', goal: sampleGoal() } }) // get_task
      .mockResolvedValueOnce({}) // append_task_goal_audit_entry
    const runSubAgentDirect = vi.fn().mockResolvedValue({
      output: 'AUDIT_RESULT: fail\nFAILED_CRITERIA: [c1]\n\n## 失败原因\n- typecheck 报错\n\nAUDIT_REPORT_END',
      isError: false,
      traceId: 'trace-xyz',
    })
    const handler = makeHandler({ rpcCall, runSubAgentDirect })
    try {
      const result = await handler.runGoalAudit({ taskId: 't2', pendingContent: '做完了' })
      expect(result.pass).toBe(false)
      expect(result.failedCriteria).toEqual(['c1'])
      expect(result.auditTraceId).toBe('trace-xyz')
      // detailedReport 包含 fail 报告核心要素
      expect(result.detailedReport).toContain('目标审计未通过')
      expect(result.detailedReport).toContain('c1')
      expect(result.detailedReport).toContain('typecheck 报错')

      // 不调 complete_task_goal —— 只有两次 RPC
      expect(rpcCall).toHaveBeenCalledTimes(2)
      expect(rpcCall.mock.calls[0][1]).toBe('get_task')
      expect(rpcCall.mock.calls[1][1]).toBe('append_task_goal_audit_entry')
      const completeCalls = rpcCall.mock.calls.filter((c) => c[1] === 'complete_task_goal')
      expect(completeCalls).toHaveLength(0)

      // audit_history entry 记 fail
      expect(rpcCall.mock.calls[1][2]).toMatchObject({
        task_id: 't2',
        entry: expect.objectContaining({
          pass: false,
          failed_criteria: ['c1'],
        }),
      })
    } finally {
      handler.dispose()
    }
  })

  it('runSubAgentDirect 收到 traceSummaryPrefix="[goal_audit]" 和 traceTaskType="goal_audit"（M4）', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't', goal: sampleGoal() } })
      .mockResolvedValue({})
    const runSubAgentDirect = vi.fn().mockResolvedValue({
      output: 'AUDIT_RESULT: pass\nFAILED_CRITERIA: []',
      isError: false,
      traceId: 'tr-1',
    })
    const handler = makeHandler({ rpcCall, runSubAgentDirect })
    try {
      await handler.runGoalAudit({ taskId: 't', pendingContent: 'x' })
      expect(runSubAgentDirect).toHaveBeenCalledTimes(1)
      const callArgs = runSubAgentDirect.mock.calls[0]
      // callArgs[3] 是 deps 参数
      expect(callArgs[3]).toMatchObject({
        traceSummaryPrefix: '[goal_audit]',
        traceTaskType: 'goal_audit',
        callerLabel: 'goal_audit',
        parentTaskId: 't',
        parentTools: [],
      })
      // input 段必须把 subagent_type='goal_auditor' + 拼好的 prompt 一起塞进去
      expect(callArgs[1]).toMatchObject({
        subagent_type: 'goal_auditor',
      })
      expect(String(callArgs[1].task)).toContain('实现功能 X')
    } finally {
      handler.dispose()
    }
  })

  it('task 没 goal → 抛错且不调任何后续 RPC', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't', /* no goal */ } })
    const runSubAgentDirect = vi.fn()
    const handler = makeHandler({ rpcCall, runSubAgentDirect })
    try {
      await expect(
        handler.runGoalAudit({ taskId: 't', pendingContent: 'x' }),
      ).rejects.toThrow(/has no goal/)
      expect(runSubAgentDirect).not.toHaveBeenCalled()
      // 只调了一次 get_task
      expect(rpcCall).toHaveBeenCalledTimes(1)
    } finally {
      handler.dispose()
    }
  })

  it('subAgents 里没 goal_auditor → 抛 not configured', async () => {
    const rpcCall = vi.fn()
      .mockResolvedValueOnce({ task: { id: 't', goal: sampleGoal() } })
    const runSubAgentDirect = vi.fn()
    const handler = makeHandler({ rpcCall, runSubAgentDirect, subAgents: [] })
    try {
      await expect(
        handler.runGoalAudit({ taskId: 't', pendingContent: 'x' }),
      ).rejects.toThrow(/goal_auditor.*not configured/)
      expect(runSubAgentDirect).not.toHaveBeenCalled()
    } finally {
      handler.dispose()
    }
  })
})
