import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FrontHandler, buildUserMessage } from '../../src/agent/front-handler.js'
import type { HandleMessageParams, FrontAgentContext, ChannelMessage } from '../../src/types.js'

// Mock runFrontLoop so we control decision output without a real LLM
vi.mock('../../src/agent/front-loop.js', () => ({
  runFrontLoop: vi.fn(),
}))

// Mock ToolExecutor constructor
vi.mock('../../src/agent/tool-executor.js', () => ({
  ToolExecutor: vi.fn().mockImplementation(() => ({})),
}))

import { runFrontLoop } from '../../src/agent/front-loop.js'

const mockRunFrontLoop = vi.mocked(runFrontLoop)

function makeMockAdapter() {
  return {
    stream: vi.fn(),
    updateConfig: vi.fn(),
  }
}

function makeFrontHandler() {
  const adapter = makeMockAdapter()
  const llmConfig = { adapter, model: 'test-model' }
  const toolDeps = {
    rpcClient: {} as any,
    moduleId: 'test',
    getAdminPort: async () => 3001,
    getActiveTasks: () => [],
    getMemoryPort: async () => 3005,
    memoryWriteVisibility: () => 'public' as const,
    memoryWriteScopes: () => [],
  }
  const config = {
    getSystemPrompt: () => 'You are helpful',
    // 测试不依赖 messaging 工具；返回空 server map 即可
    mcpConfigFactory: () => ({}),
    getTimezone: () => 'Asia/Shanghai',
  }
  return { handler: new FrontHandler(llmConfig, toolDeps, config), adapter }
}

function makeMessages(): ChannelMessage[] {
  return [
    {
      platform_message_id: 'msg_1',
      session: { session_id: 'session-1', channel_id: 'ch_1', type: 'private' },
      sender: { friend_id: 'friend_1', platform_user_id: 'user_1', platform_display_name: 'Test User' },
      content: { type: 'text', text: 'Hi' },
      features: { is_mention_crab: false },
      platform_timestamp: '2024-01-01T00:00:00Z',
    },
  ]
}

function makeContext(): FrontAgentContext {
  return {
    sender_friend: {
      id: 'friend-1',
      display_name: 'Test User',
      permission: 'master',
      channel_identities: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    recent_messages: [],
    short_term_memories: [],
    active_tasks: [],
    available_tools: [],
    time_windows: {
      recent_messages_window_hours: 6,
      short_term_memory_window_hours: 12,
    },
  }
}

describe('FrontHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('handleMessage', () => {
    it('应该解析 direct_reply 决策', async () => {
      mockRunFrontLoop.mockResolvedValue({
        decision: { type: 'direct_reply', reply: { type: 'text', text: 'Hello!' } },
      })

      const { handler } = makeFrontHandler()
      const params: HandleMessageParams = { messages: makeMessages(), context: makeContext() }
      const result = await handler.handleMessage(params)

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0].type).toBe('direct_reply')
    })

    it('应该解析 create_task 决策', async () => {
      mockRunFrontLoop.mockResolvedValue({
        decision: {
          type: 'create_task',
          task_title: 'Fix bug',
          task_description: 'Fix the login bug',
          task_type: 'user_request',
          immediate_reply: { type: 'text', text: '好的，我来处理' },
        },
      })

      const messages: ChannelMessage[] = [{
        platform_message_id: 'msg_1',
        session: { session_id: 'session-1', channel_id: 'ch_1', type: 'private' },
        sender: { friend_id: 'friend_1', platform_user_id: 'user_1', platform_display_name: 'Test User' },
        content: { type: 'text', text: 'Please fix the login bug' },
        features: { is_mention_crab: false },
        platform_timestamp: '2024-01-01T00:00:00Z',
      }]

      const { handler } = makeFrontHandler()
      const result = await handler.handleMessage({ messages, context: makeContext() })

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0].type).toBe('create_task')
      if (result.decisions[0].type === 'create_task') {
        expect(result.decisions[0].task_title).toBe('Fix bug')
      }
    })

    it('应该在 runFrontLoop 成功时正常返回决策', async () => {
      mockRunFrontLoop.mockResolvedValue({
        decision: { type: 'direct_reply', reply: { type: 'text', text: 'plain response' } },
      })

      const { handler } = makeFrontHandler()
      const result = await handler.handleMessage({ messages: makeMessages(), context: makeContext() })

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0].type).toBe('direct_reply')
    })

    it('应该调用 runFrontLoop 并传递 adapter 和 model', async () => {
      mockRunFrontLoop.mockResolvedValue({
        decision: { type: 'direct_reply', reply: { type: 'text', text: 'OK' } },
      })

      const { handler } = makeFrontHandler()
      await handler.handleMessage({ messages: makeMessages(), context: makeContext() })

      expect(mockRunFrontLoop).toHaveBeenCalled()
      const callArgs = mockRunFrontLoop.mock.calls[0][0]
      expect(callArgs).toHaveProperty('adapter')
      expect(callArgs).toHaveProperty('model', 'test-model')
    })

    it('supplement_task 候选集排除 trigger_type=scheduled 的任务', async () => {
      // 历史 bug：Front 把巡检/定时任务一并塞进 supplement_task 的候选 enum，
      // LLM 会误把用户新需求 supplement 到正在跑的巡检任务上，覆盖巡检本职。
      // 修复：context-assembler 拿到的 active_tasks 仍然全集进 prompt 渲染（让 LLM 能
      // 答"巡检在干嘛"），但喂给 supplement_task tool enum 的 activeTaskIds 必须只装
      // 非 scheduled 的 task_id——从源头砍掉 LLM 的错误选择面。
      mockRunFrontLoop.mockResolvedValue({
        decision: { type: 'direct_reply', reply: { type: 'text', text: 'OK' } },
      })

      const { handler } = makeFrontHandler()
      const context: FrontAgentContext = {
        ...makeContext(),
        active_tasks: [
          { task_id: 't_manual_1', title: '用户请求处理', status: 'executing', priority: 'normal', trigger_type: 'manual' },
          { task_id: 't_scheduled_1', title: '巡检', status: 'executing', priority: 'normal', trigger_type: 'scheduled' },
          { task_id: 't_legacy', title: '老数据无 trigger_type', status: 'executing', priority: 'normal' },
          { task_id: 't_manual_2', title: '另一个用户任务', status: 'executing', priority: 'normal', trigger_type: 'manual' },
        ],
      }

      await handler.handleMessage({ messages: makeMessages(), context })

      const callArgs = mockRunFrontLoop.mock.calls[0][0]
      // 只剩非 scheduled；trigger_type 缺失（旧数据）按非 scheduled 处理（保留）
      expect(callArgs.activeTaskIds).toEqual(['t_manual_1', 't_legacy', 't_manual_2'])
      expect(callArgs.activeTaskIds).not.toContain('t_scheduled_1')
    })

    it('应该处理错误并返回错误消息（私聊）', async () => {
      mockRunFrontLoop.mockRejectedValue(new Error('API error'))

      const { handler } = makeFrontHandler()
      const result = await handler.handleMessage({ messages: makeMessages(), context: makeContext() })

      expect(result.decisions).toHaveLength(1)
      expect(result.decisions[0].type).toBe('direct_reply')
      if (result.decisions[0].type === 'direct_reply') {
        expect(result.decisions[0].reply.text).toContain('异常')
      }
    })

    it('injects scene profile content verbatim into the front prompt', async () => {
      mockRunFrontLoop.mockResolvedValue({
        decision: { type: 'direct_reply', reply: { type: 'text', text: 'OK' } },
      })

      const { handler } = makeFrontHandler()
      const context: FrontAgentContext = {
        ...makeContext(),
        scene_profile: {
          label: '项目群',
          content: '第一行规则\n\n- 第二行原文\n### 不应被重写',
          source: {
            scene: { type: 'group_session', channel_id: 'ch_1', session_id: 'session-1' },
          },
        },
      }

      await handler.handleMessage({
        messages: [{
          ...makeMessages()[0],
          session: { session_id: 'session-1', channel_id: 'ch_1', type: 'group' },
        }],
        context,
      })

      const callArgs = mockRunFrontLoop.mock.calls[0][0]
      expect(callArgs.userMessage).toContain('## 场景画像')
      expect(callArgs.userMessage).toContain('<scene_profile label="项目群">')
      expect(callArgs.userMessage).toContain('第一行规则\n\n- 第二行原文\n### 不应被重写')
      expect(callArgs.userMessage).not.toContain('### 群职责')
    })
  })

  describe('buildUserMessage', () => {
    it('renders scene profile content without composing sections', () => {
      const message = buildUserMessage(makeMessages(), {
        ...makeContext(),
        scene_profile: {
          label: '项目群',
          content: '进入本群后先做技术支持与问题排查。',
          source: {
            scene: { type: 'group_session', channel_id: 'ch_1', session_id: 'session-1' },
          },
        },
      }, undefined, 'Asia/Shanghai')

      expect(typeof message).toBe('string')
      expect(message).toContain('进入本群后先做技术支持与问题排查。')
      expect(message).not.toContain('### ')
    })

    it('renders the scene profile block even when content is empty', () => {
      const message = buildUserMessage(makeMessages(), {
        ...makeContext(),
        scene_profile: {
          label: '空画像',
          content: '',
          source: {
            scene: { type: 'group_session', channel_id: 'ch_1', session_id: 'session-1' },
          },
        },
      }, undefined, 'Asia/Shanghai')

      expect(typeof message).toBe('string')
      expect(message).toContain('## 场景画像')
      expect(message).toContain('<scene_profile label="空画像">')
    })
  })

  describe('updateLlmConfig', () => {
    it('应该更新 adapter 配置', () => {
      const { handler, adapter } = makeFrontHandler()

      handler.updateLlmConfig({ endpoint: 'http://new-url:4000', apikey: 'new-key' })

      expect(adapter.updateConfig).toHaveBeenCalledWith({
        endpoint: 'http://new-url:4000',
        apikey: 'new-key',
      })
    })

    it('应该只更新 model 不触发 adapter.updateConfig', () => {
      const { handler, adapter } = makeFrontHandler()

      handler.updateLlmConfig({ model: 'new-model' })

      expect(adapter.updateConfig).not.toHaveBeenCalled()
    })

    it('应该同时更新 endpoint 和 model', () => {
      const { handler, adapter } = makeFrontHandler()

      handler.updateLlmConfig({ endpoint: 'http://new-url:4000', model: 'new-model' })

      expect(adapter.updateConfig).toHaveBeenCalledWith({
        endpoint: 'http://new-url:4000',
      })
    })
  })
})
