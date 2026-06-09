import { useEffect, useState } from 'react'
import { Button } from '../../components/Common/Button'
import { traceService } from '../../services/trace'
import { formatBytes } from './utils'

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
    <div className="trace-status-bar">
      <div className="trace-status-bar__info">
        {usage === null ? '加载中…' : (
          <>
            占用 <strong>{formatBytes(usage.total_bytes)}</strong>
            <span className="trace-status-bar__sep">·</span>
            共 <strong>{usage.trace_count.toLocaleString()}</strong> 条 trace
            {usage.oldest_iso && (
              <span className="trace-status-bar__oldest">
                最早 {usage.oldest_iso.slice(0, 16).replace('T', ' ')}
              </span>
            )}
          </>
        )}
      </div>
      <div className="trace-status-bar__actions">
        <Button variant="secondary" size="sm" onClick={onOpenManualCleanup}>手动清理</Button>
        <Button variant="secondary" size="sm" onClick={onOpenAutoCleanupSettings}>自动清理设置</Button>
      </div>
    </div>
  )
}
