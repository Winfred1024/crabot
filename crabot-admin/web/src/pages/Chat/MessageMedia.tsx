/**
 * 消息媒体渲染组件（图片网格 + lightbox + 文件下载行）
 */
import React, { useState } from 'react'
import { chatService } from '../../services/chat'
import type { MediaItem } from '../../types/chat'

function formatBytes(n?: number): string {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export const MessageMedia: React.FC<{ media: MediaItem[] }> = ({ media }) => {
  const [lightbox, setLightbox] = useState<string | null>(null)
  const images = media.filter((m) => m.mime_type.startsWith('image/'))
  const files = media.filter((m) => !m.mime_type.startsWith('image/'))

  return (
    <div style={{ marginTop: media.length > 0 ? '0.5rem' : 0 }}>
      {images.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {images.map((m, i) => (
            <img
              key={i}
              src={chatService.mediaSrc(m.media_url)}
              alt={m.filename ?? '图片'}
              onClick={() => setLightbox(chatService.mediaSrc(m.media_url))}
              onError={(e) => {
                ;(e.target as HTMLImageElement).style.opacity = '0.3'
                ;(e.target as HTMLImageElement).alt = '图片已过期或不可用'
              }}
              style={{
                maxWidth: '240px', maxHeight: '180px', borderRadius: '8px',
                border: '1px solid var(--border)', cursor: 'zoom-in', objectFit: 'cover',
              }}
            />
          ))}
        </div>
      )}
      {files.map((m, i) => (
        <a
          key={i}
          href={chatService.mediaSrc(m.media_url)}
          download={m.filename}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.4rem',
            padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid var(--border)',
            color: 'var(--text-primary)', textDecoration: 'none', fontSize: '0.9rem',
            backgroundColor: 'var(--surface)',
          }}
        >
          <span>📎</span>
          <span style={{ wordBreak: 'break-all' }}>{m.filename ?? m.media_url}</span>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{formatBytes(m.size)}</span>
        </a>
      ))}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1100, backgroundColor: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
          }}
        >
          <img src={lightbox} alt="放大查看" style={{ maxWidth: '92vw', maxHeight: '92vh', borderRadius: '8px' }} />
        </div>
      )}
    </div>
  )
}
