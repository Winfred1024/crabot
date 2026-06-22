import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isFdaEnabled,
  shouldScanProtectedDirs,
  hasFullDiskAccess,
  checkFdaIfEnabled,
  __resetFdaCacheForTest,
} from '../../../src/engine/tools/fda-check'

describe('fda-check', () => {
  const original = process.env.CRABOT_ENABLE_FDA

  beforeEach(() => {
    __resetFdaCacheForTest()
    delete process.env.CRABOT_ENABLE_FDA
  })

  afterEach(() => {
    if (original === undefined) delete process.env.CRABOT_ENABLE_FDA
    else process.env.CRABOT_ENABLE_FDA = original
  })

  describe('isFdaEnabled', () => {
    it('未设置时为 false', () => {
      expect(isFdaEnabled()).toBe(false)
    })

    it('"1" / "true" / "yes" 视为开启', () => {
      for (const v of ['1', 'true', 'yes']) {
        process.env.CRABOT_ENABLE_FDA = v
        expect(isFdaEnabled()).toBe(true)
      }
    })

    it('"0" / 任意其它值视为关闭', () => {
      for (const v of ['0', 'false', 'off', '']) {
        process.env.CRABOT_ENABLE_FDA = v
        expect(isFdaEnabled()).toBe(false)
      }
    })
  })

  describe('shouldScanProtectedDirs', () => {
    it('意图未开启时恒为 false（无论是否持有 FDA）', () => {
      delete process.env.CRABOT_ENABLE_FDA
      expect(shouldScanProtectedDirs()).toBe(false)
    })

    it('开启意图时 = 实际是否持有 FDA（与探针一致，不会凭意图放开）', () => {
      process.env.CRABOT_ENABLE_FDA = '1'
      expect(shouldScanProtectedDirs()).toBe(hasFullDiskAccess())
    })
  })

  describe('hasFullDiskAccess', () => {
    it('返回布尔且结果被缓存', () => {
      const a = hasFullDiskAccess()
      const b = hasFullDiskAccess()
      expect(typeof a).toBe('boolean')
      expect(a).toBe(b)
    })
  })

  describe('checkFdaIfEnabled', () => {
    it('意图未开启时不打印任何内容', () => {
      delete process.env.CRABOT_ENABLE_FDA
      const logs: string[] = []
      checkFdaIfEnabled((m) => logs.push(m))
      expect(logs).toHaveLength(0)
    })

    it('darwin + 开启意图时至少给出一行提示', () => {
      if (process.platform !== 'darwin') return // 非 darwin 静默，跳过
      process.env.CRABOT_ENABLE_FDA = '1'
      const logs: string[] = []
      checkFdaIfEnabled((m) => logs.push(m))
      expect(logs.length).toBeGreaterThanOrEqual(1)
      expect(logs.join('\n')).toContain('FDA')
    })
  })
})
