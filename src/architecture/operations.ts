import type { AppState } from '../types'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { buildGraph, emptyDocument, newGraphAsset, graphEndpointIds, type GraphDocument, type GraphEdge, type NoteFacts, type Point, type Side } from './model'

export class GraphError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
export interface NodeInput { id: string; address?: string; title?: string; purpose?: string; note?: string; categoryId?: string }
export interface GraphPatch {
  layout?: 'tree'
  revision: number; requestId: string
  nodes?: NodeInput[]; edges?: GraphEdge[]
  remove?: { nodes?: string[]; edges?: string[] }
  positions?: Record<string, Point>; collapsed?: string[]; restoreHidden?: boolean
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GraphError('需要 JSON 对象')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new GraphError(`不支持的字段：${key}`)
}
function text(value: unknown, max = 240): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new GraphError(`文本字段无效或超过 ${max} 字符`)
  return value
}
function id(value: unknown) {
  const result = text(value, 2200)
  if (!result || ['__proto__', 'constructor', 'prototype'].includes(result)) throw new GraphError('无效 ID')
  return result
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 500) throw new GraphError('每批最多 500 项')
  return value
}
export function parsePatch(raw: unknown): GraphPatch {
  const input = object(raw)
  keys(input, ['revision', 'requestId', 'nodes', 'edges', 'remove', 'positions', 'collapsed', 'restoreHidden', 'layout'])
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new GraphError('需要有效的 revision')
  const output: GraphPatch = { revision: Number(input.revision), requestId: text(input.requestId, 100) }
  if (!output.requestId) throw new GraphError('需要 requestId')
  if (input.layout !== undefined) {
    if (input.layout !== 'tree') throw new GraphError('layout 必须为 tree')
    output.layout = 'tree'
  }
  if (input.nodes !== undefined) output.nodes = list(input.nodes).map(rawNode => {
    const node = object(rawNode); keys(node, ['id', 'address', 'title', 'purpose', 'note', 'categoryId'])
    const result: NodeInput = { id: id(node.id) }
    for (const field of ['address', 'title', 'purpose', 'note', 'categoryId'] as const) if (node[field] !== undefined) result[field] = text(node[field], field === 'note' ? 4000 : field === 'address' ? 2048 : 500)
    return result
  })
  if (input.edges !== undefined) output.edges = list(input.edges).map(rawEdge => {
    const edge = object(rawEdge); keys(edge, ['id', 'source', 'target', 'label', 'sourceHandle', 'targetHandle', 'evidence', 'kind'])
    const result: GraphEdge = { id: id(edge.id), source: id(edge.source), target: id(edge.target), label: text(edge.label, 80).trim() || '关联', kind: 'manual', evidence: [] }
    for (const side of ['sourceHandle', 'targetHandle'] as const) if (edge[side] !== undefined) {
      if (!['top', 'right', 'bottom', 'left'].includes(String(edge[side]))) throw new GraphError('无效连接点')
      result[side] = edge[side] as Side
    }
    if (edge.evidence !== undefined) result.evidence = list(edge.evidence).map(rawEvidence => {
      const evidence = object(rawEvidence); keys(evidence, ['assetId', 'quote'])
      return { assetId: id(evidence.assetId), quote: text(evidence.quote, 240) }
    })
    return result
  })
  if (input.remove !== undefined) {
    const remove = object(input.remove); keys(remove, ['nodes', 'edges']); output.remove = {}
    for (const field of ['nodes', 'edges'] as const) if (remove[field] !== undefined) output.remove[field] = list(remove[field]).map(id)
  }
  if (input.positions !== undefined) {
    const positions = object(input.positions)
    if (Object.keys(positions).length > 500) throw new GraphError('每批最多 500 个位置')
    output.positions = {}
    for (const [key, rawPoint] of Object.entries(positions)) {
      id(key); const point = object(rawPoint); keys(point, ['x', 'y'])
      if (typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1_000_000 || Math.abs(point.y) > 1_000_000) throw new GraphError('无效节点位置')
      output.positions[key] = { x: point.x, y: point.y }
    }
  }
  if (input.collapsed !== undefined) output.collapsed = list(input.collapsed).map(id)
  if (input.restoreHidden !== undefined) {
    if (typeof input.restoreHidden !== 'boolean') throw new GraphError('restoreHidden 必须为布尔值')
    output.restoreHidden = input.restoreHidden
  }
  return output
}

export function applyGraphPatch(state: AppState, caseId: string, raw: unknown, facts?: Map<string, NoteFacts>) {
  const patch = parsePatch(raw), current = state.cases.find(item => item.id === caseId && !item.deletedAt)
  if (!current) throw new GraphError('案件不存在', 404)
  const previous = current.architecture ?? emptyDocument(), serialized = JSON.stringify(patch)
  const fingerprint = bytesToHex(sha256(new TextEncoder().encode(serialized)))
  const receipt = previous.receipts?.find(item => item.id === patch.requestId)
  if (receipt) {
    if (receipt.fingerprint !== fingerprint && receipt.fingerprint !== serialized) throw new GraphError('requestId 已用于不同的修改', 409)
    return { state, revision: receipt.revision, replayed: true }
  }
  if (patch.revision !== previous.revision) throw new GraphError('资产图已更新，请重新读取后修改', 409)
  const document: GraphDocument = structuredClone(previous)
  if (patch.layout === 'tree') {
    document.layout = 'tree'
    const manualIds = new Set(state.assets.filter(asset => current.assetIds.includes(asset.id) && asset.provenance.method === 'architecture').map(asset => asset.id))
    document.positions = Object.fromEntries(Object.entries(document.positions).filter(([id]) => manualIds.has(id)))
  }
  const before = buildGraph(state, caseId, facts), existing = new Map(before.nodes.map(node => [node.id, node]))
  const categoryIds = new Set(before.categories.map(item => item.id))
  const time = new Date().toISOString()
  let assets = state.assets, assetIds = current.assetIds
  for (const input of patch.nodes ?? []) {
    if (input.categoryId && !categoryIds.has(input.categoryId) && input.categoryId !== 'unassigned') throw new GraphError('分类不属于当前案件')
    const node = existing.get(input.id)
    const original = assets.find(item => item.id === input.id)
    if (!node && original) throw new GraphError('资产已隐藏、已删除或属于其他案件')
    if (input.id.startsWith('entity:') && !node) throw new GraphError('发现节点已失效，请重新生成')
    if (node?.discovered && input.categoryId && input.categoryId !== node.categoryId) throw new GraphError('发现节点的归属来自原笔记')
    if (!node) {
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/.test(input.id)) throw new GraphError('新资产 ID 仅支持字母、数字、下划线和连字符，最多 100 字符')
      assets = [...assets, newGraphAsset(input.id, caseId, { ...input, categoryId: input.categoryId === 'unassigned' ? undefined : input.categoryId })]
      assetIds = [...new Set([...assetIds, input.id])]
    } else if (node.assetId) {
      assets = assets.map(asset => asset.id !== node.assetId ? asset : { ...asset,
        ...(input.address !== undefined ? { value: input.address, kind: newGraphAsset(asset.id, caseId, { address: input.address }).kind } : {}),
        ...(input.address !== undefined && input.title === undefined && !asset.customTitle && (asset.title === '未命名资产' || asset.title === asset.value) ? { title: input.address || '未命名资产' } : {}),
        ...(input.title !== undefined ? { title: input.title, customTitle: input.title } : {}),
        ...(input.purpose !== undefined ? { utility: input.purpose } : {}),
        ...(input.categoryId !== undefined ? { targetId: input.categoryId === 'unassigned' ? undefined : input.categoryId } : {}),
        updatedAt: time, version: asset.version + 1,
      })
    }
    const { id: _id, categoryId: _category, ...fields } = input
    // Bound assets keep address/title/purpose in the original records, so sidebar edits stay live.
    document.nodes[input.id] = { ...document.nodes[input.id], ...(node?.discovered ? fields : input.note !== undefined ? { note: input.note } : {}) }
    if (!node?.discovered && input.purpose !== undefined) {
      if (input.purpose === '') document.nodes[input.id].purpose = ''
      else delete document.nodes[input.id].purpose
    }
    document.hiddenNodes = document.hiddenNodes.filter(item => item !== input.id)
  }
  let next: AppState = { ...state, assets, cases: state.cases.map(item => item.id === caseId ? { ...item, assetIds, architecture: document, updatedAt: time } : item) }
  const after = buildGraph(next, caseId, facts), ids = new Set(after.nodes.map(node => node.id))
  const endpoints = graphEndpointIds(after)
  const edgeIds = new Set(after.edges.map(edge => edge.id))
  for (const edge of patch.edges ?? []) {
    if (!endpoints.has(edge.source) || !endpoints.has(edge.target) || edge.source === edge.target) throw new GraphError('关系两端必须是当前案件中不同的可见节点')
    if (edge.evidence.some(item => !assetIds.includes(item.assetId))) throw new GraphError('关系依据必须来自当前案件')
    if (edgeIds.has(edge.id) && !document.edges.some(item => item.id === edge.id)) throw new GraphError('自动关系请先移除，再建立新关系')
    document.edges = [...document.edges.filter(item => item.id !== edge.id), edge]
    document.hiddenEdges = document.hiddenEdges.filter(item => item !== edge.id)
  }
  for (const nodeId of patch.remove?.nodes ?? []) {
    if (!ids.has(nodeId)) throw new GraphError('待移除节点不存在')
    document.hiddenNodes = [...new Set([...document.hiddenNodes, nodeId])]
  }
  for (const edgeId of patch.remove?.edges ?? []) {
    if (!edgeIds.has(edgeId) && !document.edges.some(edge => edge.id === edgeId)) throw new GraphError('待移除关系不存在')
    document.hiddenEdges = [...new Set([...document.hiddenEdges, edgeId])]
  }
  for (const nodeId of Object.keys(patch.positions ?? {})) if (!ids.has(nodeId)) throw new GraphError('位置对应的节点不存在')
  document.positions = { ...document.positions, ...patch.positions }
  if (patch.collapsed) {
    if (patch.collapsed.some(item => !after.categories.some(category => category.id === item))) throw new GraphError('折叠分类不存在')
    document.collapsed = patch.collapsed
  }
  if (patch.restoreHidden) { document.hiddenNodes = []; document.hiddenEdges = [] }
  document.revision++
  document.receipts = [...(previous.receipts ?? []).slice(-19).map(receipt => ({ ...receipt, fingerprint: receipt.fingerprint.startsWith('{') ? bytesToHex(sha256(new TextEncoder().encode(receipt.fingerprint))) : receipt.fingerprint })), { id: patch.requestId, fingerprint, revision: document.revision }]
  return { state: next, revision: document.revision, replayed: false }
}
