import { describe, it, expect } from 'vitest'
import { renderActiveTasksSection } from '../../src/agent/active-tasks-section'
import type { TaskSummary, TaskId } from '../../src/types'

// 固定 now，避免 live snapshot 渲染时调用 Date.now() 导致测试 flaky
const FIXED_NOW = new Date('2026-06-02T06:00:00.000Z')

function makeTask(overrides: Partial<TaskSummary> & { task_id: string }): TaskSummary {
  return {
    task_id: overrides.task_id as TaskId,
    title: overrides.title ?? 'Untitled',
    status: overrides.status ?? 'executing',
    priority: overrides.priority ?? 'normal',
    source_channel_id: overrides.source_channel_id ?? 'telegram-001',
    source_session_id: overrides.source_session_id ?? 'session-A',
    trigger_type: overrides.trigger_type,
    latest_progress: overrides.latest_progress,
    pending_question: overrides.pending_question,
    live: overrides.live,
    updated_at: overrides.updated_at,
  }
}

const BASE_INPUT = {
  currentChannel: 'telegram-001',
  currentSession: 'session-A',
  isMaster: true,
  isGroup: false,
  timezone: 'Asia/Shanghai',
  now: FIXED_NOW,
}

describe('renderActiveTasksSection', () => {
  describe('SELF marker', () => {
    it('当前 worker 跑的 task 行尾追加【本任务】', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-self' as TaskId,
        activeTasks: [
          makeTask({ task_id: 'task-self', title: '当前任务' }),
          makeTask({ task_id: 'task-other', title: '同会话另一个 task' }),
        ],
      })
      const output = lines.join('\n')
      expect(output).toMatch(/- \[task-self\][^\n]*【本任务】/)
      const otherLine = lines.find(l => l.includes('[task-other]'))
      expect(otherLine).toBeDefined()
      expect(otherLine).not.toContain('【本任务】')
    })

    it('currentTaskId 不在 activeTasks 里时不打 marker（不崩）', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-not-in-list' as TaskId,
        activeTasks: [makeTask({ task_id: 'task-a' })],
      })
      const output = lines.join('\n')
      expect(output).not.toContain('【本任务】')
    })

    it('跨分组也只有 currentTaskId 那条标本任务', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-other-session' as TaskId,
        activeTasks: [
          makeTask({ task_id: 'task-current-session', title: '本会话' }),
          makeTask({
            task_id: 'task-other-session',
            title: '别的会话',
            source_session_id: 'session-B',
            source_channel_id: 'telegram-001',
          }),
        ],
      })
      const selfLine = lines.find(l => l.includes('[task-other-session]'))
      const otherLine = lines.find(l => l.includes('[task-current-session]'))
      expect(selfLine).toContain('【本任务】')
      expect(otherLine).not.toContain('【本任务】')
    })
  })

  describe('空 list 文案', () => {
    it('activeTasks 为空时显示"（无）"，且不输出历史查询提示（已挪到 system prompt）', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-self' as TaskId,
        activeTasks: [],
      })
      const output = lines.join('\n')
      expect(output).toContain('## 活跃任务')
      expect(output).toContain('（无）')
      // 历史查询提示已经挪到 system prompt（agent-sections.INFO_QUERY_GUIDE）
      expect(output).not.toContain('find_task')
      expect(output).not.toContain('get_task_progress')
      expect(output).not.toContain('已结束的任务')
      expect(output).not.toContain('不允许凭印象')
    })
  })

  describe('单组场景省略三级标题（flatten）', () => {
    it('私聊只有当前对话任务时直接平铺，不顶 ### 标题', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-self' as TaskId,
        activeTasks: [makeTask({ task_id: 'task-self', title: '唯一任务' })],
      })
      const output = lines.join('\n')
      expect(output).toContain('## 活跃任务')
      expect(output).not.toContain('### 当前对话')
      expect(output).toMatch(/- \[task-self\]/)
    })

    it('master 只有 scheduled 任务时也不顶 ### 标题', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-sched' as TaskId,
        activeTasks: [
          makeTask({ task_id: 'task-sched', title: '定时', trigger_type: 'scheduled' }),
        ],
      })
      const output = lines.join('\n')
      expect(output).not.toContain('### schedule 触发')
      expect(output).toContain('[定时/巡检任务，禁止 supplement]')
    })
  })

  describe('多组场景才出 ### 标题', () => {
    it('master 看到 current / other / scheduled 三组时各自加标题', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-current' as TaskId,
        activeTasks: [
          makeTask({ task_id: 'task-current', title: '当前会话任务' }),
          makeTask({
            task_id: 'task-other',
            title: '别的会话任务',
            source_session_id: 'session-B',
          }),
          makeTask({
            task_id: 'task-sched',
            title: '定时任务',
            trigger_type: 'scheduled',
          }),
        ],
      })
      const output = lines.join('\n')
      expect(output).toContain('### 当前对话的任务（1 条）')
      expect(output).toContain('### 其他对话场景的任务（1 条）')
      expect(output).toContain('### schedule 触发任务（1 条）')
    })

    it('群聊场景的"当前组"标题使用群聊措辞', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        isGroup: true,
        currentTaskId: 'task-current' as TaskId,
        activeTasks: [
          makeTask({ task_id: 'task-current', title: '当前群聊任务' }),
          makeTask({
            task_id: 'task-other',
            title: '别的会话',
            source_session_id: 'session-B',
          }),
        ],
      })
      const output = lines.join('\n')
      expect(output).toContain('### 当前群聊的任务（1 条）')
    })

    it('非 master 不显示 other / scheduled 组', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        isMaster: false,
        currentTaskId: 'task-current' as TaskId,
        activeTasks: [
          makeTask({ task_id: 'task-current', title: '当前会话' }),
          makeTask({
            task_id: 'task-other',
            title: '别的会话',
            source_session_id: 'session-B',
          }),
          makeTask({
            task_id: 'task-sched',
            title: '定时',
            trigger_type: 'scheduled',
          }),
        ],
      })
      const output = lines.join('\n')
      // 非 master 只剩当前组一组，flatten
      expect(output).not.toContain('### 当前对话')
      expect(output).not.toContain('### 其他对话场景的任务')
      expect(output).not.toContain('### schedule 触发任务')
    })
  })

  describe('scheduled 警示按需输出', () => {
    it('没有 scheduled 任务时不输出"禁止 supplement"警示', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-current' as TaskId,
        activeTasks: [
          makeTask({ task_id: 'task-current', title: '当前会话任务' }),
        ],
      })
      const output = lines.join('\n')
      expect(output).not.toContain('禁止 supplement')
    })

    it('有 scheduled 任务时输出警示', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-sched' as TaskId,
        activeTasks: [
          makeTask({ task_id: 'task-sched', title: '定时', trigger_type: 'scheduled' }),
        ],
      })
      const output = lines.join('\n')
      expect(output).toContain('[定时/巡检任务，禁止 supplement]')
    })
  })

  describe('waiting_human 不全文塞 pending_question', () => {
    it('只输出一行"详情调 get_task_progress 取"摘要，不塞整段 quoted question', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-wh' as TaskId,
        activeTasks: [
          makeTask({
            task_id: 'task-wh',
            title: '等人答',
            status: 'waiting_human',
            pending_question: '要不要继续？\n请回 yes/no\n（很多行的细节...）',
          }),
        ],
      })
      const output = lines.join('\n')
      expect(output).toContain('正在等待人类回答')
      expect(output).toContain('get_task_progress("task-wh")')
      // 整段 quoted question 不塞 prompt
      expect(output).not.toContain('> 要不要继续？')
      expect(output).not.toContain('> 请回 yes/no')
      expect(output).not.toContain('（很多行的细节')
    })
  })
})
