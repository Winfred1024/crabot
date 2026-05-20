import { describe, it, expect } from 'vitest'

describe('Phase 3e: 统一 loop 已完全合并（无 feature flag，无旧路径）', () => {
  it('UnifiedAgent.prototype 含 processDirectBatch（私聊 lane handler）', async () => {
    const mod = await import('../../src/unified-agent.js')
    const proto = mod.UnifiedAgent.prototype as unknown as Record<string, unknown>
    expect(typeof proto.processDirectBatch).toBe('function')
  })

  it('UnifiedAgent.prototype 不再含 processDirectMessage（已替换为 processDirectBatch）', async () => {
    const mod = await import('../../src/unified-agent.js')
    const proto = mod.UnifiedAgent.prototype as unknown as Record<string, unknown>
    expect(proto.processDirectMessage).toBeUndefined()
  })

  it('UnifiedAgent.prototype 不再含 processDirectMessageUnified（已合并删除）', async () => {
    const mod = await import('../../src/unified-agent.js')
    const proto = mod.UnifiedAgent.prototype as unknown as Record<string, unknown>
    expect(proto.processDirectMessageUnified).toBeUndefined()
  })

  it('UnifiedAgent.prototype 不再含 frontHandler 相关字段（Phase 3e 已删除）', async () => {
    const mod = await import('../../src/unified-agent.js')
    const proto = mod.UnifiedAgent.prototype as unknown as Record<string, unknown>
    // FrontHandler 已从类中删除，不应在 prototype 上出现
    expect(proto.frontHandler).toBeUndefined()
  })
})
