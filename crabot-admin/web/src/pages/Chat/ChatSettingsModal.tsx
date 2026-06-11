/**
 * 聊天媒体设置弹窗（TTL 可配置 + 存储占用展示）
 */
import React, { useEffect, useState } from 'react'
import { api } from '../../services/api'

interface MediaUsage {
  file_count: number
  total_bytes: number
  ttl_days: number
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export const ChatSettingsModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [usage, setUsage] = useState<MediaUsage | null>(null)
  const [ttlDays, setTtlDays] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.get<MediaUsage>('/chat/media-usage').then((u) => {
      setUsage(u)
      setTtlDays(String(u.ttl_days))
    }).catch(() => setError('加载失败'))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      await api.patch('/chat/media-config', { ttl_days: Number(ttlDays) })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: '380px', padding: '1.5rem', borderRadius: '12px', backgroundColor: 'var(--surface-raised, var(--bg-secondary))', border: '1px solid var(--border)' }}
      >
        <h3 style={{ marginBottom: '1rem' }}>聊天媒体设置</h3>
        <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          {usage ? `当前存储占用：${usage.file_count} 个文件，共 ${formatBytes(usage.total_bytes)}` : '加载中…'}
        </div>
        <label style={{ display: 'block', fontSize: '0.9rem', marginBottom: '0.4rem' }}>
          媒体保留天数（1-365，超期自动清理）
        </label>
        <input
          type="number"
          min={1}
          max={365}
          value={ttlDays}
          onChange={(e) => setTtlDays(e.target.value)}
          className="input"
          style={{ width: '100%', marginBottom: '0.75rem' }}
        />
        {error && <div style={{ color: 'var(--error)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="btn" style={{ padding: '0.5rem 1rem' }}>取消</button>
          <button onClick={handleSave} disabled={saving} className="btn btn-primary" style={{ padding: '0.5rem 1rem' }}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
