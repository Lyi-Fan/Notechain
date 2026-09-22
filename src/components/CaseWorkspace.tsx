import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { flushNative, nativeInvoke } from '../native-storage'
import { writeClipboardText } from '../platform'
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Archive, Check, ChevronDown, ChevronRight, CircleDot, Copy, Eye, EyeOff, FileText, FolderOpen, Home, PanelLeftClose, PanelLeftOpen, Pencil, Moon, Plus, Search, Sun, Target, Trash2, X } from 'lucide-react'
import { useLedger } from '../store'
import { assetKindMeta } from '../lib'
import { DesktopChrome, Field, IconButton, Modal, TextInput } from './ui'
import type { AssetRecord, TargetRecord } from '../types'
import { ActionMenu } from './ActionMenu'
import { ContextMenu, type ContextMenuPosition } from './ContextMenu'
import { NavigationControls } from './NavigationControls'
import { AssetIcon } from './AssetIcon'
import { assetMarkdown } from '../notes'
import { displaySourceUrl, displayUrl } from '../url-display'
import { ModeSwitch } from './ModeSwitch'

function CaseHeader({ caseName }: { caseName: string }) {
  const navigate = useNavigate()
  const { state, setTheme } = useLedger()
  return <header className="workspace-header notebook-header" data-tauri-drag-region>
    <div className="workspace-header-left"><NavigationControls /><ModeSwitch /><div className="crumb-divider" /><Link className="notebook-case-crumb" to="/">案件索引</Link><span className="notebook-crumb-separator">/</span><strong>{caseName}</strong></div>
    <div className="workspace-header-right"><ActionMenu label="案件操作" items={[
      { label: '关键发现', icon: <CircleDot size={16} />, onSelect: () => navigate('findings') },
      { label: state.theme === 'light' ? '夜间主题' : '日间主题', icon: state.theme === 'light' ? <Moon size={16} /> : <Sun size={16} />, onSelect: () => setTheme(state.theme === 'light' ? 'dark' : 'light') },
      { label: '返回案件索引', icon: <Home size={16} />, onSelect: () => navigate('/') },
    ]} /><DesktopChrome /></div>
  </header>
}

const NoteNavItem = memo(function NoteNavItem({ caseId, asset, active, navigationKey, onNavigate, onOpen, onContextMenu, onCopy }: { caseId: string; asset: AssetRecord; active: boolean; navigationKey: string; onNavigate?: () => void; onOpen: (href: string) => void; onContextMenu: (event: MouseEvent | KeyboardEvent, id: string, display: string) => void; onCopy: (text: string) => void }) {
  const [showName, setShowName] = useState(false)
  const [addressOverflows, setAddressOverflows] = useState(false)
  const addressViewport = useRef<HTMLSpanElement>(null)
  const addressText = useRef<HTMLElement>(null)
  const clickText = useRef('')
  const clickTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(clickTimer.current), [])
  useEffect(() => setShowName(false), [active, navigationKey])
  const canToggle = active && Boolean(asset.value.trim())
  const display = canToggle && !showName ? displaySourceUrl(asset.value) : displayUrl(asset.title || '未命名笔记')
  useEffect(() => {
    const viewport = addressViewport.current
    const text = addressText.current
    if (!viewport || !text || !canToggle || showName) { setAddressOverflows(false); return }
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
    let animation: Animation | undefined
    let previousDistance = -1
    const measure = () => {
      const distance = Math.max(0, Math.ceil(text.scrollWidth - viewport.clientWidth))
      setAddressOverflows(distance > 1)
      if (previousDistance === distance) return
      previousDistance = distance
      animation?.cancel()
      if (distance <= 1 || reducedMotion.matches) return
      const travel = distance / 28 * 1000
      const duration = travel * 2 + 1800
      animation = text.animate([
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(0)', offset: 900 / duration },
        { transform: `translateX(-${distance}px)`, offset: (900 + travel) / duration },
        { transform: `translateX(-${distance}px)`, offset: (1800 + travel) / duration },
        { transform: 'translateX(0)', offset: 1 },
      ], { duration, iterations: Infinity, easing: 'linear' })
    }
    const motionChanged = () => { previousDistance = -1; measure() }
    const observer = new ResizeObserver(measure)
    observer.observe(viewport); observer.observe(text)
    reducedMotion.addEventListener('change', motionChanged)
    measure()
    return () => { animation?.cancel(); observer.disconnect(); reducedMotion.removeEventListener('change', motionChanged) }
  }, [display, canToggle, showName])
  const handleKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { onContextMenu(event, asset.id, display); return }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [...document.querySelectorAll<HTMLAnchorElement>('.notebook-note-row')]
    const currentIndex = items.indexOf(event.currentTarget)
    if (currentIndex < 0 || items.length < 2) return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const next = items[(currentIndex + delta + items.length) % items.length]
    next.focus()
    const href = next.getAttribute('href')
    if (href) onOpen(href)
  }
  return <div className={`notebook-note-entry ${active ? 'active' : ''}`} onContextMenu={(event) => onContextMenu(event, asset.id, display)}><Link to={`/cases/${caseId}/assets/${asset.id}`} className={`notebook-note-row ${active ? 'active' : ''}`} onClick={(event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    if (event.detail < 2) clickText.current = display
    clearTimeout(clickTimer.current)
    if (event.detail > 1) { event.preventDefault(); return }
    if (active) {
      event.preventDefault()
      // Defer only the active row's label reset so a double-click can copy
      // the displayed title without changing it or adding a history entry.
      if (event.detail) clickTimer.current = setTimeout(() => setShowName(false), 400)
      else setShowName(false)
    } else setShowName(false)
    onNavigate?.()
  }} onDoubleClick={(event) => { event.preventDefault(); clearTimeout(clickTimer.current); onCopy(clickText.current || display) }} onKeyDown={handleKeyDown} aria-current={active ? 'page' : undefined} title={display}>
    <span className={`notebook-note-icon kind-${asset.kind}`} title={assetKindMeta[asset.kind].label}><AssetIcon kind={asset.kind} size={16} /></span><span ref={addressViewport} className={`notebook-note-copy ${canToggle && !showName ? 'showing-address' : ''}`} data-overflow={addressOverflows}><strong ref={addressText}>{display}</strong></span>
  </Link>{canToggle && <button className="notebook-name-toggle" type="button" title={showName ? '显示地址' : '显示资产名称'} aria-label={showName ? '显示地址' : '显示资产名称'} aria-pressed={showName} onClick={() => setShowName((value) => !value)}>{showName ? <EyeOff size={14} /> : <Eye size={14} />}</button>}</div>
})

function AssetSidebar({ caseId, open, expanded, onClose, onCreateAsset }: { caseId: string; open: boolean; expanded: boolean; onClose: () => void; onCreateAsset: (targetId?: string) => void }) {
  const { state, cases, assets, targets, updateAsset, softDeleteAsset, addTarget, updateTarget, setCategoryDeleted } = useLedger()
  const navigate = useNavigate()
  const location = useLocation()
  const navigation = useRef(navigate)
  navigation.current = navigate
  const openNote = useCallback((href: string) => navigation.current(href), [])
  const closeAction = useRef(onClose)
  closeAction.current = onClose
  const closeNavigation = useCallback(() => closeAction.current(), [])
  const current = cases.find((item) => item.id === caseId)
  const [query, setQuery] = useState('')
  const [nativeMatches, setNativeMatches] = useState<string[]>([])
  useEffect(() => {
    if (!nativeInvoke || !query) { setNativeMatches([]); return }
    let cancelled = false
    const timer = setTimeout(() => { void flushNative().then(() => nativeInvoke!<string[]>('search_assets', { query })).then(ids => { if (!cancelled) setNativeMatches(ids) }).catch(() => { if (!cancelled) setNativeMatches([]) }) }, 100)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, assets])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [recycleOpen, setRecycleOpen] = useState(false)
  const [creatingCategory, setCreatingCategory] = useState(false)
  const [categoryName, setCategoryName] = useState('')
  const [categoryError, setCategoryError] = useState('')
  type Selection = { kind: 'asset' | 'category'; id: string }
  const [context, setContext] = useState<(Selection & ContextMenuPosition & { display?: string }) | null>(null)
  const [editing, setEditing] = useState<Selection | null>(null)
  const [deleting, setDeleting] = useState<Selection | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [editError, setEditError] = useState('')
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const closeContext = useCallback(() => setContext(null), [])
  useEffect(() => () => clearTimeout(toastTimer.current), [])
  useEffect(() => { setContext(null); setEditing(null); setDeleting(null) }, [location.pathname])
  useEffect(() => { setCreatingCategory(false); setCategoryName(''); setCategoryError('') }, [caseId])
  const caseAssetIds = useMemo(() => new Set(current?.assetIds), [current?.assetIds])
  const caseNotes = useMemo(() => {
    const search = query.toLowerCase()
    return assets.filter((asset) => caseAssetIds.has(asset.id) && (!query || nativeMatches.includes(asset.id) || `${asset.title} ${asset.value} ${displayUrl(asset.value)} ${asset.tags.join(' ')} ${nativeInvoke ? '' : assetMarkdown(asset)}`.toLowerCase().includes(search)))
  }, [assets, caseAssetIds, query, nativeMatches])
  const groups = useMemo(() => {
    const map = new Map<string, AssetRecord[]>()
    const targetIds = new Set(targets.map((target) => target.id))
    if (!query.trim()) current?.targetIds.forEach((id) => { if (targetIds.has(id)) map.set(id, []) })
    caseNotes.forEach((asset) => {
      const key = asset.targetId && !current?.deletedTargetIds?.includes(asset.targetId) ? asset.targetId : 'unassigned'
      const group = map.get(key)
      if (group) group.push(asset)
      else map.set(key, [asset])
    })
    return [...map.entries()]
  }, [caseNotes, current?.targetIds, current?.deletedTargetIds, targets, query])
  const groupLabel = (key: string) => targets.find((item) => item.id === key)?.name ?? '未归类'
  const createCategory = () => {
    const name = categoryName.trim()
    if (!name) return
    if (targets.some((target) => current?.targetIds.includes(target.id) && target.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { setCategoryError('此分类已存在'); return }
    addTarget({ name, kind: '分类', identifier: '', note: '' }, caseId)
    setCreatingCategory(false); setCategoryName(''); setCategoryError(''); setQuery('')
  }

  const openContext = useCallback((event: MouseEvent | KeyboardEvent, selection: Selection, display?: string) => {
    event.preventDefault(); event.stopPropagation()
    const element = event.currentTarget as HTMLElement
    const trigger = element.matches('a,button') ? element : element.querySelector<HTMLElement>('a,button') ?? element
    const box = trigger.getBoundingClientRect()
    setContext({ ...selection, display, trigger, x: 'clientX' in event ? event.clientX : box.left + 16, y: 'clientY' in event ? event.clientY : box.bottom })
  }, [])
  const openNoteContext = useCallback((event: MouseEvent | KeyboardEvent, id: string, display: string) => openContext(event, { kind: 'asset', id }, display), [openContext])
  const copyText = useCallback(async (text: string) => {
    clearTimeout(toastTimer.current)
    try { await writeClipboardText(text); setToast('已复制') } catch { setToast('复制失败，请重试') }
    toastTimer.current = setTimeout(() => setToast(''), 1600)
  }, [])
  const startEdit = (selection: Selection) => {
    const asset = assets.find((item) => item.id === selection.id)
    setEditTitle(selection.kind === 'asset' ? asset?.title ?? '' : groupLabel(selection.id))
    setEditUrl(asset?.value ?? ''); setEditError(''); setEditing(selection)
  }
  const saveEdit = () => {
    if (!editing) return
    const title = editTitle.trim()
    if (!title) { setEditError('名称不能为空'); return }
    if (editing.kind === 'category') {
      if (targets.some((target) => target.id !== editing.id && current?.targetIds.includes(target.id) && target.name.toLocaleLowerCase() === title.toLocaleLowerCase())) { setEditError('此分类已存在'); return }
      updateTarget(editing.id, { name: title })
    } else updateAsset(editing.id, { title, customTitle: title, value: editUrl.trim() })
    setEditing(null)
  }
  const confirmDelete = () => {
    if (!deleting) return
    if (deleting.kind === 'category') setCategoryDeleted(caseId, deleting.id, true)
    else {
      softDeleteAsset(deleting.id)
      if (location.pathname.endsWith(`/assets/${deleting.id}`)) navigate(`/cases/${caseId}`)
    }
    setDeleting(null)
  }

  return <>
    <div className={`sidebar-scrim ${open ? 'visible' : ''}`} onClick={onClose} />
    <aside id="notebook-sidebar" className={`asset-sidebar notebook-sidebar ${open ? 'open' : ''}`} aria-hidden={!expanded} {...(!expanded ? { inert: '' } : {})}>
      <div className="sidebar-brand notebook-sidebar-title"><span className="sidebar-case-icon"><FolderOpen size={20} strokeWidth={1.7} /></span><div><strong title={current?.name}>{current?.name}</strong><span className="mono">{current?.code}</span></div></div>
      <nav className="notebook-index-links" aria-label="案件索引"><Link to={`/cases/${caseId}`} onClick={onClose} aria-current={location.pathname === `/cases/${caseId}` ? 'page' : undefined}><FileText size={15} />案件概览</Link></nav>
      <div className="sidebar-tools notebook-search"><div className="sidebar-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记" aria-label="搜索笔记" /></div></div>
      <div className="sidebar-label notebook-directory-label"><span>笔记</span><button className="notebook-category-add" type="button" title="新建分类" aria-label="新建分类" aria-expanded={creatingCategory} onClick={() => { setCreatingCategory((value) => !value); setCategoryError('') }}><Plus size={17} /></button></div>
      {creatingCategory && <form className="notebook-category-form" onSubmit={(event) => { event.preventDefault(); createCategory() }}><div><input autoFocus aria-label="分类名称" placeholder="分类名称" value={categoryName} onChange={(event) => { setCategoryName(event.target.value); setCategoryError('') }} onKeyDown={(event) => { if (event.key === 'Escape') setCreatingCategory(false) }} /><button type="submit" aria-label="创建分类" title="创建分类" disabled={!categoryName.trim()}><Check size={15} /></button><button type="button" aria-label="取消创建分类" title="取消" onClick={() => setCreatingCategory(false)}><X size={15} /></button></div>{categoryError && <small role="alert">{categoryError}</small>}</form>}
      <nav className="asset-nav notebook-note-list" aria-label="案件笔记列表">
        {groups.map(([groupKey, groupNotes]) => {
          const collapseKey = `${caseId}:${groupKey}`
          const activeGroup = groupNotes.some((asset) => location.pathname.endsWith(`/assets/${asset.id}`))
          const isCollapsed = query.trim() ? false : (collapsed[collapseKey] ?? !activeGroup)
          return <div className="asset-group notebook-target-group" key={groupKey}>
            <div className="notebook-group-heading" onContextMenu={(event) => { if (groupKey !== 'unassigned') openContext(event, { kind: 'category', id: groupKey }) }}><button className="asset-group-head" type="button" aria-expanded={!isCollapsed} data-active={activeGroup || undefined} onKeyDown={(event) => { if (groupKey !== 'unassigned' && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) openContext(event, { kind: 'category', id: groupKey }) }} onClick={() => setCollapsed((value) => ({ ...value, [collapseKey]: !isCollapsed }))}><span>{isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<Target size={13} />{groupLabel(groupKey)}</span><span className="sr-only">{groupNotes.length} 篇笔记</span></button><button className="notebook-group-add" type="button" title="新建资产" aria-label={`在${groupLabel(groupKey)}中创建资产`} onClick={() => { setCollapsed((value) => ({ ...value, [collapseKey]: false })); setQuery(''); onCreateAsset(groupKey === 'unassigned' ? undefined : groupKey) }}><span className="notebook-group-count" aria-hidden="true">{groupNotes.length}</span><Plus className="notebook-group-plus" size={15} /></button></div>
            {!isCollapsed && groupNotes.map((asset) => <NoteNavItem key={asset.id} caseId={caseId} asset={asset} active={location.pathname.endsWith(`/assets/${asset.id}`)} navigationKey={location.pathname.endsWith(`/assets/${asset.id}`) ? location.key : ''} onNavigate={closeNavigation} onOpen={openNote} onContextMenu={openNoteContext} onCopy={copyText} />)}
          </div>
        })}
      </nav>
      <div className="sidebar-bottom"><button type="button" className="sidebar-bottom-link" onClick={() => setRecycleOpen(true)}><Archive size={14} />回收站</button></div>
    </aside>
    {context && <ContextMenu position={context} label={context.kind === 'asset' ? '资产菜单' : '分类菜单'} onClose={closeContext} items={[
      { label: context.kind === 'asset' ? '编辑资产' : '编辑分类', icon: <Pencil size={15} />, onSelect: () => startEdit(context) },
      { label: '复制当前显示内容', icon: <Copy size={15} />, onSelect: () => { void copyText(context.kind === 'category' ? groupLabel(context.id) : context.display ?? '') } },
      { label: context.kind === 'asset' ? '删除资产' : '删除分类', icon: <Trash2 size={15} />, danger: true, onSelect: () => setDeleting(context) },
    ]} />}
    <Modal open={Boolean(editing)} title={editing?.kind === 'category' ? '编辑分类' : '编辑资产'} onClose={() => setEditing(null)} footer={<><button className="secondary-button" onClick={() => setEditing(null)}>取消</button><button className="primary-button" type="submit" form="sidebar-edit-form">保存</button></>}>
      <form id="sidebar-edit-form" onSubmit={(event) => { event.preventDefault(); saveEdit() }}><Field label={editing?.kind === 'category' ? '分类名称' : '标题'}><TextInput autoFocus value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></Field>{editing?.kind === 'asset' && <Field label="URL / 地址"><TextInput value={editUrl} onChange={(event) => setEditUrl(event.target.value)} /></Field>}{editing?.kind === 'category' && cases.some((item) => item.id !== caseId && item.targetIds.includes(editing.id)) && <p className="sidebar-edit-hint">名称会同步更新到引用此分类的案件。</p>}{editError && <p className="sidebar-edit-error" role="alert">{editError}</p>}</form>
    </Modal>
    <Modal open={Boolean(deleting)} title={deleting?.kind === 'category' ? '删除分类？' : '删除资产？'} onClose={() => setDeleting(null)} footer={<><button className="secondary-button" onClick={() => setDeleting(null)}>取消</button><button className="primary-button sidebar-delete-confirm" onClick={confirmDelete}>确认删除</button></>}><p className="sidebar-delete-copy">{deleting?.kind === 'category' ? '仅移除此案件中的分类，资产保留在“未归类”。分类可从回收站恢复。' : '资产将移至回收站，可以恢复。'}</p></Modal>
    <RecycleBinModal open={recycleOpen} onClose={() => setRecycleOpen(false)} assets={state.assets.filter((asset) => current?.assetIds.includes(asset.id) && asset.deletedAt)} categories={targets.filter((target) => current?.deletedTargetIds?.includes(target.id))} onRestoreCategory={(id) => setCategoryDeleted(caseId, id, false)} onRestore={(assetId) => updateAsset(assetId, { deletedAt: undefined })} />
    {toast && <div className="notebook-toast" role="status">{toast}</div>}
  </>
}

function RecycleBinModal({ open, onClose, assets, categories, onRestore, onRestoreCategory }: { open: boolean; onClose: () => void; assets: AssetRecord[]; categories: TargetRecord[]; onRestore: (assetId: string) => void; onRestoreCategory: (id: string) => void }) {
  return <Modal open={open} onClose={onClose} eyebrow="RECYCLE BIN" title="回收站"><div className="recycle-bin-list">{categories.map((category) => <div className="recycle-bin-item" key={category.id}><div><strong>{category.name}</strong><small>分类</small></div><button className="secondary-button" type="button" onClick={() => onRestoreCategory(category.id)}>恢复</button></div>)}{assets.map((asset) => <div className="recycle-bin-item" key={asset.id}><div><strong>{asset.title || '未命名笔记'}</strong><small>{asset.value}</small></div><button className="secondary-button" type="button" onClick={() => onRestore(asset.id)}>恢复</button></div>)}{!assets.length && !categories.length && <p className="recycle-bin-empty">回收站为空。</p>}</div></Modal>
}

export function CaseLayout() {
  const { caseId = '' } = useParams()
  const navigate = useNavigate()
  const { cases, addAsset } = useLedger()
  const current = cases.find((item) => item.id === caseId)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 760px)').matches)
  const buttonBounce = useRef<Animation>()
  useEffect(() => {
    const query = matchMedia('(max-width: 760px)')
    const update = () => { setCompact(query.matches); setSidebarOpen(false) }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => () => buttonBounce.current?.cancel(), [])
  const expanded = compact ? sidebarOpen : !focused
  const toggleSidebar = (event: MouseEvent<HTMLButtonElement>) => {
    if (compact) setSidebarOpen((value) => !value)
    else setFocused((value) => !value)
    buttonBounce.current?.cancel()
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      buttonBounce.current = event.currentTarget.animate([
        { transform: 'scale(.9)' }, { transform: 'scale(1.12)', offset: .45 },
        { transform: 'scale(.98)', offset: .72 },
        { transform: event.currentTarget.matches(':hover') ? 'scale(1.045)' : 'scale(1)' },
      ], { duration: 360, easing: 'ease-out' })
    }
  }
  const createNote = (targetId?: string) => {
    const id = addAsset({ caseId, targetId, kind: 'url', value: '', title: '未命名笔记', status: 'unknown', severity: 'medium', confidence: 'medium', tags: [], situation: '', utility: '', nextSteps: '', provenance: { source: '', method: '', reason: '', capturedAt: new Date().toISOString() }, details: '', noteMarkdown: '' })
    setSidebarOpen(false)
    navigate(`/cases/${caseId}/assets/${id}`)
  }
  if (!current) return <div className="not-found"><h1>案件不存在</h1><Link to="/">返回案件索引</Link></div>
  return <div className={`workspace-screen notebook-workspace ${focused ? 'notebook-focused' : ''} ${sidebarOpen ? 'notebook-mobile-open' : ''}`} data-sidebar-expanded={expanded}><CaseHeader caseName={current.name} /><div className="workspace-body"><div className="notebook-sidebar-control-position"><IconButton label={expanded ? '收起侧边栏' : '展开侧边栏'} className="notebook-sidebar-control" aria-controls="notebook-sidebar" aria-expanded={expanded} onClick={toggleSidebar}>{expanded ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</IconButton></div><AssetSidebar caseId={caseId} open={sidebarOpen} expanded={expanded} onClose={() => setSidebarOpen(false)} onCreateAsset={createNote} /><main className="workspace-main notebook-main"><Outlet context={{ openAddAsset: () => createNote() }} /></main></div></div>
}

export type WorkspaceOutlet = { openAddAsset: () => void }
