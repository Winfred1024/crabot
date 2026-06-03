/**
 * MediaResolver - 将 ChannelMessage 中的媒体内容解析为 engine ImageBlock
 *
 * 处理本地文件路径（base64 编码）和远程 URL（下载后 base64 编码）。
 * 任何错误静默降级，不影响文本消息处理。
 */

import { promises as fs } from 'fs'
import type { ImageBlock } from '../engine/types.js'
import type { ChannelMessage } from '../types'

const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20MB
const SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** formatMessageContent 在 text + mediaRef 都空时的兜底返回值。
 *  调用方过滤"空消息"时应 import 这个常量做 sentinel 比较，避免字符串字面量耦合。 */
export const EMPTY_MESSAGE_PLACEHOLDER = '[非文本消息]'
type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export function inferMediaType(mimeType?: string, filePath?: string): ImageMediaType {
  if (mimeType && SUPPORTED_MIME_TYPES.has(mimeType)) {
    return mimeType as ImageMediaType
  }
  if (filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase()
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'png') return 'image/png'
    if (ext === 'gif') return 'image/gif'
    if (ext === 'webp') return 'image/webp'
  }
  return 'image/png'
}

async function readLocalFile(filePath: string): Promise<Buffer | null> {
  try {
    const buffer = await fs.readFile(filePath)
    if (buffer.length > MAX_IMAGE_SIZE) return null
    return buffer
  } catch {
    return null
  }
}

async function fetchRemoteImage(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    if (buffer.length > MAX_IMAGE_SIZE) return null
    return buffer
  } catch {
    return null
  }
}

function formatMediaRef(msg: ChannelMessage): string {
  if (!msg.content.media_url) return ''
  switch (msg.content.type) {
    case 'image':
      return `[图片: ${msg.content.media_url}]`
    case 'file':
      return `[文件: ${msg.content.filename ?? msg.content.media_url}]`
    default:
      return ''
  }
}

/**
 * system_event 类型的消息渲染：把 affected_users 的 display_name + open_id
 * 都暴露给 LLM，否则 agent 想 @ 这些人时拿不到 ID。
 * 形如："已加入：张三 (open_id=ou_a), 李四 (open_id=ou_b)"
 */
function formatSystemEvent(msg: ChannelMessage): string {
  const text = msg.content.text ?? ''
  const affected = msg.content.affected_users ?? []
  if (affected.length === 0) return text
  const listing = affected
    .map((u) => `${u.platform_display_name} (open_id=${u.platform_user_id})`)
    .join(', ')
  // text 是 channel 给的人类可读句子（如 "已加入：张三、李四"），
  // 在它后面拼一行带 ID 的结构化清单给 LLM 用。
  return text ? `${text}\n[event_affected_users] ${listing}` : `[event_affected_users] ${listing}`
}

/**
 * 将消息内容格式化为可读文本。
 * 同时保留文本内容和媒体引用（图片、文件等），两者都有时用换行拼接。
 */
export function formatMessageContent(msg: ChannelMessage): string {
  if (msg.content.type === 'system_event') {
    return formatSystemEvent(msg)
  }
  const text = msg.content.text ?? ''
  const mediaRef = formatMediaRef(msg)

  if (text && mediaRef) return `${text}\n${mediaRef}`
  if (text) return text
  if (mediaRef) return mediaRef
  return EMPTY_MESSAGE_PLACEHOLDER
}

/**
 * 从 ChannelMessage 列表中解析图片为 engine ImageBlock
 */
export async function resolveImageBlocks(
  messages: ChannelMessage[]
): Promise<ImageBlock[]> {
  // Fast path: skip all I/O if no image messages present
  const imageMessages = messages.filter(
    (msg) => msg.content.type === 'image' && msg.content.media_url
  )
  if (imageMessages.length === 0) return []

  // Resolve all images in parallel
  const results = await Promise.all(
    imageMessages.map(async (msg): Promise<ImageBlock | null> => {
      const url = msg.content.media_url!
      const isRemote = url.startsWith('http://') || url.startsWith('https://')
      const buffer = isRemote
        ? await fetchRemoteImage(url)
        : await readLocalFile(url)

      if (!buffer) return null

      const mediaType = inferMediaType(msg.content.mime_type, url)
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: buffer.toString('base64'),
        },
      }
    })
  )

  return results.filter((block): block is ImageBlock => block !== null)
}

/**
 * 从文件路径列表解析图片为 engine ImageBlock。
 * 供 Worker buildTaskMessage 和 Sub-agent image_paths 参数复用。
 */
export async function resolveImageFromPaths(
  paths: ReadonlyArray<string>
): Promise<ImageBlock[]> {
  const results = await Promise.all(
    paths.map(async (filePath): Promise<ImageBlock | null> => {
      const buffer = await readLocalFile(filePath)
      if (!buffer) return null

      const mediaType = inferMediaType(undefined, filePath)
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: buffer.toString('base64'),
        },
      }
    })
  )
  return results.filter((block): block is ImageBlock => block !== null)
}
