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
      // self 行必须含 marker
      expect(output).toMatch(/- \[task-self\][^\n]*【本任务】/)
      // 非 self 行禁止含 marker
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

  describe('历史查询提示', () => {
    it('activeTasks 非空时输出历史提示', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-self' as TaskId,
        activeTasks: [makeTask({ task_id: 'task-self' })],
      })
      const output = lines.join('\n')
      expect(output).toContain('已结束的任务（completed / failed / cancelled）不在此清单里')
      expect(output).toContain('search_traces')
      expect(output).toContain('search_memory')
      expect(output).toContain('不允许凭印象或上下文猜测任务状态')
    })

    it('activeTasks 为空时仍输出历史提示——agent 在 active list 为空时也必须撞到', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-self' as TaskId,
        activeTasks: [],
      })
      const output = lines.join('\n')
      expect(output).toContain('## 活跃任务')
      expect(output).toContain('已结束的任务（completed / failed / cancelled）不在此清单里')
      expect(output).toContain('search_traces')
      expect(output).toContain('search_memory')
    })

    it('历史提示明确点名"用户引用历史消息 / 问进度 / 上次那个"等触发场景', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-self' as TaskId,
        activeTasks: [],
      })
      const output = lines.join('\n')
      // 三种用户表达全覆盖（13:56/13:57 那次撒谎现场就是被 "进度如何" / 引用历史消息 击中没反应过来）
      expect(output).toContain('引用历史消息')
      expect(output).toContain('进度如何')
      expect(output).toContain('上次那个')
    })
  })

  describe('分组渲染', () => {
    it('master 看到 current / other / scheduled 三个分组', () => {
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
      expect(output).toContain('### 当前对话对象的任务（1 条）')
      expect(output).toContain('### 其他对话场景的任务（1 条）')
      expect(output).toContain('### schedule 触发任务（1 条）')
    })

    it('非 master 不显示 other / scheduled 分组', () => {
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
      expect(output).toContain('### 当前对话对象的任务')
      expect(output).not.toContain('### 其他对话场景的任务')
      expect(output).not.toContain('### schedule 触发任务')
    })

    it('scheduled task 行带禁止 supplement 标签', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-sched' as TaskId,
        activeTasks: [
          makeTask({
            task_id: 'task-sched',
            title: '定时',
            trigger_type: 'scheduled',
          }),
        ],
      })
      const output = lines.join('\n')
      expect(output).toContain('[定时/巡检任务，禁止 supplement]')
    })

    it('waiting_human + pending_question 渲染等待问题', () => {
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'task-wh' as TaskId,
        activeTasks: [
          makeTask({
            task_id: 'task-wh',
            title: '等人答',
            status: 'waiting_human',
            pending_question: '要不要继续？\n请回 yes/no',
          }),
        ],
      })
      const output = lines.join('\n')
      expect(output).toContain('正在等待人类回答的问题')
      expect(output).toContain('> 要不要继续？')
      expect(output).toContain('> 请回 yes/no')
    })
  })

  describe('原 13:58 撒谎场景的回归测试', () => {
    it('单 task 在 active 列表里 + currentTaskId 跟它一致 → SELF marker 出现 + 历史提示在场', () => {
      // 复现现场：worker 跑 trigger-dc19（用户引用消息新建的），active_tasks 里
      // 只有这一条。agent 之前误把这条当成 trigger-66f2 (failed) 还在跑。
      // 修复后 prompt 里 trigger-dc19 应该明确标【本任务】，且末尾提示让 agent
      // 在再问"06:33 那条进度"时主动 search_memory / search_traces。
      const lines = renderActiveTasksSection({
        ...BASE_INPUT,
        currentTaskId: 'trigger-dc19' as TaskId,
        activeTasks: [
          makeTask({
            task_id: 'trigger-dc19',
            title: '继续推进quant-signal 项目',
            status: 'executing',
          }),
        ],
      })
      const output = lines.join('\n')
      // SELF marker 让 agent 不再把"自己当前 task"误识别成"用户问的老任务"
      expect(output).toMatch(/- \[trigger-dc19\][^\n]*【本任务】/)
      // 历史提示让 agent 知道 trigger-66f2 这种 failed task 要去另一个入口找
      expect(output).toContain('search_memory')
    })
  })
})
