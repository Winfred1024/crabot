import { describe, it, expect } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// 行为断言：tail-N 行
import { tailLogFile } from './module-log-tail.js'

describe('tailLogFile', () => {
  it('returns last N lines of a log file', async () => {
    const tmp = path.join(os.tmpdir(), `crabot-test-${Date.now()}.log`)
    fs.writeFileSync(tmp, ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n') + '\n')
    const out = await tailLogFile(tmp, 3)
    expect(out.split('\n').filter(Boolean)).toEqual(['l3', 'l4', 'l5'])
    fs.unlinkSync(tmp)
  })

  it('returns empty when file does not exist', async () => {
    const tmp = path.join(os.tmpdir(), `crabot-missing-${Date.now()}.log`)
    const out = await tailLogFile(tmp, 10)
    expect(out).toBe('')
  })

  it('caps lines at requested count', async () => {
    const tmp = path.join(os.tmpdir(), `crabot-cap-${Date.now()}.log`)
    const lines = Array.from({ length: 1000 }, (_, i) => `line-${i}`)
    fs.writeFileSync(tmp, lines.join('\n') + '\n')
    const out = await tailLogFile(tmp, 50)
    const result = out.split('\n').filter(Boolean)
    expect(result).toHaveLength(50)
    expect(result[0]).toBe('line-950')
    expect(result[49]).toBe('line-999')
    fs.unlinkSync(tmp)
  })
})
