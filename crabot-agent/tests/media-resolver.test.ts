import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveImageBlocks, formatMessageContent } from '../src/agent/media-resolver.js'
import type { ChannelMessage } from '../src/types.js'

const TMP = './test-data/media-resolver-test'

function msg(content: ChannelMessage['content']): ChannelMessage {
  return {
    platform_message_id: 'm1',
    session: { session_id: 's', channel_id: 'admin-web', type: 'private' },
    sender: { platform_user_id: 'master', platform_display_name: 'Master' },
    content,
    platform_timestamp: '2026-06-11T00:00:00Z',
  } as ChannelMessage
}

describe('media[] 多图注入', () => {
  let img1: string
  let img2: string

  beforeAll(async () => {
    await fs.mkdir(TMP, { recursive: true })
    img1 = path.resolve(TMP, 'a.png')
    img2 = path.resolve(TMP, 'b.jpg')
    await fs.writeFile(img1, Buffer.from('89504e470d0a1a0a', 'hex'))
    await fs.writeFile(img2, Buffer.from('ffd8ffe0', 'hex'))
  })
  afterAll(async () => {
    await fs.rm(TMP, { recursive: true, force: true })
  })

  it('一条消息 media[] 两张图 → 两个 ImageBlock', async () => {
    const blocks = await resolveImageBlocks([
      msg({
        type: 'image',
        text: '两张图',
        media: [
          { media_url: img1, mime_type: 'image/png' },
          { media_url: img2, mime_type: 'image/jpeg' },
        ],
        media_url: img1,
      }),
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0].source.media_type).toBe('image/png')
    expect(blocks[1].source.media_type).toBe('image/jpeg')
  })

  it('media[] 混合图片+文件 → 只注入图片', async () => {
    const blocks = await resolveImageBlocks([
      msg({
        type: 'image',
        media: [
          { media_url: img1, mime_type: 'image/png' },
          { media_url: path.resolve(TMP, 'doc.pdf'), mime_type: 'application/pdf', filename: 'doc.pdf' },
        ],
        media_url: img1,
      }),
    ])
    expect(blocks).toHaveLength(1)
  })

  it('遗留单 media_url 路径不回归', async () => {
    const blocks = await resolveImageBlocks([
      msg({ type: 'image', media_url: img1, mime_type: 'image/png' }),
    ])
    expect(blocks).toHaveLength(1)
  })

  it('formatMessageContent：media[] 渲染多行标记', () => {
    const out = formatMessageContent(
      msg({
        type: 'image',
        text: '看这些',
        media: [
          { media_url: img1, mime_type: 'image/png', filename: 'a.png' },
          { media_url: '/x/doc.pdf', mime_type: 'application/pdf', filename: 'doc.pdf' },
        ],
        media_url: img1,
      })
    )
    expect(out).toContain('看这些')
    expect(out).toContain('[图片: a.png]')
    expect(out).toContain('[文件: doc.pdf]')
  })
})
