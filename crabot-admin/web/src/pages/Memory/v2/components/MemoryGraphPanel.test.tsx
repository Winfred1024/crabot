import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryGraphPanel } from './MemoryGraphPanel'
import type { MemoryGraphData } from '../../../../services/memoryV2'

const data: MemoryGraphData = {
  nodes: [
    { id: 'm1', kind: 'memory', type: 'fact', brief: '事实一', maturity: 'confirmed' },
    { id: 'm2', kind: 'memory', type: 'concept', brief: '概念二', maturity: 'established' },
    { id: 'e1', kind: 'entity', entity_type: 'person', name: '小明' },
  ],
  edges: [
    { source: 'm1', target: 'm2', edge_type: 'link', relation: 'related' },
    { source: 'm1', target: 'e1', edge_type: 'membership' },
  ],
  stats: { node_count: 3, edge_count: 2 },
}

describe('MemoryGraphPanel', () => {
  beforeEach(() => {
    // 不跑动画：rAF 设为 noop，只断言首帧 DOM
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders one shape per node and one line per visible edge', () => {
    const { container } = render(<MemoryGraphPanel data={data} />)
    const circles = container.querySelectorAll('circle')
    const rects = container.querySelectorAll('rect')
    const lines = container.querySelectorAll('line')
    // 2 memory circles + 1 entity rect = 3 nodes
    expect(circles.length).toBe(2)
    expect(rects.length).toBe(1)
    expect(lines.length).toBe(2)
  })

  it('shows node/edge counts in the header', () => {
    render(<MemoryGraphPanel data={data} />)
    expect(screen.getByText('图谱：3 节点，2 边')).toBeInTheDocument()
  })

  it('hides edges of a type when its checkbox is unchecked', () => {
    const { container } = render(<MemoryGraphPanel data={data} />)
    expect(container.querySelectorAll('line').length).toBe(2)
    fireEvent.click(screen.getByRole('checkbox', { name: /关联/ }))
    expect(container.querySelectorAll('line').length).toBe(1)
  })

  it('shows node detail on click', () => {
    const { container } = render(<MemoryGraphPanel data={data} />)
    const firstCircle = container.querySelector('circle')!
    fireEvent.click(firstCircle)
    expect(screen.getByText('事实一')).toBeInTheDocument()
  })
})
