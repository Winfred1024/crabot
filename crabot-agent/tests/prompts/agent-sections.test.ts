import { describe, it, expect } from 'vitest'
import { CRABOT_BRAIN_IDENTITY, SYSTEM_DIALOGUE_BOUNDARY, WORKFLOW_PRIVATE, WORKFLOW_GROUP, SEND_MESSAGE_SPEC, END_TURN_SELF_CHECK, TIME_AWARENESS, INFO_QUERY_GUIDE, TOOL_USAGE, TASK_HARD_CONSTRAINTS } from '../../src/prompts/agent-sections.js'

describe('#1 你是 Crabot 的大脑', () => {
  it('开头自我定位为"认知中枢"', () => {
    expect(CRABOT_BRAIN_IDENTITY).toContain('## 你是 Crabot 的大脑')
    expect(CRABOT_BRAIN_IDENTITY).toContain('Crabot 这套 AI 员工系统的认知中枢')
  })

  it('列出 Crabot 系统组成', () => {
    expect(CRABOT_BRAIN_IDENTITY).toContain('### Crabot 系统的组成')
    expect(CRABOT_BRAIN_IDENTITY).toContain('多 Channel 联通')
    expect(CRABOT_BRAIN_IDENTITY).toContain('任务系统')
    expect(CRABOT_BRAIN_IDENTITY).toContain('调度系统')
    expect(CRABOT_BRAIN_IDENTITY).toContain('记忆系统')
    expect(CRABOT_BRAIN_IDENTITY).toContain('权限系统')
    expect(CRABOT_BRAIN_IDENTITY).toContain('工具生态')
    expect(CRABOT_BRAIN_IDENTITY).toContain('自管理 CLI')
  })

  it('保留主动性 / 承诺→产物 / 事实→证据 三段', () => {
    expect(CRABOT_BRAIN_IDENTITY).toContain('### 主动性的具体表现')
    expect(CRABOT_BRAIN_IDENTITY).toContain('### 承诺 → 产物')
    expect(CRABOT_BRAIN_IDENTITY).toContain('### 事实 → 证据')
  })

  it('事实→证据 段含"缺证据就去补证据"指令', () => {
    expect(CRABOT_BRAIN_IDENTITY).toContain('缺证据就去补证据')
  })
})

describe('#2 你和 Crabot 系统的对话边界', () => {
  it('阐明只与系统对话', () => {
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('## 你和 Crabot 系统的对话边界')
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('只与 Crabot 系统对话')
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('传递者')
  })

  it('列出三种系统注入信号', () => {
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('超期辅助提醒')
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('任务结束反思要求')
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('bg entity 退出通知')
  })

  it('明确超期提醒不是完成信号', () => {
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('不是完成信号')
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('必须继续执行主工作流')
  })

  it('明确 assistant 回复给系统看', () => {
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('### assistant 回复 = 与系统对话')
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('唯一通道是 `send_message`')
  })
})

describe('#3 工作流 · 私聊版', () => {
  it('含 turn 0 triage + supplement_task 路径', () => {
    expect(WORKFLOW_PRIVATE).toContain('[turn 0 · triage]')
    expect(WORKFLOW_PRIVATE).toContain('supplement_task(target_task_id, supplement_text)')
    expect(WORKFLOW_PRIVATE).toContain('triage 仅本轮（turn 0）有效')
  })

  it('含主工作流分支', () => {
    expect(WORKFLOW_PRIVATE).toContain('能立即回答吗？')
    expect(WORKFLOW_PRIVATE).toContain('规划 → 执行 → 核验')
    expect(WORKFLOW_PRIVATE).toContain('send_message')
  })

  it('含超期辅助机制说明', () => {
    expect(WORKFLOW_PRIVATE).toContain('[超期辅助')
    expect(WORKFLOW_PRIVATE).toContain('默认 30s')
    expect(WORKFLOW_PRIVATE).toContain('仅注入一次')
  })

  it('含复杂任务反思说明', () => {
    expect(WORKFLOW_PRIVATE).toContain('身份已转 worker')
    expect(WORKFLOW_PRIVATE).toContain('outcome_brief')
    expect(WORKFLOW_PRIVATE).toContain('process_highlights')
  })

  it('明确 supplement_task 早期退出不反思', () => {
    expect(WORKFLOW_PRIVATE).toContain('supplement_task 早期退出不反思')
  })

  it('不含 stay_silent 描述（私聊不渲染）', () => {
    expect(WORKFLOW_PRIVATE).not.toContain('stay_silent')
  })
})

describe('#3 工作流 · 群聊版', () => {
  it('含三选一 triage（stay_silent / supplement_task / 主流程）', () => {
    expect(WORKFLOW_GROUP).toContain('stay_silent(reason)')
    expect(WORKFLOW_GROUP).toContain('supplement_task')
    expect(WORKFLOW_GROUP).toContain('与我相关且不是 supplement')
  })

  it('列出必须 stay_silent 的情形', () => {
    expect(WORKFLOW_GROUP).toContain('群成员之间互相讨论')
    expect(WORKFLOW_GROUP).toContain('群成员之间一问一答')
    expect(WORKFLOW_GROUP).toContain('系统通知')
    expect(WORKFLOW_GROUP).toContain('不确定是否在叫你')
  })

  it('明确被 @你 时禁止 stay_silent', () => {
    expect(WORKFLOW_GROUP).toContain('被 [@你] 标注')
    expect(WORKFLOW_GROUP).toContain('禁止 stay_silent')
  })

  it('主工作流/超期辅助/反思 段说明引用私聊版', () => {
    expect(WORKFLOW_GROUP).toContain('与私聊一致')
  })
})

describe('#4 send_message 工具使用规范', () => {
  it('说明 intent 字段语义', () => {
    expect(SEND_MESSAGE_SPEC).toContain('intent="normal"')
    expect(SEND_MESSAGE_SPEC).toContain('intent="ask_human"')
  })

  it('要求 ask_human 结构化书写', () => {
    expect(SEND_MESSAGE_SPEC).toContain('背景一句话')
    expect(SEND_MESSAGE_SPEC).toContain('问题清单')
    expect(SEND_MESSAGE_SPEC).toContain('明示阻塞性')
  })

  it('含 ask_human 反例 + 正例', () => {
    expect(SEND_MESSAGE_SPEC).toContain('反例')
    expect(SEND_MESSAGE_SPEC).toContain('正例')
  })

  it('要求隐藏内部 ID', () => {
    expect(SEND_MESSAGE_SPEC).toContain('隐藏内部 ID')
    expect(SEND_MESSAGE_SPEC).toContain('message_id')
    expect(SEND_MESSAGE_SPEC).toContain('task_id')
  })

  it('强调 send_message 不会自动调用', () => {
    expect(SEND_MESSAGE_SPEC).toContain('必须显式调用')
  })

  it('含克制反问 4 条触发条件', () => {
    expect(SEND_MESSAGE_SPEC).toContain('信息不足以决策')
    expect(SEND_MESSAGE_SPEC).toContain('破坏性操作')
    expect(SEND_MESSAGE_SPEC).toContain('最多一个')
  })
})

describe('#5 end_turn 前的 self-check', () => {
  it('开篇明确触发条件', () => {
    expect(END_TURN_SELF_CHECK).toContain('## end_turn 前的 self-check')
    expect(END_TURN_SELF_CHECK).toContain('本 loop 内调用过 send_message')
  })

  it('含 3 类 anti-pattern', () => {
    expect(END_TURN_SELF_CHECK).toContain('Sycophancy ghost-promise')
    expect(END_TURN_SELF_CHECK).toContain('Context hallucination')
    expect(END_TURN_SELF_CHECK).toContain('Effortful synthesis displacement')
  })

  it('保留 3 个真实 trace 反例引用', () => {
    expect(END_TURN_SELF_CHECK).toContain('trace d790bbb4')
    expect(END_TURN_SELF_CHECK).toContain('trace ffdfc894')
    expect(END_TURN_SELF_CHECK).toContain('trace 26b67f2b')
  })

  it('每类 anti-pattern 含 self-check 问句', () => {
    const occurrences = (END_TURN_SELF_CHECK.match(/Self-check:/g) || []).length
    expect(occurrences).toBeGreaterThanOrEqual(3)
  })

  it('指引"不要 end_turn"作为反 pattern 后的动作', () => {
    expect(END_TURN_SELF_CHECK).toContain('不要 end_turn')
  })
})

describe('#6 时间感知', () => {
  it('说明 user message 首行的"当前时间"', () => {
    expect(TIME_AWARENESS).toContain('## 时间感知')
    expect(TIME_AWARENESS).toContain('user message 第一行的"当前时间"')
  })

  it('说明历史消息时间前缀', () => {
    expect(TIME_AWARENESS).toContain('[HH:MM]')
    expect(TIME_AWARENESS).toContain('[MM-DD HH:MM]')
  })

  it('说明 tool_result 时间戳', () => {
    expect(TIME_AWARENESS).toContain('tool_result')
    expect(TIME_AWARENESS).toContain('[HH:MM:SS]')
  })

  it('合并 Worker 版"最近 tool_result 判断现在"', () => {
    expect(TIME_AWARENESS).toContain('靠最近一条 tool_result 的时间戳判断"现在"')
  })

  it('说明任务列表时间格式', () => {
    expect(TIME_AWARENESS).toContain('创建于 HH:MM')
    expect(TIME_AWARENESS).toContain('第 N 轮')
  })
})

describe('#7 信息查询指引', () => {
  it('明确"按需查、不预注入"的指导原则', () => {
    expect(INFO_QUERY_GUIDE).toContain('## 信息查询指引')
    expect(INFO_QUERY_GUIDE).toContain('按需查')
    expect(INFO_QUERY_GUIDE).toContain('不预注入')
  })

  it('列出短期记忆必须查的情形', () => {
    expect(INFO_QUERY_GUIDE).toContain('search_short_term')
    expect(INFO_QUERY_GUIDE).toContain('用代词指代过去事件')
    expect(INFO_QUERY_GUIDE).toContain('其他 channel/session')
  })

  it('含长期记忆查询入口', () => {
    expect(INFO_QUERY_GUIDE).toContain('search_long_term')
    expect(INFO_QUERY_GUIDE).toContain('get_memory_detail')
  })

  it('含历史回溯锚点链', () => {
    expect(INFO_QUERY_GUIDE).toContain('search_traces')
    expect(INFO_QUERY_GUIDE).toContain('get_task_details')
  })

  it('含指代消歧规则', () => {
    expect(INFO_QUERY_GUIDE).toContain('指代消歧')
    expect(INFO_QUERY_GUIDE).toContain('绝不按 task title 字面术语执行')
  })

  it('明确"凭印象=hallucination"', () => {
    expect(INFO_QUERY_GUIDE).toContain('凭印象')
    expect(INFO_QUERY_GUIDE).toContain('hallucination')
  })

  it('明确检索为空 ≠ 不存在', () => {
    expect(INFO_QUERY_GUIDE).toContain('检索返回空')
    expect(INFO_QUERY_GUIDE).toContain('不等于"不存在"')
  })
})

describe('#8 工具使用规范', () => {
  it('含找群/找联系人优先顺序', () => {
    expect(TOOL_USAGE).toContain('lookup_friend')
    expect(TOOL_USAGE).toContain('list_groups')
    expect(TOOL_USAGE).toContain('list_sessions')
  })

  it('含 bg shell 使用规范 + Output 调用姿势', () => {
    expect(TOOL_USAGE).toContain('run_in_background=true')
    expect(TOOL_USAGE).toContain('push notification')
    expect(TOOL_USAGE).toContain('block=true')
  })

  it('含工具失败诊断规则', () => {
    expect(TOOL_USAGE).toContain('≥2 次同类失败')
    expect(TOOL_USAGE).toContain('禁止第 3 次重跑相同参数')
  })

  it('含 Skill 加载强制要求', () => {
    expect(TOOL_USAGE).toContain('必须')
    expect(TOOL_USAGE).toContain('Skill("')
  })

  it('含能力盲区元认知三路径', () => {
    expect(TOOL_USAGE).toContain('自助')
    expect(TOOL_USAGE).toContain('求助')
    expect(TOOL_USAGE).toContain('PERMISSION_DENIED')
  })

  it('含 Execution Bias 要点', () => {
    expect(TOOL_USAGE).toContain('mutable facts')
    expect(TOOL_USAGE).toContain('live check')
  })

  it('含 bg entity 时长分级', () => {
    expect(TOOL_USAGE).toContain('1min - 1h')
    expect(TOOL_USAGE).toContain('1h - 数天')
    expect(TOOL_USAGE).toContain('数天 - 几周')
  })
})

describe('#9 任务推进硬约束', () => {
  it('含探索/研究类任务的持续性 + 三种 anti-pattern', () => {
    expect(TASK_HARD_CONSTRAINTS).toContain('探索')
    expect(TASK_HARD_CONSTRAINTS).toContain('研究')
    expect(TASK_HARD_CONSTRAINTS).toContain('同一假设的微调')
    expect(TASK_HARD_CONSTRAINTS).toContain('凭先验驳回')
    expect(TASK_HARD_CONSTRAINTS).toContain('返工以求确认')
  })

  it('含如实报告原则', () => {
    expect(TASK_HARD_CONSTRAINTS).toContain('如实报告')
    expect(TASK_HARD_CONSTRAINTS).toContain('不要 hedge')
  })

  it('含 Blocker 优先路径', () => {
    expect(TASK_HARD_CONSTRAINTS).toContain('Blocker')
    expect(TASK_HARD_CONSTRAINTS).toContain('ask_human')
  })

  it('含 specification gaming + 五分钟头脑风暴', () => {
    expect(TASK_HARD_CONSTRAINTS).toContain('specification gaming')
    expect(TASK_HARD_CONSTRAINTS).toContain('五分钟头脑风暴')
    expect(TASK_HARD_CONSTRAINTS).toContain('DeepMind')
  })

  it('含禁止未尝试的后续方向', () => {
    expect(TASK_HARD_CONSTRAINTS).toContain('禁止未尝试的后续方向')
    expect(TASK_HARD_CONSTRAINTS).toContain('下一步可以试')
    expect(TASK_HARD_CONSTRAINTS).toContain('未来工作')
  })
})
