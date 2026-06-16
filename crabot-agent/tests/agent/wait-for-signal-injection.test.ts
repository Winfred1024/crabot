import { describe, it, expect } from 'vitest'
import {
  extractLaunchedSubagentId,
  maybeCreateWaitForSignalTool,
} from '../../src/agent/agent-handler.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'

describe('extractLaunchedSubagentId', () => {
  it('从 delegate_task 异步路径 JSON 输出抓 agent_id', () => {
    const output = JSON.stringify({
      agent_id: 'agent_abc123',
      status: 'launched',
      output_file: null,
    })
    expect(extractLaunchedSubagentId(output)).toBe('agent_abc123')
  })

  it('status 不是 launched（同步路径文字结果）返回 undefined', () => {
    const output = JSON.stringify({
      output: 'sync subagent text result',
      outcome: 'completed',
    })
    expect(extractLaunchedSubagentId(output)).toBeUndefined()
  })

  it('agent_id 为空 / 非字符串返回 undefined', () => {
    expect(extractLaunchedSubagentId(JSON.stringify({ status: 'launched', agent_id: '' }))).toBeUndefined()
    expect(extractLaunchedSubagentId(JSON.stringify({ status: 'launched', agent_id: 123 }))).toBeUndefined()
    expect(extractLaunchedSubagentId(JSON.stringify({ status: 'launched' }))).toBeUndefined()
  })

  it('非 JSON 字符串返回 undefined（不抛错）', () => {
    expect(extractLaunchedSubagentId('plain text from sync subagent')).toBeUndefined()
  })

  it('output 是 undefined / 空串时返回 undefined', () => {
    expect(extractLaunchedSubagentId(undefined)).toBeUndefined()
    expect(extractLaunchedSubagentId('')).toBeUndefined()
  })
})

describe('maybeCreateWaitForSignalTool', () => {
  const stubDeps = {
    humanQueue: new HumanMessageQueue(),
    hasActiveAudit: () => false,
    hasActiveAsyncSubagent: () => false,
    hasRunningBgEntity: () => false,
  }

  it('goalMode + async 都开 → 注入', () => {
    const tool = maybeCreateWaitForSignalTool(
      { goalModeEnabled: true, asyncEnabled: true },
      stubDeps,
    )
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('wait_for_signal')
  })

  it('仅 goalMode 开 → 注入', () => {
    const tool = maybeCreateWaitForSignalTool(
      { goalModeEnabled: true, asyncEnabled: false },
      stubDeps,
    )
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('wait_for_signal')
  })

  it('仅 async 开 → 注入', () => {
    const tool = maybeCreateWaitForSignalTool(
      { goalModeEnabled: false, asyncEnabled: true },
      stubDeps,
    )
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('wait_for_signal')
  })

  it('两者都关 → 仍然注入（门槛已放开，总是注入）', () => {
    const tool = maybeCreateWaitForSignalTool(
      { goalModeEnabled: false, asyncEnabled: false },
      stubDeps,
    )
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('wait_for_signal')
  })

  it('注入的工具透传 deps（hasActiveAsyncSubagent 真正被调）', async () => {
    let callCount = 0
    const tool = maybeCreateWaitForSignalTool(
      { goalModeEnabled: false, asyncEnabled: true },
      {
        ...stubDeps,
        hasActiveAsyncSubagent: () => {
          callCount += 1
          return true
        },
      },
    )
    expect(tool).toBeDefined()
    // 触发 tool.call —— 应该看到 hasActiveAsyncSubagent 被调用
    await tool!.call({ reason: 'test' }, {} as never)
    expect(callCount).toBeGreaterThan(0)
    // 清理 barrier（hasActiveAsyncSubagent=true 时 tool.call 会 setBarrier(24h)，否则会泄露 setTimeout）
    stubDeps.humanQueue.clearBarrier()
  })
})
