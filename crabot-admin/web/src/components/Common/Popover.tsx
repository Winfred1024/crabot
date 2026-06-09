import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type PopoverPlacement = 'top' | 'bottom' | 'left' | 'right'

interface PopoverProps {
  /** Element rendered inside the popover. */
  content: React.ReactNode
  placement?: PopoverPlacement
  /** When `true`, the popover stays open until `onClose` is called. */
  open?: boolean
  /** Required when `open` is controlled. */
  onOpenChange?: (open: boolean) => void
  /** Visual size. */
  size?: 'sm' | 'md' | 'lg'
  /** Trigger element. */
  children: React.ReactElement
}

interface Position {
  top: number
  left: number
  placement: PopoverPlacement
}

const GAP = 8
const SCREEN_PAD = 12

function flipPlacement(p: PopoverPlacement, rect: DOMRect, w: number, h: number): PopoverPlacement {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (p === 'top' && rect.top - h - GAP < SCREEN_PAD) return 'bottom'
  if (p === 'bottom' && rect.bottom + h + GAP > vh - SCREEN_PAD) return 'top'
  if (p === 'left' && rect.left - w - GAP < SCREEN_PAD) return 'right'
  if (p === 'right' && rect.right + w + GAP > vw - SCREEN_PAD) return 'left'
  return p
}

function computePosition(trigger: DOMRect, panel: { w: number; h: number }, preferred: PopoverPlacement): Position {
  const placement = flipPlacement(preferred, trigger, panel.w, panel.h)
  const vw = window.innerWidth
  const cx = trigger.left + trigger.width / 2
  const cy = trigger.top + trigger.height / 2

  let top = 0
  let left = 0
  if (placement === 'top')    { top = trigger.top - panel.h - GAP; left = cx - panel.w / 2 }
  if (placement === 'bottom') { top = trigger.bottom + GAP;          left = cx - panel.w / 2 }
  if (placement === 'left')   { left = trigger.left - panel.w - GAP; top = cy - panel.h / 2 }
  if (placement === 'right')  { left = trigger.right + GAP;          top = cy - panel.h / 2 }

  left = Math.max(SCREEN_PAD, Math.min(left, vw - panel.w - SCREEN_PAD))
  top = Math.max(SCREEN_PAD, top)
  return { top, left, placement }
}

export const Popover: React.FC<PopoverProps> = ({
  content,
  placement = 'bottom',
  open: openProp,
  onOpenChange,
  size = 'md',
  children,
}) => {
  const id = useId()
  const [innerOpen, setInnerOpen] = useState(false)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp! : innerOpen
  const setOpen = useCallback((value: boolean) => {
    if (!isControlled) setInnerOpen(value)
    onOpenChange?.(value)
  }, [isControlled, onOpenChange])

  const [pos, setPos] = useState<Position | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !panelRef.current) return
    const triggerRect = triggerRef.current.getBoundingClientRect()
    const panelRect = panelRef.current.getBoundingClientRect()
    setPos(computePosition(triggerRect, { w: panelRect.width, h: panelRect.height }, placement))
  }, [open, placement, content])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        triggerRef.current && triggerRef.current.contains(target)
      ) return
      if (
        panelRef.current && panelRef.current.contains(target)
      ) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open, setOpen])

  // Focus first focusable on open
  useEffect(() => {
    if (!open || !panelRef.current) return
    const focusables = panelRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    const target = focusables[0] ?? panelRef.current
    window.requestAnimationFrame(() => target.focus())
  }, [open])

  const childProps = children.props as Record<string, unknown>
  const child = React.cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
      const ref = (children as unknown as { ref?: React.Ref<HTMLElement> }).ref
      if (typeof ref === 'function') ref(node)
      else if (ref && typeof ref === 'object') (ref as React.RefObject<HTMLElement | null>).current = node
    },
    onClick: (e: React.MouseEvent) => {
      const orig = childProps.onClick as ((e: React.MouseEvent) => void) | undefined
      orig?.(e)
      setOpen(!open)
    },
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
  } as React.HTMLAttributes<HTMLElement>)

  return (
    <>
      {child}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="dialog"
            tabIndex={-1}
            className={`popover popover--${size} popover--${pos?.placement ?? placement}`}
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              opacity: pos ? 1 : 0,
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  )
}
