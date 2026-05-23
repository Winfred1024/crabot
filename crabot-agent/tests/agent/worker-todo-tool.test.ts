import { describe, it, expect } from 'vitest'
import { TodoStore } from '../../src/agent/worker-todo-store.js'
import { createTodoTool } from '../../src/agent/worker-todo-tool.js'

function callTool(store: TodoStore, input: Record<string, unknown>) {
  const tool = createTodoTool(store)
  return tool.call(input, {} as never)
}

describe('createTodoTool', () => {
  it('exposes correct name and isReadOnly=false', () => {
    const tool = createTodoTool(new TodoStore())
    expect(tool.name).toBe('todo')
    expect(tool.isReadOnly).toBe(false)
  })

  it('read mode (no args) returns empty list initially', async () => {
    const result = await callTool(new TodoStore(), {})
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.output)).toEqual([])
  })

  it('replace mode (default merge=false) overwrites list', async () => {
    const store = new TodoStore()
    await callTool(store, {
      todos: [{ id: 'a', content: 'first', status: 'pending' }],
    })
    const result = await callTool(store, {
      todos: [{ id: 'b', content: 'second', status: 'pending' }],
    })
    expect(JSON.parse(result.output)).toEqual([
      { id: 'b', content: 'second', status: 'pending' },
    ])
  })

  it('merge mode (merge=true) updates by id and appends', async () => {
    const store = new TodoStore()
    await callTool(store, {
      todos: [
        { id: 'a', content: 'A', status: 'pending' },
        { id: 'b', content: 'B', status: 'pending' },
      ],
    })
    const result = await callTool(store, {
      merge: true,
      todos: [
        { id: 'a', content: 'A', status: 'in_progress' },
        { id: 'c', content: 'C', status: 'pending' },
      ],
    })
    expect(JSON.parse(result.output)).toEqual([
      { id: 'a', content: 'A', status: 'in_progress' },
      { id: 'b', content: 'B', status: 'pending' },
      { id: 'c', content: 'C', status: 'pending' },
    ])
  })

  it('returns isError on validation failure (two in_progress)', async () => {
    const store = new TodoStore()
    const result = await callTool(store, {
      todos: [
        { id: 'a', content: 'A', status: 'in_progress' },
        { id: 'b', content: 'B', status: 'in_progress' },
      ],
    })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/Only one item can be in_progress/)
  })

  it('returns isError on duplicate id', async () => {
    const store = new TodoStore()
    const result = await callTool(store, {
      todos: [
        { id: 'a', content: 'A', status: 'pending' },
        { id: 'a', content: 'A2', status: 'pending' },
      ],
    })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/duplicate id/)
  })

  it('returns isError when todos is non-array', async () => {
    const store = new TodoStore()
    const result = await callTool(store, { todos: 'not-an-array' })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/todos must be an array/)
  })
})

describe('todo 工具 hasGoal 门控', () => {
  it('hasGoal=false + 写模式 → 拒绝', async () => {
    const store = new TodoStore()
    const tool = createTodoTool(store, { hasGoal: () => false })
    const r = await tool.call!({ todos: [{ id: 'a', content: 'x', status: 'pending' }] }, {} as never)
    expect(r.isError).toBe(true)
    expect(String(r.output)).toMatch(/set_task_goal|尚未/)
  })

  it('hasGoal=false + 读模式 → 允许（返回空列表）', async () => {
    const store = new TodoStore()
    const tool = createTodoTool(store, { hasGoal: () => false })
    const r = await tool.call!({}, {} as never)
    expect(r.isError).toBe(false)
    expect(String(r.output)).toBe('[]')
  })

  it('hasGoal=true + 写模式 → 允许', async () => {
    const store = new TodoStore()
    const tool = createTodoTool(store, { hasGoal: () => true })
    const r = await tool.call!({ todos: [{ id: 'a', content: 'x', status: 'pending' }] }, {} as never)
    expect(r.isError).toBe(false)
  })

  it('hasGoal=true + merge 模式 → 允许', async () => {
    const store = new TodoStore()
    store.replace([{ id: 'a', content: 'x', status: 'pending' }])
    const tool = createTodoTool(store, { hasGoal: () => true })
    const r = await tool.call!({
      todos: [{ id: 'b', content: 'y', status: 'pending' }],
      merge: true,
    }, {} as never)
    expect(r.isError).toBe(false)
  })

  it('缺省 deps → 不门控，写模式 backward compat', async () => {
    const store = new TodoStore()
    const tool = createTodoTool(store)
    const r = await tool.call!({ todos: [{ id: 'a', content: 'x', status: 'pending' }] }, {} as never)
    expect(r.isError).toBe(false)
  })

  it('hasGoal getter 是动态查询（中途变 true 后允许）', async () => {
    const store = new TodoStore()
    let goalSet = false
    const tool = createTodoTool(store, { hasGoal: () => goalSet })
    const r1 = await tool.call!({ todos: [{ id: 'a', content: 'x', status: 'pending' }] }, {} as never)
    expect(r1.isError).toBe(true)
    goalSet = true
    const r2 = await tool.call!({ todos: [{ id: 'a', content: 'x', status: 'pending' }] }, {} as never)
    expect(r2.isError).toBe(false)
  })

  it('todos 非数组 → 报错（原有验证保留）', async () => {
    const store = new TodoStore()
    const tool = createTodoTool(store, { hasGoal: () => true })
    const r = await tool.call!({ todos: 'not-array' }, {} as never)
    expect(r.isError).toBe(true)
    expect(String(r.output)).toMatch(/must be an array/)
  })
})
