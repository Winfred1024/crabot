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
})

describe('buildScopeGrantUrl', () => {
  it('builds feishu tenant scope grant deep link', () => {
    const url = buildScopeGrantUrl('cli_abc123')
    expect(url).toContain('open.feishu.cn/app/cli_abc123/auth')
    expect(url).toContain('token_type=tenant')
    expect(url).toContain('im%3Amessage')
  })

  it('includes all ONBOARD_SCOPES in the url', () => {
    const url = buildScopeGrantUrl('cli_test')
    for (const scope of ONBOARD_SCOPES) {
      expect(url).toContain(encodeURIComponent(scope))
    }
  })
})
