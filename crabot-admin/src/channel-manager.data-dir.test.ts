import { describe, expect, it } from 'vitest'
import { ChannelManager } from './channel-manager.js'

describe('ChannelManager buildModuleEnv', () => {
  it('injects instance-scoped DATA_DIR for builtin channel instances', async () => {
    const manager = new ChannelManager('./test-data/channel-manager-data-dir-test', {} as any)
    const env = await (manager as any).buildModuleEnv({
      id: 'vongcloud-wechat',
      implementation_id: 'channel-wechat',
      name: 'vongcloud-wechat',
      platform: 'wechat',
      auto_start: true,
      start_priority: 30,
      module_registered: true,
      created_at: '2026-04-22T00:00:00Z',
      updated_at: '2026-04-22T00:00:00Z',
    })

    expect(env.CRABOT_MODULE_ID).toBe('vongcloud-wechat')
    expect(env.DATA_DIR).toContain('vongcloud-wechat')
  })
})
