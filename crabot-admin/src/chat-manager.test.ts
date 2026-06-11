/**
 * ChatManager.handleSendMessage（admin-web 伪 channel 入口）单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ChatManager, buildChatTaskSnapshot } from './chat-manager.js'
import { MediaStore } from './media-store.js'
import type { Task } from './types.js'

const TEST_DATA_DIR = './test-data/chat-manager-send-test'

/** 创建注入 MediaStore 的 ChatManager（async） */
async function makeManager(): Promise<ChatManager> {
  const store = new MediaStore(TEST_DATA_DIR)
  await store.init()
  return new ChatManager(
    TEST_DATA_DIR,
    { call: async () => ({}) } as never,
    async () => 0,
    'test-secret',
    async () => ({ sub: 'admin' }),
    store,
  )
}

/** 创建注入可观察 rpc stub 的 ChatManager（async） */
async function makeManagerWithRpc(
  rpcCall: (port: number, method: string, params: unknown) => Promise<unknown>,
): Promise<ChatManager> {
  const store = new MediaStore(TEST_DATA_DIR)
  await store.init()
  return new ChatManager(
    TEST_DATA_DIR,
    { call: rpcCall } as never,
    async () => 42, // 非零端口，让 dispatchToAgent 正常往下走
    'test-secret',
    async () => ({ sub: 'admin' }),
    store,
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
    const mgr = await makeManager()
    const result = await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: '任务完成，结果如下…' },
    })
    expect(result.platform_message_id).toBeTruthy()
    expect(result.sent_at).toBeTruthy()

    const stored = mgr.getMessages(10)
    expect(stored).toHaveLength(1)
    expect(stored[0].role).toBe('assistant')
    expect(stored[0].content.text).toBe('任务完成，结果如下…')
  })

  it('未知 session_id 抛错且不落库', async () => {
    const mgr = await makeManager()
    await expect(
      mgr.handleSendMessage({ session_id: 'wechat-xyz', content: { type: 'text', text: 'hi' } })
    ).rejects.toThrow(/Unknown chat session/)
    expect(mgr.getMessages(10)).toHaveLength(0)
  })

  it('system_event 内容直接透出 text（不降级为媒体占位）', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'system_event', text: '成员加入：小明' },
    })
    expect(mgr.getMessages(10)[0].content.text).toBe('成员加入：小明')
  })

  it('WS send 同步抛错时推送 best-effort 吞错，不污染调用方', async () => {
    const mgr = await makeManager()
    ;(mgr as unknown as { activeClient: unknown }).activeClient = {
      readyState: 1, // WebSocket.OPEN
      send: () => { throw new Error('socket closing') },
    }
    // handleSendMessage（内部 pushToClient）与 pushTaskUpdate 都不应抛错
    await expect(
      mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: 'ok' } })
    ).resolves.toBeTruthy()
    expect(() =>
      mgr.pushTaskUpdate({ task_id: 't1' as never, status: 'executing' as never, title: 'x' })
    ).not.toThrow()
  })

  it('空文本抛错', async () => {
    const mgr = await makeManager()
    await expect(
      mgr.handleSendMessage({ session_id: 'admin-chat', content: { type: 'text', text: '  ' } })
    ).rejects.toThrow(/Empty message content/)
  })

  it('持久化：新实例 loadData 后可见', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: 'persisted' },
    })
    const mgr2 = await makeManager()
    await mgr2.loadData()
    expect(mgr2.getMessages(10)[0].content.text).toBe('persisted')
  })
})

describe('ChatMessage content 模型升级', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  it('loadData hydrate：旧 string content 升级为 {type:text,text}', async () => {
    await fs.writeFile(
      `${TEST_DATA_DIR}/chat_messages.json`,
      JSON.stringify([{ message_id: 'old-1', role: 'user', content: '旧消息', timestamp: '2026-05-19T00:00:00Z' }]),
      'utf-8'
    )
    const mgr = await makeManager()
    await mgr.loadData()
    const [msg] = mgr.getMessages(10)
    expect(msg.content).toEqual({ type: 'text', text: '旧消息' })
  })

  it('handleSendMessage 落库的 content 是 MessageContent 结构', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'text', text: '结构化' },
    })
    expect(mgr.getMessages(10)[0].content.text).toBe('结构化')
    expect(mgr.getMessages(10)[0].content.type).toBe('text')
  })
})

describe('入站带附件消息（handleInboundMessage）', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('process_message RPC 失败：消息仍落库、推 chat_error、不抛回调用方', async () => {
    const mgr = await makeManagerWithRpc(async () => {
      throw new Error('agent down')
    })
    const pushed: Array<{ type: string }> = []
    ;(mgr as unknown as { activeClient: unknown }).activeClient = {
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => { pushed.push(JSON.parse(data)) },
    }
    const result = await mgr.handleInboundMessage({
      request_id: 'req-err',
      text: '会失败的消息',
      files: [],
    })
    // user 消息已落库且正常返回（失败非原子是已登记的设计取舍）
    expect(result.message.content.text).toBe('会失败的消息')
    expect(mgr.getMessages(10)).toHaveLength(1)
    // 推送序列：chat_status processing → chat_error
    expect(pushed.map((p) => p.type)).toEqual(['chat_status', 'chat_error'])
  })

  it('文字+附件：附件落 store，落库 content 含 media[]（URL 形态），process_message 收到绝对路径版', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const mgr = await makeManagerWithRpc(async (_port: number, method: string, params: unknown) => {
      calls.push({ method, params })
      return {}
    })
    const result = await mgr.handleInboundMessage({
      request_id: 'req-1',
      text: '看下这两张图',
      files: [
        { buffer: Buffer.from('img1'), filename: 'a.png', mime_type: 'image/png' },
        { buffer: Buffer.from('img2'), filename: 'b.jpg', mime_type: 'image/jpeg' },
      ],
    })
    // 落库消息：URL 形态 media[]
    expect(result.message.content.type).toBe('image')
    expect(result.message.content.text).toBe('看下这两张图')
    expect(result.message.content.media).toHaveLength(2)
    expect(result.message.content.media![0].media_url).toMatch(/^\/api\/media\//)
    // process_message：绝对路径版 + media_url 镜像
    const pm = calls.find((c) => c.method === 'process_message')
    expect(pm).toBeTruthy()
    const sentContent = (pm!.params as { message: { content: { media: Array<{ media_url: string }>; media_url: string } } }).message.content
    expect(sentContent.media).toHaveLength(2)
    expect(path.isAbsolute(sentContent.media[0].media_url)).toBe(true)
    expect(sentContent.media_url).toBe(sentContent.media[0].media_url)
  })

  it('空文本且无附件 → 抛错', async () => {
    const mgr = await makeManager()
    await expect(mgr.handleInboundMessage({ request_id: 'r', text: ' ', files: [] })).rejects.toThrow()
  })
})

describe('出站媒体收存（handleSendMessage Phase 2）', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('file_path → 收存进 store，落库 media[] 为 store URL', async () => {
    const mgr = await makeManager()
    const src = path.join(TEST_DATA_DIR, 'shot.png')
    await fs.writeFile(src, 'png-bytes')
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'image', file_path: src, filename: 'shot.png', mime_type: 'image/png', text: '截图说明' },
    })
    const [msg] = mgr.getMessages(10)
    expect(msg.content.type).toBe('image')
    expect(msg.content.text).toBe('截图说明')
    expect(msg.content.media![0].media_url).toMatch(/^\/api\/media\//)
  })

  it('http URL → 直接存引用不下载', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'image', media_url: 'https://example.com/x.png', mime_type: 'image/png' },
    })
    expect(mgr.getMessages(10)[0].content.media![0].media_url).toBe('https://example.com/x.png')
  })

  it('收存失败（文件不存在）→ 降级为文本说明，不丢消息', async () => {
    const mgr = await makeManager()
    await mgr.handleSendMessage({
      session_id: 'admin-chat',
      content: { type: 'file', file_path: '/no/such/file.bin', filename: 'gone.bin', text: '正文' },
    })
    const [msg] = mgr.getMessages(10)
    expect(msg.content.media ?? []).toHaveLength(0)
    expect(msg.content.text).toContain('正文')
    expect(msg.content.text).toContain('gone.bin')
  })
})

describe('buildChatTaskSnapshot', () => {
  const baseTask = {
    id: 'task-1',
    status: 'executing',
    priority: 'normal',
    title: '调查 X',
    source: { trigger_type: 'message', channel_id: 'admin-web' },
    messages: [],
    tags: [],
    created_at: '2026-06-10T00:00:00Z',
    updated_at: '2026-06-10T00:00:00Z',
  } as unknown as Task

  it('无 plan：只有 task_id/status/title', () => {
    const snap = buildChatTaskSnapshot(baseTask)
    expect(snap).toEqual({ task_id: 'task-1', status: 'executing', title: '调查 X' })
  })

  it('有 plan：带当前步骤', () => {
    const task = {
      ...baseTask,
      plan: {
        goal: 'g',
        steps: [
          { id: 's1', description: '第一步', status: 'completed', retry_count: 0 },
          { id: 's2', description: '第二步', status: 'in_progress', retry_count: 0 },
        ],
        current_step_index: 1,
        created_at: '2026-06-10T00:00:00Z',
        updated_at: '2026-06-10T00:00:00Z',
      },
    } as unknown as Task
    const snap = buildChatTaskSnapshot(task)
    expect(snap.step).toEqual({ index: 1, total: 2, description: '第二步' })
  })
})
