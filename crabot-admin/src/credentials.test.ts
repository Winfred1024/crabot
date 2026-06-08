import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, readCredentials, writeCredentials, DEFAULT_SCRYPT_PARAMS, type Credentials } from './credentials'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

async function makeTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'crab-cred-'))
}

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

describe('credentials read/write', () => {
  it('writeCredentials 原子写入，readCredentials 读回', async () => {
    const dir = await makeTmpDir()
    const cred: Credentials = {
      algo: 'scrypt',
      salt: 'aa',
      hash: 'bb',
      params: DEFAULT_SCRYPT_PARAMS,
      is_temp: true,
      token_epoch: 0,
      created_at: new Date().toISOString(),
      last_changed_at: new Date().toISOString(),
      changed_via: 'start',
    }
    await writeCredentials(dir, cred)

    const stat = await fs.stat(path.join(dir, 'credentials.json'))
    expect(stat.mode & 0o777).toBe(0o600)

    const read = await readCredentials(dir)
    expect(read).toEqual(cred)
  })

  it('readCredentials 在文件不存在且无 .env 时返回 null', async () => {
    const dir = await makeTmpDir()
    expect(await readCredentials(dir)).toBeNull()
  })

  it('readCredentials 在 JSON 损坏时抛错', async () => {
    const dir = await makeTmpDir()
    await fs.writeFile(path.join(dir, 'credentials.json'), 'not-json{', 'utf-8')
    await expect(readCredentials(dir)).rejects.toThrow()
  })
})
