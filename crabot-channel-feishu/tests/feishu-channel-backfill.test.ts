/**
 * FeishuChannel backfill_history 测试
 *
 * 覆盖：
 * - 群 session 才能 backfill；private session 抛 INVALID_ARGUMENT
 * - dedup：已有 platform_message_id 跳过
 * - max_count 上限：超过即停止分页
 * - has_more：飞书还有更多分页时返回 true
 * - 并发互斥：同 session 第二次调用抛 CONFLICT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Domain: { Feishu: 'feishu', Lark: 'lark' },
    Client: class MockLarkClient {
      im = {}
      contact = { v3: { user: {} } }
      request = vi.fn()
    },
    WSClient: class MockWSClient {
      start() { return Promise.resolve() }
      close() { return Promise.resolve() }
    },
    EventDispatcher: class MockEventDispatcher {
      register() { return this }
    },
  }
})

import { FeishuChannel } from '../src/feishu-channel.js'

interface BackfillResult {
  session_id: string
  backfilled_count: number
  skipped_count: number
  has_more: boolean
  oldest_ts?: string
  newest_ts?: string
}

interface ChannelInternals {
  client: {
    listMessages: (...args: unknown[]) => Promise<{ items: Array<Record<string, unknown>>; page_token?: string; has_more: boolean }>
  }
  sessionManager: {
    upsertGroupSessionFromSnapshot: (p: { platform_session_id: string; title: string; participants: Array<{ platform_user_id: string; role: 'member' }> }) => { session: { id: string }; created: boolean }
    upsert: (p: { platform_session_id: string; type: 'private'; title: string; sender_id: string; sender_name: string }) => { session: { id: string }; created: boolean }
  }
  backfillHistory: (params: { session_id: string; max_count?: number; after?: string; before?: string }) => Promise<BackfillResult>
}

let tmpDir: string
let channel: FeishuChannel

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-backfill-'))
  channel = new FeishuChannel({
    module_id: 'feishu-test',
    module_type: 'channel',
    version: '0.0.1',
    protocol_version: '0.1.0',
    port: 0,
    data_dir: tmpDir,
    feishu: {
      app_id: 'a',
      app_secret: 's',
      domain: 'feishu',
      only_respond_to_mentions: true,
      markdown_format: 'auto',
    },
  })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeFeishuMsg(id: string, text: string, createTimeMs: number) {
  return {
    message_id: id,
    msg_type: 'text',
    create_time: String(createTimeMs),
    sender: { id: 'ou_alice' },
    body: { content: JSON.stringify({ text }) },
  }
}

describe('FeishuChannel.backfillHistory', () => {
  it('单聊 session 抛 INVALID_ARGUMENT，飞书 listMessages 不被调用', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsert({
      platform_session_id: 'ou_alice',
      type: 'private',
      title: 'Alice',
      sender_id: 'ou_alice',
      sender_name: 'Alice',
    })
    const listMessages = vi.fn()
    internals.client = { listMessages } as never

    await expect(internals.backfillHistory({ session_id: session.id })).rejects.toThrow(/group sessions/i)
    expect(listMessages).not.toHaveBeenCalled()
  })

  it('回填飞书返回的全部消息，单次内 dedup 已存在的 platform_message_id', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat1',
      title: '产品群',
      participants: [],
    })

    // 已有一条消息 m1，飞书返回 [m1, m2, m3]
    await (channel as unknown as { messageStore: { append: (sid: string, m: unknown) => Promise<void> } }).messageStore.append(session.id, {
      direction: 'inbound',
      platform_message_id: 'm1',
      sender: { platform_user_id: 'ou_alice', platform_display_name: 'Alice' },
      content: { type: 'text', text: 'old m1' },
      features: { is_mention_crab: false },
      platform_timestamp: new Date(1_700_000_000_000).toISOString(),
    })

    internals.client = {
      listMessages: vi.fn().mockResolvedValueOnce({
        items: [
          makeFeishuMsg('m1', 'old m1', 1_700_000_000_000),
          makeFeishuMsg('m2', 'new m2', 1_700_000_010_000),
          makeFeishuMsg('m3', 'new m3', 1_700_000_020_000),
        ],
        has_more: false,
      }),
    } as never

    const result = await internals.backfillHistory({ session_id: session.id, max_count: 100 })

    expect(result.backfilled_count).toBe(2)
    expect(result.skipped_count).toBe(1)
    expect(result.has_more).toBe(false)
    expect(result.oldest_ts).toBe(new Date(1_700_000_010_000).toISOString())
    expect(result.newest_ts).toBe(new Date(1_700_000_020_000).toISOString())
  })

  it('达到 max_count 上限时停止分页', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat2',
      title: '产品群',
      participants: [],
    })

    internals.client = {
      listMessages: vi.fn().mockResolvedValueOnce({
        items: [
          makeFeishuMsg('m1', 't1', 1_700_000_000_000),
          makeFeishuMsg('m2', 't2', 1_700_000_001_000),
          makeFeishuMsg('m3', 't3', 1_700_000_002_000),
        ],
        page_token: 'next',
        has_more: true,
      }),
    } as never

    const result = await internals.backfillHistory({ session_id: session.id, max_count: 2 })

    expect(result.backfilled_count).toBe(2)
    expect(result.has_more).toBe(true)
    // 第二页不应该被请求（命中 max_count 即停）
    expect((internals.client.listMessages as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('飞书 has_more=true 时返回 has_more', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat3',
      title: '产品群',
      participants: [],
    })
    internals.client = {
      listMessages: vi.fn()
        .mockResolvedValueOnce({
          items: [makeFeishuMsg('m1', 't1', 1_700_000_000_000)],
          page_token: 'next',
          has_more: true,
        })
        .mockResolvedValueOnce({
          items: [makeFeishuMsg('m2', 't2', 1_700_000_001_000)],
          has_more: false,
        }),
    } as never

    const result = await internals.backfillHistory({ session_id: session.id, max_count: 500 })

    expect(result.backfilled_count).toBe(2)
    expect(result.has_more).toBe(false)
  })

  it('同 session 并发调用第二次抛 CONFLICT', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat4',
      title: '产品群',
      participants: [],
    })

    let resolveFirstCall: (v: { items: never[]; has_more: boolean }) => void = () => {}
    const listMessagesCalled = new Promise<void>((readyResolve) => {
      internals.client = {
        listMessages: vi.fn().mockImplementation(
          () => new Promise((resolve) => {
            resolveFirstCall = resolve
            readyResolve()
          })
        ),
      } as never
    })

    const first = internals.backfillHistory({ session_id: session.id })
    // 等第一次调用真正跑到 await client.listMessages
    await listMessagesCalled

    await expect(internals.backfillHistory({ session_id: session.id })).rejects.toThrow(/in progress/i)

    resolveFirstCall({ items: [], has_more: false })
    await first
  })
})
