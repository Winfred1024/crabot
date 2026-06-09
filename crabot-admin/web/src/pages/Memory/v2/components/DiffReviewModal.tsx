import React, { useEffect, useRef } from 'react'

export interface DiffReviewModalProps {
  open: boolean
  title: string
  oldLabel: string
  newLabel: string
  oldText: string
  newText: string
  onClose: () => void
}

export const DiffReviewModal: React.FC<DiffReviewModalProps> = ({
  open, title, oldLabel, newLabel, oldText, newText, onClose,
}) => {
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    closeBtnRef.current?.focus()
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="mem-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="mem-modal mem-diff" role="dialog" aria-modal="true" aria-label={title}>
        <h3 className="mem-modal__title">{title}</h3>
        <div className="mem-diff__grid">
          <div className="mem-diff__column">
            <div className="mem-diff__caption mem-diff__caption--old">{oldLabel}</div>
            <pre className="mem-diff__pre mem-diff__pre--old">{oldText}</pre>
          </div>
          <div className="mem-diff__column">
            <div className="mem-diff__caption mem-diff__caption--new">{newLabel}</div>
            <pre className="mem-diff__pre mem-diff__pre--new">{newText}</pre>
          </div>
        </div>
        <div className="mem-modal__actions">
          <button ref={closeBtnRef} type="button" className="mem-modal__btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
