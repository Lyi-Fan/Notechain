import ELK from 'elkjs/lib/elk-api'
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker'
import { layoutGraph } from './layout'
import type { GraphModel, Point } from './model'

let engine: InstanceType<typeof ELK> | undefined
export function autoLayout(model: GraphModel, positions: Record<string, Point> = {}, collapsed: string[] = []) {
  engine ??= new ELK({ workerFactory: () => new ElkWorker() })
  return layoutGraph(engine, model, positions, collapsed)
}
