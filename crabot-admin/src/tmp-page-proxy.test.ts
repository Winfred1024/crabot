import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import http from 'node:http'
import { proxyTmpPage, isManagePath } from './tmp-page-proxy'

describe('isManagePath', () => {
  it('命中 _manage 端点', () => {
    expect(isManagePath('/tmp-pages/_manage/list')).toBe(true)
    expect(isManagePath('/tmp-pages/_manage')).toBe(true)
  })
  it('堵住连续斜杠绕过（与 server.cjs 折叠空段对齐）', () => {
    expect(isManagePath('/tmp-pages//_manage/list')).toBe(true)
    expect(isManagePath('/tmp-pages///_manage/abc')).toBe(true)
  })
  it('放行普通 page 路径', () => {
    expect(isManagePath('/tmp-pages/abcdef0123456789')).toBe(false)
    expect(isManagePath('/tmp-pages/abcdef0123456789/submit')).toBe(false)
  })
})

let upstream: http.Server, front: http.Server
let upstreamPort: number, frontPort: number

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let b = ''; req.on('data', (c) => (b += c))
      req.on('end', () => { res.writeHead(200); res.end(JSON.stringify({ got: b })) })
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>hello</h1>')
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamPort = (upstream.address() as { port: number }).port

  front = http.createServer((req, res) => {
    const target = req.url?.startsWith('/dead') ? 1 : upstreamPort
    void proxyTmpPage(req, res, target)
  })
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r))
  frontPort = (front.address() as { port: number }).port
})

afterAll(() => { upstream.close(); front.close() })

describe('proxyTmpPage', () => {
  it('转发 GET 并回传上游 body', async () => {
    const r = await fetch(`http://127.0.0.1:${frontPort}/tmp-pages/abc`)
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('hello')
  })
  it('转发 POST body', async () => {
    const r = await fetch(`http://127.0.0.1:${frontPort}/tmp-pages/abc/submit`,
      { method: 'POST', body: '{"x":1}' })
    expect(await r.json()).toEqual({ got: '{"x":1}' })
  })
  it('上游不可达 → 502', async () => {
    const r = await fetch(`http://127.0.0.1:${frontPort}/dead`)
    expect(r.status).toBe(502)
    expect(await r.text()).toContain('失效')
  })
})
