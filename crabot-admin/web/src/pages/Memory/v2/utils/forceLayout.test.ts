import { describe, it, expect } from 'vitest'
import { stepForce, type SimNode, type SimEdge } from './forceLayout'

function mk(id: string, x: number, y: number): SimNode {
  return { id, x, y, vx: 0, vy: 0, r: 6 }
}

describe('stepForce', () => {
  it('moves two connected nodes from their initial coordinates', () => {
    const nodes: SimNode[] = [mk('a', 100, 100), mk('b', 400, 100)]
    const edges: SimEdge[] = [{ source: 'a', target: 'b' }]
    const a0 = { x: nodes[0].x, y: nodes[0].y }
    const b0 = { x: nodes[1].x, y: nodes[1].y }

    for (let i = 0; i < 30; i++) stepForce(nodes, edges, 600, 400, 1)

    const aMoved = nodes[0].x !== a0.x || nodes[0].y !== a0.y
    const bMoved = nodes[1].x !== b0.x || nodes[1].y !== b0.y
    expect(aMoved).toBe(true)
    expect(bMoved).toBe(true)
  })

  it('keeps a pinned node (fx/fy) fixed and zeroes its velocity', () => {
    const pinned: SimNode = { ...mk('p', 50, 50), fx: 50, fy: 50 }
    const nodes: SimNode[] = [pinned, mk('q', 300, 300)]
    const edges: SimEdge[] = [{ source: 'p', target: 'q' }]

    for (let i = 0; i < 10; i++) stepForce(nodes, edges, 600, 400, 1)

    expect(nodes[0].x).toBe(50)
    expect(nodes[0].y).toBe(50)
    expect(nodes[0].vx).toBe(0)
    expect(nodes[0].vy).toBe(0)
  })

  it('ignores edges referencing unknown nodes', () => {
    const nodes: SimNode[] = [mk('a', 100, 100)]
    const edges: SimEdge[] = [{ source: 'a', target: 'missing' }]
    expect(() => stepForce(nodes, edges, 600, 400, 1)).not.toThrow()
  })
})
