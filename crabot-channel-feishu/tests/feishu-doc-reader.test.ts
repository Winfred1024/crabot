import { describe, it, expect, vi } from 'vitest'
import { FeishuDocReader } from '../src/feishu-doc-reader.js'
import type { FeishuClient } from '../src/feishu-client.js'

function makeClient(overrides: Partial<FeishuClient> = {}): FeishuClient {
  return {
    getDocxRawContent: vi.fn(async () => 'docx body text'),
    getDocxMeta: vi.fn(async () => ({ title: 'My Doc' })),
    getWikiNode: vi.fn(async () => ({ obj_token: 'docxTOKEN', obj_type: 'docx' })),
    getSheetMeta: vi.fn(async () => ({ title: 'Sheet1', sheets: [{ sheet_id: 'sh1', title: 'Sheet1' }] })),
    getSheetValues: vi.fn(async () => [['A1', 'B1'], ['A2', 'B2']]),
    ...overrides,
  } as unknown as FeishuClient
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
    const client = makeClient({ getWikiNode: vi.fn(async () => ({ obj_token: 'bt', obj_type: 'bitable' })) })
    const reader = new FeishuDocReader(client)
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
    const client = makeClient({ getDocxRawContent: vi.fn(async () => 'x'.repeat(200)) })
    const reader = new FeishuDocReader(client)
    const result = await reader.read({ kind: 'docx', token: 'D' }, { maxChars: 50 })
    expect(result.text.length).toBeLessThanOrEqual(55)
    expect(result.truncated).toBe(true)
  })

  it('throws UNSUPPORTED for unknown kind', async () => {
    const reader = new FeishuDocReader(makeClient())
    await expect(reader.read({ kind: 'unknown', token: '' })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
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
})
