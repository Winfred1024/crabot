import { describe, it, expect } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'

describe('AgentHandler.wakeForMediaDownload', () => {
  it('push [系统] note 到指定 task 的 humanQueue', () => {
    const handler = Object.create(AgentHandler.prototype) as any
    const queue = new HumanMessageQueue()
    handler.humanQueues = new Map([['t1', queue]])
    let pushed = ''
    const orig = queue.push.bind(queue)
    queue.push = (c: any) => { pushed = typeof c === 'string' ? c : JSON.stringify(c); orig(c) }

    handler.wakeForMediaDownload('t1', '媒体 fm_x 已就绪')
    expect(pushed).toContain('[系统]')
    expect(pushed).toContain('媒体 fm_x 已就绪')
  })

  it('未知 task → 静默 no-op', () => {
    const handler = Object.create(AgentHandler.prototype) as any
    handler.humanQueues = new Map()
    expect(() => handler.wakeForMediaDownload('missing', 'x')).not.toThrow()
  })
})
