import { describe, it, expect } from 'vitest'
import { PromptManager } from '../src/prompt-manager.js'

// PromptManager.assembleWorkerPrompt() 会把 WORKER_RULES 内嵌到 system prompt，
// 通过 public API 间接断言 WORKER_RULES 内容（保持 WORKER_RULES 为模块私有）。
function getWorkerPrompt(): string {
  const pm = new PromptManager()
  return pm.assembleWorkerPrompt({})
}

describe('Worker prompt 改造（finalize redesign）', () => {
  it('不再包含 "末尾必填 JSON 块" 契约段', () => {
    const prompt = getWorkerPrompt()
    expect(prompt).not.toMatch(/最终回复的【最后一段】，必须是一个 fenced JSON 块/)
    expect(prompt).not.toMatch(/process_highlights 是干什么的/)
  })

  it('删除 "完成任务后直接输出最终结果；结果会自动回复给用户" 这条 outdated 规则', () => {
    const prompt = getWorkerPrompt()
    expect(prompt).not.toMatch(/结果会自动回复给用户.*不需要额外调用 send_message/)
  })

  it('删除 "已发送的即时回复" 提示行', () => {
    const prompt = getWorkerPrompt()
    expect(prompt).not.toMatch(/已发送的即时回复/)
  })

  it('包含新的 send_message intent 使用说明', () => {
    const prompt = getWorkerPrompt()
    // 提到 send_message
    expect(prompt).toMatch(/send_message/)
    // 提到 intent 的两个值
    expect(prompt).toMatch(/intent.*['"]?ask_human['"]?/)
    expect(prompt).toMatch(/intent.*['"]?normal['"]?/)
  })

  it('包含 "任务结束后会要求反思总结" 说明', () => {
    const prompt = getWorkerPrompt()
    expect(prompt).toMatch(/反思|总结|结束后/)
  })
})
