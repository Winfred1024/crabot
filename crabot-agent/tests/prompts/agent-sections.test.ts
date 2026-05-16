import { describe, it, expect } from 'vitest'
import { CRABOT_BRAIN_IDENTITY, SYSTEM_DIALOGUE_BOUNDARY } from '../../src/prompts/agent-sections.js'

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
