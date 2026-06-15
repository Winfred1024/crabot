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
})
