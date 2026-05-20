import { useEffect, useState } from 'react'
import { Button } from '../../components/Common/Button'
import { traceService } from '../../services/trace'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

interface Props {
  onOpenManualCleanup: () => void
  onOpenAutoCleanupSettings: () => void
  /** 外部 trigger 重拉占用（例如清理完成后） */
  refreshKey?: number
}

export const StatusBar: React.FC<Props> = ({ onOpenManualCleanup, onOpenAutoCleanupSettings, refreshKey }) => {
  const [usage, setUsage] = useState<{ total_bytes: number; trace_count: number; oldest_iso?: string } | null>(null)

  useEffect(() => {
    let alive = true
    traceService.getDiskUsage()
      .then((data) => { if (alive) setUsage(data) })
      .catch(() => { if (alive) setUsage(null) })
    return () => { alive = false }
  }, [refreshKey])

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 16px', background: '#f8f9fa', borderRadius: 4, marginBottom: 12,
    }}>
      <div style={{ color: '#555' }}>
        {usage === null ? '加载中…' : (
          <>
            占用 <strong>{formatBytes(usage.total_bytes)}</strong>
            <span style={{ margin: '0 6px' }}>·</span>
            共 <strong>{usage.trace_count.toLocaleString()}</strong> 条 trace
            {usage.oldest_iso && (
              <span style={{ marginLeft: 12, color: '#888' }}>
                最早 {usage.oldest_iso.slice(0, 16).replace('T', ' ')}
              </span>
            )}
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="secondary" onClick={onOpenManualCleanup}>手动清理</Button>
        <Button variant="secondary" onClick={onOpenAutoCleanupSettings}>自动清理设置</Button>
      </div>
    </div>
  )
}
