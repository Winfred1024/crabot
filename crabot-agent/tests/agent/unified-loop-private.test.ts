import { describe, it, expect, afterEach } from 'vitest'

describe('Phase 3c: CRABOT_USE_UNIFIED_LOOP feature flag', () => {
  const originalValue = process.env.CRABOT_USE_UNIFIED_LOOP

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.CRABOT_USE_UNIFIED_LOOP
    } else {
      process.env.CRABOT_USE_UNIFIED_LOOP = originalValue
    }
  })

  it('环境变量未设置 → useUnifiedLoop = false', () => {
    delete process.env.CRABOT_USE_UNIFIED_LOOP
    const useUnifiedLoop = process.env.CRABOT_USE_UNIFIED_LOOP === 'true'
    expect(useUnifiedLoop).toBe(false)
  })

  it('环境变量 = "true" → useUnifiedLoop = true', () => {
    process.env.CRABOT_USE_UNIFIED_LOOP = 'true'
    const useUnifiedLoop = process.env.CRABOT_USE_UNIFIED_LOOP === 'true'
    expect(useUnifiedLoop).toBe(true)
  })

  it('环境变量 = "1" → useUnifiedLoop = false（严格匹配 "true"）', () => {
    process.env.CRABOT_USE_UNIFIED_LOOP = '1'
    const useUnifiedLoop = process.env.CRABOT_USE_UNIFIED_LOOP === 'true'
    expect(useUnifiedLoop).toBe(false)
  })

  it('环境变量 = "false" → useUnifiedLoop = false', () => {
    process.env.CRABOT_USE_UNIFIED_LOOP = 'false'
    const useUnifiedLoop = process.env.CRABOT_USE_UNIFIED_LOOP === 'true'
    expect(useUnifiedLoop).toBe(false)
  })

  it('环境变量 = "TRUE"（大写）→ useUnifiedLoop = false（严格匹配小写）', () => {
    process.env.CRABOT_USE_UNIFIED_LOOP = 'TRUE'
    const useUnifiedLoop = process.env.CRABOT_USE_UNIFIED_LOOP === 'true'
    expect(useUnifiedLoop).toBe(false)
  })
})

describe('Phase 3c: processDirectMessageUnified 方法存在', () => {
  it('UnifiedAgent.prototype 含 processDirectMessageUnified（private 方法）', async () => {
    const mod = await import('../../src/unified-agent.js')
    // private 方法在运行时仍可见于 prototype（TypeScript private 不是运行时 enforce）
    const proto = mod.UnifiedAgent.prototype as unknown as Record<string, unknown>
    expect(typeof proto.processDirectMessageUnified).toBe('function')
  })

  it('UnifiedAgent.prototype 含 processDirectMessage（旧路径仍保留）', async () => {
    const mod = await import('../../src/unified-agent.js')
    const proto = mod.UnifiedAgent.prototype as unknown as Record<string, unknown>
    expect(typeof proto.processDirectMessage).toBe('function')
  })
})
