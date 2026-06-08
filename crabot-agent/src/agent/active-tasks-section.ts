/**
 * Worker trigger prompt 的"活跃任务"段渲染。
 *
 * 从 agent-handler.buildTriggerUserPrompt 抽出成 pure function，目的有二：
 * 1. 便于单测验证 SELF marker / 历史查询提示 / 分组渲染等行为不破
 * 2. 强约束 task list 末尾的"已结束任务在此不可见 → 用 search_traces / search_memory"
 *    历史提示，**消除 agent 凭印象瞎答历史任务状态的 hallucination**。
 *
 * **设计要点（直接关系信任）**：
 *
 * a. **SELF marker** — 当前 worker loop 正在跑的 task 在列表里追加 `【本任务】`。
 *    没这个标记时，agent 容易把"自己当前 task running"误识别成"用户问的某条
 *    历史 task 还活着"，于是凭空汇报"任务还在运行中"（实际是它自己刚被建出来）。
 *
 * b. **历史查询提示**始终输出（即使 active list 为空）。LLM 看完 list 后必须
 *    撞到一段明确说明："这个 list 不全，已结束的在另一个入口"——这是嵌入数据
 *    展示位置的语义注释，比独立写"硬规则段"更难被 specification-game。
 *
 * c. **Dispatcher 不复用本函数**。dispatcher 自身不是 task，没有"本任务"概念；
 *    它的 task list 渲染在 dispatcher.ts 内联，保持极简，跟这里不互相影响。
 */

import type { TaskSummary } from '../types.js'
import { formatTaskCreatedAt, formatElapsedMs } from '../utils/time.js'

export interface RenderActiveTasksInput {
  readonly activeTasks: ReadonlyArray<TaskSummary>
  /** 当前 worker loop 正在跑的 task_id；renderTask 用它判 SELF marker。 */
  readonly currentTaskId: string
  /** 当前对话所在 channel——用于"当前/其他对话场景"分组。 */
  readonly currentChannel: string
  /** 当前对话 session 同上。 */
  readonly currentSession: string
  /** 是否 master——决定是否展示 other / scheduled 分组。 */
  readonly isMaster: boolean
  /** 渲染 live 子段时格式化时间用。 */
  readonly timezone: string
  /** 渲染 live 子段时算 elapsed 用。 */
  readonly now: Date
}

const HISTORY_HINT_LINES: ReadonlyArray<string> = [
  '',
  '上面"活跃任务"清单只包含 admin 维护的活跃状态（pending / planning / executing / waiting_human）。',
  '**已结束的任务（completed / failed / cancelled）不在此清单里**，但它们仍存在历史中：',
  '- 已知 task_id 或 trace_id → `search_traces` 拿过程详情',
  '- 不知道 ID（只记得时间窗 / 关键词 / 对话锚点）→ 先 `search_memory level=short_term` 拿到 task_id 锚点，再 `search_traces`',
  '',
  '**凡用户提到 / 暗示 / 引用过去的事（"上次那个" / "进度如何" / 引用历史消息 / 你自己在 recent_messages 里说过却找不到对应 active task），先调上述工具查清楚再答——不允许凭印象或上下文猜测任务状态。**',
]

export function renderActiveTasksSection(input: RenderActiveTasksInput): string[] {
  const { activeTasks, currentTaskId, currentChannel, currentSession, isMaster, timezone, now } = input
  const lines: string[] = []

  lines.push('\n## 活跃任务')

  if (activeTasks.length === 0) {
    lines.push('（当前 admin 维护的活跃任务清单为空。）')
  } else {
    const currentTasks: TaskSummary[] = []
    const otherTasks: TaskSummary[] = []
    const scheduledTasks: TaskSummary[] = []

    for (const t of activeTasks) {
      if (t.trigger_type === 'scheduled') scheduledTasks.push(t)
      else if (t.source_session_id === currentSession && t.source_channel_id === currentChannel) currentTasks.push(t)
      else otherTasks.push(t)
    }

    const renderTask = (t: TaskSummary, includeSource: boolean): string[] => {
      const out: string[] = []
      const tag = t.trigger_type === 'scheduled' ? ' [定时/巡检任务，禁止 supplement]' : ''
      const src = includeSource && t.source_channel_id ? ` [来源: ${t.source_channel_id}:${t.source_session_id}]` : ''
      const selfMarker = t.task_id === currentTaskId ? ' 【本任务】' : ''
      out.push(`- [${t.task_id}] "${t.title}" (status: ${t.status})${tag}${src}${selfMarker}`)
      if (t.latest_progress) out.push(`  最近进度（事后摘要）: ${t.latest_progress}`)
      if (t.status === 'waiting_human' && t.pending_question) {
        out.push('  正在等待人类回答的问题:')
        for (const ql of t.pending_question.split('\n')) {
          out.push(`  > ${ql}`)
        }
      }
      const live = t.live
      if (live) {
        out.push(`  创建于 ${formatTaskCreatedAt(live.started_at, timezone, now)} / 第 ${live.current_turn} 轮`)
        if (live.last_assistant_text) {
          const tt = live.last_assistant_text.trim()
          if (tt.length > 0) out.push(`  上轮模型说: ${tt.slice(0, 200)}${tt.length > 200 ? '…' : ''}`)
        }
        if (live.active_tools.length > 0) {
          for (const at of live.active_tools) {
            const elapsed = formatElapsedMs(Date.now() - at.started_at)
            out.push(`  正在跑工具: ${at.name}（已 ${elapsed}）— ${at.input_summary}`)
          }
        }
        if (live.recent_completed.length > 0) {
          const tail = live.recent_completed.slice(-3).map((c: { name: string; is_error: boolean }) => `${c.name}${c.is_error ? '(失败)' : ''}`).join(' / ')
          out.push(`  最近完成: ${tail}`)
        }
        if (live.llm_retry) {
          const r = live.llm_retry
          const elapsed = formatElapsedMs(Date.now() - r.since)
          out.push(`  LLM 调用 retry 中: ${r.attempt}/${r.max_attempts} (${r.source})，已 ${elapsed}，原因: ${r.last_error}`)
        }
      }
      return out
    }

    if (currentTasks.length > 0) {
      lines.push(`\n### 当前对话对象的任务（${currentTasks.length} 条）`)
      for (const t of currentTasks) lines.push(...renderTask(t, false))
    }

    if (isMaster && otherTasks.length > 0) {
      lines.push(`\n### 其他对话场景的任务（${otherTasks.length} 条）`)
      for (const t of otherTasks) lines.push(...renderTask(t, true))
    }

    if (isMaster && scheduledTasks.length > 0) {
      lines.push(`\n### schedule 触发任务（${scheduledTasks.length} 条）`)
      for (const t of scheduledTasks) lines.push(...renderTask(t, false))
    }

    lines.push('\n**带 [定时/巡检任务，禁止 supplement] 标签的任务由 dispatcher 在 spawn 前过滤；如果它出现在本列表里，说明它仍可被查询，但不会接收 supplement**。')
  }

  // 历史查询提示——active list 是否为空都要输出，agent 必须撞到
  for (const line of HISTORY_HINT_LINES) lines.push(line)

  return lines
}
