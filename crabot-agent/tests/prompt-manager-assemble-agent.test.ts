import { describe, it, expect } from 'vitest'
import { PromptManager } from '../src/prompt-manager.js'

describe('PromptManager.assembleAgentPrompt 委派', () => {
  const pm = new PromptManager()

  it('私聊版包含核心段', () => {
    const prompt = pm.assembleAgentPrompt({ isGroup: false })
    expect(prompt).toContain('## 你是 Crabot 的大脑')
    expect(prompt).toContain('## 工作流')
    expect(prompt).not.toContain('stay_silent')
  })

  it('群聊版含 stay_silent', () => {
    const prompt = pm.assembleAgentPrompt({ isGroup: true })
    expect(prompt).toContain('stay_silent(reason)')
  })

  it('旧 assembleFrontPrompt 仍然可用（兼容期）', () => {
    const old = pm.assembleFrontPrompt({ isGroup: false })
    expect(old).toContain('## 一、判别')
  })

  it('旧 assembleWorkerPrompt 仍然可用（兼容期）', () => {
    const old = pm.assembleWorkerPrompt()
    expect(old).toContain('## 一、接任')
  })
})
