import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ReactFlow, ReactFlowProvider, Background, Handle, Position, ConnectionMode, MarkerType, applyNodeChanges, useReactFlow, BaseEdge, EdgeLabelRenderer, getStraightPath, getNodesBounds, type Node, type NodeProps, type Edge, type EdgeProps, type Connection, type FinalConnectionState, type HandleType } from '@xyflow/react'
import { Plus, Minus, Maximize2, Minimize2, Scan, Network, RotateCcw, Search, ChevronDown, ChevronRight, ExternalLink, Trash2, Pencil, X, FileText, GripHorizontal, Folder, ArrowLeftRight } from 'lucide-react'
import { useLedger } from '../store'
import { buildGraph, emptyDocument, graphEndpointIds, hierarchyLinks, relationVisible, type GraphNode, type GraphEdge, type GraphEvidence, type NoteFacts, type Point, type Side } from '../architecture/model'
import { snapToNode } from '../architecture/connections'
import { autoLayout } from '../architecture/engine'
import { graphFacts } from '../architecture/sources'
import { NODE_HEIGHT, NODE_WIDTH, ROOT_WIDTH, ROOT_HEIGHT, CATEGORY_WIDTH, CATEGORY_HEIGHT, MIN_ZOOM, MANUAL_MIN_ZOOM, nodeSize, readableViewport, straightLabelPosition, type GraphLayout, type GraphRect } from '../architecture/layout'
import type { GraphPatch, NodeInput } from '../architecture/operations'
import { IconButton } from './ui'
import { GraphInlineField } from './GraphInlineField'
import '@xyflow/react/dist/style.css'
import './asset-architecture.css'

type NodeData = {
  record: GraphNode; highlighted: boolean; focus: boolean
  open: (node: GraphNode) => void; select: (id: string) => void; save: (input: NodeInput) => boolean
}
type AssetFlowNode = Node<NodeData, 'asset'>
type BranchNode = Node<{ title: string; count?: number; collapsed?: boolean; toggle?: () => void }, 'branch'>
const sides: [Side, Position][] = [['top', Position.Top], ['right', Position.Right], ['bottom', Position.Bottom], ['left', Position.Left]]
const fields = [
  { key: 'address', title: '地址', label: 'IP / 域名 / URL', rows: 1, max: 2048 },
  { key: 'purpose', title: '用途', label: '用途', rows: 2, max: 500 },
  { key: 'note', title: '备注', label: '备注', rows: 3, max: 4000 },
] as const
const AssetNode = memo(function AssetNode({ data, selected }: NodeProps<AssetFlowNode>) {
  const node = data.record
  const size = nodeSize(node)
  return <div style={{ height: size.height }} className={`architecture-node ${selected ? 'selected' : ''} ${data.highlighted ? 'highlighted' : ''} ${node.discovered ? 'discovered' : ''}`}>
    {sides.map(([side, position]) => <Handle key={side} id={side} type="source" position={position} aria-label={`${side} 连接点`} />)}
    <span className="architecture-node-grip" title="拖动资产"><GripHorizontal size={14} /></span>
    <div className="architecture-node-fields" style={{ gridTemplateRows: `31px ${size.purposeRows * 20 + 9}px ${size.noteRows * 20 + 8}px` }}>
      {fields.map(field => <div className={`architecture-field field-${field.key}`} key={field.key}><span>{field.title}</span>
        <GraphInlineField value={node[field.key]} label={field.label} rows={field.key === 'address' ? 1 : field.key === 'purpose' ? size.purposeRows : size.noteRows} multiline={field.key !== 'address'} maxLength={field.max} placeholder={field.key === 'address' ? 'IP / 域名 / URL' : ''}
          onSave={value => data.save({ id: node.id, [field.key]: value })} onFocus={() => data.select(node.id)} focus={data.focus && field.key === 'address'} />
        {field.key === 'note' && <button className="architecture-node-open nodrag nopan" title={node.assetId ? `打开笔记：${node.title || node.address}` : `查看来源：${node.evidence.length} 篇笔记`} aria-label={node.assetId ? '打开笔记' : '查看来源'} onClick={() => data.open(node)}><ExternalLink size={13} /></button>}
      </div>)}
    </div>
  </div>
})
const TreeBranch = memo(function TreeBranch({ data }: NodeProps<BranchNode>) {
  const content = <><span className="architecture-branch-icon">{data.toggle ? data.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} /> : <Folder size={18} />}</span><strong>{data.title}</strong>{data.count !== undefined && <span className="architecture-branch-count">{data.count}</span>}</>
  return <div className={`architecture-branch ${data.toggle ? 'category' : 'case'}`}>
    {sides.map(([side, position]) => <Handle key={side} id={side} type="source" position={position} aria-label={`${side} 连接点`} />)}
    {data.toggle ? <button className="nodrag" onClick={data.toggle} title={data.collapsed ? '展开分类' : '折叠分类'}>{content}</button> : content}
  </div>
})
type RelationData = { record: GraphEdge; labelPosition: Point; save: (edge: GraphEdge) => boolean; evidence: (items: GraphEvidence[]) => void }
function RelationEdge(props: EdgeProps) {
  const data = props.data as unknown as RelationData
  const [path] = getStraightPath(props)
  const { x, y } = data.labelPosition
  return <><BaseEdge path={path} markerEnd={props.markerEnd} style={props.style} interactionWidth={20} />{(data.record.kind !== 'manual' || (data.record.label.trim() && data.record.label !== '关联')) && <EdgeLabelRenderer>
    <div className={`architecture-edge-label nodrag nopan ${props.selected ? 'selected' : ''}`} data-edge-id={props.id} style={{ transform: `translate(-50%, -50%) translate(${x}px,${y}px)` }}>
      {data.record.kind === 'manual' ? <GraphInlineField label="关系名称" value={data.record.label} maxLength={80} onSave={label => data.save({ ...data.record, label })} /> : <button title="查看关系依据" onClick={() => data.evidence(data.record.evidence)}>{data.record.label}</button>}
    </div>
  </EdgeLabelRenderer>}</>
}
const nodeTypes = { asset: AssetNode, branch: TreeBranch }
const edgeTypes = { relation: RelationEdge }
type Menu = { x: number; y: number; node?: GraphNode; edge?: GraphEdge; position: Point }

export function AssetArchitecture({ caseId }: { caseId: string }) {
  return <ReactFlowProvider><ArchitectureCanvas key={caseId} caseId={caseId} /></ReactFlowProvider>
}
function ArchitectureCanvas({ caseId }: { caseId: string }) {
  const ledger = useLedger(), navigate = useNavigate(), flow = useReactFlow()
  const current = ledger.cases.find(item => item.id === caseId)!
  const document = useMemo(() => current.architecture ?? emptyDocument(), [current.architecture])
  const [facts, setFacts] = useState(new Map<string, NoteFacts>()), [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [nodes, setNodes] = useState<Node[]>([]), [layout, setLayout] = useState<GraphLayout | null>(null)
  const [query, setQuery] = useState(''), [category, setCategory] = useState('all'), [expanded, setExpanded] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null), [evidence, setEvidence] = useState<GraphEvidence[] | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null), [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null), [allRelations, setAllRelations] = useState(false), [zoom, setZoom] = useState(1)
  const root = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null), framePending = useRef(true), focusPending = useRef<string | null>(null)
  const generation = useRef(0), dragPositions = useRef(new Map<string, Point>())
  const connectionCompleted = useRef(false)
  const reconnecting = useRef(false)
  const model = useMemo(() => buildGraph(ledger.state, caseId, facts), [ledger.state, caseId, facts])
  const viewModel = useMemo(() => category === 'all' ? model : { ...model, categories: model.categories.filter(item => item.id === category), nodes: model.nodes.filter(node => node.categoryId === category) }, [model, category])
  const signature = ledger.assets.filter(asset => current.assetIds.includes(asset.id)).map(asset => `${asset.id}:${asset.version}:${asset.updatedAt}`).join('|')
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      graphFacts(ledger.getState(), caseId).then(result => { if (active) { setFacts(result); setLoaded(true) } }).catch(failure => { if (active) setError(String(failure)) })
    }, 180)
    return () => { active = false; clearTimeout(timer) }
  }, [caseId, signature, ledger.getState])
  const commit = useCallback((patch: Omit<GraphPatch, 'revision' | 'requestId'>) => {
    try {
      const revision = ledger.getState().cases.find(item => item.id === caseId)?.architecture?.revision ?? 0
      ledger.applyArchitecture(caseId, { ...patch, revision, requestId: crypto.randomUUID() }, facts)
      setError(''); return true
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false }
  }, [caseId, ledger.applyArchitecture, ledger.getState, facts])
  const saveNode = useCallback((input: NodeInput) => commit({ nodes: [input] }), [commit])
  const saveEdge = useCallback((edge: GraphEdge) => commit({ edges: [edge] }), [commit])
  const selectNode = useCallback((id: string) => { setSelectedNodeId(id); setSelectedEdgeId(null); setFocusNodeId(value => value === id ? null : value) }, [])
  const openNode = useCallback((node: GraphNode) => {
    window.dispatchEvent(new Event('ledger-flush-editors'))
    if (node.assetId) navigate(`/cases/${caseId}/assets/${node.assetId}`)
    else setEvidence(node.evidence)
  }, [navigate, caseId])
  const toggleCategory = useCallback((id: string) => {
    window.dispatchEvent(new Event('ledger-flush-editors'))
    const valid = new Set(model.categories.map(category => category.id))
    const collapsed = (ledger.getState().cases.find(item => item.id === caseId)?.architecture?.collapsed ?? []).filter(id => valid.has(id))
    framePending.current = true
    commit({ collapsed: collapsed.includes(id) ? collapsed.filter(item => item !== id) : [...collapsed, id] })
  }, [commit, ledger.getState, caseId, model.categories])
  const layoutKey = JSON.stringify({ nodes: viewModel.nodes.map(node => [node.id, node.categoryId, node.manual, nodeSize(node).height]), categories: viewModel.categories.map(item => item.id), positions: document.positions, collapsed: document.collapsed, layout: document.layout })
  useEffect(() => {
    if (!loaded) return
    if (document.layout !== 'tree') { commit({ layout: 'tree' }); return }
    const sequence = ++generation.current
    setBusy(true)
    autoLayout(viewModel, document.positions, document.collapsed).then(result => {
      if (generation.current === sequence) setLayout(result)
    }).catch(failure => setError(`布局失败：${String(failure)}`)).finally(() => { if (generation.current === sequence) setBusy(false) })
    return () => { generation.current++ }
  // Text edits do not re-run the layout worker.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, loaded])
  const frameTree = useCallback(() => {
    if (!canvas.current || !layout) return
    const visible = flow.getNodes()
    if (!visible.length) return
    const bounds = getNodesBounds(visible), size = canvas.current.getBoundingClientRect()
    void flow.setViewport(readableViewport(bounds, size, { x: layout.root.x + ROOT_WIDTH / 2, y: layout.root.y + ROOT_HEIGHT / 2 }), { duration: 200 })
  }, [flow, layout])
  useEffect(() => {
    if (!layout) return
    const result: Node[] = [{ id: `case:${caseId}`, type: 'branch', position: layout.root, width: ROOT_WIDTH, height: ROOT_HEIGHT, draggable: false, selectable: false, data: { title: current.name } }]
    for (const item of layout.categories) result.push({ id: `category:${item.id}`, type: 'branch', position: item.position, draggable: false, selectable: false, style: { pointerEvents: 'all' }, width: CATEGORY_WIDTH, height: CATEGORY_HEIGHT,
      data: { title: model.categories.find(category => category.id === item.id)?.title ?? item.title, count: item.count, collapsed: document.collapsed.includes(item.id), toggle: () => toggleCategory(item.id) } })
    for (const node of viewModel.nodes) if (layout.positions[node.id] && (node.manual || !document.collapsed.includes(node.categoryId))) result.push({
      id: node.id, type: 'asset', position: layout.positions[node.id], selected: selectedNodeId === node.id, width: NODE_WIDTH, height: nodeSize(node).height,
      data: { record: node, open: openNode, save: saveNode, select: selectNode, focus: focusNodeId === node.id,
        highlighted: !!query.trim() && `${node.address} ${node.title} ${node.purpose} ${node.note}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) },
    })
    setNodes(result)
  }, [layout, current.name, caseId, viewModel, model, document.collapsed, query, selectedNodeId, focusNodeId, openNode, saveNode, selectNode, toggleCategory])
  useEffect(() => {
    if (!flow.viewportInitialized || !layout || !nodes.length || !framePending.current) return
    const timer = setTimeout(() => {
      const id = focusPending.current, position = id ? layout.positions[id] : undefined
      if (id && !position) return
      framePending.current = false; focusPending.current = null
      if (position) void flow.setCenter(position.x + NODE_WIDTH / 2, position.y + NODE_HEIGHT / 2, { zoom: flow.getZoom(), duration: 180 }).then(() => { if (id) setFocusNodeId(id) })
      else frameTree()
    }, 60)
    return () => clearTimeout(timer)
  }, [nodes, layout, flow, frameTree])
  const visibleNodeIds = nodes.map(node => node.id).join('\0')
  const edges = useMemo<Edge[]>(() => {
    if (!layout) return []
    const visible = new Set(nodes.map(node => node.id)), byId = new Map(model.nodes.map(node => [node.id, node]))
    const rectangles = new Map(nodes.map(node => [node.id, { ...node.position, width: node.width ?? NODE_WIDTH, height: node.height ?? NODE_HEIGHT }]))
    const obstacles: GraphRect[] = [...rectangles.values()]
    const point = (id: string, side: Side) => {
      const rect = rectangles.get(id)!
      return { x: rect.x + (side === 'left' ? 0 : side === 'right' ? rect.width : rect.width / 2), y: rect.y + (side === 'top' ? 0 : side === 'bottom' ? rect.height : rect.height / 2) }
    }
    const hierarchy: Edge[] = hierarchyLinks(viewModel, document.collapsed).filter(edge => visible.has(edge.source) && visible.has(edge.target)).map(edge => ({ ...edge, sourceHandle: 'right', targetHandle: 'left', type: 'straight', selectable: false, focusable: false, reconnectable: false, style: { stroke: '#a9b6bd', strokeWidth: 1.4 } }))
    const endpoint = (id: string) => {
      const asset = byId.get(id)
      return asset && !asset.manual && document.collapsed.includes(asset.categoryId) ? `category:${asset.categoryId}` : id
    }
    const relations = model.edges.flatMap(edge => {
      if (!relationVisible(edge, allRelations, selectedNodeId, selectedEdgeId)) return []
      const from = endpoint(edge.source), to = endpoint(edge.target)
      if (!visible.has(from) || !visible.has(to) || from === to) return []
      const sourceHandle = edge.sourceHandle ?? 'right', targetHandle = edge.targetHandle ?? 'left'
      const color = edge.kind === 'mention' ? '#a18e67' : '#278e80'
      const labelPosition = straightLabelPosition(point(from, sourceHandle), point(to, targetHandle), obstacles)
      obstacles.push({ x: labelPosition.x - 88, y: labelPosition.y - 15, width: 176, height: 30 })
      return [{ id: edge.id, source: from, target: to, sourceHandle, targetHandle, type: 'relation', label: edge.label,
        data: { record: edge, labelPosition, save: saveEdge, evidence: setEvidence },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 }, style: { stroke: color, strokeWidth: 1.8, strokeDasharray: edge.kind === 'mention' ? '5 4' : undefined }, reconnectable: edge.kind === 'manual', selected: selectedEdgeId === edge.id }]
    })
    return [...hierarchy, ...relations]
  }, [layout, caseId, model, viewModel, visibleNodeIds, document.collapsed, allRelations, selectedNodeId, selectedEdgeId, saveEdge])
  const contextMenu = (event: { preventDefault(): void; clientX: number; clientY: number }, node?: GraphNode, edge?: GraphEdge) => {
    event.preventDefault(); const bounds = root.current!.getBoundingClientRect()
    setMenu({ x: Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - 195)), y: Math.max(48, Math.min(event.clientY - bounds.top, bounds.height - 175)), position: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), node, edge })
  }
  const createNode = (position?: Point) => {
    window.dispatchEvent(new Event('ledger-flush-editors'))
    const id = `ast_${crypto.randomUUID()}`, categoryId = category === 'all' || category === 'discovered' ? 'unassigned' : category
    if (!position) {
      const bounds = canvas.current!.getBoundingClientRect()
      const center = flow.screenToFlowPosition({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
      position = { x: center.x - NODE_WIDTH / 2, y: center.y - NODE_HEIGHT / 2 }
      const occupied = flow.getNodes()
      while (occupied.some(node => position!.x < node.position.x + (node.width ?? NODE_WIDTH) + 16 && position!.x + NODE_WIDTH + 16 > node.position.x && position!.y < node.position.y + (node.height ?? NODE_HEIGHT) + 16 && position!.y + NODE_HEIGHT + 16 > node.position.y)) position.y += NODE_HEIGHT + 32
    }
    if (commit({ nodes: [{ id, address: '', title: '', purpose: '', note: '', categoryId }], positions: { [id]: position } })) {
      framePending.current = true; focusPending.current = id; setFocusNodeId(null); setSelectedNodeId(id); setMenu(null)
    }
  }
  const connect = (connection: Connection, previous?: GraphEdge) => {
    connectionCompleted.current = true
    window.dispatchEvent(new Event('ledger-flush-editors'))
    if (previous) previous = ledger.getState().cases.find(item => item.id === caseId)?.architecture?.edges.find(edge => edge.id === previous!.id) ?? previous
    const edge: GraphEdge = { id: previous?.id ?? `edge_${crypto.randomUUID()}`, source: connection.source, target: connection.target, sourceHandle: connection.sourceHandle as Side, targetHandle: connection.targetHandle as Side, label: previous?.label ?? '关联', kind: 'manual', evidence: previous?.evidence ?? [] }
    if (saveEdge(edge)) { setSelectedEdgeId(edge.id); setSelectedNodeId(edge.source) }
  }
  const connectToBody = (event: MouseEvent | TouchEvent, state: FinalConnectionState, oldEdge?: Edge, movingEnd: HandleType = 'target') => {
    if (connectionCompleted.current || state.isValid || !state.fromNode || !state.fromHandle) return
    const pointer = 'changedTouches' in event ? event.changedTouches[0] : event
    if (!pointer || !Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return
    const target = window.document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest<HTMLElement>('.react-flow__node')
    if (!target || !root.current?.contains(target) || !target.dataset.id) return
    const previous = oldEdge ? ledger.getState().cases.find(item => item.id === caseId)?.architecture?.edges.find(edge => edge.id === oldEdge.id) : undefined
    if (oldEdge && !previous) return
    const fixedId = previous ? movingEnd === 'target' ? previous.source : previous.target : state.fromNode.id
    const renderedId = oldEdge ? movingEnd === 'target' ? oldEdge.source : oldEdge.target : state.fromNode.id
    const side = (previous ? movingEnd === 'target' ? previous.sourceHandle ?? 'right' : previous.targetHandle ?? 'left' : state.fromHandle.id ?? state.fromPosition) as Side
    const start = root.current.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(renderedId)}"]`)
    const endpoints = graphEndpointIds(model)
    if (!start || !endpoints.has(fixedId) || !endpoints.has(target.dataset.id)) return
    const connection = snapToNode(fixedId, side, start.getBoundingClientRect(), target.dataset.id, target.getBoundingClientRect(), movingEnd)
    if (connection) connect(connection, previous)
  }
  const editNode = (node: GraphNode) => { setSelectedNodeId(node.id); setFocusNodeId(node.id); setMenu(null) }
  const selectedEdge = model.edges.find(edge => edge.id === selectedEdgeId)
  const reverseEdge = () => {
    window.dispatchEvent(new Event('ledger-flush-editors'))
    const edge = ledger.getState().cases.find(item => item.id === caseId)?.architecture?.edges.find(edge => edge.id === selectedEdgeId)
    if (edge) saveEdge({ ...edge, source: edge.target, target: edge.source, sourceHandle: edge.targetHandle, targetHandle: edge.sourceHandle })
  }
  return <div ref={root} className={`asset-architecture ${expanded ? 'expanded' : ''}`} onKeyDown={event => { if (event.key === 'Escape') { setMenu(null); setEvidence(null); setSelectedNodeId(null); setSelectedEdgeId(null) } }}>
    <div className="architecture-toolbar"><div className="architecture-search"><Search size={15} /><input aria-label="搜索资产图" placeholder="搜索资产" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { const found = nodes.filter(node => node.data.highlighted); if (found.length) void flow.fitView({ nodes: found, padding: 0.3, minZoom: MIN_ZOOM, maxZoom: 1, duration: 200 }) } }} /></div>
      <select aria-label="筛选分类" value={category} onChange={event => { framePending.current = true; setCategory(event.target.value) }}><option value="all">全部分类</option>{model.categories.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
      <label className="architecture-relations-toggle"><input type="checkbox" checked={allRelations} onChange={event => setAllRelations(event.target.checked)} />全部关联</label>
      <span className="architecture-count">{model.nodes.length} 个资产</span><div className="architecture-tools">
        <IconButton label="新建资产" onClick={() => createNode()}><Plus size={17} /></IconButton>
        <IconButton label="重新排列为横向树" disabled={busy || !loaded} onClick={() => { window.dispatchEvent(new Event('ledger-flush-editors')); framePending.current = true; if (commit({ layout: 'tree' }) && !Object.keys(document.positions).length) frameTree() }}><Network size={17} /></IconButton>
        <IconButton label="恢复图中已移除项" disabled={!document.hiddenNodes.length && !document.hiddenEdges.length} onClick={() => { framePending.current = true; commit({ restoreHidden: true }) }}><RotateCcw size={16} /></IconButton>
        <IconButton label={expanded ? '收起画布' : '展开画布'} onClick={() => { setExpanded(value => !value); setTimeout(frameTree, 80) }}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</IconButton>
      </div></div>
    {selectedEdge && <div className="architecture-relation-tools">{selectedEdge.kind === 'manual' ? <GraphInlineField label="关系名称" placeholder="关系名称" value={selectedEdge.label === '关联' ? '' : selectedEdge.label} maxLength={80} onSave={label => saveEdge({ ...selectedEdge, label })} /> : <span>{selectedEdge.label}</span>}{selectedEdge.kind === 'manual' && <IconButton label="反转关系方向" onClick={reverseEdge}><ArrowLeftRight size={15} /></IconButton>}<IconButton label="移除关系" onClick={() => { window.dispatchEvent(new Event('ledger-flush-editors')); commit({ remove: { edges: [selectedEdge.id] } }); setSelectedEdgeId(null) }}><Trash2 size={15} /></IconButton><IconButton label="关闭关系选择" onClick={() => { window.dispatchEvent(new Event('ledger-flush-editors')); setSelectedEdgeId(null) }}><X size={15} /></IconButton></div>}
    <div ref={canvas} className="architecture-canvas">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} connectionMode={ConnectionMode.Loose} connectionRadius={28} nodeDragThreshold={0} minZoom={MANUAL_MIN_ZOOM} maxZoom={2} deleteKeyCode={null} nodesConnectable selectionOnDrag={false} panOnDrag={[0]} panOnScroll={false} zoomOnScroll zoomOnPinch zoomOnDoubleClick={false} onlyRenderVisibleElements
        onMove={(_event, viewport) => setZoom(viewport.zoom)}
        onNodesChange={changes => { for (const change of changes) if (change.type === 'position' && change.position) dragPositions.current.set(change.id, change.position); setNodes(value => applyNodeChanges(changes, value)) }}
        onNodeClick={(_event, node) => { if (node.type === 'asset') selectNode(node.id) }}
        onEdgeClick={(_event, edge) => { if (model.edges.some(item => item.id === edge.id)) setSelectedEdgeId(edge.id) }}
        onNodeDragStop={(_event, node) => { if (node.type === 'asset') {
          const position = dragPositions.current.get(node.id) ?? node.position; dragPositions.current.delete(node.id)
          if (position.x !== layout?.positions[node.id]?.x || position.y !== layout?.positions[node.id]?.y) {
            setLayout(value => value ? { ...value, positions: { ...value.positions, [node.id]: position } } : value); commit({ positions: { [node.id]: position } })
          }
        } }}
        onConnectStart={() => { connectionCompleted.current = false }}
        onConnect={connection => connect(connection)} onConnectEnd={(event, state) => { if (!reconnecting.current) connectToBody(event, state) }}
        isValidConnection={connection => { const ids = graphEndpointIds(model); return connection.source !== connection.target && ids.has(connection.source) && ids.has(connection.target) }}
        onReconnectStart={() => { connectionCompleted.current = false; reconnecting.current = true }}
        onReconnect={(edge, connection) => connect(connection, model.edges.find(item => item.id === edge.id))}
        onReconnectEnd={(event, edge, fixedHandleType, state) => {
          // React Flow reports the fixed (opposite) handle, not the endpoint being dragged.
          connectToBody(event, state, edge, fixedHandleType === 'source' ? 'target' : 'source')
          reconnecting.current = false
        }}
        onPaneContextMenu={event => contextMenu(event)} onNodeContextMenu={(event, node) => contextMenu(event, node.type === 'asset' ? (node.data as NodeData).record : undefined)}
        onEdgeContextMenu={(event, edge) => { const record = model.edges.find(item => item.id === edge.id); if (record) contextMenu(event, undefined, record); else event.preventDefault() }}
        onPaneClick={() => { window.dispatchEvent(new Event('ledger-flush-editors')); setMenu(null); setSelectedNodeId(null); setSelectedEdgeId(null); setFocusNodeId(null) }}>
        <Background gap={24} size={1} color="var(--graph-dot)" />
      </ReactFlow>
      {(!loaded || busy) && <div className="architecture-status" role="status">{!loaded ? '读取资产关系…' : '正在排列…'}</div>}
      {loaded && !model.nodes.length && <button className="architecture-empty" onClick={() => createNode()}><Plus size={22} />新建资产</button>}
      <div className="architecture-zoom"><IconButton label="放大" disabled={zoom >= 2} onClick={() => void flow.zoomIn({ duration: 150 })}><Plus size={16} /></IconButton><span aria-label="缩放比例">{zoom < 0.01 ? (zoom * 100).toFixed(1) : Math.round(zoom * 100)}%</span><IconButton label="缩小" disabled={zoom <= MANUAL_MIN_ZOOM} onClick={() => void flow.zoomOut({ duration: 150 })}><Minus size={16} /></IconButton><IconButton label="回到树的起点" onClick={frameTree}><Scan size={16} /></IconButton></div>
    </div>
    {evidence && <section className="architecture-evidence-band"><header><span>来源依据</span><IconButton label="关闭来源" onClick={() => setEvidence(null)}><X size={15} /></IconButton></header>{evidence.length ? evidence.map((item, index) => <button className="architecture-evidence" key={index} onClick={() => { window.dispatchEvent(new Event('ledger-flush-editors')); navigate(`/cases/${caseId}/assets/${item.assetId}`) }}><FileText size={15} /><span>{ledger.assets.find(asset => asset.id === item.assetId)?.title ?? '来源笔记'}<small>{item.quote}</small></span></button>) : <span className="architecture-no-evidence">暂无来源记录</span>}</section>}
    {error && <div className="architecture-error" role="alert">{error}<IconButton label="关闭提示" onClick={() => setError('')}><X size={14} /></IconButton></div>}
    {menu && <div className="architecture-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      {menu.node ? <><button role="menuitem" onClick={() => editNode(menu.node!)}><Pencil size={14} />编辑资产</button><button role="menuitem" onClick={() => { openNode(menu.node!); setMenu(null) }}><ExternalLink size={14} />{menu.node.assetId ? '打开笔记' : '查看来源'}</button><button role="menuitem" onClick={() => { window.dispatchEvent(new Event('ledger-flush-editors')); commit({ remove: { nodes: [menu.node!.id] } }); setMenu(null) }}><Trash2 size={14} />从图中移除</button>{menu.node.assetId && <select className="architecture-menu-category" aria-label="移动到分类" value={menu.node.categoryId} onChange={event => { window.dispatchEvent(new Event('ledger-flush-editors')); saveNode({ id: menu.node!.id, categoryId: event.target.value }); setMenu(null) }}><option value="unassigned">未分类</option>{model.categories.filter(item => !['unassigned', 'discovered'].includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}</> : menu.edge ? <><button role="menuitem" onClick={() => { setSelectedEdgeId(menu.edge!.id); setEvidence(menu.edge!.kind === 'manual' ? null : menu.edge!.evidence); setMenu(null) }}><Pencil size={14} />查看 / 编辑关系</button><button role="menuitem" onClick={() => { commit({ remove: { edges: [menu.edge!.id] } }); setMenu(null) }}><Trash2 size={14} />移除关系</button></> : <button role="menuitem" onClick={() => createNode(menu.position)}><Plus size={14} />新建资产</button>}
    </div>}
  </div>
}
