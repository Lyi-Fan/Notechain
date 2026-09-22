import { Marked, type Token } from 'marked'
import type { AppState, AssetRecord } from '../types'
import { assetIdFromNoteHref } from '../notes'

export type Point = { x: number; y: number }
export type Side = 'top' | 'right' | 'bottom' | 'left'
export interface GraphEvidence { assetId: string; quote: string }
export interface GraphNode {
  manual?: boolean
  id: string; assetId?: string; categoryId: string; address: string; title: string
  purpose: string; note: string; evidence: GraphEvidence[]; discovered?: boolean
}
export interface GraphEdge {
  id: string; source: string; target: string; label: string
  kind: 'relation' | 'reference' | 'mention' | 'contains' | 'manual'
  evidence: GraphEvidence[]; sourceHandle?: Side; targetHandle?: Side
}
export interface GraphDocument {
  layout?: 'tree'
  revision: number
  nodes: Record<string, Partial<Pick<GraphNode, 'address' | 'title' | 'purpose' | 'note'>>>
  edges: GraphEdge[]
  positions: Record<string, Point>
  hiddenNodes: string[]; hiddenEdges: string[]; collapsed: string[]
  receipts?: { id: string; fingerprint: string; revision: number }[]
}
export interface GraphModel {
  caseId: string; revision: number; nodes: GraphNode[]; edges: GraphEdge[]
  categories: { id: string; title: string }[]; hiddenCount: number
}
export interface NoteFacts { addresses: string[]; links: string[]; purpose?: string; statements?: { source: string; target: string; label: string; quote: string }[] }
export const emptyDocument = (): GraphDocument => ({ layout: 'tree', revision: 0, nodes: {}, edges: [], positions: {}, hiddenNodes: [], hiddenEdges: [], collapsed: [] })
export function graphEndpointIds(model: Pick<GraphModel, 'caseId' | 'nodes' | 'categories'>) {
  return new Set([`case:${model.caseId}`, ...model.categories.map(category => `category:${category.id}`), ...model.nodes.map(node => node.id)])
}
export function hierarchyLinks(model: GraphModel, collapsed: string[] = []) {
  return [
    ...model.categories.map(category => ({ id: `branch:${category.id}`, source: `case:${model.caseId}`, target: `category:${category.id}` })),
    ...model.nodes.filter(node => !node.manual && !collapsed.includes(node.categoryId)).map(node => ({ id: `leaf:${node.id}`, source: `category:${node.categoryId}`, target: node.id })),
  ]
}
export function relationVisible(edge: GraphEdge, allAutomatic: boolean, selectedNode: string | null, selectedEdge: string | null) {
  return edge.kind === 'manual' || allAutomatic || edge.source === selectedNode || edge.target === selectedNode || edge.id === selectedEdge
}
const parser = new Marked()
const relationLabels: Record<string, string> = { references: '引用', derived_from: '发现自', hosted_on: '部署于', runs: '运行', depends_on: '依赖', duplicate_of: '重复资产' }

// URL parsing normalizes host names, IPv6 and IDNs without resolving DNS or stripping ports.
export function addressIdentity(input: string): string | null {
  const raw = input.trim().replace(/[。；，、）)]+$/u, '')
  if (!raw || /\s/.test(raw) || raw.length > 2048) return null
  try {
    const explicit = /^https?:\/\//i.test(raw)
    if (!explicit && /[/?#@]/.test(raw)) return null
    const url = new URL(explicit ? raw : `https://${raw}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!host.includes('.') && !host.startsWith('[')) return null
    if (/^\d+(\.\d+){3}$/.test(host)) {
      if (!explicit && raw.split(':')[0] !== host) return null
    } else if (!host.startsWith('[') && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)) return null
    if (explicit) { url.hostname = host; return url.href }
    return host + (url.port ? `:${url.port}` : '')
  } catch { return null }
}

export function extractFacts(markdown: string): NoteFacts {
  const addresses = new Set<string>(), links = new Set<string>()
  const paragraphs: string[] = []
  const candidatePattern = /https?:\/\/[^\s<>\[\]"'`\p{Script=Han}，。；、（）]+|(?<![\w@/.-])(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+(?:[a-zA-Z]{2,63}|\d{1,3})(?::\d{1,5})?(?![\w.-])/u.source
  // Code, HTML, images and secret-reference destinations are not architecture evidence.
  const scan = (text: string) => {
    const candidates = text.match(new RegExp(candidatePattern, 'gu')) ?? []
    for (const candidate of candidates) {
      const address = addressIdentity(candidate)
      if (address && addresses.size < 64) addresses.add(address)
    }
  }
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (['code', 'codespan', 'html', 'image'].includes(token.type)) continue
      if (token.type === 'link') {
        const link = token as Token & { href: string; tokens: Token[] }
        const id = assetIdFromNoteHref(link.href) ?? (link.href.startsWith('asset://') ? link.href.slice(8).split('#')[0] : null)
        if (id) links.add(id)
        else if (!link.href.includes('/findings/') && !link.href.startsWith('secret:')) { scan(link.href); visit(link.tokens) }
        continue
      }
      if (token.type === 'paragraph' || token.type === 'heading') {
        const plain = (token.tokens ?? []).filter(item => item.type === 'text' || item.type === 'strong' || item.type === 'em').map(item => 'text' in item ? item.text : '').join('')
        paragraphs.push(plain)
      }
      if ('tokens' in token && Array.isArray(token.tokens)) visit(token.tokens)
      else if (token.type === 'list') for (const item of token.items) visit(item.tokens)
      else if (token.type === 'table') for (const cell of [...token.header, ...token.rows.flat()]) visit(cell.tokens)
      else if (token.type === 'text' && 'text' in token) scan(String(token.text))
    }
  }
  visit(parser.lexer(markdown.slice(0, 512_000)))
  let purpose: string | undefined
  const statements: NonNullable<NoteFacts['statements']> = []
  for (let i = 0; i < paragraphs.length; i++) {
    const line = paragraphs[i]
    const labelled = line.match(/^(?:用途|作用|职责|purpose)\s*[:：]\s*(.{1,500})$/i)
    if (!purpose && labelled) purpose = labelled[1]
    if (!purpose && /^(用途|作用|职责|purpose)$/i.test(line.trim()) && paragraphs[i + 1]) purpose = paragraphs[i + 1].slice(0, 500)
    for (const sentence of line.split(/[\n。；!?！？]/u)) {
      if (/(可能|疑似|猜测|待确认|不确定|尚未|没有|并非|不是|未能|不依赖|未部署|未解析)/.test(sentence)) continue
      const relation = new RegExp(`(${candidatePattern})\\s*(解析到|解析为|部署在|部署于|依赖于|依赖|调用)\\s*(${candidatePattern})`, 'gu')
      for (const match of sentence.matchAll(relation)) {
        const source = addressIdentity(match[1]), target = addressIdentity(match[3])
        if (!source || !target || source === target || !addresses.has(source) || !addresses.has(target)) continue
        const label = match[2].startsWith('解析') ? '解析到' : match[2].startsWith('部署') ? '部署于' : match[2].startsWith('依赖') ? '依赖' : '调用'
        statements.push({ source, target, label, quote: `${match[1]} ${match[2]} ${match[3]}`.slice(0, 240) })
      }
    }
  }
  return { addresses: [...addresses].sort(), links: [...links].sort(), ...(purpose ? { purpose } : {}), ...(statements.length ? { statements } : {}) }
}

export function graphAssets(state: AppState, caseId: string) {
  const current = state.cases.find(item => item.id === caseId && !item.deletedAt)
  return state.assets.filter(item => !item.deletedAt && current?.assetIds.includes(item.id))
}

export function buildGraph(state: AppState, caseId: string, facts: Map<string, NoteFacts> = new Map()): GraphModel {
  const current = state.cases.find(item => item.id === caseId && !item.deletedAt)
  if (!current) throw new Error('案件不存在')
  const document = current.architecture ?? emptyDocument()
  const categories = state.targets.filter(item => current.targetIds.includes(item.id)).map(item => ({ id: item.id, title: item.name }))
  const categoryIds = new Set(categories.map(item => item.id))
  const sourceAssets = graphAssets(state, caseId).sort((a, b) => a.id.localeCompare(b.id))
  const automaticAssets = sourceAssets.filter(asset => asset.provenance.method !== 'architecture')
  const nodes: GraphNode[] = sourceAssets.map(asset => ({
    id: asset.id, assetId: asset.id, categoryId: categoryIds.has(asset.targetId ?? '') ? asset.targetId! : 'unassigned',
    manual: asset.provenance.method === 'architecture',
    address: asset.value, title: asset.customTitle || asset.title, purpose: asset.utility || (document.nodes[asset.id]?.purpose === '' ? '' : facts.get(asset.id)?.purpose || extractFacts(asset.noteMarkdown ?? '').purpose || ''),
    note: asset.provenance.source || asset.situation, evidence: [],
  }))
  const byAddress = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    const address = addressIdentity(node.address)
    if (address) byAddress.set(address, [...(byAddress.get(address) ?? []), node])
  }
  const edges: GraphEdge[] = []
  const nodeIds = new Set(nodes.map(node => node.id))
  for (const relation of state.relations) {
    if (relation.sourceType !== 'asset' || relation.targetType !== 'asset' || !relation.sourceId || !nodeIds.has(relation.sourceId) || !nodeIds.has(relation.targetId)) continue
    edges.push({ id: `relation:${relation.id}`, source: relation.sourceId, target: relation.targetId, label: relationLabels[relation.type] ?? relation.type, kind: 'relation', evidence: [], ...(relation.note ? { evidence: [{ assetId: relation.sourceId, quote: relation.note.slice(0, 240) }] } : {}) })
  }
  for (const asset of automaticAssets) {
    const extracted = facts.get(asset.id) ?? extractFacts(asset.noteMarkdown ?? '')
    for (const target of extracted.links) {
      if (nodeIds.has(target) && target !== asset.id) edges.push({ id: `reference:${asset.id}:${target}`, source: asset.id, target, label: '引用', kind: 'reference', evidence: [{ assetId: asset.id, quote: '笔记内的资产关联引用' }] })
    }
    for (const address of extracted.addresses) {
      let matches = byAddress.get(address)
      // Ambiguous existing records stay distinct; never guess which duplicate was meant.
      if (matches && matches.length > 1) continue
      if (!matches) {
        const node: GraphNode = { id: `entity:${address}`, categoryId: 'discovered', address, title: '', purpose: '', note: '', evidence: [], discovered: true }
        nodes.push(node); nodeIds.add(node.id); matches = [node]; byAddress.set(address, matches)
      }
      const target = matches[0]
      if (target.id === asset.id) continue
      const evidence = { assetId: asset.id, quote: address }
      if (target.discovered && !target.evidence.some(item => item.assetId === asset.id)) target.evidence.push(evidence)
      edges.push({ id: `mention:${asset.id}:${target.id}`, source: asset.id, target: target.id, label: '提及', kind: 'mention', evidence: [evidence] })
    }
  }
  for (const [address, matches] of byAddress) {
    if (!/^https?:\/\//.test(address) || matches.length !== 1) continue
    const url = new URL(address), hosts = byAddress.get(url.hostname)
    if (hosts?.length === 1 && hosts[0].id !== matches[0].id) edges.push({ id: `host:${matches[0].id}:${hosts[0].id}`, source: matches[0].id, target: hosts[0].id, label: 'URL 主机', kind: 'contains', evidence: [{ assetId: matches[0].assetId ?? hosts[0].assetId ?? '', quote: url.hostname }] })
  }
  for (const asset of automaticAssets) for (const statement of (facts.get(asset.id) ?? extractFacts(asset.noteMarkdown ?? '')).statements ?? []) {
    const source = byAddress.get(statement.source), target = byAddress.get(statement.target)
    if (source?.length !== 1 || target?.length !== 1 || source[0].id === target[0].id) continue
    const id = `statement:${source[0].id}:${statement.label}:${target[0].id}`
    const existing = edges.find(edge => edge.id === id || edge.source === source[0].id && edge.target === target[0].id && edge.label === statement.label)
    if (existing) existing.evidence.push({ assetId: asset.id, quote: statement.quote })
    else edges.push({ id, source: source[0].id, target: target[0].id, label: statement.label, kind: 'relation', evidence: [{ assetId: asset.id, quote: statement.quote }] })
  }
  if (nodes.some(node => !node.manual && node.categoryId === 'unassigned')) categories.push({ id: 'unassigned', title: '未分类' })
  if (nodes.some(node => node.categoryId === 'discovered')) categories.push({ id: 'discovered', title: '笔记中发现' })
  const visible = nodes.filter(node => !document.hiddenNodes.includes(node.id)).map(node => ({ ...node, ...(node.assetId ? { note: document.nodes[node.id]?.note ?? node.note } : document.nodes[node.id]) }))
  const visibleIds = graphEndpointIds({ caseId, nodes: visible, categories })
  const manualIds = new Set(nodes.filter(node => node.manual).map(node => node.id))
  const explicitOrAutomatic = edges.filter(edge => edge.id.startsWith('relation:') || !manualIds.has(edge.source) && !manualIds.has(edge.target))
  const allEdges = [...explicitOrAutomatic, ...document.edges].filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target) && edge.source !== edge.target && !document.hiddenEdges.includes(edge.id))
  // A stored semantic relationship takes precedence over a weaker mention of the same pair.
  const strongPairs = new Set(allEdges.filter(edge => !['mention', 'reference'].includes(edge.kind)).map(edge => `${edge.source}\0${edge.target}`))
  return { caseId, revision: document.revision, categories, nodes: visible, edges: allEdges.filter(edge => !['mention', 'reference'].includes(edge.kind) || !strongPairs.has(`${edge.source}\0${edge.target}`)), hiddenCount: nodes.length - visible.length }
}

export function newGraphAsset(id: string, caseId: string, input: { address?: string; title?: string; purpose?: string; note?: string; categoryId?: string }): AssetRecord {
  const time = new Date().toISOString(), address = input.address ?? ''
  const kind = /^https?:/.test(address) ? 'url' : /^\d+\.\d+\.\d+\.\d+$/.test(address) || address.startsWith('[') ? 'ip' : address ? 'domain' : 'service'
  return { id, caseId, targetId: input.categoryId, kind, value: address, title: input.title || address || '未命名资产', utility: input.purpose ?? '', situation: '', details: '', nextSteps: '', provenance: { source: input.note ?? '', method: 'architecture', reason: '', capturedAt: time }, relationIds: [], findingIds: [], status: 'unknown', severity: 'info', confidence: 'medium', tags: [], noteMarkdown: '', createdAt: time, updatedAt: time, version: 1 }
}
