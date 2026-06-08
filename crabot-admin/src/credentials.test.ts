import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, DEFAULT_SCRYPT_PARAMS } from './credentials'

describe('credentials hash/verify', () => {
  it('hashPassword 产出可验证的 hash', async () => {
    const { salt, hash, params } = await hashPassword('hello-world')

    expect(salt).toMatch(/^[0-9a-f]{32}$/) // 16 bytes hex
    expect(hash).toMatch(/^[0-9a-f]+$/)
    expect(params).toEqual(DEFAULT_SCRYPT_PARAMS)

    expect(await verifyPassword('hello-world', { salt, hash, params })).toBe(true)
    expect(await verifyPassword('wrong', { salt, hash, params })).toBe(false)
  })

  it('同样密码两次 hash 产生不同 salt 与 hash', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
  })
})
