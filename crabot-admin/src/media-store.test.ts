/**
 * MediaStore — 带 TTL 的简易媒体存储
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { MediaStore } from './media-store.js'

const TEST_DIR = './test-data/media-store-test'

async function makeStore(): Promise<MediaStore> {
  const store = new MediaStore(TEST_DIR)
  await store.init()
  return store
}

describe('MediaStore', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
  })
  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('saveBuffer：落盘 + 返回 MediaItem（store URL）+ resolve 可取回', async () => {
    const store = await makeStore()
    const saved = await store.saveBuffer(Buffer.from('png-bytes'), { filename: '截图.png', mime_type: 'image/png' })
    expect(saved.item.media_url).toMatch(/^\/api\/media\//)
    expect(saved.item.mime_type).toBe('image/png')
    expect(saved.item.filename).toBe('截图.png')
    expect(saved.item.size).toBe(9)

    const resolved = store.resolve(saved.id)
    expect(resolved).not.toBeNull()
    expect(await fs.readFile(resolved!.abs_path, 'utf-8')).toBe('png-bytes')
  })

  it('ingestFile：复制外部文件进 store（原文件不动）', async () => {
    const store = await makeStore()
    const src = path.join(TEST_DIR, 'outside.pdf')
    await fs.writeFile(src, 'pdf-bytes')
    const item = await store.ingestFile(src, { filename: 'report.pdf', mime_type: 'application/pdf' })
    expect(item.media_url).toMatch(/^\/api\/media\//)
    expect(await fs.readFile(src, 'utf-8')).toBe('pdf-bytes') // 原文件保留
  })

  it('resolve 非法 id（路径穿越）返回 null', async () => {
    const store = await makeStore()
    expect(store.resolve('../../etc/passwd')).toBeNull()
    expect(store.resolve('..%2f..')).toBeNull()
  })

  it('持久化：新实例 init 后 index 仍可 resolve', async () => {
    const store = await makeStore()
    const saved = await store.saveBuffer(Buffer.from('x'), { filename: 'a.txt', mime_type: 'text/plain' })
    const store2 = await makeStore()
    expect(store2.resolve(saved.id)).not.toBeNull()
  })

  it('并发 saveBuffer：两次都成功且 index 持久化完整', async () => {
    const store = await makeStore()
    const [a, b] = await Promise.all([
      store.saveBuffer(Buffer.from('a'), { filename: 'a', mime_type: 'text/plain' }),
      store.saveBuffer(Buffer.from('b'), { filename: 'b', mime_type: 'text/plain' }),
    ])
    expect(store.resolve(a.id)).not.toBeNull()
    expect(store.resolve(b.id)).not.toBeNull()
    const store2 = await makeStore()
    expect(store2.resolve(a.id)).not.toBeNull()
    expect(store2.resolve(b.id)).not.toBeNull()
  })

  it('getUsage 统计数量与字节数', async () => {
    const store = await makeStore()
    await store.saveBuffer(Buffer.from('12345'), { filename: 'a', mime_type: 'text/plain' })
    await store.saveBuffer(Buffer.from('123'), { filename: 'b', mime_type: 'text/plain' })
    const usage = await store.getUsage()
    expect(usage.file_count).toBe(2)
    expect(usage.total_bytes).toBe(8)
    expect(usage.ttl_days).toBe(30) // 默认值
  })

  it('setConfig 持久化 TTL，越界拒绝', async () => {
    const store = await makeStore()
    await store.setConfig({ ttl_days: 7 })
    const store2 = await makeStore()
    expect((await store2.getUsage()).ttl_days).toBe(7)
    await expect(store.setConfig({ ttl_days: 0 })).rejects.toThrow()
    await expect(store.setConfig({ ttl_days: 9999 })).rejects.toThrow()
  })

  it('sweepExpired：超期文件删除、未超期保留、index 同步', async () => {
    const store = await makeStore()
    const old = await store.saveBuffer(Buffer.from('old'), { filename: 'old', mime_type: 'text/plain' })
    const fresh = await store.saveBuffer(Buffer.from('new'), { filename: 'new', mime_type: 'text/plain' })
    // 记录超期文件的绝对路径，用于验证物理删除
    const oldAbsPath = old.abs_path
    // 把 old 的 created_at 改到 31 天前（直接操作内部 index 再触发 sweep）
    ;(store as any).index.get(old.id).created_at = new Date(Date.now() - 31 * 86400_000).toISOString()
    const deleted = await store.sweepExpired()
    expect(deleted).toBe(1)
    expect(store.resolve(old.id)).toBeNull()
    expect(store.resolve(fresh.id)).not.toBeNull()
    // 磁盘文件已物理删除
    await expect(fs.access(oldAbsPath)).rejects.toBeDefined()
  })
})
