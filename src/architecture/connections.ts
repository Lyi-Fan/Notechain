import type { Point, Side } from './model'
import type { GraphRect } from './layout'

export function handlePoint(rect: GraphRect, side: Side): Point {
  return { x: rect.x + (side === 'left' ? 0 : side === 'right' ? rect.width : rect.width / 2), y: rect.y + (side === 'top' ? 0 : side === 'bottom' ? rect.height : rect.height / 2) }
}
export function snapToNode(fixedId: string, fixedSide: Side, fixedRect: GraphRect, targetId: string, targetRect: GraphRect, movingEnd: 'source' | 'target' = 'target') {
  if (fixedId === targetId) return null
  const origin = handlePoint(fixedRect, fixedSide)
  const candidates: Side[] = ['left', 'right', 'top', 'bottom']
  const side = candidates.sort((a, b) => {
    const pa = handlePoint(targetRect, a), pb = handlePoint(targetRect, b)
    return Math.hypot(pa.x - origin.x, pa.y - origin.y) - Math.hypot(pb.x - origin.x, pb.y - origin.y)
  })[0]
  return movingEnd === 'target'
    ? { source: fixedId, target: targetId, sourceHandle: fixedSide, targetHandle: side }
    : { source: targetId, target: fixedId, sourceHandle: side, targetHandle: fixedSide }
}
