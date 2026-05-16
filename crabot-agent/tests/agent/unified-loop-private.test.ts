import { describe, it, expect, afterEach } from 'vitest'

describe('Phase 3d: CRABOT_USE_UNIFIED_LOOP feature flag（opt-out 语义）', () => {
  const originalValue = process.env.CRABOT_USE_UNIFIED_LOOP

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.CRABOT_USE_UNIFIED_LOOP
    } else {
      process.env.CRABOT_USE_UNIFIED_LOOP = originalValue
    }
  })

  it('环境变量未设置 → useUnifiedLoop = true（默认启用）', () => {
    delete process.env.CRABOT_USE_UNIFIED_LOOP
    const useUnifiedLoop = process.env.CRABOT_USE_UNIFIED_LOOP !== 'false'
    expect(useUnifiedLoop).toBe(true)
  })

  it('环境变量 = "false" → useUnifiedLoop = false（显式 opt-out 回老路径）', () => {
    process.env.CRABOT_USE_UNIFIED_LOOP = 'false'
    const useUnifiedLoop = process.env.CRABOT_USE_UNIFIED_LOOP !== 'false'
    expect(useUnifiedLoop).toBe(false)
  })

  it('环境变量 = "true" → useUnifiedLoop = true', () => {
    process.env.CRABOT_USE_UNIFIED_LOOP = 'true'
    const useUnifiedLoop = process.env.CRABOT_USE_UNIFIED_LOOP !== 'false'
    expect(useUnifiedLoop).toBe(true)
  })

  it('环境变量 = "0"（非 false 字面值）→ useUnifiedLoop = true', () => {
    process.env.CRABOT_USE_UNIFIED_LOOP = '0'
    const useUnifiedLoop = process.env.CRABOT_USE_UNIFIED_LOOP !== 'false'
    expect(useUnifiedLoop).toBe(true)
  })

  it('环境变量 = "FALSE"（大写）→ useUnifiedLoop = true（严格匹配小写 "false"）', () => {
    process.env.CRABOT_USE_UNIFIED_LOOP = 'FALSE'
    const useUnifiedLoop = process.env.CRABOT_USE_UNIFIED_LOOP !== 'false'
    expect(useUnifiedLoop).toBe(true)
  })
})

describe('Phase 3d: processDirectMessageUnified 方法存在', () => {
  it('UnifiedAgent.prototype 含 processDirectMessageUnified', async () => {
    const mod = await import('../../src/unified-agent.js')
    const proto = mod.UnifiedAgent.prototype as unknown as Record<string, unknown>
    expect(typeof proto.processDirectMessageUnified).toBe('function')
  })

  it('UnifiedAgent.prototype 含 processDirectMessage（老路径过渡期保留）', async () => {
    const mod = await import('../../src/unified-agent.js')
    const proto = mod.UnifiedAgent.prototype as unknown as Record<string, unknown>
    expect(typeof proto.processDirectMessage).toBe('function')
  })
})
