/**
 * SecretInput 解析测试：明文返回值，SecretRef（env/file/exec 引用）返回 undefined。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.1（备份只存引用本身，明文不在包里）
 */
import { describe, it, expect } from 'vitest'
import { resolveSecret } from './resolve-secret.js'

describe('resolveSecret', () => {
  it('明文字符串 → 原样返回', () => {
    expect(resolveSecret('sk-literal')).toBe('sk-literal')
  })

  it('SecretRef（对象）→ undefined（明文不在备份）', () => {
    expect(resolveSecret({ source: 'env', provider: 'default', id: 'OPENAI_API_KEY' })).toBeUndefined()
  })

  it('undefined / 空串 → undefined', () => {
    expect(resolveSecret(undefined)).toBeUndefined()
    expect(resolveSecret('')).toBeUndefined()
    expect(resolveSecret('   ')).toBeUndefined()
  })
})
