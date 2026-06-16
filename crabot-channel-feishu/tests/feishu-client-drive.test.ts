import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'

const driveDownload = vi.fn(async (): Promise<{ getReadableStream: () => Readable; headers: Record<string, string> }> => ({
  getReadableStream: () => Readable.from([Buffer.from('PPTXBYTES')]),
  headers: { 'content-disposition': 'attachment; filename="plan.pptx"', 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
}))
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  Client: class {
    request = vi.fn(async () => ({ code: 0 }))
    drive = { v1: { file: { download: driveDownload } } }
  },
}))
import { FeishuClient } from '../src/feishu-client.js'

const client = () => new FeishuClient({ app_id: 'cli_x', app_secret: 's', domain: 'feishu' })

describe('FeishuClient.downloadDriveFile', () => {
  it('返回 buffer + 从响应头取 filename/mimeType', async () => {
    const r = await client().downloadDriveFile('boxT')
    expect(r.buffer.toString()).toBe('PPTXBYTES')
    expect(r.filename).toBe('plan.pptx')
    expect(r.mimeType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
  })
  it('无 content-disposition 时 filename 为 undefined', async () => {
    driveDownload.mockResolvedValueOnce({ getReadableStream: () => Readable.from([Buffer.from('X')]), headers: {} })
    const r = await client().downloadDriveFile('boxT')
    expect(r.filename).toBeUndefined()
  })
})
