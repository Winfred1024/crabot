import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
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
    assert.equal(r.kind, 'invalid-input')
  })
  it('唯一匹配返回 task', () => {
    const tasks = [makeTask('a3f8c2-uuid'), makeTask('b7c2aa-uuid')]
    const r = resolveTaskByShortIdPrefix('a3f8', tasks)
    assert.equal(r.kind, 'found')
    if (r.kind === 'found') assert.equal(r.task.id, 'a3f8c2-uuid')
  })
  it('0 匹配返回 not-found', () => {
    const r = resolveTaskByShortIdPrefix('ffff', [makeTask('a3f8c2-uuid')])
    assert.equal(r.kind, 'not-found')
  })
  it('≥2 匹配返回 ambiguous（带候选列表）', () => {
    const tasks = [makeTask('a3f8c2-uuid'), makeTask('a3f8c3-uuid')]
    const r = resolveTaskByShortIdPrefix('a3f8', tasks)
    assert.equal(r.kind, 'ambiguous')
    if (r.kind === 'ambiguous') assert.equal(r.candidates.length, 2)
  })
  it('精确长 id 命中', () => {
    const tasks = [makeTask('a3f8c2-uuid-full-length')]
    const r = resolveTaskByShortIdPrefix('a3f8c2-uuid-full-length', tasks)
    assert.equal(r.kind, 'found')
  })
})

describe('话术格式化', () => {
  it('formatGoalShowResponse 带 [系统响应 /目标 <input>] 前缀', () => {
    const task = makeTask('a3f8c2-uuid', 'do stuff')
    const out = formatGoalShowResponse('a3f8', task)
    assert.ok(out.startsWith('[系统响应 /目标 a3f8]\n'))
    assert.ok(out.includes('a3f8c2'))
    assert.ok(out.includes('do stuff'))
    assert.ok(out.includes('status: active'))
  })
  it('formatGoalClearResponse 带 [系统响应 /清除目标 <input>] 前缀', () => {
    const out = formatGoalClearResponse('a3f8', 'a3f8c2-uuid')
    assert.ok(out.startsWith('[系统响应 /清除目标 a3f8]\n'))
    assert.ok(out.includes('已清除'))
    assert.ok(out.includes('a3f8c2'))
  })
  it('formatGoalListResponse 带 [系统响应 /目标列表] 前缀，按 task 列出', () => {
    const tasks = [
      makeTask('a3f8c2-uuid', 'task one'),
      makeTask('b7c2aa-uuid', 'task two', 'cleared'),
    ]
    const out = formatGoalListResponse(tasks)
    assert.ok(out.startsWith('[系统响应 /目标列表]\n'))
    assert.ok(out.includes('a3f8'))
    assert.ok(out.includes('task one'))
    assert.ok(out.includes('b7c2'))
  })
  it('formatGoalListResponse 无 task 时回"无 active task"', () => {
    const out = formatGoalListResponse([])
    assert.ok(out.startsWith('[系统响应 /目标列表]\n'))
    assert.ok(out.includes('无'))
  })
  it('formatMissingIdResponse 用对应命令前缀', () => {
    const tasks = [makeTask('a3f8c2-uuid', 'task one')]
    const showOut = formatMissingIdResponse('/目标', tasks)
    assert.ok(showOut.startsWith('[系统响应 /目标]\n'))
    assert.ok(showOut.includes('缺少 task-id'))
    assert.ok(showOut.includes('a3f8'))
    const clearOut = formatMissingIdResponse('/清除目标', tasks)
    assert.ok(clearOut.startsWith('[系统响应 /清除目标]\n'))
  })
  it('formatGoalShowNotFound 列出当前 channel 候选', () => {
    const tasks = [makeTask('a3f8c2-uuid', 'task one')]
    const out = formatGoalShowNotFound('zzzz', tasks)
    assert.ok(out.startsWith('[系统响应 /目标 zzzz]\n'))
    assert.ok(out.includes('未找到'))
    assert.ok(out.includes('a3f8'))
  })
  it('formatGoalShowNoGoal 显式提示无 goal', () => {
    const task = makeTask('a3f8c2-uuid', 't', null)
    const out = formatGoalShowNoGoal('a3f8', task)
    assert.ok(out.startsWith('[系统响应 /目标 a3f8]\n'))
    assert.ok(out.includes('该 task 没有 goal'))
  })
  it('formatGoalClearAlreadyTerminal 告知当前 status', () => {
    const out = formatGoalClearAlreadyTerminal('a3f8', 'complete')
    assert.ok(out.startsWith('[系统响应 /清除目标 a3f8]\n'))
    assert.ok(out.includes('complete'))
    assert.ok(out.includes('不可清除'))
  })
  it('formatGoalClearAmbiguous 列出候选并要求加长', () => {
    const candidates = [makeTask('a3f8c2-uuid'), makeTask('a3f8c3-uuid')]
    const out = formatGoalClearAmbiguous('a3f8', candidates)
    assert.ok(out.startsWith('[系统响应 /清除目标 a3f8]\n'))
    assert.ok(out.includes('多个 task 匹配前缀'))
    assert.ok(out.includes('a3f8c2'))
    assert.ok(out.includes('a3f8c3'))
  })
})
