import { describe, it, expect } from 'vitest'
import { RpcCallError } from 'crabot-shared'
import { translateChannelError } from '../../src/mcp/error-translator.js'

describe('translateChannelError', () => {
  it('CHANNEL_LIST_GROUPS_NOT_SUPPORTED → 带 hint', () => {
    const err = new RpcCallError('CHANNEL_LIST_GROUPS_NOT_SUPPORTED', 'tg bot 不支持')
    const out = translateChannelError(err, '列群')
    expect(out).toEqual({
      error_code: 'CHANNEL_LIST_GROUPS_NOT_SUPPORTED',
      error: 'tg bot 不支持',
      hint: "该 channel 平台不支持列群，请改用 list_sessions(type='group') 看已感知会话",
    })
  })

  it('CHANNEL_LIST_CONTACTS_NOT_SUPPORTED → 列联系人 hint', () => {
    const err = new RpcCallError('CHANNEL_LIST_CONTACTS_NOT_SUPPORTED', 'tg 不支持')
    const out = translateChannelError(err, '列联系人')
    expect(out.hint).toContain('list_sessions')
  })

  it('PERMISSION_DENIED → 透传 missing_scope，不强加 hint', () => {
    const err = new RpcCallError('PERMISSION_DENIED', '缺 scope', { missing_scope: 'contact:user.base:readonly' })
    const out = translateChannelError(err, '列联系人')
    expect(out).toEqual({
      error_code: 'PERMISSION_DENIED',
      error: '缺 scope',
      missing_scope: 'contact:user.base:readonly',
    })
  })

  it('其他错误 → 透传 message，不加 hint', () => {
    const err = new RpcCallError('SOME_OTHER', 'oops')
    const out = translateChannelError(err, '列群')
    expect(out).toEqual({ error_code: 'SOME_OTHER', error: 'oops' })
  })

  it('非 RpcCallError 包装为 INTERNAL', () => {
    const err = new Error('plain')
    const out = translateChannelError(err, '列群')
    expect(out).toEqual({ error_code: 'INTERNAL', error: 'plain' })
  })
})
