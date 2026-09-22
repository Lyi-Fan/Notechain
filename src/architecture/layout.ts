import type { ElkNode } from 'elkjs/lib/elk-api'
import { hierarchyLinks, type GraphModel, type GraphNode, type Point } from './model'

export const NODE_WIDTH = 300
export const NODE_HEIGHT = 108
export const CATEGORY_WIDTH = 180
export const CATEGORY_HEIGHT = 56
export const ROOT_WIDTH = 148
export const ROOT_HEIGHT = 72
export const MIN_ZOOM = 0.7
export const MANUAL_MIN_ZOOM = 0.001
export const CATEGORY_X = 32 + ROOT_WIDTH + 160
export const ASSET_X = CATEGORY_X + CATEGORY_WIDTH + 180
let measuringContext: CanvasRenderingContext2D | null | undefined
function textRows(value: string, width: number, maximum: number) {
  if (!value) return 1
  if (typeof document !== 'undefined') {
    measuringContext ??= document.createElement('canvas').getContext('2d')
    if (measuringContext) measuringContext.font = `14px ${getComputedStyle(document.querySelector('.asset-architecture') ?? document.body).fontFamily}`
  }
  const rows = value.split('\n').reduce((total, line) => {
    const measured = measuringContext?.measureText(line).width ?? [...line].reduce((sum, char) => sum + (char.codePointAt(0)! > 255 ? 14 : 8), 0)
    return total + Math.max(1, Math.ceil(measured / width))
  }, 0)
  return Math.min(maximum, rows)
}
export function nodeSize(node: Pick<GraphNode, 'purpose' | 'note'>) {
  const purposeRows = textRows(node.purpose, 230, 3), noteRows = textRows(node.note, 209, 4)
  return { purposeRows, noteRows, height: 20 + 31 + purposeRows * 20 + 9 + noteRows * 20 + 8 }
}
export type GraphRect = Point & { width: number; height: number }
export function straightLabelPosition(start: Point, end: Point, obstacles: GraphRect[]): Point {
  const dx = end.x - start.x, dy = end.y - start.y, halfWidth = 88, halfHeight = 15
  const blocked: [number, number][] = []
  // Clip the line against label-expanded rectangles, leaving the connecting line straight.
  for (const rect of obstacles) {
    let low = 0, high = 1
    for (const [origin, delta, min, max] of [[start.x, dx, rect.x - halfWidth, rect.x + rect.width + halfWidth], [start.y, dy, rect.y - halfHeight, rect.y + rect.height + halfHeight]]) {
      if (Math.abs(delta) < 0.000001) { if (origin < min || origin > max) { high = -1; break } }
      else { const a = (min - origin) / delta, b = (max - origin) / delta; low = Math.max(low, Math.min(a, b)); high = Math.min(high, Math.max(a, b)) }
    }
    if (low <= high) blocked.push([low, high])
  }
  blocked.sort((a, b) => a[0] - b[0])
  const gaps: [number, number][] = []
  let cursor = 0
  for (const [low, high] of blocked) { if (low > cursor) gaps.push([cursor, low]); cursor = Math.max(cursor, high) }
  if (cursor < 1) gaps.push([cursor, 1])
  const best = gaps.filter(([a, b]) => b - a > 0.000001).map(([a, b]) => (a + b) / 2).sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5))[0]
  if (best !== undefined) return { x: start.x + dx * best, y: start.y + dy * best }
  return { x: Math.max(start.x, end.x, ...obstacles.map(rect => rect.x + rect.width)) + halfWidth + 16, y: (start.y + end.y) / 2 }
}
export interface GraphLayout {
  positions: Record<string, Point>
  root: Point
  categories: { id: string; title: string; position: Point; count: number }[]
}
export interface LayoutEngine { layout(graph: ElkNode): Promise<ElkNode> }

export async function layoutGraph(engine: LayoutEngine, model: GraphModel, saved: Record<string, Point> = {}, collapsed: string[] = []): Promise<GraphLayout> {
  const rootId = `case:${model.caseId}`
  const visible = model.nodes.filter(node => node.manual || !collapsed.includes(node.categoryId))
  const treeNodes = visible.filter(node => !node.manual), manualNodes = visible.filter(node => node.manual)
  const sizes = new Map(visible.map(node => [node.id, nodeSize(node)]))
  // Ownership alone defines the tree; cyclic asset relations remain a separate overlay.
  const graph = await engine.layout({ id: 'asset-tree', layoutOptions: {
    'elk.algorithm': 'mrtree', 'elk.direction': 'RIGHT',
    'elk.spacing.nodeNode': '32', 'elk.padding': '[top=24,left=24,bottom=24,right=24]',
    'elk.mrtree.weighting': 'MODEL_ORDER',
  }, children: [
    { id: rootId, width: ROOT_WIDTH, height: ROOT_HEIGHT },
    ...model.categories.map(category => ({ id: `category:${category.id}`, width: CATEGORY_WIDTH, height: CATEGORY_HEIGHT })),
    ...treeNodes.map(node => ({ id: node.id, width: NODE_WIDTH, height: sizes.get(node.id)!.height })),
  ], edges: hierarchyLinks(model, collapsed).map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })) })
  const arranged = new Map(graph.children?.map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]))
  const positions: Record<string, Point> = {}
  for (const node of treeNodes) if (saved[node.id]) positions[node.id] = { ...saved[node.id] }
  for (const node of treeNodes) {
    if (positions[node.id]) continue
    let point = { x: ASSET_X, y: arranged.get(node.id)?.y ?? 24 }
    const height = sizes.get(node.id)!.height
    while (Object.entries(positions).some(([id, other]) => point.x < other.x + NODE_WIDTH + 16 && point.x + NODE_WIDTH + 16 > other.x && point.y < other.y + sizes.get(id)!.height + 16 && point.y + height + 16 > other.y)) point = { x: point.x, y: point.y + height + 32 }
    positions[node.id] = point
  }
  for (const node of manualNodes) if (saved[node.id]) positions[node.id] = { ...saved[node.id] }
  let freeY = 24
  for (const node of manualNodes) {
    if (positions[node.id]) continue
    const point = { x: ASSET_X + NODE_WIDTH + 180, y: freeY }, height = sizes.get(node.id)!.height
    while (Object.entries(positions).some(([id, other]) => point.x < other.x + NODE_WIDTH + 16 && point.x + NODE_WIDTH + 16 > other.x && point.y < other.y + sizes.get(id)!.height + 16 && point.y + height + 16 > other.y)) point.y += height + 32
    positions[node.id] = point; freeY = point.y + height + 32
  }
  return {
    root: { x: 32, y: arranged.get(rootId)?.y ?? 24 }, positions,
    categories: model.categories.map(category => ({ ...category, count: model.nodes.filter(node => !node.manual && node.categoryId === category.id).length, position: { x: CATEGORY_X, y: arranged.get(`category:${category.id}`)?.y ?? 24 } })),
  }
}

export function readableViewport(bounds: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }, anchor: Point) {
  const padding = 32
  const fit = Math.min((viewport.width - padding * 2) / Math.max(bounds.width, 1), (viewport.height - padding * 2) / Math.max(bounds.height, 1), 1)
  const zoom = Math.max(MIN_ZOOM, fit)
  const overflow = fit < MIN_ZOOM
  return {
    zoom,
    x: overflow ? padding - bounds.x * zoom : (viewport.width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: overflow ? viewport.height / 2 - anchor.y * zoom : (viewport.height - bounds.height * zoom) / 2 - bounds.y * zoom,
  }
}
