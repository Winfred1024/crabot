export interface SimNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  fx?: number
  fy?: number
}

export interface SimEdge {
  source: string
  target: string
}

/**
 * 单步力导向布局：节点间斥力 + 边弹簧 + 向心力。
 * 直接原地更新 nodes（动画热路径，刻意可变）。
 */
export function stepForce(nodes: SimNode[], edges: SimEdge[], W: number, H: number, alpha: number): void {
  const byId = new Map(nodes.map(n => [n.id, n]))
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]
      const dx = a.x - b.x, dy = a.y - b.y
      const d2 = dx * dx + dy * dy || 0.01
      const rep = 2600 / d2, d = Math.sqrt(d2)
      const fx = (dx / d) * rep, fy = (dy / d) * rep
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
    }
  }
  for (const e of edges) {
    const a = byId.get(e.source), b = byId.get(e.target)
    if (!a || !b) continue
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01
    const f = (d - 80) * 0.02, fx = (dx / d) * f, fy = (dy / d) * f
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
  }
  for (const n of nodes) {
    n.vx += (W / 2 - n.x) * 0.0016; n.vy += (H / 2 - n.y) * 0.0016
    if (n.fx != null && n.fy != null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0 }
    else { n.vx *= 0.82; n.vy *= 0.82; n.x += n.vx * alpha * 3; n.y += n.vy * alpha * 3 }
  }
}
