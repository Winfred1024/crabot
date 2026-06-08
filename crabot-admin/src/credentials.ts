import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
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

const FILE_NAME = 'credentials.json'

export async function readCredentials(dataDir: string): Promise<Credentials | null> {
  const target = path.join(dataDir, FILE_NAME)
  try {
    const raw = await fs.readFile(target, 'utf-8')
    return JSON.parse(raw) as Credentials
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
}

export async function writeCredentials(dataDir: string, c: Credentials): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  const tmp = path.join(dataDir, `${FILE_NAME}.tmp.${process.pid}`)
  const target = path.join(dataDir, FILE_NAME)
  await fs.writeFile(tmp, JSON.stringify(c, null, 2), { mode: 0o600 })
  await fs.rename(tmp, target)
}
