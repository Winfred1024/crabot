/**
 * 消息右键上下文菜单（引用 / 复制 / 删除）
 *
 * - fixed 定位于 (x, y)，超出右/下边缘自动钳制
 * - zIndex 1100，与选区引用浮动按钮同层
 * - 点击任意菜单项后自动关闭（各自回调 + onClose）
 */
import React, { useEffect, useRef } from 'react'

interface MessageContextMenuProps {
  x: number
  y: number
  onQuote: () => void
  onCopy: () => void
  onDelete: () => void
  onClose: () => void
}

export const MessageContextMenu: React.FC<MessageContextMenuProps> = ({
  x,
  y,
  onQuote,
  onCopy,
  onDelete,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null)

  // 钳制：防止菜单飞出视口右/下边缘（宽度约 110px，高度约 108px）
  const MENU_WIDTH = 110
  const MENU_HEIGHT = 108
  const clampedX = Math.min(x, window.innerWidth - MENU_WIDTH - 8)
  const clampedY = Math.min(y, window.innerHeight - MENU_HEIGHT - 8)

  // 点击菜单外关闭
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const menuItemStyle: React.CSSProperties = {
    padding: '0.45rem 0.75rem',
    cursor: 'pointer',
    fontSize: '0.85rem',
    color: 'var(--text-primary)',
    borderRadius: '4px',
    whiteSpace: 'nowrap',
    transition: 'background 0.1s',
    userSelect: 'none',
  }

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: clampedX,
        top: clampedY,
        zIndex: 1100,
        backgroundColor: 'var(--bg-primary)',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        padding: '0.3rem',
        minWidth: `${MENU_WIDTH}px`,
      }}
    >
      <div
        style={menuItemStyle}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        onMouseDown={(e) => {
          e.preventDefault()
          onQuote()
          onClose()
        }}
      >
        引用
      </div>
      <div
        style={menuItemStyle}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        onMouseDown={(e) => {
          e.preventDefault()
          onCopy()
          onClose()
        }}
      >
        复制
      </div>
      <div
        style={{
          ...menuItemStyle,
          color: 'var(--error)',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        onMouseDown={(e) => {
          e.preventDefault()
          onDelete()
          onClose()
        }}
      >
        删除
      </div>
    </div>
  )
}
