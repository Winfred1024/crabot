import { describe, it, expect, vi, beforeEach } from 'vitest'
import { subagentService } from './subagent'
import { api } from './api'

vi.mock('./api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

describe('subagentService', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('list calls GET /subagents', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue([])
    await subagentService.list()
    expect(api.get).toHaveBeenCalledWith('/subagents')
  })

  it('get calls GET /subagents/:id', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({})
    await subagentService.get('id-1')
    expect(api.get).toHaveBeenCalledWith('/subagents/id-1')
  })

  it('create calls POST /subagents', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({})
    await subagentService.create({ name: 'foo' } as never)
    expect(api.post).toHaveBeenCalledWith('/subagents', { name: 'foo' })
  })

  it('update calls PATCH /subagents/:id', async () => {
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({})
    await subagentService.update('id-1', { enabled: false })
    expect(api.patch).toHaveBeenCalledWith('/subagents/id-1', { enabled: false })
  })

  it('remove calls DELETE /subagents/:id', async () => {
    ;(api.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    await subagentService.remove('id-1')
    expect(api.delete).toHaveBeenCalledWith('/subagents/id-1')
  })
})
