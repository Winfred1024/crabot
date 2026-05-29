import { describe, it, expect } from 'vitest'
import { redactSecrets } from '../../src/engine/redact-secrets.js'

describe('redactSecrets', () => {
  it('masks known secret value', () => {
    const result = redactSecrets('token is abc123secret', ['abc123secret'])
    expect(result).toBe('token is [REDACTED]')
    expect(result).not.toContain('abc123secret')
  })

  it('masks tenant_access_token pattern', () => {
    const result = redactSecrets('{"tenant_access_token":"t-abc.xyz.123456789012345"}', [])
    expect(result).not.toContain('t-abc.xyz.123456789012345')
    expect(result).toContain('[REDACTED]')
  })

  it('masks Bearer token in Authorization header', () => {
    const result = redactSecrets('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.abcdefghijk', [])
    expect(result).toContain('Bearer [REDACTED]')
  })

  it('masks app_secret in json', () => {
    const result = redactSecrets('{"FEISHU_APP_SECRET":"TZGmwscqAHiuZUSQ"}', [])
    expect(result).not.toContain('TZGmwscqAHiuZUSQ')
  })

  it('masks channel-config file content fingerprint', () => {
    const text = '{"FEISHU_APP_ID":"cli_abc","FEISHU_APP_SECRET":"secretXYZ123456","FEISHU_DOMAIN":"feishu"}'
    const result = redactSecrets(text, [])
    expect(result).not.toContain('secretXYZ123456')
  })

  it('does not mutate unrelated text', () => {
    const text = 'Hello world, no secrets here'
    expect(redactSecrets(text, [])).toBe(text)
  })

  it('is idempotent on already-redacted text', () => {
    const text = 'token is [REDACTED]'
    expect(redactSecrets(text, [])).toBe(text)
  })
})
