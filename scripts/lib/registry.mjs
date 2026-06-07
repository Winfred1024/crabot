import { readFileSync, writeFileSync } from 'node:fs'
import lockfile from 'proper-lockfile'

const MIN_OFFSET = 100
const MAX_OFFSET = 9900
const STEP = 100

export function readRegistry(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return []
  }
}

/**
 * 申请 offset，原子操作（文件锁）。同名 user 复用旧 offset。
 *
 * @param {string} path - registry 文件绝对路径（必须已存在）
 * @param {{user: string, hostname: string, pidAtInit?: number}} info
 * @returns {Promise<{offset: number, reused: boolean}>}
 */
export async function allocateOffset(path, { user, hostname, pidAtInit = -1 }) {
  const release = await lockfile.lock(path, { retries: { retries: 5, minTimeout: 50 } })
  try {
    const reg = readRegistry(path)
    const existing = reg.find(e => e.user === user)
    if (existing) {
      return { offset: existing.offset, reused: true }
    }
    const occupied = new Set(reg.map(e => e.offset))
    let off = MIN_OFFSET
    while (off <= MAX_OFFSET && occupied.has(off)) off += STEP
    if (off > MAX_OFFSET) {
      throw new Error(`no available offset in [${MIN_OFFSET}, ${MAX_OFFSET}]`)
    }
    reg.push({
      offset: off,
      user,
      hostname,
      pid_at_init: pidAtInit,
      claimed_at: new Date().toISOString(),
    })
    writeFileSync(path, JSON.stringify(reg, null, 2) + '\n')
    return { offset: off, reused: false }
  } finally {
    await release()
  }
}
