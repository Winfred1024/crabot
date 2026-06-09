import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  content: React.ReactNode
  placement?: TooltipPlacement
  /** ms to wait before showing on hover/focus. Default 150. */
  delay?: number
  /** Disable showing entirely (e.g. when content is empty). */
  disabled?: boolean
  /** Visual size; default 'md'. 'sm' for tight space, 'lg' for richer content. */
  size?: 'sm' | 'md' | 'lg'
  children: React.ReactElement
}

interface Position {
  top: number
  left: number
  placement: TooltipPlacement
}

const GAP = 8
const SCREEN_PAD = 8

function flipPlacement(p: TooltipPlacement, rect: DOMRect, w: number, h: number): TooltipPlacement {
  // Flip if the preferred side would be cut off; pick the side with most room
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (p === 'top' && rect.top - h - GAP < SCREEN_PAD) return 'bottom'
  if (p === 'bottom' && rect.bottom + h + GAP > vh - SCREEN_PAD) return 'top'
  if (p === 'left' && rect.left - w - GAP < SCREEN_PAD) return 'right'
  if (p === 'right' && rect.right + w + GAP > vw - SCREEN_PAD) return 'left'
  return p
}

function computePosition(trigger: DOMRect, tip: { w: number; h: number }, preferred: TooltipPlacement): Position {
  const placement = flipPlacement(preferred, trigger, tip.w, tip.h)
  const vw = window.innerWidth
  const cx = trigger.left + trigger.width / 2
  const cy = trigger.top + trigger.height / 2

  let top = 0
  let left = 0
  if (placement === 'top')    { top = trigger.top - tip.h - GAP; left = cx - tip.w / 2 }
  if (placement === 'bottom') { top = trigger.bottom + GAP;       left = cx - tip.w / 2 }
  if (placement === 'left')   { left = trigger.left - tip.w - GAP; top = cy - tip.h / 2 }
  if (placement === 'right')  { left = trigger.right + GAP;        top = cy - tip.h / 2 }

  // Clamp inside viewport
  left = Math.max(SCREEN_PAD, Math.min(left, vw - tip.w - SCREEN_PAD))
  top = Math.max(SCREEN_PAD, top)
  return { top, left, placement }
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  placement = 'top',
  delay = 150,
  disabled = false,
  size = 'md',
  children,
}) => {
  const id = useId()
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState<Position | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearShowTimer = useCallback(() => {
    if (showTimer.current) {
      clearTimeout(showTimer.current)
      showTimer.current = null
    }
  }, [])

  const show = useCallback(() => {
    if (disabled || !content) return
    clearShowTimer()
    showTimer.current = setTimeout(() => setVisible(true), delay)
  }, [disabled, content, delay, clearShowTimer])

  const hide = useCallback(() => {
    clearShowTimer()
    setVisible(false)
  }, [clearShowTimer])

  // Reposition when visible
  useLayoutEffect(() => {
    if (!visible || !triggerRef.current || !tooltipRef.current) return
    const triggerRect = triggerRef.current.getBoundingClientRect()
    const tipRect = tooltipRef.current.getBoundingClientRect()
    setPos(computePosition(triggerRect, { w: tipRect.width, h: tipRect.height }, placement))
  }, [visible, placement, content])

  useEffect(() => {
    if (!visible) return
    const onScroll = () => hide()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', hide)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('keydown', onKey)
    }
  }, [visible, hide])

  useEffect(() => () => clearShowTimer(), [clearShowTimer])

  // Inject handlers into the child element while preserving its own handlers
  const childProps = children.props as Record<string, unknown>
  const titleFallback = typeof content === 'string' ? content : undefined
  const child = React.cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node
      const ref = (children as unknown as { ref?: React.Ref<HTMLElement> }).ref
      if (typeof ref === 'function') ref(node)
      else if (ref && typeof ref === 'object') (ref as React.RefObject<HTMLElement | null>).current = node
    },
    onMouseEnter: (e: React.MouseEvent) => {
      const orig = childProps.onMouseEnter as ((e: React.MouseEvent) => void) | undefined
      orig?.(e)
      show()
    },
    onMouseLeave: (e: React.MouseEvent) => {
      const orig = childProps.onMouseLeave as ((e: React.MouseEvent) => void) | undefined
      orig?.(e)
      hide()
    },
    onFocus: (e: React.FocusEvent) => {
      const orig = childProps.onFocus as ((e: React.FocusEvent) => void) | undefined
      orig?.(e)
      show()
    },
    onBlur: (e: React.FocusEvent) => {
      const orig = childProps.onBlur as ((e: React.FocusEvent) => void) | undefined
      orig?.(e)
      hide()
    },
    'aria-describedby': visible ? id : undefined,
    // Fallback so screen readers + headless tests still see the label even
    // when the portal-rendered tooltip is not present. Once our custom tooltip
    // is shown the browser cancels its native title rendering, so it doesn't
    // double up visually.
    title: childProps.title ?? titleFallback,
  } as React.HTMLAttributes<HTMLElement>)

  if (disabled || !content) return child

  return (
    <>
      {child}
      {visible &&
        createPortal(
          <div
            ref={tooltipRef}
            id={id}
            role="tooltip"
            className={`tooltip tooltip--${size} tooltip--${pos?.placement ?? placement}`}
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
