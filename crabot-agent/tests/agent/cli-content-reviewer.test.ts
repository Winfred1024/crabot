import { describe, it, expect } from 'vitest'
import type { ResolvedPermissions } from '../../src/types.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { reviewCliContent } from '../../src/agent/cli-content-reviewer.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

const groupSchedulerPerms: ResolvedPermissions = {
  tool_access: {
    memory: true, messaging: true, task: true,
    mcp_skill: false, file_io: false, browser: false,
    shell: false, remote_exec: false, desktop: false,
  },
  cli_access: {
    provider: 'none', agent: 'none', mcp: 'none', skill: 'none',
    schedule: 'write', channel: 'none', friend: 'none',
    permission: 'none', config: 'none', undo: 'none',
  },
  storage: null,
  memory_scopes: [],
}

function makeAdapter(opts: { response?: string; throws?: Error }): LLMAdapter {
  return {
    stream: async function* () {
      if (opts.throws) throw opts.throws
      yield* chunksFromContent(
        [{ type: 'text', text: opts.response ?? '' }],
        'end_turn',
        { inputTokens: 100, outputTokens: 20 },
      )
    },
    updateConfig: () => {},
  }
}

describe('reviewCliContent', () => {
  it('messaging-only schedule（提醒类）落在 group_scheduler 范围 → approve', async () => {
    const adapter = makeAdapter({
      response: '{"verdict":"approve","reason":"仅需 messaging 工具发提醒"}',
    })
    const result = await reviewCliContent({
      effectivePermissions: groupSchedulerPerms,
      commandText: 'crabot schedule add --title 提醒张三 --task-description 提醒张三下午3点开会 --trigger-at 2026-05-06T15:00:00+08:00',
      adapter,
      modelId: 'claude-haiku-4-5',
    })
    expect(result.verdict).toBe('approve')
    expect(result.reason).toContain('messaging')
  })

  it('shell-required schedule 不在 tool_access 范围 → deny', async () => {
    const adapter = makeAdapter({
      response: '{"verdict":"deny","reason":"需要 shell 工具，超出权限"}',
    })
    const result = await reviewCliContent({
      effectivePermissions: groupSchedulerPerms,
      commandText: 'crabot schedule add --title cleanup --task-description 执行 rm -rf / --cron "0 15 * * *"',
      adapter,
      modelId: 'claude-haiku-4-5',
    })
    expect(result.verdict).toBe('deny')
    expect(result.reason).toContain('shell')
  })

  it('LLM 调用失败 → fail-closed deny', async () => {
    const adapter = makeAdapter({ throws: new Error('reviewer timeout') })
    const result = await reviewCliContent({
      effectivePermissions: groupSchedulerPerms,
      commandText: 'crabot schedule add --task-description 任意',
      adapter,
      modelId: 'claude-haiku-4-5',
    })
    expect(result.verdict).toBe('deny')
    expect(result.reason.toLowerCase()).toMatch(/审核|unavailable|timeout|fail-closed/i)
  })

  it('LLM 返回非法 JSON → fail-closed deny', async () => {
    const adapter = makeAdapter({ response: 'I think this is fine' })
    const result = await reviewCliContent({
      effectivePermissions: groupSchedulerPerms,
      commandText: 'crabot schedule add --task-description 测试',
      adapter,
      modelId: 'claude-haiku-4-5',
    })
    expect(result.verdict).toBe('deny')
  })

  it('LLM 输出 markdown 围栏包裹 JSON 也能解析', async () => {
    const adapter = makeAdapter({
      response: '```json\n{"verdict":"approve","reason":"OK"}\n```',
    })
    const result = await reviewCliContent({
      effectivePermissions: groupSchedulerPerms,
      commandText: 'crabot schedule add --task-description 任意',
      adapter,
      modelId: 'claude-haiku-4-5',
    })
    expect(result.verdict).toBe('approve')
  })

  it('reason 字段内含 } 不会让解析提前截断（bracket-balance）', async () => {
    const adapter = makeAdapter({
      response: '{"verdict":"approve","reason":"如 ${date} 模板含 } 字符也合法"}',
    })
    const result = await reviewCliContent({
      effectivePermissions: groupSchedulerPerms,
      commandText: 'crabot schedule add --task-description 任意',
      adapter,
      modelId: 'claude-haiku-4-5',
    })
    expect(result.verdict).toBe('approve')
    expect(result.reason).toContain('${date}')
    expect(result.reason).toContain('}')
  })
})
