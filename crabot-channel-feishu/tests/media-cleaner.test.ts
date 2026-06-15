import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { MediaCleaner } from '../src/media-cleaner'

let dir: string
let mediaDir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-gc-'))
  mediaDir = path.join(dir, 'media')
  fs.mkdirSync(mediaDir, { recursive: true })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('MediaCleaner.sweepExpired', () => {
  it('删超期文件、留未超期、返回删除数', async () => {
    const oldFile = path.join(mediaDir, 'old.pdf')
    const freshFile = path.join(mediaDir, 'fresh.pdf')
    await fsp.writeFile(oldFile, 'old')
    await fsp.writeFile(freshFile, 'fresh')
    const eightDaysAgo = new Date(Date.now() - 8 * 86400_000)
    await fsp.utimes(oldFile, eightDaysAgo, eightDaysAgo)

    const cleaner = new MediaCleaner(dir, 7)
    const deleted = await cleaner.sweepExpired()

    expect(deleted).toBe(1)
    expect(fs.existsSync(oldFile)).toBe(false)
    expect(fs.existsSync(freshFile)).toBe(true)
  })

  it('media 目录不存在 → 返回 0 不抛', async () => {
    fs.rmSync(mediaDir, { recursive: true, force: true })
    const cleaner = new MediaCleaner(dir, 7)
    await expect(cleaner.sweepExpired()).resolves.toBe(0)
  })

  it('startCleanup 立即扫一次 + 可 stopCleanup（无泄漏）', async () => {
    const oldFile = path.join(mediaDir, 'old.bin')
    await fsp.writeFile(oldFile, 'x')
    const eightDaysAgo = new Date(Date.now() - 8 * 86400_000)
    await fsp.utimes(oldFile, eightDaysAgo, eightDaysAgo)

    const cleaner = new MediaCleaner(dir, 7)
    cleaner.startCleanup()
    await new Promise((r) => setTimeout(r, 50))
    expect(fs.existsSync(oldFile)).toBe(false)
    cleaner.stopCleanup()
  })
})
