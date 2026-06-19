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
const REP_CAP = 600   // 斥力上限：避免节点过近时 2600/d² 爆炸把节点甩飞
const VEL_CAP = 40    // 单步速度上限：防止数值不稳定导致坐标溢出

export function stepForce(nodes: SimNode[], edges: SimEdge[], W: number, H: number, alpha: number): void {
  const byId = new Map(nodes.map(n => [n.id, n]))
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]
      const dx = a.x - b.x, dy = a.y - b.y
      const d2 = dx * dx + dy * dy || 0.01
      const rep = Math.min(2600 / d2, REP_CAP), d = Math.sqrt(d2)
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
    // 固定节点（拖拽中）直接跟随，不参与向心/钳位（拖拽坐标可能在视口外）
    if (n.fx != null && n.fy != null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; continue }
    // 加强向心，把所有节点拢向中心，防止弱连接节点被斥力推到极远
    n.vx += (W / 2 - n.x) * 0.012; n.vy += (H / 2 - n.y) * 0.012
    n.vx *= 0.82; n.vy *= 0.82
    if (n.vx > VEL_CAP) n.vx = VEL_CAP; else if (n.vx < -VEL_CAP) n.vx = -VEL_CAP
    if (n.vy > VEL_CAP) n.vy = VEL_CAP; else if (n.vy < -VEL_CAP) n.vy = -VEL_CAP
    n.x += n.vx * alpha * 3; n.y += n.vy * alpha * 3
    // NaN 兜底 + 钳进画布范围，保证布局始终落在视口内、适配视图可见
    if (!Number.isFinite(n.x)) { n.x = W / 2; n.vx = 0 }
    if (!Number.isFinite(n.y)) { n.y = H / 2; n.vy = 0 }
    if (n.x < 0) n.x = 0; else if (n.x > W) n.x = W
    if (n.y < 0) n.y = 0; else if (n.y > H) n.y = H
  }
}
