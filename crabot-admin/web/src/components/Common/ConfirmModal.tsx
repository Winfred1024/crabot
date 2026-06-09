import React from 'react'
import { Button } from './Button'
import { Modal } from './Modal'

interface ConfirmModalWarning {
  title: string
  items: string[]
  note: string
}

interface ConfirmModalProps {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
  title: string
  message: string
  warning?: ConfirmModalWarning
  confirmText?: string
  confirmVariant?: 'danger' | 'primary'
  loading?: boolean
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  onConfirm,
  onCancel,
  title,
  message,
  warning,
  confirmText = '确认',
  confirmVariant = 'primary',
  loading = false,
}) => {
  return (
    <Modal
      open={open}
      onClose={loading ? () => {} : onCancel}
      title={title}
      description={message}
      hideCloseButton
      dismissOnBackdrop={!loading}
      dismissOnEscape={!loading}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            取消
          </Button>
          <Button
            variant={confirmVariant}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? '处理中…' : confirmText}
          </Button>
        </>
      }
    >
      {warning && (
        <div className="modal-warning">
          <div className="modal-warning-title">{warning.title}</div>
          <ul className="modal-warning-items">
            {warning.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
          <div className="modal-warning-note">{warning.note}</div>
        </div>
      )}
    </Modal>
  )
}
