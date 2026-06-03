import { describe, it, expect } from 'vitest'
import { buildEventSubscriptionUrl, buildEventSubscriptionGuide } from '../src/onboard.js'
import { SUBSCRIBED_EVENTS } from '../src/feishu-channel.js'

describe('buildEventSubscriptionUrl', () => {
  it('builds feishu event subscription deep link', () => {
    const url = buildEventSubscriptionUrl('cli_abc123', 'feishu')
    expect(url).toBe('https://open.feishu.cn/app/cli_abc123/event')
  })

  it('builds lark event subscription deep link (international)', () => {
    const url = buildEventSubscriptionUrl('cli_abc123', 'lark')
    expect(url).toBe('https://open.larksuite.com/app/cli_abc123/event')
  })
})

describe('buildEventSubscriptionGuide', () => {
  it('exposes all SUBSCRIBED_EVENTS as the events list', () => {
    const guide = buildEventSubscriptionGuide('cli_x', 'feishu')
    expect(guide.events).toEqual(SUBSCRIBED_EVENTS)
  })

  it('url uses correct host per domain', () => {
    const f = buildEventSubscriptionGuide('cli_x', 'feishu')
    const l = buildEventSubscriptionGuide('cli_x', 'lark')
    expect(f.url).toContain('open.feishu.cn')
    expect(l.url).toContain('open.larksuite.com')
  })

  it('extra_instructions has 3 zh-CN tips covering manual-add / scope-vs-events / must-publish-version', () => {
    const guide = buildEventSubscriptionGuide('cli_x', 'feishu')
    expect(guide.extra_instructions).toHaveLength(3)
    expect(guide.extra_instructions![0]).toContain('接收消息')
    expect(guide.extra_instructions![1]).toContain('scope')
    expect(guide.extra_instructions![1]).toContain('事件订阅')
    expect(guide.extra_instructions![2]).toContain('发版')
  })
})
