/**
 * AgentHandler 热更新：updateSubagents / updateSdkEnv
 *
 * 设计目标（来自 FuFu 2026-05-21 讨论）：
 * - admin 改 model_config 或 subagents 后，不能重建 AgentHandler 实例
 *   （重建会让 in-flight task 的 activeTasks 表丢失 + agent_loop trace 永不 endTrace）
 * - in-flight 跑中的 loop 继续用 loop 启动时的旧 sdkEnv / 旧 subAgents 跑完
 * - 后续新 loop 用新 sdkEnv / 新 subAgents
 *
 * 本文件只测最薄的接口契约（字段被替换 + 实例不变）。in-flight 闭包快照行为由
 * handler-hot-update-snapshot.test.ts 覆盖。
 */
import { describe, it, expect } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type { SubAgentConfig } from '../../src/types.js'

function makeSdkEnv(modelId = 'm-1') {
  return {
    modelId,
    format: 'anthropic' as const,
    env: {
      ANTHROPIC_BASE_URL: 'http://localhost:4000',
      ANTHROPIC_API_KEY: 'key',
    },
  }
}

function makeSubAgent(name: string): SubAgentConfig {
  return {
    id: `id-${name}`,
    name,
    description: `desc ${name}`,
    when_to_use: `use when ${name}`,
    role: 'r',
    workflow: 'w',
    deliverables: 'd',
    model: { model_id: 'm', endpoint: 'https://x', apikey: 'k', format: 'anthropic' } as never,
    builtin_capabilities: { file_system: true, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
    allowed_mcp_server_ids: [],
    allowed_skill_ids: [],
    max_turns: 10,
  }
}

describe('AgentHandler.updateSubagents', () => {
  it('原地写 subagents，不返回新 handler 实例', () => {
    const handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'sys' }, {
      subAgents: [makeSubAgent('old_writer')],
    })
    const before = handler

    handler.updateSubagents([makeSubAgent('new_writer'), makeSubAgent('researcher')])

    expect(handler).toBe(before)
    // 字段被替换：通过 getSubagentsSnapshot 暴露的只读视图断言
    const snap = handler.getSubagentsSnapshot()
    expect(snap.map((s) => s.name)).toEqual(['new_writer', 'researcher'])
  })

  it('空列表也能 update（清空所有 subagents）', () => {
    const handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'sys' }, {
      subAgents: [makeSubAgent('a')],
    })
    handler.updateSubagents([])
    expect(handler.getSubagentsSnapshot()).toHaveLength(0)
  })

  it('多次连续 update 后只保留最后一次', () => {
    const handler = new AgentHandler(makeSdkEnv(), { systemPrompt: 'sys' })
    handler.updateSubagents([makeSubAgent('v1')])
    handler.updateSubagents([makeSubAgent('v2')])
    handler.updateSubagents([makeSubAgent('v3')])
    expect(handler.getSubagentsSnapshot().map((s) => s.name)).toEqual(['v3'])
  })
})

describe('AgentHandler.updateSdkEnv', () => {
  it('原地写 sdkEnv，不返回新 handler 实例', () => {
    const handler = new AgentHandler(makeSdkEnv('old-model'), { systemPrompt: 'sys' })
    const before = handler

    handler.updateSdkEnv(makeSdkEnv('new-model'))

    expect(handler).toBe(before)
    expect(handler.getSdkEnvSnapshot().modelId).toBe('new-model')
  })

  it('可选 digestSdkEnv 单独更新', () => {
    const handler = new AgentHandler(makeSdkEnv('m'), { systemPrompt: 'sys' }, {
      digestSdkEnv: makeSdkEnv('digest-old'),
    })
    handler.updateSdkEnv(makeSdkEnv('m'), makeSdkEnv('digest-new'))
    expect(handler.getDigestSdkEnvSnapshot()?.modelId).toBe('digest-new')
  })

  it('updateSdkEnv 不传 digest 时不清空旧 digest', () => {
    const handler = new AgentHandler(makeSdkEnv('m'), { systemPrompt: 'sys' }, {
      digestSdkEnv: makeSdkEnv('digest-old'),
    })
    handler.updateSdkEnv(makeSdkEnv('m'))   // 没传 digest
    expect(handler.getDigestSdkEnvSnapshot()?.modelId).toBe('digest-old')
  })
})
