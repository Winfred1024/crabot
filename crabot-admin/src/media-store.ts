/**
 * MediaStore — 带 TTL 的简易媒体存储（spec 2026-06-10-master-chat-redesign Phase 2 / protocol-admin §3.20.4）
 *
 * 目录布局：{baseDir}/media-store/<uuid><ext> + index.json（元数据）+ config.json（ttl_days）。
 * 临时存储定位：每日清扫超期文件，引用方（聊天历史）过期后显示占位。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { MediaItem, MediaStoreConfig, MediaUsage } from './types.js'

interface MediaIndexEntry {
  id: string
  ext: string
  filename: string
  mime_type: string
  size: number
  created_at: string
}

const DEFAULT_TTL_DAYS = 30
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** mime → 扩展名（仅常见类型，未知用 .bin） */
function extFor(mime: string, filename?: string): string {
  const fromName = filename ? path.extname(filename) : ''
  if (fromName && /^\.[A-Za-z0-9]{1,8}$/.test(fromName)) return fromName.toLowerCase()
  const map: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'application/pdf': '.pdf', 'text/plain': '.txt',
  }
  return map[mime] ?? '.bin'
}

export class MediaStore {
  private index: Map<string, MediaIndexEntry> = new Map()
  private config: MediaStoreConfig = { ttl_days: DEFAULT_TTL_DAYS }
  private readonly storeDir: string
  private readonly indexPath: string
  private readonly configPath: string

  constructor(baseDir: string) {
    this.storeDir = path.join(baseDir, 'media-store')
    this.indexPath = path.join(this.storeDir, 'index.json')
    this.configPath = path.join(this.storeDir, 'config.json')
  }

  async init(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true })
    try {
      const entries = JSON.parse(await fs.readFile(this.indexPath, 'utf-8')) as MediaIndexEntry[]
      this.index = new Map(entries.map((e) => [e.id, e]))
    } catch { /* 首次启动无 index */ }
    try {
      const cfg = JSON.parse(await fs.readFile(this.configPath, 'utf-8')) as MediaStoreConfig
      if (typeof cfg.ttl_days === 'number') this.config = { ttl_days: cfg.ttl_days }
    } catch { /* 默认配置 */ }
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    // tmp 名带随机后缀：并发 saveIndex 时共享固定 tmp 名会让先 rename 的一方
    // 把另一方的 tmp 抢走（ENOENT），调用方平白收到失败
    const tmp = `${filePath}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(tmp, content, 'utf-8')
    await fs.rename(tmp, filePath)
  }

  private async saveIndex(): Promise<void> {
    await this.atomicWrite(this.indexPath, JSON.stringify(Array.from(this.index.values()), null, 2))
  }

  private filePathOf(entry: MediaIndexEntry): string {
    return path.join(this.storeDir, `${entry.id}${entry.ext}`)
  }

  private toItem(entry: MediaIndexEntry): MediaItem {
    return {
      media_url: `/api/media/${entry.id}`,
      mime_type: entry.mime_type,
      filename: entry.filename,
      size: entry.size,
    }
  }

  async saveBuffer(
    buf: Buffer,
    opts: { filename: string; mime_type: string },
  ): Promise<{ id: string; abs_path: string; item: MediaItem }> {
    const id = crypto.randomUUID()
    const entry: MediaIndexEntry = {
      id,
      ext: extFor(opts.mime_type, opts.filename),
      filename: opts.filename,
      mime_type: opts.mime_type,
      size: buf.length,
      created_at: new Date().toISOString(),
    }
    const absPath = this.filePathOf(entry)
    await fs.writeFile(absPath, buf)
    this.index.set(id, entry)
    await this.saveIndex()
    return { id, abs_path: path.resolve(absPath), item: this.toItem(entry) }
  }

  /** 复制外部文件进 store（出站收存：worker 的 file_path / 本地路径形态 media_url） */
  async ingestFile(
    srcAbsPath: string,
    opts?: { filename?: string; mime_type?: string },
  ): Promise<MediaItem> {
    const buf = await fs.readFile(srcAbsPath)
    const filename = opts?.filename ?? path.basename(srcAbsPath)
    const mime = opts?.mime_type ?? 'application/octet-stream'
    const { item } = await this.saveBuffer(buf, { filename, mime_type: mime })
    return item
  }

  /** id → 磁盘信息；非法/不存在返回 null（id 白名单防路径穿越） */
  resolve(id: string): { abs_path: string; mime_type: string; filename: string } | null {
    if (!UUID_PATTERN.test(id)) return null
    const entry = this.index.get(id)
    if (!entry) return null
    return {
      abs_path: path.resolve(this.filePathOf(entry)),
      mime_type: entry.mime_type,
      filename: entry.filename,
    }
  }

  async getUsage(): Promise<MediaUsage> {
    let total = 0
    for (const entry of this.index.values()) total += entry.size
    return { file_count: this.index.size, total_bytes: total, ttl_days: this.config.ttl_days }
  }

  getConfig(): MediaStoreConfig {
    return { ...this.config }
  }

  async setConfig(cfg: MediaStoreConfig): Promise<void> {
    if (!Number.isInteger(cfg.ttl_days) || cfg.ttl_days < 1 || cfg.ttl_days > 365) {
      throw new Error('ttl_days 必须是 1-365 的整数')
    }
    this.config = { ttl_days: cfg.ttl_days }
    await this.atomicWrite(this.configPath, JSON.stringify(this.config, null, 2))
  }

  /** 清扫超期文件；返回删除数。失败的单个文件跳过不中断。 */
  async sweepExpired(nowMs: number = Date.now()): Promise<number> {
    const ttlMs = this.config.ttl_days * 86400_000
    let deleted = 0
    for (const entry of Array.from(this.index.values())) {
      if (nowMs - Date.parse(entry.created_at) <= ttlMs) continue
      try {
        await fs.unlink(this.filePathOf(entry)).catch(() => {})
        this.index.delete(entry.id)
        deleted++
      } catch { /* 单文件失败跳过 */ }
    }
    if (deleted > 0) await this.saveIndex()
    return deleted
  }
}
