import { describe, it, expect, vi } from 'vitest'
import { FeishuDocReader } from '../src/feishu-doc-reader.js'
import type { FeishuClient } from '../src/feishu-client.js'

function makeClient(overrides: Partial<FeishuClient> = {}): FeishuClient {
  const rawGet = vi.fn(async (path: string) => {
    if (path.includes('/raw_content')) return { content: 'docx body text' }
    if (/\/docx\/v1\/documents\/[^/]+$/.test(path)) return { document: { title: 'My Doc' } }
    if (path.includes('/wiki/v2/spaces/get_node')) return { node: { obj_token: 'docxTOKEN', obj_type: 'docx' } }
    if (path.includes('/sheets/query')) return { sheets: [{ sheet_id: 'sh1', title: 'Sheet1' }] }
    if (path.includes('/values/')) return { valueRange: { values: [['A1', 'B1'], ['A2', 'B2']] } }
    return {}
  })
  return { rawGet, ...overrides } as unknown as FeishuClient
}

describe('FeishuDocReader.read()', () => {
  it('reads docx', async () => {
    const reader = new FeishuDocReader(makeClient())
    const result = await reader.read({ kind: 'docx', token: 'DOCID' })
    expect(result.type).toBe('docx')
    expect(result.title).toBe('My Doc')
    expect(result.text).toBe('docx body text')
    expect(result.truncated).toBe(false)
  })

  it('reads wiki by resolving to docx', async () => {
    const reader = new FeishuDocReader(makeClient())
    const result = await reader.read({ kind: 'wiki', token: 'WIKITOKEN' })
    expect(result.type).toBe('wiki')
    expect(result.title).toBe('My Doc')
    expect(result.text).toBe('docx body text')
  })

  it('throws UNSUPPORTED when wiki resolves to non-docx type', async () => {
    const rawGet = vi.fn(async (path: string) =>
      path.includes('get_node') ? { node: { obj_token: 'bt', obj_type: 'bitable' } } : {})
    const reader = new FeishuDocReader({ rawGet } as unknown as FeishuClient)
    await expect(reader.read({ kind: 'wiki', token: 'W' })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('reads sheets and formats as text', async () => {
    const reader = new FeishuDocReader(makeClient())
    const result = await reader.read({ kind: 'sheets', token: 'SHTOKEN' })
    expect(result.type).toBe('sheets')
    expect(result.text).toContain('A1')
    expect(result.text).toContain('B2')
  })

  it('truncates docx content when maxChars exceeded', async () => {
    const rawGet = vi.fn(async (path: string) => {
      if (path.includes('/raw_content')) return { content: 'x'.repeat(200) }
      if (/\/docx\/v1\/documents\/[^/]+$/.test(path)) return { document: { title: 'My Doc' } }
      return {}
    })
    const reader = new FeishuDocReader({ rawGet } as unknown as FeishuClient)
    const result = await reader.read({ kind: 'docx', token: 'D' }, { maxChars: 50 })
    expect(result.text.length).toBeLessThanOrEqual(55)
    expect(result.truncated).toBe(true)
  })

  it('throws UNSUPPORTED for unknown kind', async () => {
    const reader = new FeishuDocReader(makeClient())
    await expect(reader.read({ kind: 'unknown', token: '' })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('wiki(file) 节点返回 file descriptor，不抛错，filename 取自节点 title', async () => {
    const rawGet = vi.fn(async (path: string) =>
      path.includes('get_node') ? { node: { obj_token: 'boxT', obj_type: 'file', title: 'plan.pptx' } } : {})
    const reader = new FeishuDocReader({ rawGet } as unknown as FeishuClient)
    const r = await reader.read({ kind: 'wiki', token: 'W' })
    expect(r.type).toBe('file')
    expect(r.file_token).toBe('boxT')
    expect(r.filename).toBe('plan.pptx')
  })

  it('drive file 链接直接返回 file descriptor', async () => {
    const rawGet = vi.fn(async () => ({}))
    const reader = new FeishuDocReader({ rawGet } as unknown as FeishuClient)
    const r = await reader.read({ kind: 'file', token: 'boxT' })
    expect(r.type).toBe('file'); expect(r.file_token).toBe('boxT')
  })
})

describe('FeishuDocReader.readMeta()', () => {
  it('returns title and type for docx', async () => {
    const reader = new FeishuDocReader(makeClient())
    const meta = await reader.readMeta({ kind: 'docx', token: 'DOCID' })
    expect(meta).toEqual({ type: 'docx', title: 'My Doc' })
  })

  it('resolves wiki to docx title', async () => {
    const reader = new FeishuDocReader(makeClient())
    const meta = await reader.readMeta({ kind: 'wiki', token: 'W' })
    expect(meta.type).toBe('wiki')
    expect(meta.title).toBe('My Doc')
  })

  it('returns sheets first sheet title', async () => {
    const reader = new FeishuDocReader(makeClient())
    const meta = await reader.readMeta({ kind: 'sheets', token: 'S' })
    expect(meta).toEqual({ type: 'sheets', title: 'Sheet1' })
  })

  it('throws UNSUPPORTED for unknown kind in readMeta', async () => {
    const reader = new FeishuDocReader(makeClient())
    await expect(reader.readMeta({ kind: 'unknown', token: '' })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('wiki(file) 节点 readMeta 返回 file 类型 + 节点标题作文件名', async () => {
    const rawGet = vi.fn(async (path: string) =>
      path.includes('get_node') ? { node: { obj_token: 'boxT', obj_type: 'file', title: 'plan.pptx' } } : {})
    const reader = new FeishuDocReader({ rawGet } as unknown as FeishuClient)
    const meta = await reader.readMeta({ kind: 'wiki', token: 'W' })
    expect(meta).toEqual({ type: 'file', title: 'plan.pptx' })
  })

  it('直接 file 链接 readMeta 返回空标题不抛错', async () => {
    const reader = new FeishuDocReader({ rawGet: vi.fn(async () => ({})) } as unknown as FeishuClient)
    const meta = await reader.readMeta({ kind: 'file', token: 'boxT' })
    expect(meta).toEqual({ type: 'file', title: '' })
  })
})
