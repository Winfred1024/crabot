/**
 * 暂存上传存储测试：stage/resolve/discard + TTL 清扫 + 启动清孤儿。
 *
 * 最佳实践：两步流程的大文件暂存，清理不依赖客户端——TTL 后台清扫兜底取消/放弃，
 * finally discard 兜底执行失败，init 清扫兜底进程重启孤儿。对齐 media-store.ts 的 sweepExpired 范式。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StagedUploadStore } from './staged-upload-store.js'

let baseDir: string

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-staged-'))
})
afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true })
})

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false)
}

describe('StagedUploadStore', () => {
  it('stage 返回 token + 路径，resolve 取回路径', async () => {
    const store = new StagedUploadStore(baseDir)
    await store.init()

    const { token, path: p } = store.stage(1000)
    await fs.writeFile(p, 'x')

    expect(store.resolve(token)).toBe(p)
    expect(await exists(p)).toBe(true)
  })

  it('discard 删文件 + 删记录（成功/失败/取消共用）', async () => {
    const store = new StagedUploadStore(baseDir)
    await store.init()
    const { token, path: p } = store.stage(1000)
    await fs.writeFile(p, 'x')

    await store.discard(token)

    expect(store.resolve(token)).toBeUndefined()
    expect(await exists(p)).toBe(false)
  })

  it('discard 不存在的 token → 安静返回', async () => {
    const store = new StagedUploadStore(baseDir)
    await store.init()
    await expect(store.discard('nope')).resolves.toBeUndefined()
  })

  it('sweepExpired 清掉超过 TTL 的，保留新鲜的', async () => {
    const store = new StagedUploadStore(baseDir, { ttlMs: 1000 })
    await store.init()
    const old = store.stage(0)
    const fresh = store.stage(900)
    await fs.writeFile(old.path, 'x')
    await fs.writeFile(fresh.path, 'x')

    const swept = await store.sweepExpired(1000) // old: 1000-0>=1000 清；fresh: 1000-900<1000 留

    expect(swept).toBe(1)
    expect(store.resolve(old.token)).toBeUndefined()
    expect(await exists(old.path)).toBe(false)
    expect(store.resolve(fresh.token)).toBe(fresh.path)
    expect(await exists(fresh.path)).toBe(true)
  })

  it('init 清扫上次进程残留的孤儿文件', async () => {
    const storeDir = path.join(baseDir, 'openclaw-import-staging')
    await fs.mkdir(storeDir, { recursive: true })
    const orphan = path.join(storeDir, 'leftover.tar.gz')
    await fs.writeFile(orphan, 'stale')

    const store = new StagedUploadStore(baseDir)
    await store.init()

    expect(await exists(orphan)).toBe(false)
  })
})
