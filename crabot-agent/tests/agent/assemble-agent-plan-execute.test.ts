import { describe, it, expect } from 'vitest'
import { assembleAgentPrompt } from '../../src/prompts/assemble-agent.js'

describe('assembleAgentPrompt — PLAN_AND_EXECUTE_GUIDE 注入', () => {
  it('hasCodePlanner=true 时含引导段', () => {
    const out = assembleAgentPrompt({ isGroup: false, hasCodePlanner: true })
    expect(out).toContain('## Plan-and-Execute 协作模式')
    expect(out).toContain('code_planner')
    expect(out).toContain('code_writer')
  })

  it('hasCodePlanner=false 时不含引导段', () => {
    const out = assembleAgentPrompt({ isGroup: false, hasCodePlanner: false })
    expect(out).not.toContain('## Plan-and-Execute 协作模式')
  })

  it('hasCodePlanner 缺省时不含引导段（向后兼容）', () => {
    const out = assembleAgentPrompt({ isGroup: false })
    expect(out).not.toContain('## Plan-and-Execute 协作模式')
  })

  it('引导段位置：在 ## 工作流 之后', () => {
    const out = assembleAgentPrompt({ isGroup: false, hasCodePlanner: true })
    const idxFlow = out.indexOf('## 工作流')
    const idxGuide = out.indexOf('## Plan-and-Execute 协作模式')
    expect(idxFlow).toBeLessThan(idxGuide)
    expect(idxFlow).toBeGreaterThan(-1)
    expect(idxGuide).toBeGreaterThan(-1)
  })
})
