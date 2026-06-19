import { describe, it, expect } from 'vitest'
import { scrubProvidersJson, scrubChannelConfigJson, SECRET_PLACEHOLDER } from './scrub-secrets.js'

describe('scrub-secrets', () => {
  it('把 provider 的 api_key 与 oauth token 置空', () => {
    const input = JSON.stringify([
      { id: 'p1', name: 'openai', api_key: 'sk-real', auth_type: 'apikey' },
      {
        id: 'p2', name: 'oauth-prov', api_key: '', auth_type: 'oauth',
        oauth_credential: { access_token: 'AT', refresh_token: 'RT' },
      },
    ])
    const out = JSON.parse(scrubProvidersJson(input))
    expect(out[0].api_key).toBe(SECRET_PLACEHOLDER)
    expect(out[1].oauth_credential.access_token).toBe(SECRET_PLACEHOLDER)
    expect(out[1].oauth_credential.refresh_token).toBe(SECRET_PLACEHOLDER)
    expect(out[0].name).toBe('openai') // 非密钥字段保留
  })

  it('channel config 里常见 secret key 置空，其它保留', () => {
    const input = JSON.stringify({
      WECHAT_CONNECTOR_URL: 'http://x', WECHAT_API_KEY: 'real-key',
      FEISHU_APP_SECRET: 'sec', FEISHU_APP_ID: 'id-keep',
    })
    const out = JSON.parse(scrubChannelConfigJson(input))
    expect(out.WECHAT_API_KEY).toBe(SECRET_PLACEHOLDER)
    expect(out.FEISHU_APP_SECRET).toBe(SECRET_PLACEHOLDER)
    expect(out.WECHAT_CONNECTOR_URL).toBe('http://x')
    expect(out.FEISHU_APP_ID).toBe('id-keep')
  })
})
