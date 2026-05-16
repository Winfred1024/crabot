import { describe, it, expect } from 'vitest'
import { CRABOT_BRAIN_IDENTITY, SYSTEM_DIALOGUE_BOUNDARY, WORKFLOW_PRIVATE, WORKFLOW_GROUP, SEND_MESSAGE_SPEC } from '../../src/prompts/agent-sections.js'

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
