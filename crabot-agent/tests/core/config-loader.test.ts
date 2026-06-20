import { describe, it, expect } from 'vitest'
import { ConfigLoader } from '../../src/core/config-loader.js'

/**
 * 回归：convertAdminConfigToLocal 是个白名单字段映射，曾漏掉 tmp_page_base_url，
 * 导致 admin 注入了、agent 收到了，但转成 this.agentConfig 时被筛掉 → worker
 * 拿不到对外 base / task_id → 满世界 grep 自查 + meta.owner_task_id 写错 → 唤醒断链。
 * 这里锁住该字段必须从 adminConfig 流到 agent_config。
 */
describe('ConfigLoader.convertAdminConfigToLocal — tmp_page_base_url 透传', () => {
  const baseAdminConfig = {
    instance_id: 'crabot-agent',
    role: 'worker' as const,
    system_prompt: '',
    model_config: {},
  }

  it('admin 下发的 tmp_page_base_url 必须带进 agent_config', () => {
    const local = (ConfigLoader as unknown as {
      convertAdminConfigToLocal: (c: unknown, id: string) => { agent_config: { tmp_page_base_url?: string } }
    }).convertAdminConfigToLocal(
      { ...baseAdminConfig, tmp_page_base_url: 'http://localhost:3000' },
      'crabot-agent',
    )
    expect(local.agent_config.tmp_page_base_url).toBe('http://localhost:3000')
  })

  it('admin 未下发时 agent_config 不带该字段（条件展开，不塞 undefined）', () => {
    const local = (ConfigLoader as unknown as {
      convertAdminConfigToLocal: (c: unknown, id: string) => { agent_config: { tmp_page_base_url?: string } }
    }).convertAdminConfigToLocal(baseAdminConfig, 'crabot-agent')
    expect(local.agent_config.tmp_page_base_url).toBeUndefined()
  })
})
