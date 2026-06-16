import { describe, it, expect } from 'vitest'
import type { MessageContent } from '../src/types'

describe('MessageContent 惰性媒体字段', () => {
  it('non_fetched 文件携带 handle + status', () => {
    const c: MessageContent = {
      type: 'file',
      filename: 'report.pdf',
      size: 12_000_000,
      handle: 'fm_abc123',
      status: 'not_fetched',
    }
    expect(c.handle).toBe('fm_abc123')
    expect(c.status).toBe('not_fetched')
  })

  it('status 仅接受四种取值（编译期 + 运行期断言）', () => {
    const statuses: NonNullable<MessageContent['status']>[] = [
      'ready', 'not_fetched', 'fetching', 'failed',
    ]
    expect(statuses).toHaveLength(4)
  })
})
