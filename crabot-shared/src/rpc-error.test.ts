import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import http from 'node:http'
import { RpcError, RpcCallError, formatHandlerError, RpcClient } from './module-base.js'

describe('RpcError', () => {
  it('携带 code、message 与 details', () => {
    const err = new RpcError('PERMISSION_DENIED', '缺少 contact scope', { missing_scope: 'contact:user.base:readonly' })
    assert.equal(err.code, 'PERMISSION_DENIED')
    assert.equal(err.message, '缺少 contact scope')
    assert.deepEqual(err.details, { missing_scope: 'contact:user.base:readonly' })
    assert.ok(err instanceof Error)
  })

  it('details 缺省时为 undefined', () => {
    const err = new RpcError('CHANNEL_LIST_GROUPS_NOT_SUPPORTED', 'tg bot 不支持列群')
    assert.equal(err.details, undefined)
  })
})

describe('RpcCallError', () => {
  it('携带原始错误码与服务端 details', () => {
    const err = new RpcCallError('PERMISSION_DENIED', '缺少 scope', { missing_scope: 'x' })
    assert.equal(err.code, 'PERMISSION_DENIED')
    assert.equal(err.details?.missing_scope, 'x')
    assert.ok(err instanceof Error)
  })
})

describe('formatHandlerError', () => {
  it('RpcError → 带 code/details 的 createErrorResponse', () => {
    const err = new RpcError('CHANNEL_LIST_GROUPS_NOT_SUPPORTED', 'tg bot 不支持', { hint: 'use list_sessions' })
    const out = formatHandlerError(err, 'req-1')
    assert.equal(out.success, false)
    assert.equal(out.error?.code, 'CHANNEL_LIST_GROUPS_NOT_SUPPORTED')
    assert.equal(out.error?.message, 'tg bot 不支持')
    assert.deepEqual(out.error?.details, { hint: 'use list_sessions' })
  })

  it('普通 Error → INTERNAL_ERROR', () => {
    const out = formatHandlerError(new Error('oops'), 'req-2')
    assert.equal(out.error?.code, 'INTERNAL_ERROR')
    assert.equal(out.error?.message, 'oops')
    assert.equal(out.error?.details, undefined)
  })
})

describe('RpcClient.call 错误透传', () => {
  it('收到 success=false 响应时 reject RpcCallError', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'x', success: false,
        error: { code: 'PERMISSION_DENIED', message: '缺 scope', details: { missing_scope: 's1' } },
        timestamp: new Date().toISOString(),
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    const client = new RpcClient(0)
    let caught: unknown
    try {
      await client.call(port, 'whatever', {}, 'test-source')
    } catch (e) {
      caught = e
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))

    assert.ok(caught instanceof RpcCallError)
    assert.equal((caught as RpcCallError).code, 'PERMISSION_DENIED')
    assert.equal((caught as RpcCallError).details?.missing_scope, 's1')
  })
})
