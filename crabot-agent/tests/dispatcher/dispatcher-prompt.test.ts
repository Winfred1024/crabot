import { describe, it, expect } from 'vitest'
import { assembleDispatcherPrompt } from '../../src/dispatcher/dispatcher-prompt.js'
import type { DispatchContext } from '../../src/dispatcher/dispatcher-types.js'
import type { TaskSummary } from '../../src/types.js'

function task(id: string): TaskSummary {
  return {
    task_id: id as never,
    title: `t-${id}`,
    status: 'executing',
    priority: 'normal',
  }
}

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    messages: [], recentMessages: [], activeTasks: [], sessionType: 'private',
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

  it('群聊场景 + 有活跃任务 → 三种动作都暴露', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'group', activeTasks: [task('task-A')] }))
    expect(p).toMatch(/supplement/)
    expect(p).toMatch(/new_task/)
    expect(p).toMatch(/stay_silent/)
  })

  it('私聊场景下不暴露 stay_silent 选项', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'private', activeTasks: [task('task-A')] }))
    expect(p).not.toMatch(/stay_silent/)
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

  // ============================================================================
  // Regression: activeTasks 为空时不向 LLM 暴露 supplement 选项
  // 修复来源：trace db206eaf — group 会话首条消息（无任何 active task），LLM 仍
  // 凭空输出 supplement + 编造 trigger-<uuid> 的 target_task_id。根因是 prompt
  // 仍把 supplement 描述为合法选项，加上 schema 只校验类型不校验白名单。
  // ============================================================================

  it('空 activeTasks + 私聊 → prompt 完全不含 supplement 字串', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'private', activeTasks: [] }))
    expect(p).not.toMatch(/supplement/)
    expect(p).toMatch(/new_task/)
    // 提示语应说明"没有活跃任务"
    expect(p).toMatch(/没有任何活跃任务/)
  })

  it('空 activeTasks + 群聊 → prompt 完全不含 supplement 字串，但保留 stay_silent', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'group', activeTasks: [] }))
    expect(p).not.toMatch(/supplement/)
    expect(p).toMatch(/new_task/)
    expect(p).toMatch(/stay_silent/)
    expect(p).toMatch(/没有任何活跃任务/)
  })

  it('非空 activeTasks → prompt 含白名单硬约束提醒（防 LLM 编造 task_id）', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'private', activeTasks: [task('task-A')] }))
    expect(p).toMatch(/target_task_id 硬约束/)
    expect(p).toMatch(/字面完全一致/)
  })

  it('空 activeTasks → 不显示白名单提醒（没有 supplement 选项时不需要）', () => {
    const p = assembleDispatcherPrompt(ctx({ sessionType: 'private', activeTasks: [] }))
    expect(p).not.toMatch(/target_task_id 硬约束/)
  })

  it('OUTPUT_SCHEMA 在空 activeTasks 时只列出允许的 kind', () => {
    const pPrivate = assembleDispatcherPrompt(ctx({ sessionType: 'private', activeTasks: [] }))
    // schema 段应表明 1 种合法 kind
    expect(pPrivate).toMatch(/1 种之一/)
    expect(pPrivate).toMatch(/`new_task`/)
    expect(pPrivate).not.toMatch(/`supplement`/)

    const pGroup = assembleDispatcherPrompt(ctx({ sessionType: 'group', activeTasks: [] }))
    expect(pGroup).toMatch(/2 种之一/)
    expect(pGroup).toMatch(/`new_task`/)
    expect(pGroup).toMatch(/`stay_silent`/)
    expect(pGroup).not.toMatch(/`supplement`/)
  })
})
