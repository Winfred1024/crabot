import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  Client: class {
    request = vi.fn(async () => ({ code: 0 }))
    im = {
      message: { create: vi.fn(), reply: vi.fn(), get: vi.fn(), list: vi.fn() },
      messageResource: { get: vi.fn() },
      chat: { list: vi.fn(async () => ({ data: { items: [], has_more: false } })) },
      chatMembers: { get: vi.fn() }, image: { create: vi.fn() }, file: { create: vi.fn() },
    }
    contact = { v3: { user: { get: vi.fn(), list: vi.fn() } } }
  },
  WSClient: class { start() { return Promise.resolve() } close() { return Promise.resolve() } },
  EventDispatcher: class { register() { return this } },
}))

import { FeishuChannel } from '../src/feishu-channel'
import { mapMessageContent } from '../src/event-mapper'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1])
let dir: string
let channel: FeishuChannel

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-lazy-'))
  channel = new FeishuChannel({
    module_id: 'channel-feishu-test', module_type: 'channel', version: '0', protocol_version: '0',
    port: 0, data_dir: dir,
    feishu: { app_id: 'cli_x', app_secret: 's', domain: 'feishu', only_respond_to_mentions: true, markdown_format: 'auto' },
  })
  await (channel as any).mediaHandleStore.init()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('飞书入站惰性媒体', () => {
  it('图片：急切下载，写 file_path + status=ready', async () => {
    ;(channel as any).client.downloadResource = vi.fn(async () => PNG)
    const mapped = mapMessageContent('image', JSON.stringify({ image_key: 'img_x' }), [])
    const content = await (channel as any).applyMediaContent(mapped, 'om_img')
    expect(content.type).toBe('image')
    expect(content.status).toBe('ready')
    expect(content.file_path).toMatch(/[/\\]media[/\\]om_img\.png$/)
    expect(fs.existsSync(content.file_path)).toBe(true)
  })

  it('文件：不下载，只产 handle + status=not_fetched + 元信息', async () => {
    const download = vi.fn(async () => Buffer.from('x'))
    ;(channel as any).client.downloadResource = download
    const mapped = mapMessageContent('file', JSON.stringify({ file_key: 'file_x', file_name: 'a.pdf', file_size: 5 }), [])
    const content = await (channel as any).applyMediaContent(mapped, 'om_file')
    expect(content.type).toBe('file')
    expect(content.status).toBe('not_fetched')
    expect(content.handle).toMatch(/^fm_[0-9a-f]{12}$/)
    expect(content.filename).toBe('a.pdf')
    expect(content.size).toBe(5)
    expect(content.file_path).toBeUndefined()
    expect(download).not.toHaveBeenCalled()
    expect((channel as any).mediaHandleStore.get(content.handle)?.file_key).toBe('file_x')
  })
})
