import PF from 'pathfinding'
import type { Point, Side } from './model'
import { NODE_HEIGHT, NODE_WIDTH } from './layout'

export interface Route { path: string; label: Point; start: Point; end: Point }
export function port(position: Point, side: Side): Point {
  return { x: position.x + (side === 'left' ? 0 : side === 'right' ? NODE_WIDTH : NODE_WIDTH / 2), y: position.y + (side === 'top' ? 0 : side === 'bottom' ? NODE_HEIGHT : NODE_HEIGHT / 2) }
}
const offset = (point: Point, side: Side, amount: number) => ({ x: point.x + (side === 'right' ? amount : side === 'left' ? -amount : 0), y: point.y + (side === 'bottom' ? amount : side === 'top' ? -amount : 0) })
function simplify(grid: PF.Grid, path: number[][]): number[][] {
  const clear = (a: number[], b: number[]) => {
    const dx = Math.sign(b[0] - a[0]), dy = Math.sign(b[1] - a[1])
    if (dx && dy) return false
    let [x, y] = a
    while (x !== b[0] || y !== b[1]) { if (!grid.isWalkableAt(x, y)) return false; x += dx; y += dy }
    return grid.isWalkableAt(x, y)
  }
  const result = [path[0]]
  let index = 0
  while (index < path.length - 1) {
    let found = false
    for (let next = path.length - 1; next > index; next--) {
      const a = path[index], b = path[next]
      for (const bend of [[b[0], a[1]], [a[0], b[1]]]) if (clear(a, bend) && clear(bend, b)) {
        result.push(bend, b); index = next; found = true; break
      }
      if (found) break
    }
    if (!found) { result.push(path[++index]) }
  }
  return PF.Util.compressPath(result)
}
export function routeEdge(source: string, target: string, sourceSide: Side, targetSide: Side, positions: Record<string, Point>): Route | undefined {
  if (!positions[source] || !positions[target]) return
  const start = port(positions[source], sourceSide), end = port(positions[target], targetSide)
  const a = offset(start, sourceSide, 32), b = offset(end, targetSide, 32), cell = 16
  const minX = Math.floor((Math.min(a.x, b.x) - 400) / cell) * cell, minY = Math.floor((Math.min(a.y, b.y) - 400) / cell) * cell
  const width = Math.ceil((Math.max(a.x, b.x) + 400 - minX) / cell) + 1, height = Math.ceil((Math.max(a.y, b.y) + 400 - minY) / cell) + 1
  // Bound both memory and work for extremely distant manually positioned nodes.
  if (width * height > 180_000) return
  const grid = new PF.Grid(width, height)
  for (const point of Object.values(positions)) {
    const left = Math.max(0, Math.floor((point.x - 12 - minX) / cell)), right = Math.min(width - 1, Math.ceil((point.x + NODE_WIDTH + 12 - minX) / cell))
    const top = Math.max(0, Math.floor((point.y - 12 - minY) / cell)), bottom = Math.min(height - 1, Math.ceil((point.y + NODE_HEIGHT + 12 - minY) / cell))
    for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) grid.setWalkableAt(x, y, false)
  }
  const ax = Math.round((a.x - minX) / cell), ay = Math.round((a.y - minY) / cell), bx = Math.round((b.x - minX) / cell), by = Math.round((b.y - minY) / cell)
  if (!grid.isWalkableAt(ax, ay) || !grid.isWalkableAt(bx, by)) return
  const path = new PF.AStarFinder({ allowDiagonal: false }).findPath(ax, ay, bx, by, grid)
  if (!path.length) return
  const points: Point[] = [start, a, ...simplify(grid, path).map(([x, y]) => ({ x: minX + x * cell, y: minY + y * cell })), b, end]
  const segments = points.slice(1).map((point, index) => ({ a: points[index], b: point, length: Math.hypot(point.x - points[index].x, point.y - points[index].y) }))
  const longest = segments.reduce((best, segment) => segment.length > best.length ? segment : best)
  return { path: `M ${start.x} ${start.y} ` + points.slice(1).map(point => `L ${point.x} ${point.y}`).join(' '), label: { x: (longest.a.x + longest.b.x) / 2, y: (longest.a.y + longest.b.y) / 2 }, start, end }
}
