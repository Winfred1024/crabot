import { describe, it, expect } from 'vitest'
import { CRABOT_BRAIN_IDENTITY } from '../../src/prompts/agent-sections.js'

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

  it('保留 specification gaming 命名出处', () => {
    expect(CRABOT_BRAIN_IDENTITY).toContain('证据')
  })
})
