import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { MemoryGraphData, MemoryGraphNode, MemoryGraphEdge } from '../../../../services/memoryV2'
import { stepForce, type SimNode, type SimEdge } from '../utils/forceLayout'

const W = 760
const H = 520

type EdgeType = MemoryGraphEdge['edge_type']

const EDGE_COLORS: Record<EdgeType, string> = {
  membership: '#5b6b88',
  link: '#60a5fa',
  source_case: '#60a5fa',
  invalidated: '#f87171',
  version: '#c084fc',
}

const EDGE_LABELS: Record<EdgeType, string> = {
  membership: '归属',
  link: '关联',
  source_case: '来源案例',
  invalidated: '已失效',
  version: '版本',
}

const MEMORY_TYPE_COLORS: Record<string, string> = {
  concept: '#a78bfa',
  fact: '#38bdf8',
  lesson: '#34d399',
}

const ENTITY_COLOR = '#fbbf24'

const ALL_EDGE_TYPES: EdgeType[] = ['link', 'membership', 'source_case', 'invalidated', 'version']

function memoryColor(node: MemoryGraphNode): string {
  return (node.type && MEMORY_TYPE_COLORS[node.type]) || '#94a3b8'
}

function isDimmed(node: MemoryGraphNode): boolean {
  return node.maturity === 'stale' || node.maturity === 'retired' || node.invalidated === true
}

export interface MemoryGraphPanelProps {
  data: MemoryGraphData
}

export const MemoryGraphPanel: React.FC<MemoryGraphPanelProps> = ({ data }) => {
  const nodeById = useMemo(
    () => new Map(data.nodes.map(n => [n.id, n])),
    [data.nodes],
  )

  const initialNodes = useMemo<SimNode[]>(() => {
    const N = Math.max(data.nodes.length, 1)
    return data.nodes.map((n, i) => ({
      id: n.id,
      x: W / 2 + Math.cos((i / N) * 2 * Math.PI) * 200,
      y: H / 2 + Math.sin((i / N) * 2 * Math.PI) * 200,
      vx: 0,
      vy: 0,
      r: n.kind === 'entity' ? 8 : 7,
    }))
  }, [data.nodes])

  const allSimEdges = useMemo<Array<SimEdge & { edge_type: EdgeType; relation?: string }>>(
    () => data.edges.map(e => ({ source: e.source, target: e.target, edge_type: e.edge_type, relation: e.relation })),
    [data.edges],
  )

  const simNodesRef = useRef<SimNode[]>(initialNodes)
  const rafRef = useRef<number | null>(null)
  const [, setTick] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hiddenTypes, setHiddenTypes] = useState<Set<EdgeType>>(new Set())
  const dragRef = useRef<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // 数据变化时重置模拟节点
  useEffect(() => {
    simNodesRef.current = initialNodes
    setSelectedId(null)
  }, [initialNodes])

  const visibleEdges = useMemo(
    () => allSimEdges.filter(e => !hiddenTypes.has(e.edge_type)),
    [allSimEdges, hiddenTypes],
  )

  // 力导向动画循环
  useEffect(() => {
    let alpha = 1
    const tick = () => {
      const nodes = simNodesRef.current
      stepForce(nodes, visibleEdges, W, H, alpha)
      alpha *= 0.985
      setTick(t => t + 1)
      if (alpha > 0.005 || dragRef.current) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [visibleEdges, initialNodes])

  function reheat() {
    if (rafRef.current != null) return
    let alpha = 0.4
    const tick = () => {
      const nodes = simNodesRef.current
      stepForce(nodes, visibleEdges, W, H, alpha)
      alpha *= 0.985
      setTick(t => t + 1)
      if (alpha > 0.005 || dragRef.current) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  function pointerPos(evt: React.MouseEvent): { x: number; y: number } {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const sx = W / rect.width
    const sy = H / rect.height
    return { x: (evt.clientX - rect.left) * sx, y: (evt.clientY - rect.top) * sy }
  }

  function onNodeMouseDown(evt: React.MouseEvent, id: string) {
    evt.preventDefault()
    dragRef.current = id
    const node = simNodesRef.current.find(n => n.id === id)
    if (node) {
      const p = pointerPos(evt)
      node.fx = p.x
      node.fy = p.y
    }
    reheat()
  }

  useEffect(() => {
    function onMove(evt: MouseEvent) {
      const id = dragRef.current
      if (!id) return
      const node = simNodesRef.current.find(n => n.id === id)
      const svg = svgRef.current
      if (!node || !svg) return
      const rect = svg.getBoundingClientRect()
      node.fx = (evt.clientX - rect.left) * (W / rect.width)
      node.fy = (evt.clientY - rect.top) * (H / rect.height)
    }
    function onUp() {
      const id = dragRef.current
      if (!id) return
      const node = simNodesRef.current.find(n => n.id === id)
      if (node) { node.fx = undefined; node.fy = undefined }
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  function toggleEdgeType(t: EdgeType) {
    setHiddenTypes(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  const posById = new Map(simNodesRef.current.map(n => [n.id, n]))
  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null

  // 选中态邻居高亮
  const neighborIds = useMemo(() => {
    if (!selectedId) return null
    const set = new Set<string>([selectedId])
    for (const e of visibleEdges) {
      if (e.source === selectedId) set.add(e.target)
      if (e.target === selectedId) set.add(e.source)
    }
    return set
  }, [selectedId, visibleEdges])

  return (
    <div className="mem-graph">
      <div className="mem-graph__bar">
        <span className="mem-graph__stat">
          图谱：{data.stats.node_count} 节点，{data.stats.edge_count} 边
        </span>
        <div className="mem-graph__toggles">
          {ALL_EDGE_TYPES.map(t => (
            <label key={t} className="mem-graph__toggle">
              <input
                type="checkbox"
                checked={!hiddenTypes.has(t)}
                onChange={() => toggleEdgeType(t)}
              />
              <span className="mem-graph__swatch" style={{ background: EDGE_COLORS[t] }} />
              {EDGE_LABELS[t]}
            </label>
          ))}
        </div>
      </div>

      <div className="mem-graph__body">
        <svg
          ref={svgRef}
          className="mem-graph__canvas"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="记忆图谱"
          onClick={() => setSelectedId(null)}
        >
          {visibleEdges.map((e, i) => {
            const a = posById.get(e.source)
            const b = posById.get(e.target)
            if (!a || !b) return null
            const dashed = e.edge_type === 'source_case' || (e.edge_type === 'link' && !!e.relation)
            const active = !neighborIds || (neighborIds.has(e.source) && neighborIds.has(e.target))
            return (
              <line
                key={`e${i}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={EDGE_COLORS[e.edge_type]}
                strokeWidth={1.2}
                strokeOpacity={active ? 0.7 : 0.12}
                strokeDasharray={dashed ? '4 3' : undefined}
              />
            )
          })}

          {data.nodes.map(node => {
            const p = posById.get(node.id)
            if (!p) return null
            const dim = isDimmed(node)
            const active = !neighborIds || neighborIds.has(node.id)
            const opacity = (dim ? 0.35 : 1) * (active ? 1 : 0.25)
            const selected = node.id === selectedId
            const stroke = selected ? '#ede8e0' : dim ? 'currentColor' : 'rgba(0,0,0,0.4)'
            const common = {
              opacity,
              style: { cursor: 'pointer' as const },
              onMouseDown: (evt: React.MouseEvent) => onNodeMouseDown(evt, node.id),
              onClick: (evt: React.MouseEvent) => { evt.stopPropagation(); setSelectedId(node.id) },
            }
            if (node.kind === 'entity') {
              const s = p.r * 1.6
              return (
                <rect
                  key={node.id}
                  x={p.x - s / 2}
                  y={p.y - s / 2}
                  width={s}
                  height={s}
                  transform={`rotate(45 ${p.x} ${p.y})`}
                  fill={ENTITY_COLOR}
                  stroke={stroke}
                  strokeWidth={selected ? 2 : 1}
                  strokeDasharray={dim ? '2 2' : undefined}
                  {...common}
                />
              )
            }
            return (
              <circle
                key={node.id}
                cx={p.x}
                cy={p.y}
                r={p.r}
                fill={memoryColor(node)}
                stroke={stroke}
                strokeWidth={selected ? 2 : 1}
                strokeDasharray={dim ? '2 2' : undefined}
                {...common}
              />
            )
          })}
        </svg>

        <aside className="mem-graph__detail">
          {selectedNode ? (
            <NodeDetail node={selectedNode} />
          ) : (
            <div className="mem-graph__detail-empty">点击节点查看详情</div>
          )}
          <div className="mem-graph__legend">
            <div className="mem-graph__legend-title">节点类型</div>
            <LegendItem color={MEMORY_TYPE_COLORS.concept} label="概念 concept" />
            <LegendItem color={MEMORY_TYPE_COLORS.fact} label="事实 fact" />
            <LegendItem color={MEMORY_TYPE_COLORS.lesson} label="教训 lesson" />
            <LegendItem color={ENTITY_COLOR} label="实体 entity（菱形）" />
          </div>
        </aside>
      </div>
    </div>
  )
}

const LegendItem: React.FC<{ color: string; label: string }> = ({ color, label }) => (
  <div className="mem-graph__legend-item">
    <span className="mem-graph__swatch" style={{ background: color }} />
    {label}
  </div>
)

const NodeDetail: React.FC<{ node: MemoryGraphNode }> = ({ node }) => (
  <div className="mem-graph__detail-card">
    <div className="mem-graph__detail-kind">{node.kind === 'entity' ? '实体' : '记忆'}</div>
    {node.kind === 'entity' ? (
      <>
        <Field label="名称" value={node.name} />
        <Field label="实体类型" value={node.entity_type} />
        <Field label="ID" value={node.id} mono />
      </>
    ) : (
      <>
        <Field label="摘要" value={node.brief} />
        <Field label="类型" value={node.type} />
        <Field label="成熟度" value={node.maturity} />
        {node.invalidated ? <Field label="状态" value="已失效" /> : null}
        <Field label="ID" value={node.id} mono />
      </>
    )}
  </div>
)

const Field: React.FC<{ label: string; value?: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="mem-graph__field">
    <span className="mem-graph__field-label">{label}</span>
    <span className={'mem-graph__field-value' + (mono ? ' mem-graph__field-value--mono' : '')}>
      {value || '—'}
    </span>
  </div>
)
