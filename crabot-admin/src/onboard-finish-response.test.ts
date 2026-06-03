import { describe, it, expect } from 'vitest'
import { buildOnboardFinishResponse } from './onboard-finish-response.js'
import type { ModuleId } from './types.js'

describe('buildOnboardFinishResponse', () => {
  const instance = { id: 'feishu-2' as ModuleId, name: 'feishu-2' }

  it('透传 event_subscription 字段', () => {
    const eventSub = {
      url: 'https://open.feishu.cn/app/cli_x/event',
      events: [{ name: '接收消息', identifier: 'im.message.receive_v1' }],
      extra_instructions: ['必须发版'],
    }
    const resp = buildOnboardFinishResponse({
      finishResult: { env: {}, event_subscription: eventSub },
      instance,
      masterFriendId: undefined,
      masterDisplayName: undefined,
      pushSent: false,
    })
    expect(resp.event_subscription).toEqual(eventSub)
  })

  it('无 event_subscription 时 response 不包含该 key', () => {
    const resp = buildOnboardFinishResponse({
      finishResult: { env: {} },
      instance,
      masterFriendId: undefined,
      masterDisplayName: undefined,
      pushSent: false,
    })
    expect('event_subscription' in resp).toBe(false)
  })

  it('同时透传 scope_grant_url 和 event_subscription', () => {
    const resp = buildOnboardFinishResponse({
      finishResult: {
        env: {},
        scope_grant_url: 'https://scope',
        event_subscription: { url: 'https://event', events: [] },
      },
      instance,
      masterFriendId: undefined,
      masterDisplayName: undefined,
      pushSent: false,
    })
    expect(resp.scope_grant_url).toBe('https://scope')
    expect(resp.event_subscription).toEqual({ url: 'https://event', events: [] })
  })
})
