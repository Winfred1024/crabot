/**
 * Worker trigger prompt 的"活跃任务"段渲染。
 *
 * 从 agent-handler.buildTriggerUserPrompt 抽出成 pure function，便于单测验证
 * SELF marker / 分组渲染等行为不破。
 *
 * **设计要点（直接关系信任）**：
 *
 * a. **SELF marker** — 当前 worker loop 正在跑的 task 在列表里追加 `【本任务】`。
 *    没这个标记时，agent 容易把"自己当前 task running"误识别成"用户问的某条
 *    历史 task 还活着"，于是凭空汇报"任务还在运行中"（实际是它自己刚被建出来）。
 *
 * b. **分组规则**（按当前 session / 其他 channel / scheduled 三档）只在有多
 *    分组实际产生条目时才打三级标题；单组场景直接平铺，避免私聊里只有一条
 *    任务还要顶一个 `### 当前对话对象的任务（1 条）` 标题。
 *
 * c. **waiting_human 的 pending_question 不全文塞进 prompt**——只标一句话提示
 *    "状态=waiting_human，详情用 get_task_progress 取"，避免一条任务把 prompt
 *    撑出几十行。LLM 真要看完整问题再调工具。
 *
 * d. **"已结束任务在另一入口" 提示挪去 system prompt**（每次 prompt 都重复
 *    这段太浪费 token，且属于系统级行为约束而非数据展示注释）。
 *
 * e. **Dispatcher 不复用本函数**。dispatcher 自身不是 task，没有"本任务"概念；
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
  /** 是否群聊——影响"当前对话对象的任务"标题文案。 */
  readonly isGroup: boolean
  /** 渲染 live 子段时格式化时间用。 */
  readonly timezone: string
  /** 渲染 live 子段时算 elapsed 用。 */
  readonly now: Date
}

export function renderActiveTasksSection(input: RenderActiveTasksInput): string[] {
  const { activeTasks, currentTaskId, currentChannel, currentSession, isMaster, isGroup, timezone, now } = input
  const lines: string[] = []

  lines.push('\n## 活跃任务')

  if (activeTasks.length === 0) {
    lines.push('（无）')
    return lines
  }

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
      // 不全文渲染 pending_question——避免把 prompt 撑出几十行。
      // LLM 真要看完整问题，调 get_task_progress(task_id) 拉。
      out.push(`  正在等待人类回答（详情调 \`get_task_progress("${t.task_id}")\` 取）`)
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

  // 三组里 master 视角能看到全部，普通对话只看当前组。
  const visibleOther = isMaster ? otherTasks : []
  const visibleScheduled = isMaster ? scheduledTasks : []
  const groupCount = (currentTasks.length > 0 ? 1 : 0)
    + (visibleOther.length > 0 ? 1 : 0)
    + (visibleScheduled.length > 0 ? 1 : 0)
  // 只有一组时省略三级标题，直接平铺
  const flatten = groupCount <= 1

  if (currentTasks.length > 0) {
    if (!flatten) {
      const label = isGroup ? '当前群聊的任务' : '当前对话的任务'
      lines.push(`\n### ${label}（${currentTasks.length} 条）`)
    }
    for (const t of currentTasks) lines.push(...renderTask(t, false))
  }

  if (visibleOther.length > 0) {
    if (!flatten) lines.push(`\n### 其他对话场景的任务（${visibleOther.length} 条）`)
    for (const t of visibleOther) lines.push(...renderTask(t, true))
  }

  if (visibleScheduled.length > 0) {
    if (!flatten) lines.push(`\n### schedule 触发任务（${visibleScheduled.length} 条）`)
    for (const t of visibleScheduled) lines.push(...renderTask(t, false))
  }

  if (visibleScheduled.length > 0) {
    lines.push('\n**带 [定时/巡检任务，禁止 supplement] 标签的任务由 dispatcher 在 spawn 前过滤；如果它出现在本列表里，说明它仍可被查询，但不会接收 supplement**。')
  }

  return lines
}
