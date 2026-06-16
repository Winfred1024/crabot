import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MediaHandleStore } from '../src/media-handle-store'

let dir: string
let store: MediaHandleStore

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-mh-'))
  store = new MediaHandleStore(dir)
  await store.init()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('MediaHandleStore', () => {
  it('put 返回稳定 handle（fm_ 前缀），get 取回凭证', async () => {
    const handle = await store.put({
      platform_message_id: 'om_1',
      file_key: 'file_v3_x',
      kind: 'file',
      filename: 'a.pdf',
      mime_type: 'application/pdf',
      size: 5,
    })
    expect(handle).toMatch(/^fm_[0-9a-f]{12}$/)
    const rec = store.get(handle)
    expect(rec?.file_key).toBe('file_v3_x')
    expect(rec?.platform_message_id).toBe('om_1')
  })

  it('init 后能从磁盘恢复已存映射', async () => {
    const handle = await store.put({ platform_message_id: 'om_2', file_key: 'fk2', kind: 'file' })
    const store2 = new MediaHandleStore(dir)
    await store2.init()
    expect(store2.get(handle)?.file_key).toBe('fk2')
  })

  it('未知 handle 返回 undefined', () => {
    expect(store.get('fm_deadbeef0000')).toBeUndefined()
  })

  it('markDownloaded 写回 downloaded_file_path，get 能读到', async () => {
    const handle = await store.put({ platform_message_id: 'om_3', file_key: 'fk3', kind: 'file' })
    await store.markDownloaded(handle, '/data/media/om_3.pdf')
    expect(store.get(handle)?.downloaded_file_path).toBe('/data/media/om_3.pdf')
  })

  it('markDownloaded 后重新 init 仍保留（已落盘）', async () => {
    const handle = await store.put({ platform_message_id: 'om_4', file_key: 'fk4', kind: 'file' })
    await store.markDownloaded(handle, '/data/media/om_4.pdf')
    const store2 = new MediaHandleStore(dir)
    await store2.init()
    expect(store2.get(handle)?.downloaded_file_path).toBe('/data/media/om_4.pdf')
  })

  it('markDownloaded 未知 handle → 静默 no-op', async () => {
    await expect(store.markDownloaded('fm_000000000000', '/x')).resolves.toBeUndefined()
  })

  it('setSessionId 写回 session_id，get 能读到', async () => {
    const handle = await store.put({ platform_message_id: 'om_s', file_key: 'fk', kind: 'file' })
    await store.setSessionId(handle, 'sess_123')
    expect(store.get(handle)?.session_id).toBe('sess_123')
  })

  it('setSessionId 未知 handle → 静默 no-op', async () => {
    await expect(store.setSessionId('fm_000000000000', 'sess_x')).resolves.toBeUndefined()
  })
})
