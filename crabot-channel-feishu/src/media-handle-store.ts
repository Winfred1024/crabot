/**
 * MediaHandleStore — handle → 下载凭证 的持久化映射。
 *
 * 入站非图片文件登记一条映射；agent 用 handle 调 fetch_media 时凭此重新解析
 * file_key 下载。本地文件被 GC 后仍可凭 handle 重下，故映射须独立于 data/media 持久化。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export interface MediaHandleRecord {
  platform_message_id: string
  file_key: string
  kind: 'image' | 'file'
  filename?: string
  mime_type?: string
  size?: number
}

export class MediaHandleStore {
  private readonly filePath: string
  private map: Map<string, MediaHandleRecord> = new Map()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'media-handles.json')
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as Record<string, MediaHandleRecord>
      this.map = new Map(Object.entries(raw))
    } catch {
      /* 首次启动无文件 */
    }
  }

  async put(rec: MediaHandleRecord): Promise<string> {
    const handle = `fm_${randomBytes(6).toString('hex')}`
    this.map = new Map(this.map).set(handle, rec)
    try {
      await this.persist()
    } catch (err) {
      // 落盘失败：handle 本次进程内有效（已在内存 map），但重启后丢失。
      // 不上抛——避免一条媒体消息因落盘问题被整体丢弃。
      console.warn('[MediaHandleStore] persist failed, handle will be lost on restart:', err)
    }
    return handle
  }

  get(handle: string): MediaHandleRecord | undefined {
    return this.map.get(handle)
  }

  private async persist(): Promise<void> {
    const obj = Object.fromEntries(this.map)
    const tmp = `${this.filePath}.${randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8')
    await fs.rename(tmp, this.filePath)
  }
}
