import { describe, expect, it } from 'vitest'
import {
  resolveTaskByShortIdPrefix,
  formatGoalShowResponse,
  formatGoalClearResponse,
  formatGoalListResponse,
  formatMissingIdResponse,
  formatGoalShowNotFound,
  formatGoalShowNoGoal,
  formatGoalClearAlreadyTerminal,
  formatGoalClearAmbiguous,
} from './goal-slash.js'
import type { Task, TaskGoal } from './types.js'

function makeTask(
  id: string,
  objective = '...',
  goalStatus: TaskGoal['status'] | null = 'active',
): Task {
  const goal: TaskGoal | undefined = goalStatus
    ? {
        objective,
        acceptance_criteria: [{ id: 'c1', kind: 'semantic', spec: 'x' }],
        status: goalStatus,
        tokens_used: 0,
        audit_history: [],
        created_at: '2026-05-25T00:00:00.000Z',
        updated_at: '2026-05-25T00:00:00.000Z',
      }
    : undefined
  return {
    id: id as Task['id'],
    status: 'executing',
    priority: 'normal',
    title: objective,
    source: { trigger_type: 'message' },
    messages: [],
    tags: [],
    created_at: '2026-05-25T00:00:00.000Z',
    updated_at: '2026-05-25T00:00:00.000Z',
    ...(goal ? { goal } : {}),
  }
}

describe('resolveTaskByShortIdPrefix', () => {
  it('短前缀 < 4 字符拒绝', () => {
    const r = resolveTaskByShortIdPrefix('a3f', [makeTask('a3f8c2-uuid')])
    expect(r.kind).toBe('invalid-input')
  })
  it('唯一匹配返回 task', () => {
    const tasks = [makeTask('a3f8c2-uuid'), makeTask('b7c2aa-uuid')]
    const r = resolveTaskByShortIdPrefix('a3f8', tasks)
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.task.id).toBe('a3f8c2-uuid')
  })
  it('0 匹配返回 not-found', () => {
    const r = resolveTaskByShortIdPrefix('ffff', [makeTask('a3f8c2-uuid')])
    expect(r.kind).toBe('not-found')
  })
  it('≥2 匹配返回 ambiguous（带候选列表）', () => {
    const tasks = [makeTask('a3f8c2-uuid'), makeTask('a3f8c3-uuid')]
    const r = resolveTaskByShortIdPrefix('a3f8', tasks)
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.candidates.length).toBe(2)
  })
  it('精确长 id 命中', () => {
    const tasks = [makeTask('a3f8c2-uuid-full-length')]
    const r = resolveTaskByShortIdPrefix('a3f8c2-uuid-full-length', tasks)
    expect(r.kind).toBe('found')
  })
  it('剥离 trigger- 语义前缀后用 UUID 前 8 字符匹配', () => {
    const tasks = [
      makeTask('trigger-ff5340db-264b-4016-9368-6d0f47f8e1b0'),
      makeTask('trigger-323132d6-abd0-422f-bc11-1dbcdcdc794a'),
    ]
    const r = resolveTaskByShortIdPrefix('ff5340db', tasks)
    expect(r.kind).toBe('found')
    if (r.kind === 'found') expect(r.task.id).toBe('trigger-ff5340db-264b-4016-9368-6d0f47f8e1b0')
  })
  it('master 输入带 trigger- 前缀也能匹配（input 也剥前缀）', () => {
    const tasks = [makeTask('trigger-ff5340db-264b-4016-9368-6d0f47f8e1b0')]
    const r = resolveTaskByShortIdPrefix('trigger-ff5340db', tasks)
    expect(r.kind).toBe('found')
  })
  it('多个 trigger- task 前 8 字符不同 → 不再 ambiguous', () => {
    const tasks = [
      makeTask('trigger-ff5340db-aaa'),
      makeTask('trigger-323132d6-bbb'),
      makeTask('trigger-0eb0debb-ccc'),
    ]
    const r = resolveTaskByShortIdPrefix('ff5340db', tasks)
    expect(r.kind).toBe('found')
  })
  it('纯 UUID 形态不被误剥（首段非纯字母）', () => {
    const tasks = [makeTask('a2bde067-1234-5678-9abc-def012345678')]
    const r = resolveTaskByShortIdPrefix('a2bde067', tasks)
    expect(r.kind).toBe('found')
  })
})

describe('话术格式化', () => {
  it('formatGoalShowResponse 带 [系统响应 /目标 <input>] 前缀', () => {
    const task = makeTask('a3f8c2-uuid', 'do stuff')
    const out = formatGoalShowResponse('a3f8', task)
    expect(out.startsWith('[系统响应 /目标 a3f8]\n')).toBe(true)
    expect(out.includes('a3f8c2')).toBe(true)
    expect(out.includes('do stuff')).toBe(true)
    expect(out.includes('status: active')).toBe(true)
  })
  it('formatGoalShowResponse 显示 trigger- 前缀 task 的 UUID 短 id（不是 trigger-）', () => {
    const task = makeTask('trigger-ff5340db-264b-4016-9368-6d0f47f8e1b0', 'do stuff')
    const out = formatGoalShowResponse('ff5340db', task)
    expect(out.includes('ff5340db')).toBe(true)
    expect(out.includes('trigger-')).toBe(false)  // 短 id 不应含 trigger-
  })
  it('formatGoalClearResponse 带 [系统响应 /清除目标 <input>] 前缀', () => {
    const out = formatGoalClearResponse('a3f8', 'a3f8c2-uuid')
    expect(out.startsWith('[系统响应 /清除目标 a3f8]\n')).toBe(true)
    expect(out.includes('已清除')).toBe(true)
    expect(out.includes('a3f8c2')).toBe(true)
  })
  it('formatGoalListResponse 带 [系统响应 /目标列表] 前缀，按 task 列出', () => {
    const tasks = [
      makeTask('a3f8c2-uuid', 'task one'),
      makeTask('b7c2aa-uuid', 'task two', 'cleared'),
    ]
    const out = formatGoalListResponse(tasks)
    expect(out.startsWith('[系统响应 /目标列表]\n')).toBe(true)
    expect(out.includes('a3f8')).toBe(true)
    expect(out.includes('task one')).toBe(true)
    expect(out.includes('b7c2')).toBe(true)
  })
  it('formatGoalListResponse 无 task 时回"无 active task"', () => {
    const out = formatGoalListResponse([])
    expect(out.startsWith('[系统响应 /目标列表]\n')).toBe(true)
    expect(out.includes('无')).toBe(true)
  })
  it('formatMissingIdResponse 用对应命令前缀', () => {
    const tasks = [makeTask('a3f8c2-uuid', 'task one')]
    const showOut = formatMissingIdResponse('/目标', tasks)
    expect(showOut.startsWith('[系统响应 /目标]\n')).toBe(true)
    expect(showOut.includes('缺少 task-id')).toBe(true)
    expect(showOut.includes('a3f8')).toBe(true)
    const clearOut = formatMissingIdResponse('/清除目标', tasks)
    expect(clearOut.startsWith('[系统响应 /清除目标]\n')).toBe(true)
  })
  it('formatGoalShowNotFound 列出当前 channel 候选', () => {
    const tasks = [makeTask('a3f8c2-uuid', 'task one')]
    const out = formatGoalShowNotFound('zzzz', tasks)
    expect(out.startsWith('[系统响应 /目标 zzzz]\n')).toBe(true)
    expect(out.includes('未找到')).toBe(true)
    expect(out.includes('a3f8')).toBe(true)
  })
  it('formatGoalShowNoGoal 显式提示无 goal', () => {
    const task = makeTask('a3f8c2-uuid', 't', null)
    const out = formatGoalShowNoGoal('a3f8', task)
    expect(out.startsWith('[系统响应 /目标 a3f8]\n')).toBe(true)
    expect(out.includes('该 task 没有 goal')).toBe(true)
  })
  it('formatGoalClearAlreadyTerminal 告知当前 status', () => {
    const out = formatGoalClearAlreadyTerminal('a3f8', 'complete')
    expect(out.startsWith('[系统响应 /清除目标 a3f8]\n')).toBe(true)
    expect(out.includes('complete')).toBe(true)
    expect(out.includes('不可清除')).toBe(true)
  })
  it('formatGoalClearAmbiguous 列出候选并要求加长', () => {
    const candidates = [makeTask('a3f8c2-uuid'), makeTask('a3f8c3-uuid')]
    const out = formatGoalClearAmbiguous('a3f8', candidates)
    expect(out.startsWith('[系统响应 /清除目标 a3f8]\n')).toBe(true)
    expect(out.includes('多个 task 匹配前缀')).toBe(true)
    expect(out.includes('a3f8c2')).toBe(true)
    expect(out.includes('a3f8c3')).toBe(true)
  })
})
