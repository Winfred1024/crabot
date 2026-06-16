import { describe, it, expect } from 'vitest'
import { parseFeishuDocUrl, extractFeishuDocUrls } from '../src/feishu-url.js'

describe('parseFeishuDocUrl', () => {
  it('parses docx url', () => {
    const r = parseFeishuDocUrl('https://bcnme6vi1icq.feishu.cn/docx/SX2JdvUuwoLGtTxJBvlc5Z9ynkb?dcuId=123&from=vc#dox')
    expect(r).toEqual({ kind: 'docx', token: 'SX2JdvUuwoLGtTxJBvlc5Z9ynkb' })
  })

  it('parses wiki url', () => {
    const r = parseFeishuDocUrl('https://bcnme6vi1icq.feishu.cn/wiki/EbJJw3TYciy6sbkWeKPcLESQngd')
    expect(r).toEqual({ kind: 'wiki', token: 'EbJJw3TYciy6sbkWeKPcLESQngd' })
  })

  it('parses sheets url', () => {
    const r = parseFeishuDocUrl('https://bcnme6vi1icq.feishu.cn/sheets/Uit5sdwtbh7Y0ctcZwHcgFnDnTc')
    expect(r).toEqual({ kind: 'sheets', token: 'Uit5sdwtbh7Y0ctcZwHcgFnDnTc' })
  })

  it('returns unknown kind for unrecognised feishu path', () => {
    const r = parseFeishuDocUrl('https://bcnme6vi1icq.feishu.cn/base/QlQ2b')
    expect(r?.kind).toBe('unknown')
  })

  it('returns null for non-feishu domain', () => {
    expect(parseFeishuDocUrl('https://example.com/docx/abc')).toBeNull()
    expect(parseFeishuDocUrl('https://evil.feishu.cn.attacker.com/docx/abc')).toBeNull()
  })

  it('returns null for invalid url', () => {
    expect(parseFeishuDocUrl('not-a-url')).toBeNull()
  })

  it('strips token with slash suffix', () => {
    const r = parseFeishuDocUrl('https://feishu.cn/docx/TOKEN123/')
    expect(r?.token).toBe('TOKEN123')
  })

  it('识别 drive file 链接为 kind=file', () => {
    expect(parseFeishuDocUrl('https://x.feishu.cn/file/boxcnTOKEN123')).toEqual({ kind: 'file', token: 'boxcnTOKEN123' })
  })

  it('wiki 链接仍为 kind=wiki（file 判定不误伤 wiki）', () => {
    expect(parseFeishuDocUrl('https://x.feishu.cn/wiki/WTOKEN')).toEqual({ kind: 'wiki', token: 'WTOKEN' })
  })
})

describe('extractFeishuDocUrls', () => {
  it('extracts feishu urls from text', () => {
    const text = '看看这个 https://bcnme6vi1icq.feishu.cn/docx/ABC 和这个 https://example.com/docx/XYZ'
    expect(extractFeishuDocUrls(text)).toEqual(['https://bcnme6vi1icq.feishu.cn/docx/ABC'])
  })

  it('returns empty array when no feishu urls', () => {
    expect(extractFeishuDocUrls('no urls here')).toEqual([])
  })

  it('excludes unknown-kind feishu urls (e.g. /base/)', () => {
    const text = 'https://bcnme6vi1icq.feishu.cn/base/QlQ2b 和 https://bcnme6vi1icq.feishu.cn/docx/ABC'
    expect(extractFeishuDocUrls(text)).toEqual(['https://bcnme6vi1icq.feishu.cn/docx/ABC'])
  })
})
