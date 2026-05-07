import { describe, it, expect } from 'vitest'
import { formatWechatContent } from '../src/format-wechat-content.js'

describe('formatWechatContent quote (type=18) with quoted_resource_url', () => {
  it('quotes an image: lifts content.type to image and exposes media_url', () => {
    const { content, features } = formatWechatContent(18, {
      text: '看下这张',
      quoted_sender_name: '张三',
      quoted_content: '[图片]',
      quoted_svr_id: 'svr-123',
      quoted_msg_type: 1,
      quoted_resource_url: 'https://cdn.example.com/abc.jpg',
    })

    expect(content.type).toBe('image')
    expect(content.media_url).toBe('https://cdn.example.com/abc.jpg')
    expect(content.text).toContain('> 张三: [图片]')
    expect(content.text).toContain('看下这张')
    expect(features.quote_message_id).toBe('svr-123')
  })

  it('quotes an emoji (type=47): lifts to image', () => {
    const { content } = formatWechatContent(18, {
      text: '哈哈',
      quoted_sender_name: '李四',
      quoted_content: '[表情]',
      quoted_msg_type: 47,
      quoted_resource_url: 'https://cdn.example.com/emoji.gif',
    })

    expect(content.type).toBe('image')
    expect(content.media_url).toBe('https://cdn.example.com/emoji.gif')
  })

  it('quotes a video (type=43): lifts to file with video mime', () => {
    const { content } = formatWechatContent(18, {
      text: '这段',
      quoted_sender_name: '王五',
      quoted_content: '[视频]',
      quoted_msg_type: 43,
      quoted_resource_url: 'https://cdn.example.com/v.mp4',
    })

    expect(content.type).toBe('file')
    expect(content.media_url).toBe('https://cdn.example.com/v.mp4')
    expect(content.mime_type).toBe('video/mp4')
  })

  it('quotes a text (no quoted_resource_url): stays as text', () => {
    const { content, features } = formatWechatContent(18, {
      text: '同意',
      quoted_sender_name: '张三',
      quoted_content: '我之前说的那个事',
      quoted_svr_id: 'svr-9',
      quoted_msg_type: 0,
    })

    expect(content.type).toBe('text')
    expect(content.text).toContain('> 张三: 我之前说的那个事')
    expect(content.text).toContain('同意')
    expect(features.quote_message_id).toBe('svr-9')
  })

  it('quote without quoted_msg_type: falls back to text even if URL exists', () => {
    const { content } = formatWechatContent(18, {
      text: 'reply',
      quoted_content: '[图片]',
      quoted_resource_url: 'https://cdn.example.com/x.jpg',
    })

    expect(content.type).toBe('text')
  })

  it('quote when quotedContent missing: still emits placeholder line', () => {
    const { content } = formatWechatContent(18, {
      text: '回复',
      quoted_sender_name: '张三',
    })

    expect(content.type).toBe('text')
    expect(content.text).toContain('> 张三: [消息]')
  })
})
