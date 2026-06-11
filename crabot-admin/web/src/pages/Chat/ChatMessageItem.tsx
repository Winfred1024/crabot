/**
 * 单条聊天消息气泡（React.memo：函数式 setMessages 保持未变更消息的对象引用，
 * memo 后历史消息不随列表更新重渲染，ReactMarkdown 不重复解析）
 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { chatService } from '../../services/chat'
import { MessageMedia } from './MessageMedia'
import type { ChatMessage } from '../../types/chat'

/** 消息状态（从 index.tsx 迁入，UI 层扩展字段） */
export interface MessageState extends ChatMessage {
  status?: 'sending' | 'sent' | 'processing' | 'completed' | 'failed'
  reply_type?: 'direct_reply' | 'task_created' | 'task_completed' | 'task_failed'
  error?: string
}

export const ChatMessageItem = React.memo(function ChatMessageItem({ message }: { message: MessageState }) {
  const navigate = useNavigate()
  const isUser = message.role === 'user'
  const isProcessing = message.status === 'processing'

  // task_created 消息（含历史存量）渲染为居中单行系统提示样式
  if (message.task_id && message.content.text?.startsWith('已创建任务')) {
    return (
      <div style={{ textAlign: 'center', margin: '0.75rem 0' }}>
        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          ⚙ {message.content.text}
          <a
            onClick={(e) => { e.preventDefault(); navigate(`/traces?task_id=${encodeURIComponent(message.task_id!)}`) }}
            href="#"
            style={{ color: 'var(--primary)', marginLeft: '0.5rem', textDecoration: 'none' }}
          >
            详情 →
          </a>
        </span>
      </div>
    )
  }

  // reply_type 对应的提示信息
  const getReplyTypeHint = () => {
    // task_created 由系统提示行承载，不出提示文字
    if (message.reply_type !== 'task_completed' && message.reply_type !== 'task_failed') return null

    const hints = {
      task_completed: { text: '✓ 任务已完成', color: 'var(--success)' },
      task_failed: { text: '✗ 任务执行失败', color: 'var(--error)' },
    } as const

    const hint = hints[message.reply_type]

    return (
      <div
        style={{
          fontSize: '0.85rem',
          color: hint.color,
          marginBottom: '0.5rem',
          fontWeight: 500,
        }}
      >
        {hint.text}
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: '1rem',
      }}
    >
      <div
        style={{
          maxWidth: '80%',
          padding: '0.75rem 1rem',
          borderRadius: '12px',
          backgroundColor: isUser ? 'var(--primary)' : 'var(--bg-secondary)',
          color: isUser ? 'white' : 'var(--text-primary)',
          border: isUser ? 'none' : '1px solid var(--border)',
        }}
      >
        {isProcessing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div className="spinner" style={{ width: '16px', height: '16px', borderWidth: '2px' }} />
            <span style={{ color: 'var(--text-secondary)' }}>思考中...</span>
          </div>
        ) : (
          <>
            {getReplyTypeHint()}
            <div
              className="markdown-content"
              style={{
                wordBreak: 'break-word',
                lineHeight: '1.6',
              }}
            >
              {isUser ? (
                <div style={{ whiteSpace: 'pre-wrap' }}>{message.content.text}</div>
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    // worker 在正文 markdown 嵌 store 图时统一补 token
                    img: ({ src, alt }) => (
                      <img
                        src={typeof src === 'string' ? chatService.mediaSrc(src) : undefined}
                        alt={alt ?? ''}
                        style={{ maxWidth: '100%', borderRadius: '8px' }}
                      />
                    ),
                  }}
                >
                  {message.content.text ?? ''}
                </ReactMarkdown>
              )}
            </div>
            {message.content.media && message.content.media.length > 0 && (
              <MessageMedia media={message.content.media} />
            )}
            {message.error && (
              <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--error)' }}>
                {message.error}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
})
