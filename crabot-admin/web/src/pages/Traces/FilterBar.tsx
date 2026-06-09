import { Tooltip } from '../../components/Common/Tooltip'
import { type FilterState } from './utils'

// ============================================================================
// 子组件：FilterBar
// ============================================================================

export function FilterBar({
  filter,
  onChange,
  onReset,
}: {
  filter: FilterState
  onChange: (next: FilterState) => void
  onReset: () => void
}) {
  const isFiltered =
    filter.keyword !== '' ||
    filter.status !== '' ||
    filter.range !== 'all' ||
    filter.taskId !== ''

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '8px 12px',
        background: 'var(--bg-secondary, #f9fafb)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        flexWrap: 'wrap',
      }}
    >
      {filter.taskId && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px',
            background: 'var(--primary-glow)',
            color: 'var(--primary-light)',
            borderRadius: 4,
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
          }}
        >
          🔗 task: {filter.taskId.slice(0, 12)}
          <Tooltip content="移除任务筛选">
            <button
              onClick={() => onChange({ ...filter, taskId: '' })}
              style={{ marginLeft: 4, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--primary-light)', fontSize: 14, lineHeight: 1, padding: 0 }}
            >
              ×
            </button>
          </Tooltip>
        </span>
      )}
      <input
        type="text"
        placeholder="🔍 关键字（trigger / outcome）"
        value={filter.keyword}
        onChange={(e) => onChange({ ...filter, keyword: e.target.value })}
        style={{
          flex: '1 1 240px',
          minWidth: 200,
          padding: '6px 10px',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 13,
          background: 'var(--bg-primary, #fff)',
        }}
      />
      <select
        value={filter.status}
        onChange={(e) => onChange({ ...filter, status: e.target.value as FilterState['status'] })}
        style={{
          padding: '6px 10px',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 13,
          background: 'var(--bg-primary, #fff)',
          cursor: 'pointer',
        }}
      >
        <option value="">全部状态</option>
        <option value="running">运行中</option>
        <option value="completed">完成</option>
        <option value="failed">失败</option>
      </select>
      <select
        value={filter.range}
        onChange={(e) => onChange({ ...filter, range: e.target.value as FilterState['range'] })}
        style={{
          padding: '6px 10px',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 13,
          background: 'var(--bg-primary, #fff)',
          cursor: 'pointer',
        }}
      >
        <option value="all">所有时间</option>
        <option value="today">今天</option>
        <option value="24h">最近 24 小时</option>
        <option value="7d">最近 7 天</option>
        <option value="custom">自定义</option>
      </select>
      {filter.range === 'custom' && (
        <>
          <input
            type="datetime-local"
            value={filter.customStart}
            onChange={(e) => onChange({ ...filter, customStart: e.target.value })}
            style={{
              padding: '6px 8px',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 13,
            }}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>至</span>
          <input
            type="datetime-local"
            value={filter.customEnd}
            onChange={(e) => onChange({ ...filter, customEnd: e.target.value })}
            style={{
              padding: '6px 8px',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 13,
            }}
          />
        </>
      )}
      {isFiltered && (
        <button
          onClick={onReset}
          style={{
            padding: '6px 12px',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 12,
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
          }}
        >
          清除筛选
        </button>
      )}
    </div>
  )
}
