import React from 'react'

// ============================================================================
// 子组件：PaginationBar
// ============================================================================

export function PaginationBar({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number
  pageSize: number
  total: number
  onChange: (page: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const canPrev = page > 1
  const canNext = page < totalPages
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  const btn = (label: string, onClick: () => void, disabled = false) => (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '4px 10px',
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: disabled ? 'var(--bg-secondary, #f3f4f6)' : 'var(--bg-primary, #fff)',
        color: disabled ? '#9ca3af' : 'var(--text-primary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 12,
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-secondary, #f9fafb)',
        fontSize: 12,
      }}
    >
      <span style={{ color: 'var(--text-secondary)' }}>
        {total === 0 ? '无数据' : `${from}-${to} / 共 ${total} 条`}
      </span>
      <span style={{ flex: 1 }} />
      {btn('« 首页', () => onChange(1), !canPrev)}
      {btn('‹ 上一页', () => onChange(page - 1), !canPrev)}
      <span style={{ color: 'var(--text-primary)', padding: '0 6px', fontVariantNumeric: 'tabular-nums' }}>
        第 {page} / {totalPages} 页
      </span>
      {btn('下一页 ›', () => onChange(page + 1), !canNext)}
      {btn('末页 »', () => onChange(totalPages), !canNext)}
    </div>
  )
}
