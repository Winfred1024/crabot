import React, { useState } from 'react'
import type { EngineMessageLike } from '../../services/trace'

// ============================================================================
// 子组件：MessageBlocks — 将 EngineMessageLike[] 渲染为可读的对话块
// 角色标签 + 文本；assistant 的 tool_use 显示工具名 + 可折叠入参；
// tool_result 折叠；长块用限高滚动 <pre>。
// ============================================================================

const Collapsible: React.FC<{
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
  isError?: boolean
}> = ({ title, children, defaultOpen, isError }) => {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div style={{ marginBottom: 6 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'none',
          border: 'none',
          color: isError ? 'var(--error)' : 'var(--primary-light)',
          cursor: 'pointer',
          padding: 0,
          fontSize: 12,
          fontFamily: 'var(--font-body)',
        }}
      >
        {open ? '▾' : '▸'} {title}
      </button>
      {open && <div style={{ marginTop: 4 }}>{children}</div>}
    </div>
  )
}

const Pre: React.FC<{ text: string }> = ({ text }) => (
  <pre
    style={{
      margin: 0,
      maxHeight: 320,
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      background: 'var(--bg-primary)',
      border: '1px solid var(--border)',
      padding: '6px 8px',
      borderRadius: 4,
      color: 'var(--text-primary)',
      lineHeight: 1.55,
    }}
  >
    {text}
  </pre>
)

const ROLE_LABELS: Record<string, string> = {
  assistant: '助手',
  user: '用户',
}

export const MessageBlocks: React.FC<{
  messages: ReadonlyArray<EngineMessageLike>
}> = ({ messages }) => {
  if (!messages?.length) {
    return (
      <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>
        （无对话内容）
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {messages.map((m, i) => {
        const roleLabel = ROLE_LABELS[m.role] ?? m.role
        const blocks = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : null
        const toolResults = Array.isArray(m.toolResults)
          ? (m.toolResults as Record<string, unknown>[])
          : null

        return (
          <div
            key={m.id ?? i}
            style={{
              borderLeft: `3px solid ${m.role === 'assistant' ? 'var(--primary-dim)' : 'var(--border-strong)'}`,
              paddingLeft: 8,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                letterSpacing: '0.06em',
                color: m.role === 'assistant' ? 'var(--primary-light)' : 'var(--text-secondary)',
                marginBottom: 4,
                textTransform: 'uppercase',
              }}
            >
              {roleLabel}
              {m.stopReason && (
                <span
                  style={{
                    marginLeft: 8,
                    fontWeight: 400,
                    color: 'var(--text-muted)',
                    textTransform: 'none',
                  }}
                >
                  · 止：{m.stopReason}
                </span>
              )}
            </div>

            {/* 纯文本 content */}
            {typeof m.content === 'string' && m.content && <Pre text={m.content} />}

            {/* content 块数组 */}
            {blocks?.map((b, j) => {
              if (b.type === 'text') {
                const text = String(b.text ?? '')
                if (!text) return null
                return <Pre key={j} text={text} />
              }

              if (b.type === 'tool_use') {
                return (
                  <Collapsible key={j} title={`🔧 ${String(b.name ?? 'tool')}`}>
                    <Pre text={JSON.stringify(b.input ?? {}, null, 2)} />
                  </Collapsible>
                )
              }

              if (b.type === 'tool_result') {
                const content = b.content
                const isError = Boolean(b.is_error)
                const text =
                  typeof content === 'string'
                    ? content
                    : JSON.stringify(content, null, 2)
                return (
                  <Collapsible
                    key={j}
                    title={isError ? '工具结果（错误）' : '工具结果'}
                    isError={isError}
                  >
                    <Pre text={text} />
                  </Collapsible>
                )
              }

              return null
            })}

            {/* toolResults 数组（tool_result 消息的独立字段） */}
            {toolResults?.map((tr, j) => {
              const isError = Boolean(tr.is_error)
              const text =
                typeof tr.content === 'string'
                  ? tr.content
                  : JSON.stringify(tr.content, null, 2)
              return (
                <Collapsible
                  key={`tr${j}`}
                  title={isError ? '工具结果（错误）' : '工具结果'}
                  isError={isError}
                >
                  <Pre text={text} />
                </Collapsible>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
