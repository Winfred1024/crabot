import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MediaCleaner } from './media-cleaner.js'

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-'))
}

async function touch(filePath: string, mtimeMs: number): Promise<void> {
  await fsp.writeFile(filePath, 'x')
  const t = new Date(mtimeMs)
  await fsp.utimes(filePath, t, t)
}

test('sweepExpired 删超期留未超期', async () => {
  const dataDir = mkdtemp()
  const mediaDir = path.join(dataDir, 'media')
  await fsp.mkdir(mediaDir)

  const now = Date.now()
  const eightDaysAgo = now - 8 * 86400_000
  const oneDayAgo = now - 1 * 86400_000

  await touch(path.join(mediaDir, 'old.jpg'), eightDaysAgo)
  await touch(path.join(mediaDir, 'fresh.jpg'), oneDayAgo)

  const cleaner = new MediaCleaner(dataDir, 7)
  const deleted = await cleaner.sweepExpired(now)

  assert.equal(deleted, 1)
  assert.ok(!fs.existsSync(path.join(mediaDir, 'old.jpg')), 'old.jpg should be deleted')
  assert.ok(fs.existsSync(path.join(mediaDir, 'fresh.jpg')), 'fresh.jpg should remain')
})

test('sweepExpired 目录不存在返回 0', async () => {
  const dataDir = mkdtemp()
  // 不创建 media 子目录
  const cleaner = new MediaCleaner(dataDir, 7)
  const deleted = await cleaner.sweepExpired()
  assert.equal(deleted, 0)
})

test('startCleanup 立即触发扫描，stopCleanup 清除定时器', async () => {
  const dataDir = mkdtemp()
  const mediaDir = path.join(dataDir, 'media')
  await fsp.mkdir(mediaDir)

  const now = Date.now()
  const tenDaysAgo = now - 10 * 86400_000
  await touch(path.join(mediaDir, 'very-old.png'), tenDaysAgo)

  const cleaner = new MediaCleaner(dataDir, 7)
  cleaner.startCleanup()

  // 等待立即扫描完成
  await new Promise<void>((r) => setTimeout(r, 50))

  assert.ok(!fs.existsSync(path.join(mediaDir, 'very-old.png')), 'very-old.png should be cleaned up immediately')

  // stopCleanup 不抛错
  cleaner.stopCleanup()
})

test('stopCleanup 可重复调用不抛错', () => {
  const dataDir = mkdtemp()
  const cleaner = new MediaCleaner(dataDir, 7)
  cleaner.stopCleanup()
  cleaner.stopCleanup()
})
