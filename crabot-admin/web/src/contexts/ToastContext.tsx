import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  /** ms to auto-dismiss. Defaults: 3000 (info / success), 4500 (error / warning). 0 = sticky. */
  duration?: number
  action?: ToastAction
  /** Optional id; if a toast with the same id already exists, it is replaced. */
  id?: string
}

interface ToastEntry {
  id: string
  type: ToastType
  message: string
  duration: number
  action?: ToastAction
  leaving: boolean
}

interface ToastContextValue {
  success: (message: string, options?: ToastOptions) => string
  error:   (message: string, options?: ToastOptions) => string
  info:    (message: string, options?: ToastOptions) => string
  warning: (message: string, options?: ToastOptions) => string
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined)

const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 3000,
  info:    3000,
  warning: 4500,
  error:   4500,
}

const ICON: Record<ToastType, string> = {
  success: '✓',
  error:   '✕',
  warning: '!',
  info:    'i',
}

const LEAVE_DURATION = 180

let seq = 0
const newId = () => `t-${seq++}`

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id)
    if (t) {
      clearTimeout(t)
      timers.current.delete(id)
    }
  }, [])

  const remove = useCallback((id: string) => {
    clearTimer(id)
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [clearTimer])

  const dismiss = useCallback((id: string) => {
    clearTimer(id)
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, LEAVE_DURATION)
  }, [clearTimer])

  const push = useCallback(
    (type: ToastType, message: string, options?: ToastOptions): string => {
      const id = options?.id ?? newId()
      const duration = options?.duration ?? DEFAULT_DURATION[type]
      setToasts((prev) => {
        const without = prev.filter((t) => t.id !== id)
        return [...without, { id, type, message, duration, action: options?.action, leaving: false }]
      })
      if (duration > 0) {
        clearTimer(id)
        timers.current.set(id, setTimeout(() => dismiss(id), duration))
      }
      return id
    },
    [clearTimer, dismiss],
  )

  useEffect(() => () => {
    timers.current.forEach((t) => clearTimeout(t))
    timers.current.clear()
  }, [])

  const value: ToastContextValue = {
    success: useCallback((m, o) => push('success', m, o), [push]),
    error:   useCallback((m, o) => push('error',   m, o), [push]),
    info:    useCallback((m, o) => push('info',    m, o), [push]),
    warning: useCallback((m, o) => push('warning', m, o), [push]),
    dismiss,
  }

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-container" role="region" aria-label="通知">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast--${t.type}${t.leaving ? ' toast--leaving' : ''}`}
            role={t.type === 'error' || t.type === 'warning' ? 'alert' : 'status'}
            aria-live={t.type === 'error' || t.type === 'warning' ? 'assertive' : 'polite'}
          >
            <span className={`toast__icon toast__icon--${t.type}`} aria-hidden="true">
              {ICON[t.type]}
            </span>
            <span className="toast__message">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast__action"
                onClick={() => { t.action!.onClick(); remove(t.id) }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="toast__close"
              aria-label="关闭通知"
              onClick={() => dismiss(t.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
