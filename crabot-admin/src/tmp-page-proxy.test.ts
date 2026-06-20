import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import http from 'node:http'
import { proxyTmpPage } from './tmp-page-proxy'

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
