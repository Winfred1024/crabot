/**
 * ChatManager.handleSendMessage（admin-web 伪 channel 入口）单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { ChatManager } from './chat-manager.js'

const TEST_DATA_DIR = './test-data/chat-manager-send-test'

function makeManager(): ChatManager {
  return new ChatManager(
    TEST_DATA_DIR,
    { call: async () => ({}) } as never,
    async () => 0,
    'test-secret',
    async () => ({ sub: 'admin' }),
  )
}

describe('ChatManager.handleSendMessage', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('text 消息：落库 assistant 消息并返回 id/时间戳', async () => {
    const mgr = makeManager()
    const result = await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: '任务完成，结果如下…' },
    })
    expect(result.platform_message_id).toBeTruthy()
    expect(result.sent_at).toBeTruthy()

    const stored = mgr.getMessages(10)
    expect(stored).toHaveLength(1)
    expect(stored[0].role).toBe('assistant')
    expect(stored[0].content).toBe('任务完成，结果如下…')
  })

  it('未知 session_id 抛错且不落库', async () => {
    const mgr = makeManager()
    await expect(
      mgr.handleSendMessage({ session_id: 'wechat-xyz', content: { type: 'text', text: 'hi' } })
    ).rejects.toThrow(/Unknown chat session/)
    expect(mgr.getMessages(10)).toHaveLength(0)
  })

  it('image 内容降级为文本占位（Phase 1 不支持媒体显示）', async () => {
    const mgr = makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'image', media_url: 'http://x/y.png', filename: 'y.png', text: '截图说明' },
    })
    const stored = mgr.getMessages(10)
    expect(stored[0].content).toContain('[图片]')
    expect(stored[0].content).toContain('y.png')
    expect(stored[0].content).toContain('截图说明')
  })

  it('空文本抛错', async () => {
    const mgr = makeManager()
    await expect(
      mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: '  ' } })
    ).rejects.toThrow(/Empty message content/)
  })

  it('持久化：新实例 loadData 后可见', async () => {
    const mgr = makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: 'persisted' },
    })
    const mgr2 = makeManager()
    await mgr2.loadData()
    expect(mgr2.getMessages(10)[0].content).toBe('persisted')
  })
})
