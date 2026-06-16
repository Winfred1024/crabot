import { describe, it, expect } from 'vitest'
import { ONBOARD_SCOPES, buildScopeGrantUrl } from '../src/onboard.js'

describe('ONBOARD_SCOPES', () => {
  it('includes essential im and contact scopes', () => {
    expect(ONBOARD_SCOPES).toContain('im:message')
    expect(ONBOARD_SCOPES).toContain('contact:user.base:readonly')
  })

  it('includes doc reading scopes', () => {
    expect(ONBOARD_SCOPES).toContain('docx:document:readonly')
    expect(ONBOARD_SCOPES).toContain('wiki:wiki:readonly')
    expect(ONBOARD_SCOPES).toContain('sheets:spreadsheet:readonly')
  })

  it('includes drive read scope (大文件被飞书自动转 drive)', () => {
    expect(ONBOARD_SCOPES).toContain('drive:drive:readonly')
  })
})

describe('buildScopeGrantUrl', () => {
  it('builds feishu tenant scope grant deep link', () => {
    const url = buildScopeGrantUrl('cli_abc123', 'feishu')
    expect(url).toContain('open.feishu.cn/app/cli_abc123/auth')
    expect(url).toContain('token_type=tenant')
    expect(url).toContain('im%3Amessage')
  })

  it('builds lark tenant scope grant deep link (international)', () => {
    const url = buildScopeGrantUrl('cli_abc123', 'lark')
    expect(url).toContain('open.larksuite.com/app/cli_abc123/auth')
    expect(url).toContain('token_type=tenant')
  })

  it('includes all ONBOARD_SCOPES in the url', () => {
    const url = buildScopeGrantUrl('cli_test', 'feishu')
    for (const scope of ONBOARD_SCOPES) {
      expect(url).toContain(encodeURIComponent(scope))
    }
  })

  it('只包含传入的 scope 子集（不混入全量默认）', () => {
    const url = decodeURIComponent(buildScopeGrantUrl('cli_x', 'feishu', ['drive:drive:readonly']))
    expect(url).toContain('cli_x')
    expect(url).toContain('drive:drive:readonly')
    expect(url).not.toContain('im:message')
  })
})
