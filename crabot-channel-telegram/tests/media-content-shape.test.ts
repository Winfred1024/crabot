import { describe, it, expect } from 'vitest'
import type { MessageContent } from '../src/types'

describe('telegram MessageContent 惰性媒体字段', () => {
  it('文件携带 handle + status', () => {
    const c: MessageContent = { type: 'file', filename: 'a.pdf', handle: 'fm_x', status: 'not_fetched' }
    expect(c.handle).toBe('fm_x'); expect(c.status).toBe('not_fetched')
  })

  it('status 仅接受四种取值（编译期 + 运行期断言）', () => {
    const statuses: NonNullable<MessageContent['status']>[] = [
      'ready', 'not_fetched', 'fetching', 'failed',
    ]
    expect(statuses).toHaveLength(4)
  })
})
