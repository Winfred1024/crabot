import { describe, it, expect } from 'vitest'
import { PromptManager } from '../src/prompt-manager.js'

describe('PromptManager.assembleAgentPrompt 委派', () => {
  const pm = new PromptManager()

  it('私聊版包含核心段', () => {
    const prompt = pm.assembleAgentPrompt({ isGroup: false, goalModeEnabled: true })
    expect(prompt).toContain('## 你是 Crabot 的大脑')
    expect(prompt).toContain('## 工作流')
    expect(prompt).not.toContain('stay_silent')
  })

  // 注：Task 3 后 buildWorkflow 不再按 isGroup 分支，group/private 共用 workflow。
  it('群聊版同样不含 stay_silent', () => {
    const prompt = pm.assembleAgentPrompt({ isGroup: true, goalModeEnabled: true })
    expect(prompt).not.toContain('stay_silent')
  })

})
