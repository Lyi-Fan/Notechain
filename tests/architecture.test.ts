import test from 'node:test'
import assert from 'node:assert/strict'
import ELK from 'elkjs/lib/elk.bundled.js'
import { createTestState } from './support/state'
import { addressIdentity, buildGraph, emptyDocument, extractFacts, newGraphAsset, hierarchyLinks, relationVisible } from '../src/architecture/model'
import { snapToNode } from '../src/architecture/connections'
import { applyGraphPatch, parsePatch } from '../src/architecture/operations'
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH, ROOT_WIDTH, CATEGORY_WIDTH, readableViewport, MIN_ZOOM, nodeSize, straightLabelPosition } from '../src/architecture/layout'
import { routeEdge } from '../src/architecture/routing'

function fixture() {
  const state = createTestState()
  const current = { ...state.cases[0], id: 'synthetic_graph', assetIds: ['web', 'host', 'note'], targetIds: ['apps', 'hosts'], architecture: emptyDocument() }
  state.cases = [current]
  state.targets = [{ id: 'apps', name: '应用', kind: '', identifier: '', note: '' }, { id: 'hosts', name: '基础设施', kind: '', identifier: '', note: '' }]
  state.assets = [newGraphAsset('web', current.id, { address: 'https://portal.example.test/login', purpose: '登录入口', categoryId: 'apps' }), newGraphAsset('host', current.id, { address: 'portal.example.test', categoryId: 'hosts' }), newGraphAsset('note', current.id, { title: '发现记录', categoryId: 'apps' })]
  state.assets[2].noteMarkdown = '从 portal.example.test 发现 192.0.2.15。\n\n[入口](/cases/synthetic_graph/assets/web)\n\n```text\nignored.example.test\n```'
  state.assets.forEach(asset => { asset.provenance.method = 'synthetic-fixture' })
  state.relations = []
  return state
}
test('normalizes exact identities without merging protocols, ports or paths', () => {
  assert.equal(addressIdentity('EXAMPLE.test.'), 'example.test')
  assert.equal(addressIdentity('https://EXAMPLE.test:443/a'), 'https://example.test/a')
  assert.notEqual(addressIdentity('https://example.test/a'), addressIdentity('http://example.test/a'))
  for (const value of ['999.1.1.1', '127.1', 'https://user:pass@example.test', 'javascript:alert(1)', 'example', 'a@host.test', '192.168.001.1']) assert.equal(addressIdentity(value), null, value)
})
test('extracts structured links and prose addresses but excludes code, images and secrets', () => {
  const facts = extractFacts('文字：192.0.2.4。\n\n[站点](https://example.test/a) [资产](/cases/c/assets/ast_1#intro)\n\n`secret.example.test`\n\n![image](https://image.example.test/x.png)\n\n[密钥 example.secret.test](/cases/c/findings/secret)\n\n```\ncode.example.test\n```')
  assert.deepEqual(facts.addresses, ['192.0.2.4', 'https://example.test/a'])
  assert.deepEqual(facts.links, ['ast_1'])
})
test('builds provenance-backed discovery and never invents deployment/DNS relationships', () => {
  const graph = buildGraph(fixture(), 'synthetic_graph')
  assert.equal(graph.nodes.length, 4)
  assert(graph.edges.some(edge => edge.source === 'web' && edge.target === 'host' && edge.kind === 'contains'))
  assert(graph.edges.some(edge => edge.source === 'note' && edge.target === 'web' && edge.kind === 'reference'))
  assert(graph.edges.some(edge => edge.target === 'entity:192.0.2.15' && edge.kind === 'mention'))
  assert(!graph.edges.some(edge => edge.label === '部署于' || edge.label === '解析到'))
  assert.deepEqual(graph.nodes.find(node => node.id === 'entity:192.0.2.15')?.evidence, [{ assetId: 'note', quote: '192.0.2.15' }])
})
test('duplicate addresses and cross-case references do not guess identity', () => {
  const state = fixture()
  state.assets.push(newGraphAsset('duplicate', 'synthetic_graph', { address: 'portal.example.test' }))
  state.cases[0].assetIds.push('duplicate')
  state.assets[2].noteMarkdown += '\n[other](/cases/another/assets/foreign)'
  const graph = buildGraph(state, 'synthetic_graph')
  assert(!graph.edges.some(edge => edge.source === 'note' && ['host', 'duplicate', 'foreign'].includes(edge.target)))
})
test('extracts purpose and explicit relationships, excludes uncertain and negated statements', () => {
  const facts = extractFacts('用途：统一登录入口\n\nportal.example.test 解析到 192.0.2.10。\n\napi.example.test 可能部署于 192.0.2.11。\n\nother.example.test 未部署在 192.0.2.12。\n\nURL https://portal.example.test用于登录。')
  assert.equal(facts.purpose, '统一登录入口')
  assert.deepEqual(facts.statements, [{ source: 'portal.example.test', target: '192.0.2.10', label: '解析到', quote: 'portal.example.test 解析到 192.0.2.10' }])
  assert(facts.addresses.includes('https://portal.example.test/'))
})
test('patch writes bound assets, preserves notes and is atomic, versioned and retry-safe', () => {
  const state = fixture(), original = structuredClone(state)
  const patch = { revision: 0, requestId: 'operation-1', nodes: [{ id: 'web', purpose: '统一身份认证' }, { id: 'new', address: '198.51.100.2', categoryId: 'hosts' }], edges: [{ id: 'manual', source: 'web', target: 'new', label: '部署于' }] }
  const first = applyGraphPatch(state, 'synthetic_graph', patch)
  assert.equal(first.state.assets.find(asset => asset.id === 'web')?.utility, '统一身份认证')
  assert.equal(first.state.assets.find(asset => asset.id === 'note')?.noteMarkdown, original.assets[2].noteMarkdown)
  assert.deepEqual(state, original)
  const repeated = applyGraphPatch(first.state, 'synthetic_graph', patch)
  assert.equal(repeated.state, first.state)
  assert.equal(repeated.replayed, true)
  assert.equal(first.state.cases[0].architecture?.receipts?.[0].fingerprint.length, 64)
  assert.throws(() => applyGraphPatch(first.state, 'synthetic_graph', { ...patch, requestId: 'different' }), /已更新/)
  assert.throws(() => applyGraphPatch(state, 'synthetic_graph', { ...patch, edges: [{ id: 'bad', source: 'web', target: 'foreign', label: '错误' }] }), /两端/)
  assert.deepEqual(state, original)
})
test('hide survives regeneration, restore keeps source notes and preserves manual positions', () => {
  const state = fixture(), id = 'entity:192.0.2.15'
  const hidden = applyGraphPatch(state, 'synthetic_graph', { revision: 0, requestId: 'hide', remove: { nodes: [id] }, positions: { web: { x: -40, y: 240 } } }).state
  assert(!buildGraph(hidden, 'synthetic_graph').nodes.some(node => node.id === id))
  assert.equal(hidden.assets.length, state.assets.length)
  const restored = applyGraphPatch(hidden, 'synthetic_graph', { revision: 1, requestId: 'restore', restoreHidden: true }).state
  assert(buildGraph(restored, 'synthetic_graph').nodes.some(node => node.id === id))
  assert.deepEqual(restored.cases[0].architecture?.positions.web, { x: -40, y: 240 })
})
test('clearing an inferred purpose stays empty and later source-field edits remain live', () => {
  const state = fixture()
  state.assets[2].noteMarkdown = '用途：旧用途'
  assert.equal(buildGraph(state, 'synthetic_graph').nodes.find(node => node.id === 'note')?.purpose, '旧用途')
  const cleared = applyGraphPatch(state, 'synthetic_graph', { revision: 0, requestId: 'clear-purpose', nodes: [{ id: 'note', purpose: '' }] }).state
  assert.equal(buildGraph(cleared, 'synthetic_graph').nodes.find(node => node.id === 'note')?.purpose, '')
  cleared.assets.find(asset => asset.id === 'note')!.utility = '从原资产修改用途'
  assert.equal(buildGraph(cleared, 'synthetic_graph').nodes.find(node => node.id === 'note')?.purpose, '从原资产修改用途')
})
test('address-only creation names the bound note without replacing an existing custom title', () => {
  let state = applyGraphPatch(fixture(), 'synthetic_graph', { revision: 0, requestId: 'blank-node', nodes: [{ id: 'new_node', address: '' }] }).state
  state = applyGraphPatch(state, 'synthetic_graph', { revision: 1, requestId: 'fill-address', nodes: [{ id: 'new_node', address: '198.51.100.50' }] }).state
  assert.equal(state.assets.find(asset => asset.id === 'new_node')?.title, '198.51.100.50')
  state = applyGraphPatch(state, 'synthetic_graph', { revision: 2, requestId: 'set-title', nodes: [{ id: 'new_node', title: '自定义标题' }] }).state
  state = applyGraphPatch(state, 'synthetic_graph', { revision: 3, requestId: 'change-address', nodes: [{ id: 'new_node', address: '198.51.100.51' }] }).state
  assert.equal(state.assets.find(asset => asset.id === 'new_node')?.title, '自定义标题')
})
test('rejects prototype keys, invalid positions, unknown fields and missing revisions', () => {
  for (const patch of [JSON.parse('{"revision":0,"requestId":"a","positions":{"__proto__":{"x":0,"y":0}}}'), { revision: 0, requestId: 'a', positions: { web: { x: Infinity, y: 0 } } }, { revision: 0, requestId: 'a', unknown: true }, { requestId: 'a' }]) assert.throws(() => parsePatch(patch))
})
test('deterministic tree layout keeps relationship cycles separate and preserves explicit positions', async () => {
  const state = fixture(), engine = new ELK()
  state.cases[0].architecture!.edges = [{ id: 'cycle-a', source: 'web', target: 'note', kind: 'manual', label: '依赖', evidence: [] }, { id: 'cycle-b', source: 'note', target: 'web', kind: 'manual', label: '回调', evidence: [] }]
  const model = buildGraph(state, 'synthetic_graph')
  const first = await layoutGraph(engine, model), second = await layoutGraph(engine, model)
  assert.deepEqual(first.positions, second.positions)
  const values = Object.values(first.positions)
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) assert(Math.abs(values[i].x - values[j].x) >= NODE_WIDTH || Math.abs(values[i].y - values[j].y) >= NODE_HEIGHT)
  const changed = applyGraphPatch(state, 'synthetic_graph', { revision: 0, requestId: 'new', nodes: [{ id: 'added', title: '新增服务', categoryId: 'apps' }] }).state
  const expanded = await layoutGraph(engine, buildGraph(changed, 'synthetic_graph'), first.positions)
  for (const [id, point] of Object.entries(first.positions)) assert.deepEqual(expanded.positions[id], point)
})
test('case, categories and assets form three left-to-right levels without sibling overlap', async () => {
  const model = buildGraph(fixture(), 'synthetic_graph'), engine = new ELK()
  const result = await layoutGraph(engine, model)
  for (const category of result.categories) {
    assert(category.position.x - result.root.x - ROOT_WIDTH >= 160)
    const members = model.nodes.filter(node => node.categoryId === category.id)
    for (const node of members) assert(result.positions[node.id].x - category.position.x - CATEGORY_WIDTH >= 180)
  }
  assert.equal(new Set(Object.values(result.positions).map(point => point.x)).size, 1)
  const changedRelations = await layoutGraph(engine, { ...model, edges: [] })
  assert.deepEqual(changedRelations, result)
  const folded = await layoutGraph(engine, model, {}, ['apps'])
  assert(!folded.positions.web && !folded.positions.note)
  assert(folded.categories.some(category => category.id === 'apps' && category.count === 2))
})
test('empty and short notes use one row, multiline notes grow without overlapping siblings', async () => {
  const empty = nodeSize({ purpose: '', note: '' })
  const short = nodeSize({ purpose: '门户', note: '来自首页' })
  assert.deepEqual(empty, short)
  assert.equal(empty.noteRows, 1)
  assert.equal(empty.height, 108)
  assert(nodeSize({ purpose: '', note: '第一行\n第二行\n第三行' }).height > empty.height)
  const model = buildGraph(fixture(), 'synthetic_graph')
  model.nodes[0].note = '第一行\n第二行\n第三行'
  const layout = await layoutGraph(new ELK(), model)
  const ordered = model.nodes.map(node => ({ ...layout.positions[node.id], height: nodeSize(node).height })).sort((a, b) => a.y - b.y)
  for (let i = 1; i < ordered.length; i++) assert(ordered[i].y >= ordered[i - 1].y + ordered[i - 1].height)
})
test('straight relationship labels occupy free gaps instead of covering node fields', () => {
  const boxes = [0, 140, 280].map(y => ({ x: 700, y, width: 300, height: 108 }))
  const label = straightLabelPosition({ x: 1000, y: 54 }, { x: 700, y: 334 }, boxes)
  assert(!boxes.some(rect => label.x - 88 < rect.x + rect.width && label.x + 88 > rect.x && label.y - 15 < rect.y + rect.height && label.y + 15 > rect.y))
})
test('framing a large tree never shrinks below readable zoom, including narrow windows', () => {
  for (const width of [320, 760, 1440]) {
    const view = readableViewport({ x: 24, y: 24, width: 900, height: 5000 }, { width, height: 500 }, { x: 80, y: 2500 })
    assert.equal(view.zoom, MIN_ZOOM)
    assert.equal(24 * view.zoom + view.x, 32)
    assert.equal(2500 * view.zoom + view.y, 250)
  }
})
test('switching legacy positions to tree layout preserves every asset and relationship', () => {
  const state = fixture(), before = structuredClone(state)
  state.cases[0].architecture!.positions = { web: { x: 800, y: -500 } }
  delete state.cases[0].architecture!.layout
  const result = applyGraphPatch(state, 'synthetic_graph', { revision: 0, requestId: 'tree-layout', layout: 'tree' }).state
  assert.deepEqual(result.assets, before.assets)
  assert.deepEqual(result.relations, before.relations)
  assert.deepEqual(result.cases[0].architecture?.positions, {})
  assert.equal(result.cases[0].architecture?.layout, 'tree')
})
test('orthogonal routes detour around an intervening asset', () => {
  const route = routeEdge('a', 'b', 'right', 'left', { a: { x: 0, y: 0 }, obstacle: { x: 400, y: 0 }, b: { x: 800, y: 0 } })
  assert(route)
  const points = [...route.path.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
  assert(points.some(point => point.y < -12 || point.y > NODE_HEIGHT + 12))
  for (const point of points) assert(!(point.x > 400 && point.x < 400 + NODE_WIDTH && point.y > 0 && point.y < NODE_HEIGHT))
})
test('canvas-created assets are independent, including records from previous versions', async () => {
  const state = fixture(), before = await layoutGraph(new ELK(), buildGraph(state, 'synthetic_graph'))
  const next = applyGraphPatch(state, 'synthetic_graph', { revision: 0, requestId: 'free-node', nodes: [{ id: 'free', address: 'https://portal.example.test', categoryId: 'hosts' }], positions: { free: { x: 1280, y: 120 } } }).state
  const model = buildGraph(next, 'synthetic_graph')
  assert.equal(model.nodes.find(node => node.id === 'free')?.manual, true)
  assert(!hierarchyLinks(model).some(edge => edge.source === 'free' || edge.target === 'free'))
  assert(!model.edges.some(edge => edge.source === 'free' || edge.target === 'free'))
  const after = await layoutGraph(new ELK(), model, next.cases[0].architecture!.positions)
  assert.deepEqual(after.root, before.root)
  for (const [id, position] of Object.entries(before.positions)) assert.deepEqual(after.positions[id], position)
  assert.deepEqual(after.positions.free, { x: 1280, y: 120 })
  const reloaded = buildGraph(JSON.parse(JSON.stringify(next)), 'synthetic_graph')
  assert.equal(reloaded.nodes.find(node => node.id === 'free')?.manual, true)
})
test('free nodes stay visible when categories fold and tree resets preserve their positions', async () => {
  const initial = applyGraphPatch(fixture(), 'synthetic_graph', { revision: 0, requestId: 'free-position', nodes: [{ id: 'free', title: '手动块', categoryId: 'apps' }], positions: { free: { x: 1400, y: 80 }, web: { x: 600, y: -40 } } }).state
  const reset = applyGraphPatch(initial, 'synthetic_graph', { revision: 1, requestId: 'reset-tree', layout: 'tree' }).state
  assert.deepEqual(reset.cases[0].architecture!.positions, { free: { x: 1400, y: 80 } })
  const layout = await layoutGraph(new ELK(), buildGraph(reset, 'synthetic_graph'), reset.cases[0].architecture!.positions, ['apps'])
  assert.deepEqual(layout.positions.free, { x: 1400, y: 80 })
  assert(!layout.positions.web)
})
test('a manual-only case does not invent an unassigned tree branch or infer links', () => {
  const state = fixture()
  state.assets = []; state.cases[0].assetIds = []; state.cases[0].targetIds = []
  const next = applyGraphPatch(state, 'synthetic_graph', { revision: 0, requestId: 'only-free', nodes: [{ id: 'free', address: 'portal.example.test' }] }).state
  next.assets[0].noteMarkdown = '从 docs.example.test 发现入口'
  const model = buildGraph(next, 'synthetic_graph')
  assert.equal(model.nodes.length, 1)
  assert.deepEqual(model.categories, [])
  assert.deepEqual(hierarchyLinks(model), [])
  assert.deepEqual(model.edges, [])
})
test('manual edges can connect assets, categories and their own case and survive reload', () => {
  let state = applyGraphPatch(fixture(), 'synthetic_graph', { revision: 0, requestId: 'new-free', nodes: [{ id: 'free', address: '192.0.2.50' }] }).state
  const edges = ['web', 'category:apps', 'case:synthetic_graph'].map((source, i) => ({ id: `manual_${i}`, source, target: 'free', label: '连接' }))
  state = applyGraphPatch(state, 'synthetic_graph', { revision: 1, requestId: 'connect-free', edges }).state
  const model = buildGraph(JSON.parse(JSON.stringify(state)), 'synthetic_graph')
  for (const edge of edges) {
    const stored = model.edges.find(item => item.id === edge.id)!
    assert(stored)
    assert(relationVisible(stored, false, null, null))
  }
  assert.throws(() => applyGraphPatch(state, 'synthetic_graph', { revision: 2, requestId: 'foreign-case', edges: [{ id: 'bad', source: 'case:another', target: 'free', label: '错误' }] }), /两端/)
  assert.throws(() => applyGraphPatch(state, 'synthetic_graph', { revision: 2, requestId: 'foreign-category', edges: [{ id: 'bad', source: 'category:another', target: 'free', label: '错误' }] }), /两端/)
  state = applyGraphPatch(state, 'synthetic_graph', { revision: 2, requestId: 'hide-line', remove: { edges: ['manual_0'] } }).state
  assert(!buildGraph(state, 'synthetic_graph').edges.some(edge => edge.id === 'manual_0'))
})
test('visibility filtering only hides automatic relationships, not hand-drawn lines', () => {
  const edge = { id: 'e', source: 'a', target: 'b', label: '引用', evidence: [], kind: 'reference' as const }
  assert.equal(relationVisible(edge, false, null, null), false)
  assert.equal(relationVisible(edge, false, 'a', null), true)
  assert.equal(relationVisible(edge, true, null, null), true)
  assert.equal(relationVisible({ ...edge, kind: 'manual' }, false, null, null), true)
})
test('dropping on a node body snaps to a facing handle and preserves reconnect direction', () => {
  const a = { x: 0, y: 100, width: 300, height: 108 }, b = { x: 500, y: 100, width: 300, height: 108 }
  assert.deepEqual(snapToNode('a', 'right', a, 'b', b), { source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left' })
  assert.deepEqual(snapToNode('b', 'left', b, 'a', a, 'source'), { source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left' })
  assert.equal(snapToNode('a', 'right', a, 'a', a), null)
})
