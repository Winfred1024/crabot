import { describe, it, expect, vi } from 'vitest'

const request = vi.fn(async (opts: { url: string; method: string; data?: unknown }) => {
  if (opts.url.includes('/denied')) return { code: 99991663, msg: 'permission denied' }
  return { code: 0, data: { ok: 1, echoMethod: opts.method, echoData: opts.data } }
})
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  Client: class { request = request },
}))
import { FeishuClient } from '../src/feishu-client.js'

const client = () => new FeishuClient({ app_id: 'cli_x', app_secret: 's', domain: 'feishu' })

describe('FeishuClient.rawRequest', () => {
  it('传 method + body(data) 并返回 data', async () => {
    const data = await client().rawRequest<{ ok: number; echoMethod: string; echoData: unknown }>({
      method: 'POST', path: '/open-apis/foo', body: { a: 1 },
    })
    expect(data.ok).toBe(1)
    expect(data.echoMethod).toBe('POST')
    expect(data.echoData).toEqual({ a: 1 })
  })
  it('拼 query 参数', async () => {
    await client().rawRequest({ method: 'DELETE', path: '/open-apis/foo', query: { id: 'x' } })
    expect(request.mock.calls.at(-1)?.[0].url).toContain('id=x')
  })
  it('code 非 0 抛 FeishuClientError，权限码映射 PERMISSION_DENIED', async () => {
    await expect(client().rawRequest({ method: 'POST', path: '/open-apis/denied' }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })
})
