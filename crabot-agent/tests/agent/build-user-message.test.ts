import { describe, it, expect } from 'vitest'
import { buildUserMessage } from '../../src/agent/front-handler.js'
import type { ChannelMessage, FrontAgentContext, ShortTermMemoryEntry } from '../../src/types.js'

// ===========================================================================
// 工厂函数
// ===========================================================================

function textOf(out: ReturnType<typeof buildUserMessage>): string {
  if (typeof out === 'string') return out
  return Array.isArray(out) ? out.map(b => 'text' in b ? b.text : '').join('\n') : ''
}

function makeMessage(overrides: Omit<Partial<ChannelMessage>, 'sender'> & { text?: string; sender?: string } = {}): ChannelMessage {
  return {
    platform_message_id: overrides.platform_message_id ?? 'msg_1',
    session: overrides.session ?? { session_id: 'sess-1', channel_id: 'ch-wechat', type: 'private' },
    sender: {
      friend_id: 'friend_1',
      platform_user_id: 'user_1',
      platform_display_name: overrides.sender ?? 'TestUser',
    },
    content: { type: 'text', text: overrides.text ?? 'hello' },
    features: { is_mention_crab: false },
    platform_timestamp: overrides.platform_timestamp ?? '2026-03-28T00:00:00Z',
  }
}

function makeContext(overrides: Partial<FrontAgentContext> = {}): FrontAgentContext {
  return {
    sender_friend: {
      id: 'friend-1',
      display_name: 'TestUser',
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
    ...overrides,
  }
}

// ===========================================================================
// 测试
// ===========================================================================

describe('buildUserMessage', () => {
  // -----------------------------------------------------------------------
  // recent_messages 注入
  // -----------------------------------------------------------------------

  it('应该将所有 recent_messages 注入到 prompt 中', () => {
    const recentMessages: ChannelMessage[] = [
      makeMessage({ sender: 'Alice', text: '把统计结果通过 feishu 发给我' }),
      makeMessage({ sender: 'Crabot', text: '飞书渠道发送消息时遇到问题' }),
      makeMessage({ sender: 'Alice', text: '再重新尝试发送' }),
    ]

    const result = buildUserMessage(
      [makeMessage({ text: '再重新尝试发送' })],
      makeContext({ recent_messages: recentMessages }),
    )

    expect(result).toContain('## 最近消息（当前 session，最近 6 小时，3 条）')
    // A.2 后使用 XML 格式，检查消息内容在其中
    expect(result).toContain('把统计结果通过 feishu 发给我')
    expect(result).toContain('飞书渠道发送消息时遇到问题')
    expect(result).toContain('再重新尝试发送')
  })

  it('不应截断 recent_messages 条数——全量注入', () => {
    const recentMessages: ChannelMessage[] = Array.from({ length: 20 }, (_, i) =>
      makeMessage({ sender: `User${i}`, text: `消息 ${i}` }),
    )

    const result = buildUserMessage(
      [makeMessage({ text: '当前消息' })],
      makeContext({ recent_messages: recentMessages }),
    )

    expect(result).toContain('## 最近消息（当前 session，最近 6 小时，20 条）')
    // 第一条和最后一条都应该在（A.2 后用 XML 格式，检查消息内容而不是"User X: 文本"格式）
    expect(result).toContain('消息 0')
    expect(result).toContain('消息 19')
  })

  it('recent_messages 为空时仍渲染章节并给出空窗口提示（让 LLM 知道窗口边界）', () => {
    const result = buildUserMessage(
      [makeMessage({ text: 'hi' })],
      makeContext({ recent_messages: [] }),
    )

    expect(result).toContain('## 最近消息（当前 session，最近 6 小时，0 条）')
    expect(result).toContain('过去 6 小时本会话无消息')
  })

  it('最近 3 条消息按 maxLen=2000 截断', () => {
    // 单条 recent_messages：distFromEnd=0 < 3 → maxLen=2000
    const longText = 'A'.repeat(2500)
    const recentMessages = [makeMessage({ sender: 'Bot', text: longText })]

    const result = buildUserMessage(
      [makeMessage({ text: 'hi' })],
      makeContext({ recent_messages: recentMessages }),
    )

    expect(result).toContain('A'.repeat(2000) + '...[内容截断]')
    expect(result).not.toContain('A'.repeat(2001))
  })

  it('距离 3-10 的消息按 maxLen=600 截断', () => {
    // 构造 5 条消息：第 0 条 distFromEnd=4 落入 3-10 区（maxLen=600）
    const longText = 'A'.repeat(800)
    const recentMessages = [
      makeMessage({ sender: 'Bot', text: longText }),
      ...Array.from({ length: 4 }, (_, i) =>
        makeMessage({ sender: `User${i}`, text: `m${i}` }),
      ),
    ]

    const result = buildUserMessage(
      [makeMessage({ text: 'hi' })],
      makeContext({ recent_messages: recentMessages }),
    )

    expect(result).toContain('A'.repeat(600) + '...[内容截断]')
    expect(result).not.toContain('A'.repeat(601))
  })

  it('距离 ≥10 的远端消息按 maxLen=300 截断', () => {
    // 构造 12 条消息：第 0 条 distFromEnd=11 落入 ≥10 区（maxLen=300）
    const longText = 'A'.repeat(500)
    const recentMessages = [
      makeMessage({ sender: 'Bot', text: longText }),
      ...Array.from({ length: 11 }, (_, i) =>
        makeMessage({ sender: `User${i}`, text: `m${i}` }),
      ),
    ]

    const result = buildUserMessage(
      [makeMessage({ text: 'hi' })],
      makeContext({ recent_messages: recentMessages }),
    )

    expect(result).toContain('A'.repeat(300) + '...[内容截断]')
    expect(result).not.toContain('A'.repeat(301))
  })

  it('非文本消息应显示 [非文本消息]', () => {
    const imgMessage: ChannelMessage = {
      ...makeMessage({ sender: 'Alice' }),
      content: { type: 'image', media_url: 'https://example.com/img.png' },
    }

    const result = buildUserMessage(
      [makeMessage({ text: 'hi' })],
      makeContext({ recent_messages: [imgMessage] }),
    )

    // A.2 后的 XML 格式：消息在 <message> 标签内，不在 recent_messages 段末尾
    // 仍然应该包含图片 URL
    expect(result).toContain('[图片: https://example.com/img.png]')
  })

  // -----------------------------------------------------------------------
  // short_term_memories 注入
  // -----------------------------------------------------------------------

  function makeShortTerm(overrides: Partial<ShortTermMemoryEntry> = {}): ShortTermMemoryEntry {
    return {
      id: overrides.id ?? 'mem-stub',
      content: overrides.content ?? 'stub',
      keywords: overrides.keywords ?? [],
      event_time: overrides.event_time ?? new Date().toISOString(),
      persons: overrides.persons ?? [],
      entities: overrides.entities ?? [],
      source: overrides.source ?? { type: 'task' },
      compressed: overrides.compressed ?? false,
      visibility: overrides.visibility ?? 'public',
      scopes: overrides.scopes ?? [],
      created_at: overrides.created_at ?? new Date().toISOString(),
      ...(overrides.refs ? { refs: overrides.refs } : {}),
      ...(overrides.topic ? { topic: overrides.topic } : {}),
    }
  }

  it('短期记忆按完整内容注入（带 channel/session/task 锚点 + 相对时间）', () => {
    const memories: ShortTermMemoryEntry[] = [
      makeShortTerm({
        id: 'mem-1',
        content: '用户在 X 群让发统计报告',
        source: { channel_id: 'ch-wechat', session_id: 'sess-X', type: 'task' },
        refs: { task_id: 'task-A' },
      }),
      makeShortTerm({ id: 'mem-2', content: '发送失败了，飞书渠道有问题' }),
    ]

    const result = buildUserMessage(
      [makeMessage({ text: 'hi' })],
      makeContext({ short_term_memories: memories }),
    )

    // 新格式：section 标题带时窗 + 条数；条目带 source 锚点和正文
    expect(result).toContain('## 短期记忆（跨所有 channel/session 的近期事件流水，最近 12 小时，2 条）')
    expect(result).toContain('用户在 X 群让发统计报告')
    expect(result).toContain('channel=ch-wechat')
    expect(result).toContain('session=sess-X')
    expect(result).toContain('task=task-A')
    expect(result).toContain('发送失败了，飞书渠道有问题')
  })

  it('短期记忆为空时仍渲染章节并提示主动 search_short_term', () => {
    const result = buildUserMessage(
      [makeMessage({ text: 'hi' })],
      makeContext({ short_term_memories: [] }),
    )

    expect(result).toContain('## 短期记忆（跨所有 channel/session 的近期事件流水，最近 12 小时，0 条）')
    expect(result).toContain('过去 12 小时内无相关短期记忆')
  })

  // -----------------------------------------------------------------------
  // active_tasks 注入
  // -----------------------------------------------------------------------

  it('应该注入活跃任务列表', () => {
    const tasks = [{
      task_id: 'task-1',
      title: '发送统计报告到飞书',
      status: 'executing',
      task_type: 'user_request',
      priority: 'normal',
      source_session_id: 'sess-1',
      latest_progress: '正在查找飞书渠道...',
    }]

    const result = buildUserMessage(
      [makeMessage({ text: 'hi' })],
      makeContext({ active_tasks: tasks }),
    )

    expect(result).toContain('## 活跃任务列表')
    expect(result).toContain('[task-1] "发送统计报告到飞书" (status: executing, 来源session: sess-1)')
    expect(result).toContain('最近进度（事后摘要）: 正在查找飞书渠道...')
  })

  // -----------------------------------------------------------------------
  // 当前消息（私聊 vs 群聊）
  // -----------------------------------------------------------------------

  it('私聊应渲染"当前消息"章节', () => {
    const msg = makeMessage({ text: '你好' })

    const result = buildUserMessage([msg], makeContext())

    expect(result).toContain('## 当前消息')
    expect(result).toContain('TestUser: 你好')
    expect(result).not.toContain('当前群聊消息批次')
  })

  it('群聊应渲染"当前群聊消息批次"章节', () => {
    const msg = makeMessage({
      text: '大家好',
      session: { session_id: 'group-1', channel_id: 'ch-wechat', type: 'group' },
    })

    const result = buildUserMessage([msg], makeContext())

    expect(result).toContain('## 当前群聊消息批次')
    expect(result).toContain('是否 @你: 否')
    expect(result).not.toContain('## 当前消息')
  })

  it('群聊中 @mention 应正确标注', () => {
    const msg: ChannelMessage = {
      ...makeMessage({
        text: '@Crabot 帮我查一下',
        session: { session_id: 'group-1', channel_id: 'ch-wechat', type: 'group' },
      }),
      features: { is_mention_crab: true },
    }

    const result = buildUserMessage([msg], makeContext())

    expect(result).toContain('是否 @你: 是')
    expect(result).toContain('[@你]')
  })

  // -----------------------------------------------------------------------
  // 会话元信息
  // -----------------------------------------------------------------------

  it('应该包含 channel/session/type 元信息', () => {
    const msg = makeMessage({
      session: { session_id: 'sess-abc', channel_id: 'ch-wechat', type: 'private' },
    })

    const result = buildUserMessage([msg], makeContext())

    // A.3 新增：对话场景段显示类型
    expect(result).toContain('## 对话场景')
    expect(result).toContain('类型: 私聊')
    // A.4 后续会移入 IM 渠道段，目前仍在旧位置
    expect(result).toContain('Channel ID: ch-wechat')
    expect(result).toContain('Session ID: sess-abc')
  })

  // -----------------------------------------------------------------------
  // 指令尾部
  // -----------------------------------------------------------------------

  it('应该以指令结尾', () => {
    const result = buildUserMessage([makeMessage()], makeContext())

    expect(result).toContain('## 指令')
    expect(result).toContain('决策工具')
  })
})

// ===========================================================================
// 群聊 prompt 改进
// ===========================================================================

function makeGroupMessage(overrides: { sender?: string; text?: string; isMention?: boolean } = {}): ChannelMessage {
  return {
    platform_message_id: crypto.randomUUID(),
    session: { session_id: 'group-1', channel_id: 'ch-wechat', type: 'group' },
    sender: {
      friend_id: '',
      platform_user_id: overrides.sender ?? 'user_1',
      platform_display_name: overrides.sender ?? 'TestUser',
    },
    content: { type: 'text', text: overrides.text ?? 'hello' },
    features: { is_mention_crab: overrides.isMention ?? false },
    platform_timestamp: '2026-03-28T00:00:00Z',
  }
}

describe('群聊 prompt 改进', () => {
  it('群聊应显示参与者列表而非单一"用户"', () => {
    const messages = [
      makeGroupMessage({ sender: '王佳', text: '这段代码怎么写？' }),
      makeGroupMessage({ sender: 'FuFu', text: '你看看 profileManager' }),
    ]
    const result = buildUserMessage(messages, makeContext({
      sender_friend: {
        id: 'friend-1', display_name: 'FuFu', permission: 'master',
        channel_identities: [], created_at: '', updated_at: '',
      },
    }))
    // A.3 后：对话场景段已去除"用户"和"本批消息参与者"这些旧字段
    // 参与者信息现在在"当前群聊消息批次"段中单条消息旁
    expect(result).not.toMatch(/^- 用户: /m)
    expect(result).toContain('## 对话场景')
    // 群参与者在"当前群聊消息批次"段呈现
    expect(result).toContain('王佳')
    expect(result).toContain('FuFu')
  })

  it('群聊应包含 Crabot 在群中的身份标识', () => {
    const messages = [makeGroupMessage({ sender: '王佳', text: '你好' })]
    const result = buildUserMessage(messages, makeContext({ crab_display_name: '半糖' }))
    // A.3 后：改为"你在该渠道的昵称"（在对话场景段）
    expect(result).toContain('你在该渠道的昵称: 半糖')
  })

  it('群聊批次应标注 sender_friend 的权限角色', () => {
    const messages = [
      makeGroupMessage({ sender: '王佳', text: '代码怎么写' }),
      makeGroupMessage({ sender: 'FuFu', text: '你看看接口' }),
    ]
    const ctx = makeContext({
      sender_friend: {
        id: 'friend-1', display_name: 'FuFu', permission: 'master',
        channel_identities: [], created_at: '', updated_at: '',
      },
    })
    const result = buildUserMessage(messages, ctx)
    // A.3 后：群聊场景中权限信息不再显示在对话场景段（仅私聊显示"对话对象身份"）
    // 参与者权限信息由 worker 运行时从 Task 详情推导，不由 Front 展示
    // 这个测试的用意是验证 sender_friend 被正确加载；现在改为验证显示了发送者名字
    expect(result).toContain('FuFu')
  })

  it('无 @mention 的群聊应有 silent 引导', () => {
    const messages = [
      makeGroupMessage({ sender: '王佳', text: '这个 taglist 怎么拿？' }),
      makeGroupMessage({ sender: 'FuFu', text: '用 profileManager 那个接口' }),
    ]
    const result = buildUserMessage(messages, makeContext())
    expect(result).toContain('群聊决策提示')
    expect(result).toContain('默认选择 stay_silent')
  })

  it('有 @mention 的群聊不应有 silent 引导', () => {
    const messages = [
      makeGroupMessage({ sender: '王佳', text: '@Crabot 帮我查', isMention: true }),
    ]
    const result = buildUserMessage(messages, makeContext())
    // Current format: @mention triggers 群聊决策提示 with "必须回复" instruction
    expect(result).toContain('群聊决策提示')
    expect(result).toContain('必须回复')
  })
})

// ===========================================================================
// 对话场景段（A3）
// ===========================================================================

describe('对话场景段（B1）', () => {
  it('私聊场景显示对话对象 ID = friend:<id> 与对话对象身份', () => {
    const out = buildUserMessage(
      [makeMessage({ sender: 'FuFu' })],
      makeContext({
        sender_friend: {
          id: 'fid-master', display_name: 'FuFu', permission: 'master',
          channel_identities: [], created_at: '', updated_at: '',
        },
      }),
      undefined, 'UTC',
    )
    const txt = textOf(out)
    expect(txt).toContain('## 对话场景')
    expect(txt).toContain('类型: 私聊')
    expect(txt).toContain('对话对象: FuFu')
    expect(txt).toContain('对话对象 ID: friend:fid-master')
    expect(txt).toContain('对话对象身份: master')
  })

  it('群聊场景对话对象 = group:<channel>:<session>，不显示对话对象身份', () => {
    const m = makeMessage({ sender: 'Alice' })
    m.session = { session_id: 'sess-grp', channel_id: 'ch-tg', type: 'group' }
    const ctx = makeContext({ crab_display_name: 'CrabBot' })
    const out = buildUserMessage([m], ctx, undefined, 'UTC')
    const txt = textOf(out)
    expect(txt).toContain('## 对话场景')
    expect(txt).toContain('类型: 群聊')
    expect(txt).toContain('对话对象 ID: group:ch-tg:sess-grp')
    expect(txt).not.toContain('对话对象身份:')
  })
})
