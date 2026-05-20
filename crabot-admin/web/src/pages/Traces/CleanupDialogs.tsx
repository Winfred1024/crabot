import React, { useEffect, useId, useState } from 'react'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { traceService } from '../../services/trace'
import { providerService } from '../../services/provider'
import { useToast } from '../../contexts/ToastContext'
import { formatBytes } from './utils'

const overlayStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.4)', zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

export const ManualCleanupDialog: React.FC<{
  open: boolean
  onClose: () => void
  onDeleted: () => void
}> = ({ open, onClose, onDeleted }) => {
  const toast = useToast()
  const titleId = useId()
  const [days, setDays] = useState(30)
  const [preview, setPreview] = useState<{ count: number; bytes: number } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const doPreview = async () => {
    setBusy(true)
    try {
      const r = await traceService.cleanupOld(days, true)
      setPreview({ count: r.affected_count, bytes: r.affected_bytes })
    } catch (err) {
      toast.error('预览失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    setBusy(true)
    try {
      const r = await traceService.cleanupOld(days, false)
      toast.success(`已删除 ${r.affected_count} 条 trace`)
      onDeleted()
      onClose()
    } catch (err) {
      toast.error('删除失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()}>
      <Card>
        <div style={{ width: 480 }}>
          <h3 id={titleId} style={{ marginTop: 0 }}>手动清理 trace</h3>
          <label style={{ display: 'block', marginBottom: 12 }}>
            删除
            <input
              aria-label="天前"
              type="number"
              value={days}
              onChange={(e) => { setDays(Number(e.target.value) || 0); setPreview(null) }}
              min={1}
              style={{ width: 80, padding: '4px 8px', margin: '0 4px' }}
            />
            天前的 trace
          </label>
          <Button variant="secondary" onClick={() => void doPreview()} disabled={busy || days < 1}>预览</Button>
          {preview && (
            <div style={{ marginTop: 12, padding: 12, background: '#fff7e6', borderRadius: 4 }}>
              将删除 <strong>{preview.count} 条 trace</strong>（占 {formatBytes(preview.bytes)}）
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button>
            <Button
              variant="danger"
              onClick={() => void doDelete()}
              disabled={busy || preview === null || preview.count === 0}
            >确认删除</Button>
          </div>
        </div>
      </Card>
      </div>
    </div>
  )
}

export const AutoCleanupSettingsDialog: React.FC<{
  open: boolean
  onClose: () => void
}> = ({ open, onClose }) => {
  const toast = useToast()
  const titleId = useId()
  const [enabled, setEnabled] = useState(false)
  const [days, setDays] = useState(30)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoaded(false)
    void providerService.getGlobalConfig().then((s) => {
      const r = s.trace_retention_days
      setEnabled(r !== null && r !== undefined && r > 0)
      if (r != null && r > 0) setDays(r)
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const save = async () => {
    setBusy(true)
    try {
      const next = enabled ? days : null
      await providerService.updateGlobalConfig({ trace_retention_days: next })
      toast.success('自动清理设置已保存')
      onClose()
    } catch (err) {
      toast.error('保存失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()}>
      <Card>
        <div style={{ width: 480 }}>
          <h3 id={titleId} style={{ marginTop: 0 }}>自动清理设置</h3>
          {!loaded ? <div>加载中…</div> : (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <input
                  type="checkbox"
                  aria-label="启用自动清理"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span>启用自动清理</span>
              </label>
              <label style={{ display: 'block' }}>
                保留最近
                <input
                  aria-label="保留最近"
                  type="number"
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value) || 0)}
                  min={1}
                  disabled={!enabled}
                  style={{ width: 80, padding: '4px 8px', margin: '0 4px' }}
                />
                天的 trace
              </label>
              <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
                超过此期限的 trace 每日自动删除
              </div>
            </>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button>
            <Button onClick={() => void save()} disabled={busy || !loaded}>保存</Button>
          </div>
        </div>
      </Card>
      </div>
    </div>
  )
}
