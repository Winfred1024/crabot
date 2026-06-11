import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MainLayout } from '../../components/Layout/MainLayout'
import { chatService } from '../../services/chat'
import type { ChatMessage, ChatMessageContent, ChatServerMessage, ChatTaskSnapshot, ConnectionStatus } from '../../types/chat'
import { TaskStatusCard } from './TaskStatusCard'
import { MessageMedia } from './MessageMedia'
import { ChatSettingsModal } from './ChatSettingsModal'
import { useToast } from '../../contexts/ToastContext'

/** 消息状态 */
interface MessageState extends ChatMessage {
  status?: 'sending' | 'sent' | 'processing' | 'completed' | 'failed'
  reply_type?: 'direct_reply' | 'task_created' | 'task_completed' | 'task_failed'
  error?: string
  /** 任务状态卡数据（chat_task_update 推送 / 历史 hydrate） */
  task?: ChatTaskSnapshot
}

const PAGE_SIZE = 30

/** 同一本地日判定 */
function sameLocalDay(a: string, b: string): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
}

/** 日期分隔标签：今天 / 昨天 / yyyy年M月d日 */
function formatDateLabel(ts: string): string {
  const d = new Date(ts)
  const now = new Date()
  if (sameLocalDay(ts, now.toISOString())) return '今天'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameLocalDay(ts, yesterday.toISOString())) return '昨天'
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

export const Chat: React.FC = () => {
  const toast = useToast()
  const [messages, setMessages] = useState<MessageState[]>([])
  const [input, setInput] = useState('')
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(chatService.status)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [attachments, setAttachments] = useState<File[]>([])
  const [isSending, setIsSending] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isLoadingHistoryRef = useRef(false)
  const isNearBottomRef = useRef(true)
  // 首屏定位完成标记：完成前自动滚动 effect 与顶部哨兵都不工作，
  // 防止初始 smooth 全程滚 + 哨兵在 scrollTop=0 时误触发连环加载
  const initialPositionedRef = useRef(false)
  // objectURL 追踪，组件卸载时 revoke 防内存泄漏
  const objectUrlsRef = useRef<Map<string, string>>(new Map())

  // 清理 objectURL（组件卸载）
  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      objectUrlsRef.current.clear()
    }
  }, [])

  // 检测滚动位置
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current
    if (!container) return
    const threshold = 100
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    const nearBottom = distanceFromBottom < threshold
    isNearBottomRef.current = nearBottom
    setShowScrollButton(!nearBottom)
    if (nearBottom) {
      setUnreadCount(0)
    }
  }, [])

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    setUnreadCount(0)
    setShowScrollButton(false)
  }, [])

  // 连接 WebSocket
  useEffect(() => {
    if (connectionStatus === 'disconnected' || connectionStatus === 'error') {
      chatService.connect()
    }

    const unsubStatus = chatService.onStatusChange((status) => {
      setConnectionStatus(status)
      // 重连成功后用 API 检查并更新 processing 状态的消息
      if (status === 'connected') {
        chatService.loadHistory(PAGE_SIZE).then((history) => {
          if (history.length === 0) return
          const historyMap = new Map(history.map((m) => [m.message_id, m]))
          setMessages((prev) => {
            const hasStuck = prev.some((m) => m.status === 'processing')
            if (!hasStuck) return prev
            return prev.map((m) => {
              if (m.status !== 'processing') return m
              const found = historyMap.get(m.message_id)
              if (found) return { ...found, status: 'completed' as const }
              // 通过 request_id 匹配（占位消息的 message_id 是临时生成的）
              const byReqId = history.find((h) => h.request_id === m.request_id && h.role === 'assistant')
              if (byReqId) return { ...byReqId, status: 'completed' as const }
              return m
            })
          })
        }).catch(() => {/* ignore */})
      }
    })
    const unsubMessage = chatService.onMessage(handleServerMessage)

    // 轮询修复：每 8 秒检查是否有 processing 超过 15 秒的消息
    // 用于修复 WS 连通但 chat_reply 事件丢失的情况
    const stuckMessageTimes = new Map<string, number>()
    const pollInterval = setInterval(() => {
      setMessages((prev) => {
        const now = Date.now()
        const hasStuck = prev.some((m) => {
          if (m.status !== 'processing') return false
          const firstSeen = stuckMessageTimes.get(m.message_id)
          if (!firstSeen) {
            stuckMessageTimes.set(m.message_id, now)
            return false
          }
          return now - firstSeen > 15000
        })
        if (!hasStuck) return prev
        // 有卡住的消息，从 API 加载最近消息，精确更新 processing 的
        chatService.loadHistory(PAGE_SIZE).then((history) => {
          if (history.length === 0) return
          setMessages((current) => {
            const stillStuck = current.some((m) => m.status === 'processing')
            if (!stillStuck) return current
            return current.map((m) => {
              if (m.status !== 'processing') return m
              const byReqId = history.find((h) => h.request_id === m.request_id && h.role === 'assistant')
              if (byReqId) return { ...byReqId, status: 'completed' as const }
              return m
            })
          })
        }).catch(() => {/* ignore */})
        return prev
      })
    }, 8000)

    return () => {
      unsubStatus()
      unsubMessage()
      clearInterval(pollInterval)
    }
  }, [])

  // 加载历史消息
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const history = await chatService.loadHistory(PAGE_SIZE)
        if (history.length > 0) {
          // API 返回倒序（最新在前），UI 需要正序（最旧在前）
          const chronological = [...history].reverse()
          setMessages(chronological.map((msg) => ({ ...msg, status: 'completed' as const })))
        }
        if (history.length < PAGE_SIZE) {
          setHasMore(false)
        }
        // hydrate 任务状态卡（带 task_id 的历史消息）
        const taskIds = [...new Set(history.filter((m) => m.task_id).map((m) => m.task_id!))]
        if (taskIds.length > 0) {
          const snapshots = await Promise.all(taskIds.map((id) => chatService.getTaskSnapshot(id)))
          const snapMap = new Map(
            snapshots.filter((s): s is ChatTaskSnapshot => s !== null).map((s) => [s.task_id, s])
          )
          setMessages((prev) =>
            prev.map((m) => (m.task_id && snapMap.has(m.task_id) ? { ...m, task: snapMap.get(m.task_id) } : m))
          )
        }
      } catch (error) {
        console.error('Failed to load chat history:', error)
      }
    }
    loadHistory()
  }, [])

  // 首屏瞬时锚定底部（同步于绘制前，无可感知滚动）
  useLayoutEffect(() => {
    if (initialPositionedRef.current) return
    if (messages.length === 0) return
    const container = messagesContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
    initialPositionedRef.current = true
  }, [messages])

  // 自动滚动到底部（仅用户在底部附近时；首屏定位由上方 useLayoutEffect 负责）
  useEffect(() => {
    if (!initialPositionedRef.current) return
    if (isLoadingHistoryRef.current) return
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    } else {
      // 用户在浏览历史，累计未读新消息数
      const lastMsg = messages[messages.length - 1]
      if (lastMsg && (lastMsg.role === 'assistant' || lastMsg.status === 'sent')) {
        setUnreadCount((prev) => prev + 1)
      }
    }
  }, [messages])

  // 加载更早的消息
  const loadOlderMessages = useCallback(async () => {
    if (!hasMore || loadingMore) return
    const oldest = messages[0]
    if (!oldest) return

    setLoadingMore(true)
    isLoadingHistoryRef.current = true

    const container = messagesContainerRef.current
    const prevScrollHeight = container?.scrollHeight ?? 0
    const prevScrollTop = container?.scrollTop ?? 0

    try {
      const older = await chatService.loadHistory(PAGE_SIZE, oldest.timestamp)
      if (older.length < PAGE_SIZE) {
        setHasMore(false)
      }
      if (older.length > 0) {
        const chronological = [...older].reverse()
        setMessages((prev) => [
          ...chronological.map((msg) => ({ ...msg, status: 'completed' as const })),
          ...prev,
        ])
        // 保持滚动位置：等 DOM 更新后调整 scrollTop
        requestAnimationFrame(() => {
          if (container) {
            const newScrollHeight = container.scrollHeight
            // 保留触发时的原 scrollTop 偏移，而非假定从 0 开始
            container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight)
          }
          setLoadingMore(false)
          isLoadingHistoryRef.current = false
        })
        return
      }
    } catch (error) {
      console.error('Failed to load older messages:', error)
    }
    setLoadingMore(false)
    isLoadingHistoryRef.current = false
  }, [hasMore, loadingMore, messages])

  // IntersectionObserver 检测滚动到顶部
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        // 首屏定位完成前不触发——scrollTop=0 的初始渲染瞬间哨兵必然可见
        if (!initialPositionedRef.current) return
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          loadOlderMessages()
        }
      },
      { root: messagesContainerRef.current, threshold: 0.1 }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, loadOlderMessages])

  // 处理服务端消息
  const handleServerMessage = (message: ChatServerMessage) => {
    if (message.type === 'chat_reply' && message.reply_type === 'task_created') {
      // task_created 单独处理：转为任务状态卡，避免覆盖 dispatcher 先行 direct_reply
      // WS chat_reply 的 content 仍是 string，包装成 ChatMessageContent
      setMessages((prev) => {
        const cardMsg: MessageState = {
          message_id: `msg_${Date.now()}_task`,
          role: 'assistant',
          content: { type: 'text', text: message.content },
          request_id: message.request_id,
          task_id: message.task_id,
          reply_type: 'task_created',
          timestamp: new Date().toISOString(),
          status: 'completed',
          task: message.task_id
            ? { task_id: message.task_id, status: 'executing', title: (message.content ?? '').replace(/^已创建任务：/, '') }
            : undefined,
        }
        // 占位仍在 processing → 原地转为状态卡；否则（已被 direct_reply 填充）追加新消息
        const idx = prev.findIndex(
          (m) => m.request_id === message.request_id && m.role === 'assistant' && m.status === 'processing'
        )
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = { ...cardMsg, message_id: prev[idx].message_id }
          return updated
        }
        return [...prev, cardMsg]
      })
      return
    }

    if (message.type === 'chat_reply') {
      setMessages((prev) => {
        // 找到对应的 request 并更新状态
        const existingIndex = prev.findIndex(
          (m) => m.request_id === message.request_id && m.role === 'assistant'
        )

        // WS chat_reply 的 content 是 string，包装成 ChatMessageContent
        const msgContent: ChatMessageContent = { type: 'text', text: message.content }

        if (existingIndex >= 0) {
          // 更新现有消息
          const updated = [...prev]
          updated[existingIndex] = {
            ...updated[existingIndex],
            content: msgContent,
            status: message.status === 'completed' ? 'completed' : 'failed',
            reply_type: message.reply_type,
            task_id: message.task_id,
          }
          return updated
        }

        // 添加新的 assistant 消息
        return [
          ...prev,
          {
            message_id: `msg_${Date.now()}`,
            role: 'assistant' as const,
            content: msgContent,
            request_id: message.request_id,
            task_id: message.task_id,
            reply_type: message.reply_type,
            timestamp: new Date().toISOString(),
            status: message.status === 'completed' ? 'completed' : 'failed',
          },
        ]
      })
    } else if (message.type === 'chat_status') {
      // 只更新 assistant 占位消息的状态为 processing
      setMessages((prev) =>
        prev.map((m) =>
          m.request_id === message.request_id && m.role === 'assistant'
            ? { ...m, status: 'processing' as const }
            : m
        )
      )
    } else if (message.type === 'chat_error') {
      if (message.request_id) {
        setMessages((prev) =>
          prev.map((m) =>
            m.request_id === message.request_id
              ? { ...m, status: 'failed' as const, error: message.error }
              : m
          )
        )
      }
    } else if (message.type === 'chat_push') {
      // worker 经 send_message 伪 channel 回流的新消息，直接追加
      // message.message 已是新结构 ChatMessage，无需转换
      setMessages((prev) => [...prev, { ...message.message, status: 'completed' as const }])
    } else if (message.type === 'chat_task_update') {
      // 任务状态/计划变更，实时更新对应消息的状态卡数据
      setMessages((prev) =>
        prev.map((m) => (m.task_id === message.task.task_id ? { ...m, task: message.task } : m))
      )
    }
  }

  // 添加附件（过滤超过 25MB 的文件）
  const addFiles = (incoming: FileList | File[]) => {
    const list = Array.from(incoming)
    const valid = list.filter((f) => f.size <= 25 * 1024 * 1024)
    if (valid.length < list.length) {
      toast.warning(`${list.length - valid.length} 个文件超过 25MB 已忽略`)
    }
    // 生成 objectURL 用于预览缩略图
    valid.forEach((f) => {
      if (!objectUrlsRef.current.has(f.name + f.lastModified)) {
        objectUrlsRef.current.set(f.name + f.lastModified, URL.createObjectURL(f))
      }
    })
    setAttachments((prev) => [...prev, ...valid])
  }

  // 移除单个附件（同名同时间戳文件可能共享 objectURL，仅在无其他引用时 revoke）
  const removeAttachment = (index: number) => {
    setAttachments((prev) => {
      const removed = prev[index]
      const key = removed.name + removed.lastModified
      const stillUsed = prev.some((f, i) => i !== index && f.name + f.lastModified === key)
      const url = objectUrlsRef.current.get(key)
      if (url && !stillUsed) {
        URL.revokeObjectURL(url)
        objectUrlsRef.current.delete(key)
      }
      return prev.filter((_, i) => i !== index)
    })
  }

  // 释放一批附件的预览 objectURL（发送完成后调用，防内存泄漏）
  const releasePreviewUrls = (files: File[]) => {
    for (const f of files) {
      const key = f.name + f.lastModified
      const url = objectUrlsRef.current.get(key)
      if (url) {
        URL.revokeObjectURL(url)
        objectUrlsRef.current.delete(key)
      }
    }
  }

  // 获取文件预览 objectURL（图片用）
  const getObjectUrl = (file: File): string => {
    const key = file.name + file.lastModified
    if (!objectUrlsRef.current.has(key)) {
      objectUrlsRef.current.set(key, URL.createObjectURL(file))
    }
    return objectUrlsRef.current.get(key)!
  }

  // 粘贴处理
  const handlePaste = (e: React.ClipboardEvent) => {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault()
      addFiles(e.clipboardData.files)
    }
  }

  // 发送消息
  const handleSend = async () => {
    const content = input.trim()
    if ((!content && attachments.length === 0) || connectionStatus !== 'connected') return
    if (isSending) return

    setIsSending(true)
    try {
      if (attachments.length > 0) {
        // 带附件走 HTTP multipart。
        // 清空动作放在发送成功之后：失败时保留 input/attachments 让用户能直接重试
        // （isSending 已禁用发送按钮，await 期间不会重复提交）
        const files = attachments
        const { message, request_id } = await chatService.sendMessageWithAttachments(content, files)
        setAttachments([])
        setInput('')
        releasePreviewUrls(files)
        setMessages((prev) => [
          ...prev,
          { ...message, status: 'sent' as const },
          {
            message_id: `msg_${Date.now()}_assistant`,
            role: 'assistant' as const,
            content: { type: 'text' as const, text: '' },
            request_id,
            timestamp: new Date().toISOString(),
            status: 'processing' as const,
          },
        ])
      } else {
        // 既有 WS 纯文本路径（入口已保证 content 非空）
        const request_id = chatService.sendMessage(content)

        // 添加用户消息
        const userMessage: MessageState = {
          message_id: `msg_${Date.now()}`,
          role: 'user',
          content: { type: 'text', text: content },
          request_id,
          timestamp: new Date().toISOString(),
          status: 'sent',
        }

        // 添加占位的 assistant 消息
        const assistantPlaceholder: MessageState = {
          message_id: `msg_${Date.now()}_assistant`,
          role: 'assistant',
          content: { type: 'text', text: '' },
          request_id,
          timestamp: new Date().toISOString(),
          status: 'processing',
        }

        setMessages((prev) => [...prev, userMessage, assistantPlaceholder])
        setInput('')
      }

      inputRef.current?.focus()
    } catch (error) {
      console.error('Failed to send message:', error)
      toast.error('发送失败，请重试')
    } finally {
      setIsSending(false)
    }
  }

  // 处理键盘事件
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // 重连
  const handleReconnect = () => {
    chatService.connect()
  }

  // 连接状态指示器
  const renderConnectionStatus = () => {
    const statusConfig: Record<ConnectionStatus, { color: string; text: string }> = {
      connecting: { color: '#f59e0b', text: '连接中...' },
      connected: { color: '#10b981', text: '已连接' },
      disconnected: { color: '#94a3b8', text: '已断开' },
      error: { color: '#ef4444', text: '连接错误' },
    }

    const config = statusConfig[connectionStatus]

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <div
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: config.color,
          }}
        />
        <span style={{ fontSize: '0.85rem', color: config.color }}>{config.text}</span>
        {(connectionStatus === 'disconnected' || connectionStatus === 'error') && (
          <button
            onClick={handleReconnect}
            style={{
              padding: '0.25rem 0.5rem',
              fontSize: '0.8rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              color: 'var(--text-primary)',
              cursor: 'pointer',
            }}
          >
            重连
          </button>
        )}
      </div>
    )
  }

  // 渲染消息
  const renderMessage = (message: MessageState) => {
    const isUser = message.role === 'user'
    const isProcessing = message.status === 'processing'

    // reply_type 对应的提示信息
    const getReplyTypeHint = () => {
      // task_created 由状态卡承载，不出提示文字
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
              {message.task_id && (
                <TaskStatusCard taskId={message.task_id} snapshot={message.task} />
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
  }

  return (
    <MainLayout>
      <div
        style={{
          height: 'calc(100vh - 4rem)',
          display: 'flex',
          flexDirection: 'column',
          padding: '2rem',
        }}
      >
        {/* 头部 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>聊天</h1>
            <button
              onClick={() => setShowSettings(true)}
              title="聊天媒体设置"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.1rem', color: 'var(--text-secondary)' }}
            >
              ⚙
            </button>
          </div>
          {renderConnectionStatus()}
        </div>

        {/* 消息区域 */}
        <div
          style={{ flex: 1, position: 'relative', marginBottom: '1rem' }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files) }}
        >
          <div
            ref={messagesContainerRef}
            onScroll={handleScroll}
            style={{
              height: '100%',
              overflowY: 'auto',
              padding: '1rem',
              backgroundColor: 'var(--bg-primary)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
            }}
          >
          {messages.length === 0 ? (
            <div
              style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
              }}
            >
              开始与 AI 助手对话吧！
            </div>
          ) : (
            <>
              {/* 顶部哨兵：触发加载更多 */}
              <div ref={sentinelRef} style={{ height: '1px' }} />
              {loadingMore && (
                <div style={{ textAlign: 'center', padding: '0.5rem', color: 'var(--text-secondary)' }}>
                  <div className="spinner" style={{ width: '16px', height: '16px', borderWidth: '2px', display: 'inline-block', verticalAlign: 'middle' }} />
                  <span style={{ marginLeft: '0.5rem', fontSize: '0.85rem' }}>加载更多...</span>
                </div>
              )}
              {!hasMore && messages.length > 0 && (
                <div style={{ textAlign: 'center', padding: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                  已加载全部消息
                </div>
              )}
              {messages.map((message, i) => {
                const prev = messages[i - 1]
                const showDate = !prev || !sameLocalDay(prev.timestamp, message.timestamp)
                return (
                  <React.Fragment key={message.message_id}>
                    {showDate && (
                      <div style={{ textAlign: 'center', margin: '1rem 0' }}>
                        <span
                          style={{
                            fontSize: '0.78rem',
                            color: 'var(--text-secondary)',
                            backgroundColor: 'var(--surface)',
                            border: '1px solid var(--border)',
                            borderRadius: '10px',
                            padding: '0.2rem 0.75rem',
                          }}
                        >
                          {formatDateLabel(message.timestamp)}
                        </span>
                      </div>
                    )}
                    {renderMessage(message)}
                  </React.Fragment>
                )
              })}
              <div ref={messagesEndRef} />
            </>
          )}
          </div>

          {/* 回到最新按钮 */}
          {showScrollButton && (
            <button
              onClick={scrollToBottom}
              style={{
                position: 'absolute',
                bottom: '1rem',
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.5rem 1rem',
                backgroundColor: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                borderRadius: '20px',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: 500,
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                zIndex: 10,
                transition: 'opacity 0.2s',
              }}
            >
              <span style={{ fontSize: '1rem' }}>↓</span>
              {unreadCount > 0 ? `${unreadCount} 条新消息` : '回到最新'}
            </button>
          )}
        </div>

        {/* 附件预览条 */}
        {attachments.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.5rem',
              padding: '0.5rem 1rem',
              marginBottom: '0.5rem',
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
            }}
          >
            {attachments.map((file, index) => (
              <div
                key={index}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.3rem 0.6rem',
                  borderRadius: '6px',
                  backgroundColor: 'var(--bg-primary)',
                  border: '1px solid var(--border)',
                  fontSize: '0.85rem',
                }}
              >
                {file.type.startsWith('image/') ? (
                  <img
                    src={getObjectUrl(file)}
                    alt={file.name}
                    style={{ width: '32px', height: '32px', objectFit: 'cover', borderRadius: '4px' }}
                  />
                ) : (
                  <span>📎</span>
                )}
                <span style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {file.name}
                </span>
                <button
                  onClick={() => removeAttachment(index)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-secondary)', fontSize: '0.9rem', padding: '0 2px',
                  }}
                  title="移除附件"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 输入区域 */}
        <div
          style={{
            display: 'flex',
            gap: '1rem',
            padding: '1rem',
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: '8px',
            border: '1px solid var(--border)',
          }}
        >
          {/* 隐藏的文件选择 input */}
          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              // 重置 value：否则再次选择同一文件不触发 onChange
              e.target.value = ''
            }}
            style={{ display: 'none' }}
          />
          {/* 附件按钮 */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={connectionStatus !== 'connected'}
            title="添加附件"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '1.1rem',
              padding: '0.5rem',
              color: 'var(--text-secondary)',
              flexShrink: 0,
            }}
          >
            📎
          </button>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={connectionStatus === 'connected' ? '输入消息，可粘贴或拖拽附件...' : '等待连接...'}
            disabled={connectionStatus !== 'connected'}
            className="input"
            style={{ flex: 1 }}
          />
          <button
            onClick={handleSend}
            disabled={(!input.trim() && attachments.length === 0) || connectionStatus !== 'connected' || isSending}
            className="btn btn-primary"
            style={{ padding: '0.75rem 1.5rem' }}
          >
            {isSending ? '发送中...' : '发送'}
          </button>
        </div>
      </div>

      {/* 聊天媒体设置弹窗 */}
      {showSettings && <ChatSettingsModal onClose={() => setShowSettings(false)} />}
    </MainLayout>
  )
}
