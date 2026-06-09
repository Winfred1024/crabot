import { describe, it, expect } from 'vitest'
import { CRABOT_BRAIN_IDENTITY, SYSTEM_DIALOGUE_BOUNDARY, buildWorkflow, SEND_MESSAGE_SPEC, END_TURN_SELF_CHECK, TIME_AWARENESS, INFO_QUERY_GUIDE, TOOL_USAGE, TASK_HARD_CONSTRAINTS, MEMORY_STORE_GUIDE, CLOSURE_DUTIES, SLASH_AWARENESS_GUIDANCE, GOAL_MODE_DETAILS } from '../../src/prompts/agent-sections.js'

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

  it('列出系统注入信号（反思要求 + bg 通知）', () => {
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('任务结束反思要求')
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('bg entity 退出通知')
    // 超期辅助提醒已在 2026-06-03 spec 砍掉
    expect(SYSTEM_DIALOGUE_BOUNDARY).not.toContain('超期辅助提醒')
  })

  it('明确 assistant 回复给系统看', () => {
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('### assistant 回复 = 与系统对话')
    expect(SYSTEM_DIALOGUE_BOUNDARY).toContain('唯一通道是 `send_message`')
  })
})

describe('buildWorkflow', () => {
  it('contains all 4 base sections regardless of goal mode', () => {
    const off = buildWorkflow(false)
    const on = buildWorkflow(true)
    for (const seg of [off, on]) {
      expect(seg).toContain('[阅读理解]')
      expect(seg).toContain('[信息收集]')
      expect(seg).toContain('[意图澄清]')
      expect(seg).toContain('[规划与执行]')
      expect(seg).toContain('## 工作流')
    }
  })

  it('includes [目标承诺] when goalModeEnabled=true', () => {
    const result = buildWorkflow(true)
    expect(result).toContain('[目标承诺]')
    expect(result).toContain('set_task_goal(objective, acceptance_criteria)')
  })

  it('omits [目标承诺] when goalModeEnabled=false', () => {
    const result = buildWorkflow(false)
    expect(result).not.toContain('[目标承诺]')
  })

  it('[信息收集] points to research_collector as default', () => {
    const result = buildWorkflow(true)
    expect(result).toContain('research_collector')
    expect(result).toContain('信息收集类工作的默认派遣对象')
  })

  it('[规划与执行] retains code_planner + code_writer hard constraint', () => {
    const result = buildWorkflow(true)
    expect(result).toContain('code_planner')
    expect(result).toContain('code_writer')
    expect(result).toContain('禁止用 Write / Edit / Bash 直接改用户项目代码')
  })

  it('sections appear in order: 阅读理解 → 信息收集 → 意图澄清 → [目标承诺] → 规划与执行', () => {
    const result = buildWorkflow(true)
    const idxReading = result.indexOf('[阅读理解]')
    const idxCollection = result.indexOf('[信息收集]')
    const idxClarification = result.indexOf('[意图澄清]')
    const idxGoal = result.indexOf('[目标承诺]')
    const idxExecution = result.indexOf('[规划与执行]')
    expect(idxReading).toBeGreaterThan(-1)
    expect(idxCollection).toBeGreaterThan(idxReading)
    expect(idxClarification).toBeGreaterThan(idxCollection)
    expect(idxGoal).toBeGreaterThan(idxClarification)
    expect(idxExecution).toBeGreaterThan(idxGoal)
  })
})

describe('#4 send_message 工具使用规范', () => {
  it('说明 intent 字段语义', () => {
    expect(SEND_MESSAGE_SPEC).toContain('intent="info"')
    expect(SEND_MESSAGE_SPEC).toContain('intent="ask_human"')
  })

  it('开头有"唯一对外通道"铁则段，明示其他信号人类看不见', () => {
    expect(SEND_MESSAGE_SPEC).toContain('唯一')
    expect(SEND_MESSAGE_SPEC).toContain('人类完全看不见')
  })

  it('禁止 crabot 黑话直接搬给人类', () => {
    expect(SEND_MESSAGE_SPEC).toMatch(/禁止.*黑话|禁止.*audit|禁止.*criterion/)
    expect(SEND_MESSAGE_SPEC).toContain('翻译')
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
    // spec 2026-06-09 §4.1：find_task / get_task_progress 替代旧 search_traces / get_task_details 摸排路径
    expect(INFO_QUERY_GUIDE).toContain('find_task')
    expect(INFO_QUERY_GUIDE).toContain('get_task_progress')
    expect(INFO_QUERY_GUIDE).toContain('search_short_term')
    // 历史查询提示从 active-tasks-section 挪过来，必须保留"凭印象作答 = hallucination" 这条强约束
    expect(INFO_QUERY_GUIDE).toContain('不允许凭印象或上下文猜测任务状态')
    expect(INFO_QUERY_GUIDE).toContain('已结束的任务')
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

describe('#10 记忆存储指引', () => {
  it('开篇明确"不确定时不记"', () => {
    expect(MEMORY_STORE_GUIDE).toContain('## 记忆存储指引')
    expect(MEMORY_STORE_GUIDE).toContain('宁可漏记也不要制造噪声')
  })

  it('含 set_scene_profile 适用范围', () => {
    expect(MEMORY_STORE_GUIDE).toContain('set_scene_profile')
    expect(MEMORY_STORE_GUIDE).toContain('身份类稳定信息')
  })

  it('明确不属于场景画像的内容', () => {
    expect(MEMORY_STORE_GUIDE).toContain('操作类指令')
    expect(MEMORY_STORE_GUIDE).toContain('跨多个场景都适用')
  })

  it('含 store_memory 白名单 + 类型 + importance', () => {
    expect(MEMORY_STORE_GUIDE).toContain('store_memory')
    expect(MEMORY_STORE_GUIDE).toContain('fact')
    expect(MEMORY_STORE_GUIDE).toContain('lesson')
    expect(MEMORY_STORE_GUIDE).toContain('concept')
    expect(MEMORY_STORE_GUIDE).toContain('importance')
  })

  it('含 store_memory 黑名单 6 条', () => {
    expect(MEMORY_STORE_GUIDE).toContain('一次性数据快照')
    expect(MEMORY_STORE_GUIDE).toContain('时效性新闻')
    expect(MEMORY_STORE_GUIDE).toContain('调试过程中未经确认的中间假设')
  })
})

describe('#11 收尾责任', () => {
  it('含 bg entity 收尾责任', () => {
    expect(CLOSURE_DUTIES).toContain('## 收尾责任')
    expect(CLOSURE_DUTIES).toContain('ListEntities')
    expect(CLOSURE_DUTIES).toContain('永不自动 kill')
    expect(CLOSURE_DUTIES).toContain('Kill(entity_id)')
  })

  it('指引非持久场景自动 kill', () => {
    expect(CLOSURE_DUTIES).toContain('非持久场景')
    expect(CLOSURE_DUTIES).toContain('随 task 结束自动 kill')
  })

  it('含任务结束反思指引', () => {
    expect(CLOSURE_DUTIES).toContain('反思')
    expect(CLOSURE_DUTIES).toContain('正常 end_turn 即可')
    expect(CLOSURE_DUTIES).toContain('不要提前在最终回复里塞 JSON')
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

describe('#12 系统 slash 指令认知', () => {
  it('开头是 "## 系统 slash 指令认知"', () => {
    expect(SLASH_AWARENESS_GUIDANCE.startsWith('## 系统 slash 指令认知')).toBe(true)
  })
  it('列出已知 slash 清单', () => {
    expect(SLASH_AWARENESS_GUIDANCE).toContain('/认主')
    expect(SLASH_AWARENESS_GUIDANCE).toContain('/加好友')
    expect(SLASH_AWARENESS_GUIDANCE).toContain('/目标 <task-id>')
    expect(SLASH_AWARENESS_GUIDANCE).toContain('/清除目标 <task-id>')
    expect(SLASH_AWARENESS_GUIDANCE).toContain('/目标列表')
  })
  it('明确禁止 LLM 模仿 / 开头格式 + [系统响应] 格式', () => {
    expect(SLASH_AWARENESS_GUIDANCE).toContain('不要模仿')
    expect(SLASH_AWARENESS_GUIDANCE).toContain('[系统响应')
  })
})

describe('#13 目标模式指引', () => {
  it('四种 terminal status 都有对应的 agent 行为指引', () => {
    expect(GOAL_MODE_DETAILS).toContain('blocked')
    expect(GOAL_MODE_DETAILS).toContain('连续多次同样审计失败')
    expect(GOAL_MODE_DETAILS).toContain('cleared')
    expect(GOAL_MODE_DETAILS).toContain('complete / budget_limited')
  })
})
