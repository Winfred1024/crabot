import * as crypto from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>

export interface ScryptParams {
  N: number
  r: number
  p: number
  keylen: number
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
}

export interface Credentials {
  algo: 'scrypt'
  salt: string
  hash: string
  params: ScryptParams
  is_temp: boolean
  token_epoch: number
  created_at: string
  last_changed_at: string
  changed_via: 'start' | 'cli' | 'ui'
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<{ salt: string; hash: string; params: ScryptParams }> {
  const salt = crypto.randomBytes(16).toString('hex')
  const buf = await scryptAsync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
  })
  return { salt, hash: buf.toString('hex'), params }
}

export async function verifyPassword(
  password: string,
  c: Pick<Credentials, 'salt' | 'hash' | 'params'>,
): Promise<boolean> {
  const buf = await scryptAsync(password, c.salt, c.params.keylen, {
    N: c.params.N,
    r: c.params.r,
    p: c.params.p,
  })
  const actual = buf.toString('hex')
  if (actual.length !== c.hash.length) return false
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(c.hash, 'hex'))
}
