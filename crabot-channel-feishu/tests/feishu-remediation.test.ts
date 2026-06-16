import { describe, it, expect } from 'vitest'
import { buildFeishuRemediation, writeScopeForPath } from '../src/feishu-remediation.js'

describe('buildFeishuRemediation', () => {
  it('缺 drive scope 时给出授权链接、发版/协作者步骤、转在线文档备选', () => {
    const r = buildFeishuRemediation({ appId: 'cli_x', domain: 'feishu', missingScope: 'drive:drive:readonly' })
    expect(r.grant_url).toContain('cli_x')
    expect(decodeURIComponent(r.grant_url)).toContain('drive:drive:readonly')
    expect(decodeURIComponent(r.grant_url)).not.toContain('im:message')
    expect(r.message).toContain('权限')
    expect(r.steps.join('')).toContain('发布')
    expect(r.steps.join('')).toContain('协作者')
    expect(r.alternatives.join('')).toContain('在线')
  })
})

describe('writeScopeForPath', () => {
  it('按 path 前缀映射写 scope', () => {
    expect(writeScopeForPath('/open-apis/docx/v1/documents/x')).toBe('docx:document')
    expect(writeScopeForPath('/open-apis/sheets/v2/spreadsheets/x')).toBe('sheets:spreadsheet')
    expect(writeScopeForPath('/open-apis/drive/v1/files/x')).toBe('drive:drive')
    expect(writeScopeForPath('/open-apis/wiki/v2/spaces/x')).toBe('wiki:wiki')
    expect(writeScopeForPath('/open-apis/bitable/v1/apps/x')).toBe('bitable:app')
  })
  it('未命中返回 undefined', () => {
    expect(writeScopeForPath('/open-apis/im/v1/messages')).toBeUndefined()
  })
})

describe('buildFeishuRemediation intent=write', () => {
  it('写意图：文案是修改、备选不含转在线文档', () => {
    const r = buildFeishuRemediation({ appId: 'cli_x', domain: 'feishu', missingScope: 'sheets:spreadsheet', intent: 'write' })
    expect(decodeURIComponent(r.grant_url)).toContain('sheets:spreadsheet')
    expect(r.message).toContain('修改')
    expect(r.alternatives.join('')).not.toContain('在线 docx')
  })
})
