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

type CleanupMode = 'days' | 'count'

export const AutoCleanupSettingsDialog: React.FC<{
  open: boolean
  onClose: () => void
}> = ({ open, onClose }) => {
  const toast = useToast()
  const titleId = useId()
  const [enabled, setEnabled] = useState(false)
  const [mode, setMode] = useState<CleanupMode>('days')
  const [days, setDays] = useState(30)
  const [count, setCount] = useState(1000)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoaded(false)
    void providerService.getGlobalConfig().then((s) => {
      const d = s.trace_retention_days
      const c = s.trace_retention_count
      // days 优先（cron 端同语义）；都没配 → 默认 days 模式但未启用
      if (d != null && d > 0) {
        setMode('days')
        setDays(d)
        setEnabled(true)
      } else if (c != null && c > 0) {
        setMode('count')
        setCount(c)
        setEnabled(true)
      } else {
        setMode('days')
        setEnabled(false)
      }
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
      // 二选一：写入选中字段，另一字段置 null 避免历史值悬挂
      const payload = enabled
        ? mode === 'days'
          ? { trace_retention_days: days, trace_retention_count: null }
          : { trace_retention_days: null, trace_retention_count: count }
        : { trace_retention_days: null, trace_retention_count: null }
      await providerService.updateGlobalConfig(payload)
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
              <div role="radiogroup" aria-label="清理策略" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="radio"
                    name="cleanup-mode"
                    aria-label="按天清理"
                    checked={mode === 'days'}
                    onChange={() => setMode('days')}
                    disabled={!enabled}
                  />
                  <span>保留最近</span>
                  <input
                    aria-label="保留最近天数"
                    type="number"
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value) || 0)}
                    min={1}
                    disabled={!enabled || mode !== 'days'}
                    style={{ width: 80, padding: '4px 8px' }}
                  />
                  <span>天的 trace</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="radio"
                    name="cleanup-mode"
                    aria-label="按条清理"
                    checked={mode === 'count'}
                    onChange={() => setMode('count')}
                    disabled={!enabled}
                  />
                  <span>保留最近</span>
                  <input
                    aria-label="保留最近条数"
                    type="number"
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value) || 0)}
                    min={1}
                    disabled={!enabled || mode !== 'count'}
                    style={{ width: 100, padding: '4px 8px' }}
                  />
                  <span>条 trace</span>
                </label>
              </div>
              <div style={{ color: '#888', fontSize: 12, marginTop: 8 }}>
                {mode === 'days'
                  ? '超过此期限的 trace 每日自动删除'
                  : '按天文件粒度删除多余 trace；实际保留条数可能略大于设定值'}
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
