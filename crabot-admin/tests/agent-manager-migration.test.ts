import { describe, it, expect, vi } from 'vitest'
import { migrateModelConfig } from '../src/agent-manager.js'

describe('migrateModelConfig', () => {
  it('default/worker → powerful', () => {
    expect(migrateModelConfig({ default: { provider_id: 'p1', model_id: 'm1' } }))
      .toEqual({ powerful: { provider_id: 'p1', model_id: 'm1' } })
    expect(migrateModelConfig({ worker: { provider_id: 'p2', model_id: 'm2' } }))
      .toEqual({ powerful: { provider_id: 'p2', model_id: 'm2' } })
    expect(migrateModelConfig({ smart: { provider_id: 'p3', model_id: 'm3' } }))
      .toEqual({ powerful: { provider_id: 'p3', model_id: 'm3' } })
  })

  it('triage/digest/fast → cost_effective', () => {
    expect(migrateModelConfig({ triage: { provider_id: 'p1', model_id: 'm1' } }))
      .toEqual({ cost_effective: { provider_id: 'p1', model_id: 'm1' } })
    expect(migrateModelConfig({ digest: { provider_id: 'p2', model_id: 'm2' } }))
      .toEqual({ cost_effective: { provider_id: 'p2', model_id: 'm2' } })
    expect(migrateModelConfig({ fast: { provider_id: 'p3', model_id: 'm3' } }))
      .toEqual({ cost_effective: { provider_id: 'p3', model_id: 'm3' } })
  })

  it('vision_expert → vision', () => {
    expect(migrateModelConfig({ vision_expert: { provider_id: 'p', model_id: 'm' } }))
      .toEqual({ vision: { provider_id: 'p', model_id: 'm' } })
  })

  it('coding_expert 丢弃', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(migrateModelConfig({ coding_expert: { provider_id: 'p', model_id: 'm' } }))
      .toEqual({})
    spy.mockRestore()
  })

  it('已是新 key 保持不变', () => {
    const input = {
      powerful: { provider_id: 'p1', model_id: 'm1' },
      vision: { provider_id: 'p2', model_id: 'm2' },
    }
    expect(migrateModelConfig(input)).toEqual(input)
  })

  it('多个旧 key 映射到同一新 key 时不覆盖先到的', () => {
    const out = migrateModelConfig({
      worker: { provider_id: 'pA', model_id: 'mA' },
      default: { provider_id: 'pB', model_id: 'mB' },
    })
    expect(out.powerful).toBeDefined()
    // 先遇到 worker（按 Object.entries 顺序），default 不覆盖
    expect(out.powerful).toEqual({ provider_id: 'pA', model_id: 'mA' })
  })

  it('未知 key 丢弃 + warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(migrateModelConfig({ random_thing: { provider_id: 'p', model_id: 'm' } }))
      .toEqual({})
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('random_thing'))
    spy.mockRestore()
  })
})
