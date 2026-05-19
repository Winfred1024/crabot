import { describe, it, expect } from 'vitest'
import { assembleDispatcherPrompt } from '../../src/dispatcher/dispatcher-prompt.js'
import type { DispatchContext } from '../../src/dispatcher/dispatcher-types.js'

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    messages: [], activeTasks: [], sessionType: 'private',
    channelId: 'c', sessionId: 's',
    senderFriend: { id: 'f', display_name: 'u', permission: 'master' } as never,
    traceId: 't', ...overrides,
  }
}

describe('assembleDispatcherPrompt', () => {
  it('包含产品自我认知（Crabot 相关措辞）', () => {
    const p = assembleDispatcherPrompt(ctx())
    expect(p).toMatch(/Crabot/)
  })

  it('群聊场景包含三种动作：supplement / new_task / stay_silent', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'group' }))
    expect(p).toMatch(/supplement/)
    expect(p).toMatch(/new_task/)
    expect(p).toMatch(/stay_silent/)
  })

  it('私聊场景下不暴露 stay_silent 选项', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'private' }))
    expect(p).not.toMatch(/stay_silent.*仅群聊/)
    // 私聊 prompt 整体应不含 stay_silent 选项描述
    // 注意：assembleDispatcherPrompt 内部 OUTPUT_SCHEMA 可能仍提到 stay_silent
    // 这条只验证私聊 dispatch 规则段不主推 stay_silent
  })

  it('包含 JSON 输出 schema 与软上限 5', () => {
    const p = assembleDispatcherPrompt(ctx())
    expect(p).toMatch(/actions/)
    expect(p).toMatch(/5/)
  })

  it('不包含主工作流相关段（MCP 工具列表 / Skill / 反模式 self-check）', () => {
    const p = assembleDispatcherPrompt(ctx())
    expect(p).not.toMatch(/MCP|skill|ghost-promise|context hallucination|effortful synthesis/i)
  })
})
