import { describe, it, expect } from 'vitest'
import {
  mergeMasterChannelIdentity,
  buildOnboardingPushMessage,
  ONBOARDING_MASTER_DEFAULT_DISPLAY_NAME,
} from './onboarding-master.js'
import type { ChannelIdentity } from './types.js'

describe('mergeMasterChannelIdentity', () => {
  it('空 identities 时直接追加新 identity 并 changed=true', () => {
    const r = mergeMasterChannelIdentity([], 'feishu-a', 'ou_owner')
    expect(r.changed).toBe(true)
    expect(r.removedIdentity).toBeUndefined()
    expect(r.identities).toEqual([
      {
        channel_id: 'feishu-a',
        platform_user_id: 'ou_owner',
        platform_display_name: ONBOARDING_MASTER_DEFAULT_DISPLAY_NAME,
      },
    ])
  })

  it('不同 channel_id 时追加，已有项不变', () => {
    const existing: ChannelIdentity[] = [
      { channel_id: 'telegram-a', platform_user_id: 'tg_123', platform_display_name: 'old' },
    ]
    const r = mergeMasterChannelIdentity(existing, 'feishu-a', 'ou_owner')
    expect(r.changed).toBe(true)
    expect(r.identities).toHaveLength(2)
    expect(r.identities[0]).toEqual(existing[0])
    expect(r.identities[1].channel_id).toBe('feishu-a')
  })

  it('同 channel_id 同 platform_user_id 幂等：changed=false 不动数组', () => {
    const existing: ChannelIdentity[] = [
      { channel_id: 'feishu-a', platform_user_id: 'ou_owner', platform_display_name: '某主人' },
    ]
    const r = mergeMasterChannelIdentity(existing, 'feishu-a', 'ou_owner')
    expect(r.changed).toBe(false)
    expect(r.removedIdentity).toBeUndefined()
    expect(r.identities).toEqual(existing)
  })

  it('同 channel_id 但 platform_user_id 不同：覆盖且返回 removedIdentity', () => {
    const existing: ChannelIdentity[] = [
      { channel_id: 'feishu-a', platform_user_id: 'ou_old', platform_display_name: '某主人' },
      { channel_id: 'telegram-a', platform_user_id: 'tg_x', platform_display_name: 'tg' },
    ]
    const r = mergeMasterChannelIdentity(existing, 'feishu-a', 'ou_new')
    expect(r.changed).toBe(true)
    expect(r.removedIdentity).toEqual(existing[0])
    expect(r.identities).toHaveLength(2)
    expect(r.identities[0].platform_user_id).toBe('ou_new')
    expect(r.identities[0].platform_display_name).toBe(ONBOARDING_MASTER_DEFAULT_DISPLAY_NAME)
    expect(r.identities[1]).toEqual(existing[1])
  })

  it('返回的 identities 是新数组（不可变性）', () => {
    const existing: ChannelIdentity[] = [
      { channel_id: 'wechat-a', platform_user_id: 'wx_x', platform_display_name: 'w' },
    ]
    const r = mergeMasterChannelIdentity(existing, 'feishu-a', 'ou_y')
    expect(r.identities).not.toBe(existing)
  })
})

describe('buildOnboardingPushMessage', () => {
  it('包含 scope_grant_url 和主人称号', () => {
    const msg = buildOnboardingPushMessage('https://open.feishu.cn/app/xxx/auth?q=a,b,c')
    expect(msg).toContain('您是这台 Crabot 的主人')
    expect(msg).toContain('https://open.feishu.cn/app/xxx/auth?q=a,b,c')
  })
})
