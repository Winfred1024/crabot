import React, { useCallback, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  size?: ModalSize
  /** Hide the close (×) button in the top-right corner. */
  hideCloseButton?: boolean
  /** Prevent closing via backdrop click. ESC still works unless dismissOnEscape is false. */
  dismissOnBackdrop?: boolean
  dismissOnEscape?: boolean
  /** Extra class on the content container (e.g. for scoped page styles). */
  contentClassName?: string
  /** Optional aria-label override when title is not a string. */
  ariaLabel?: string
}

const sizeClass: Record<ModalSize, string> = {
  sm: '',
  md: '',
  lg: 'modal-content--wide',
  xl: 'modal-content--xwide',
  full: 'modal-content--full',
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  hideCloseButton = false,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  contentClassName = '',
  ariaLabel,
}) => {
  const titleId = useId()
  const descId = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  const handleBackdrop = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!dismissOnBackdrop) return
      if (e.target === e.currentTarget) onClose()
    },
    [dismissOnBackdrop, onClose],
  )

  useEffect(() => {
    if (!open) return

    previouslyFocused.current = document.activeElement as HTMLElement | null

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const node = contentRef.current
    if (node) {
      const focusables = node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      const initial = focusables[0] ?? node
      window.requestAnimationFrame(() => initial.focus())
    }

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissOnEscape) {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !contentRef.current) return
      const focusables = Array.from(
        contentRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled'))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === first || !contentRef.current.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = prevOverflow
      previouslyFocused.current?.focus?.()
    }
  }, [open, dismissOnEscape, onClose])

  if (!open) return null

  const titleIsString = typeof title === 'string'
  const labelledBy = title ? titleId : undefined
  const computedAriaLabel = !title ? ariaLabel : undefined

  const contentClasses = [
    'modal-content',
    'modal-shell',
    sizeClass[size],
    !hideCloseButton ? 'modal-shell--with-close' : '',
    contentClassName,
  ]
    .filter(Boolean)
    .join(' ')

  return createPortal(
    <div className="modal-overlay" onMouseDown={handleBackdrop}>
      <div
        ref={contentRef}
        className={contentClasses}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={description ? descId : undefined}
        aria-label={computedAriaLabel}
        tabIndex={-1}
      >
        {title && (
          <h3
            id={titleId}
            className="modal-title"
            title={titleIsString ? (title as string) : undefined}
          >
            {title}
          </h3>
        )}
        {description && (
          <p id={descId} className="modal-message">
            {description}
          </p>
        )}
        {!hideCloseButton && (
          <button
            type="button"
            aria-label="关闭"
            className="modal-close"
            onClick={onClose}
          >
            ✕
          </button>
        )}
        {children && <div className="modal-body">{children}</div>}
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
