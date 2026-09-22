import type { useLedger } from '../store'
import { buildGraph, emptyDocument } from './model'
import { graphFacts } from './sources'
import { GraphError } from './operations'
import { flushNative, nativeInvoke } from '../native-storage'
import { autoLayout } from './engine'
import { assetMarkdown } from '../notes'

export async function architectureRequest(ledger: ReturnType<typeof useLedger>, raw: unknown) {
  const input = raw as { action?: string; caseId?: string; patch?: unknown; preview?: boolean; resetLayout?: boolean; sourceIds?: string[] }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GraphError('需要 JSON 对象')
  if (Object.keys(input).some(key => !['action', 'caseId', 'patch', 'preview', 'resetLayout', 'sourceIds'].includes(key))) throw new GraphError('不支持的请求字段')
  for (const key of ['preview', 'resetLayout'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new GraphError(`${key} 必须为布尔值`)
  if (input.sourceIds !== undefined && (input.action !== 'get' || !Array.isArray(input.sourceIds) || input.sourceIds.length > 20 || input.sourceIds.some(id => typeof id !== 'string'))) throw new GraphError('get 的 sourceIds 最多包含 20 个资产 ID')
  if (input.action === 'cases') return ledger.getState().cases.filter(item => !item.deletedAt).map(item => ({ id: item.id, name: item.name }))
  if (!['get', 'apply', 'generate'].includes(input.action ?? '') || typeof input.caseId !== 'string') throw new GraphError('action 使用 get、apply 或 generate，并指定 caseId')
  const caseId = input.caseId
  if (!ledger.getState().cases.some(item => item.id === caseId && !item.deletedAt)) throw new GraphError('案件不存在', 404)
  const snapshot = ledger.getState(), facts = await graphFacts(snapshot, caseId)
  const latest = ledger.getState()
  if (snapshot.assets !== latest.assets || snapshot.relations !== latest.relations) throw new GraphError('读取期间资产已变化，请重试', 409)
  if (input.action === 'apply') {
    if (input.preview) {
      const { applyGraphPatch } = await import('./operations')
      const result = applyGraphPatch(latest, caseId, input.patch, facts)
      const model = buildGraph(result.state, caseId, facts), document = result.state.cases.find(item => item.id === caseId)!.architecture!
      const layout = await autoLayout(model, document.layout === 'tree' ? document.positions : {})
      return { preview: true, ...model, positions: layout.positions }
    }
    const result = ledger.applyArchitecture(caseId, input.patch, facts)
    await flushNative()
    return { ok: true, ...result }
  }
  const model = buildGraph(latest, caseId, facts), document = latest.cases.find(item => item.id === caseId)!.architecture ?? emptyDocument()
  const overrides = Object.fromEntries(Object.entries(document.positions).filter(([id]) => !input.resetLayout && document.layout === 'tree' || model.nodes.some(node => node.id === id && node.manual)))
  const layout = await autoLayout(model, overrides)
  if (input.action === 'generate' && !input.preview) {
    const beforeCommit = ledger.getState()
    if (latest.assets !== beforeCommit.assets || latest.cases !== beforeCommit.cases || latest.relations !== beforeCommit.relations) throw new GraphError('生成期间内容已变化，请重试', 409)
    if (input.resetLayout || document.layout !== 'tree') ledger.applyArchitecture(caseId, { revision: document.revision, requestId: crypto.randomUUID(), layout: 'tree' }, facts)
    await flushNative()
  }
  const sources = []
  for (const id of input.sourceIds ?? []) {
    const node = model.nodes.find(item => item.assetId === id)
    const asset = latest.assets.find(item => item.id === id)
    if (!node || !asset) throw new GraphError('来源笔记不属于当前图', 404)
    const body = asset._bodyPending && nativeInvoke ? await nativeInvoke<string | null>('read_body', { kind: 'assets', id }) : asset.noteMarkdown
    sources.push({ id, title: asset.title, markdown: body ?? assetMarkdown(asset) })
  }
  return { ...model, revision: ledger.getState().cases.find(item => item.id === caseId)?.architecture?.revision ?? model.revision, positions: layout.positions, collapsed: document.collapsed, ...(input.sourceIds ? { sources } : {}) }
}
