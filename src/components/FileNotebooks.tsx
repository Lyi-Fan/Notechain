import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { BookOpen, Check, ChevronDown, ChevronRight, FilePlus, FileText, Folder, FolderOpen, FolderPlus, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Search, Sun, Target, Trash2, X } from 'lucide-react'
import { Brand } from './Brand'
import { initials } from '../lib'
import { fileDocumentTools, fileReadingKey, isMarkdownLink, notebookCall, noteFileUrl, relativeFileLink, saveNoteFile, flushEditors, unsavedFiles, acknowledgeFileCopy, type FileEntry, type FileNotebook, type FileSession, type NoteFile, type OpenedNotebook } from '../file-notebooks'
import { ledgerStorage, nativeInvoke } from '../native-storage'
import { writeClipboardText } from '../platform'
import { useLedger } from '../store'
import { NotebookEditor } from './NotebookEditor'
import { FileDocumentContext } from './FileDocumentContext'
import { ActionMenu } from './ActionMenu'
import { ContextMenu, type ContextMenuPosition } from './ContextMenu'
import { DesktopChrome, Field, IconButton, Modal, TextInput } from './ui'
import { ModeSwitch } from './ModeSwitch'
import { NavigationControls } from './NavigationControls'
import './file-notebooks.css'

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/')
const baseName = (path: string) => path.split('/').at(-1) ?? path
const ancestors = (path: string) => path.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')).filter(Boolean)
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function NotebookOpenBridge() {
  const navigate = useNavigate()
  useEffect(() => {
    if (!nativeInvoke) return
    let cancelled = false
    const stops: (() => void)[] = []
    const open = async (value: OpenedNotebook) => {
      await flushEditors()
      if (cancelled) return
      ledgerStorage.setItem('asset-ledger-mode', 'notes')
      navigate(noteFileUrl(value.notebook.id, value.kind === 'file' ? value.path : '', value.kind === 'category' ? value.path : ''))
    }
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const received = () => { void notebookCall<OpenedNotebook | null>({ action: 'pendingOpen' }).then(value => value && open(value)).catch(error => window.dispatchEvent(new CustomEvent('ledger-native-error', { detail: errorText(error) }))) }
      stops.push(await listen('notebook-open', received))
      stops.push(await listen<string>('notebook-open-error', event => window.dispatchEvent(new CustomEvent('ledger-native-error', { detail: event.payload }))))
      if (cancelled) { stops.forEach(stop => stop()); return }
      received()
    })()
    return () => { cancelled = true; stops.forEach(stop => stop()) }
  }, [navigate])
  return null
}

interface Dialog { kind: 'book' | 'file' | 'directory' | 'rename'; path: string; name: string }
export function FileNotebooks() {
  const { notebookId = '' } = useParams(), [params] = useSearchParams(), navigate = useNavigate(), location = useLocation()
  const file = params.get('file') ?? '', folder = file ? parentOf(file) : params.get('folder') ?? ''
  const { state, setTheme } = useLedger()
  const [books, setBooks] = useState<FileNotebook[]>([])
  const [failedFiles, setFailedFiles] = useState(unsavedFiles)
  useEffect(() => { const update = () => setFailedFiles(unsavedFiles()); window.addEventListener('notebook-save-state', update); return () => window.removeEventListener('notebook-save-state', update) }, [])
  const [tree, setTree] = useState<Record<string, FileEntry[]>>({}), [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [creatingCategory, setCreatingCategory] = useState(false), [categoryName, setCategoryName] = useState('')
  const [context, setContext] = useState<(ContextMenuPosition & { entry: FileEntry }) | null>(null)
  const closeContext = useCallback(() => setContext(null), [])
  const [sidebarOpen, setSidebarOpen] = useState(false), [focused, setFocused] = useState(false)
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 760px)').matches)
  const buttonBounce = useRef<Animation>()
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)')
    const update = () => { setCompact(media.matches); setSidebarOpen(false) }
    media.addEventListener('change', update)
    return () => { media.removeEventListener('change', update); buttonBounce.current?.cancel() }
  }, [])
  const sidebarExpanded = compact ? sidebarOpen : !focused
  const toggleSidebar = (event: MouseEvent<HTMLButtonElement>) => {
    if (compact) setSidebarOpen(value => !value); else setFocused(value => !value)
    buttonBounce.current?.cancel()
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) buttonBounce.current = event.currentTarget.animate([
      { transform: 'scale(.9)' }, { transform: 'scale(1.12)', offset: .45 }, { transform: 'scale(.98)', offset: .72 },
      { transform: event.currentTarget.matches(':hover') ? 'scale(1.045)' : 'scale(1)' },
    ], { duration: 360, easing: 'ease-out' })
  }
  const [document, setDocument] = useState<NoteFile | null>(null), [loading, setLoading] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null), [query, setQuery] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null), [externalVersion, setExternalVersion] = useState(0)
  const session = useRef<FileSession | null>(null), reader = useRef<HTMLDivElement>(null)
  const readingTimer = useRef<ReturnType<typeof setTimeout>>()
  const readingPending = useRef<{ key: string; top: number } | null>(null)
  useEffect(() => () => {
    clearTimeout(readingTimer.current)
    const pending = readingPending.current
    if (pending) ledgerStorage.setItem(pending.key, String(pending.top))
  }, [])
  const book = books.find(item => item.id === notebookId)
  const bookRef = useRef(book); bookRef.current = book
  const notebookIdRef = useRef(notebookId); notebookIdRef.current = notebookId
  const documentRef = useRef(document); documentRef.current = document
  const treeRef = useRef(tree); treeRef.current = tree
  const fileRef = useRef(file); fileRef.current = file
  const run = async (work: () => Promise<void>) => {
    setError(''); setBusy(true)
    try { await work() } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  const index = useCallback(async () => {
    const result = await notebookCall<{ notebooks: FileNotebook[]; registryPath: string }>({ action: 'index' })
    setBooks(result.notebooks)
  }, [])
  const go = async (href: string) => { await flushEditors(true); setSidebarOpen(false); navigate(href) }
  useEffect(() => { ledgerStorage.setItem('asset-ledger-mode', 'notes'); void index().catch(error => setError(errorText(error))) }, [index, notebookId])
  const loadChildren = useCallback(async (path: string) => {
    const entries = await notebookCall<FileEntry[]>({ action: 'children', id: notebookId, path })
    if (notebookIdRef.current === notebookId) setTree(current => ({ ...current, [path]: entries }))
    return entries
  }, [notebookId])
  const categoryPaths = (tree[''] ?? []).filter(entry => entry.kind === 'directory').map(entry => entry.path).join('\0')
  useEffect(() => {
    // Read one level for category counters; nested folders remain lazy.
    for (const path of categoryPaths.split('\0').filter(Boolean)) {
      if (!treeRef.current[path]) void loadChildren(path).catch(() => {})
    }
  }, [categoryPaths, loadChildren])
  const refresh = useCallback(async () => {
    if (!bookRef.current) return
    for (const path of Object.keys(treeRef.current)) {
      try { await loadChildren(path) } catch { setTree(current => { const next = { ...current }; delete next[path]; return next }) }
    }
    const current = session.current
    if (current && !current.dirty && fileRef.current === current.path) {
      await current.queue.catch(() => {})
      if (current.dirty) return
      try {
        const next = await notebookCall<NoteFile>({ action: 'read', id: current.id, path: current.path })
        if (session.current !== current || current.dirty) return
        if (next.revision !== current.revision) {
          current.revision = next.revision; current.draft = next.content
          setDocument(next); setExternalVersion(version => version + 1); setNotice('文件已在外部更新')
        }
      } catch (error) { setError('无法重新读取当前文件：' + errorText(error)) }
    }
  }, [loadChildren])
  const refreshRef = useRef(refresh); refreshRef.current = refresh
  useEffect(() => {
    if (!book) return
    let active = true, stop: (() => void) | undefined, timer: ReturnType<typeof setTimeout>
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      stop = await listen<{ id: string }>('notebook-changed', event => {
        if (event.payload.id !== notebookId) return
        clearTimeout(timer); timer = setTimeout(() => { if (active) void refreshRef.current().catch(error => setError(errorText(error))) }, 180)
      })
      if (!active) { stop(); return }
      await notebookCall({ action: 'watch', id: notebookId })
    })().catch(error => setError(errorText(error)))
    const focus = () => { void refreshRef.current().catch(error => setError(errorText(error))) }
    window.addEventListener('focus', focus)
    return () => { active = false; stop?.(); clearTimeout(timer); window.removeEventListener('focus', focus); void notebookCall({ action: 'watch', id: '' }).catch(() => {}) }
  }, [notebookId, book?.scopes.join('\n')])
  useEffect(() => {
    setTree({}); setExpanded(new Set()); setQuery(''); setDocument(null); session.current = null
    setCreatingCategory(false); setCategoryName(''); setContext(null)
    if (book) void loadChildren('').catch(error => setError(errorText(error)))
  }, [notebookId, !!book, book?.scopes.join('\n'), loadChildren])
  useEffect(() => {
    if (!book) return
    let cancelled = false
    const paths = ancestors(folder)
    setExpanded(current => new Set([...current, ...paths, ...(file && !folder ? [''] : [])]))
    for (const path of ['', ...paths]) void loadChildren(path).catch(error => { if (!cancelled) setError(errorText(error)) })
    setDocument(null); session.current = null
    if (!file) { setLoading(false); return () => { cancelled = true } }
    setLoading(true)
    void notebookCall<NoteFile>({ action: 'read', id: notebookId, path: file }).then(note => {
      if (cancelled) return
      const failed = unsavedFiles().find(item => item.id === notebookId && item.path === file)
      if (failed) note.draft = { content: failed.draft, revision: failed.revision }
      const content = note.draft?.content ?? note.content
      const current: FileSession = { id: notebookId, path: file, revision: note.draft?.revision ?? note.revision, draft: content, dirty: !!note.draft, queue: Promise.resolve() }
      session.current = current
      setDocument({ ...note, content })
      if (note.draft) setNotice('已恢复未保存草稿')
    }).catch(error => { if (!cancelled) setError(errorText(error)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [notebookId, file, folder, !!book, book?.scopes.join('\n'), loadChildren])
  useEffect(() => {
    if (!document || !reader.current) return
    const key = fileReadingKey(notebookId, file)
    const frame = requestAnimationFrame(() => {
      if (location.hash) {
        try { reader.current?.querySelector('#' + CSS.escape(decodeURIComponent(location.hash.slice(1))))?.scrollIntoView() } catch { /* Invalid anchors leave the current reading position intact. */ }
      } else if (reader.current) reader.current.scrollTop = Number(ledgerStorage.getItem(key) ?? ledgerStorage.getItem('file-reading:' + notebookId + ':' + file) ?? 0)
    })
    return () => cancelAnimationFrame(frame)
  }, [!!document, notebookId, file, location.hash, externalVersion])
  const open = async (kind: 'notebook' | 'category' | 'file') => {
    await flushEditors()
    const opened = await notebookCall<OpenedNotebook | null>({ action: 'open', kind, id: notebookId, folder })
    if (!opened) return
    await index()
    navigate(noteFileUrl(opened.notebook.id, kind === 'file' ? opened.path : '', kind === 'category' ? opened.path : ''))
  }
  const create = async () => {
    if (!dialog?.name.trim()) return
    await flushEditors()
    if (dialog.kind === 'book') {
      const opened = await notebookCall<OpenedNotebook | null>({ action: 'createBook', name: dialog.name })
      if (!opened) return
      await index(); navigate(noteFileUrl(opened.notebook.id))
    } else if (dialog.kind === 'rename') {
      const result = await notebookCall<{ path: string }>({ action: 'rename', id: notebookId, path: dialog.path, name: dialog.name })
      const isCurrent = file === dialog.path || file.startsWith(dialog.path + '/')
      await index(); await refresh()
      if (isCurrent) navigate(noteFileUrl(notebookId, result.path + file.slice(dialog.path.length)))
      else navigate(noteFileUrl(notebookId, '', isMarkdownLink(result.path) ? parentOf(result.path) : result.path))
    } else {
      const result = await notebookCall<FileEntry>({ action: 'create', id: notebookId, path: dialog.path, name: dialog.name, kind: dialog.kind })
      await index(); await loadChildren(dialog.path)
      navigate(noteFileUrl(notebookId, result.kind === 'file' ? result.path : '', result.kind === 'directory' ? result.path : ''))
    }
    setDialog(null)
  }
  const remove = async (entry: FileEntry) => {
    if (!confirm('将“' + entry.name + '”移到系统废纸篓？')) return
    await flushEditors()
    await notebookCall({ action: 'trash', id: notebookId, path: entry.path })
    if (file === entry.path || file.startsWith(entry.path + '/') || folder === entry.path || folder.startsWith(entry.path + '/')) navigate(noteFileUrl(notebookId, '', parentOf(entry.path)))
    await refresh()
  }
  const entryMenu = (entry: FileEntry) => [
    ...(entry.kind === 'directory' ? [
      { label: '新建笔记', icon: <FilePlus size={14} />, onSelect: () => setDialog({ kind: 'file', path: entry.path, name: '' }) },
      { label: '新建文件夹', icon: <FolderPlus size={14} />, onSelect: () => setDialog({ kind: 'directory', path: entry.path, name: '' }) },
    ] : []),
    { label: '重命名', icon: <FileText size={14} />, onSelect: () => setDialog({ kind: 'rename', path: entry.path, name: entry.name }) },
    { label: '复制路径', icon: <MoreHorizontal size={14} />, onSelect: () => void run(() => writeClipboardText(book!.root + '/' + entry.path)) },
    { label: '移到废纸篓', icon: <Trash2 size={14} />, danger: true, onSelect: () => void run(() => remove(entry)) },
  ]
  const showFile = (entry: FileEntry) => void run(() => go(noteFileUrl(notebookId, entry.kind === 'file' ? entry.path : '', entry.kind === 'directory' ? entry.path : '')))
  const openContext = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, entry: FileEntry) => {
    event.preventDefault()
    const box = event.currentTarget.getBoundingClientRect()
    setContext({ entry, trigger: event.currentTarget, x: 'clientX' in event ? event.clientX : box.left, y: 'clientY' in event ? event.clientY : box.bottom })
  }
  const contextKey = (event: KeyboardEvent<HTMLElement>, entry: FileEntry) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openContext(event, entry)
  }
  const toggleFolder = (path: string) => void run(async () => {
    if (!expanded.has(path) && !tree[path]) await loadChildren(path)
    setExpanded(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next })
  })
  const matches = (entry: FileEntry) => entry.kind === 'directory' || !query || entry.name.toLowerCase().includes(query.toLowerCase())
  const nestedRow = (entry: FileEntry, depth: number): React.ReactNode => <div key={entry.path}>
    <div className="file-tree-row" data-active={file === entry.path || (!file && folder === entry.path) || undefined} style={{ paddingLeft: 10 + depth * 16 }} onContextMenu={event => openContext(event, entry)}>
      {entry.kind === 'directory' ? <button className="file-tree-toggle" aria-label={(expanded.has(entry.path) ? '收起 ' : '展开 ') + entry.name} aria-expanded={expanded.has(entry.path)} onClick={() => toggleFolder(entry.path)}>{expanded.has(entry.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="file-tree-spacer" />}
      <button className="file-tree-name" title={entry.path} onClick={() => showFile(entry)} onKeyDown={event => contextKey(event, entry)}>{entry.kind === 'directory' ? <Folder size={15} /> : <FileText size={15} />}<span>{entry.name}</span></button>
      <IconButton className="file-entry-menu" label={entry.name + '操作'} aria-haspopup="menu" onClick={event => openContext(event, entry)}><MoreHorizontal size={15} /></IconButton>
    </div>{entry.kind === 'directory' && expanded.has(entry.path) && <div className="file-nested-children">{(tree[entry.path] ?? []).filter(matches).map(child => nestedRow(child, depth + 1))}</div>}
  </div>
  const noteRow = (entry: FileEntry) => <div key={entry.path} className={'notebook-note-entry ' + (file === entry.path ? 'active' : '')} onContextMenu={event => openContext(event, entry)}>
    <Link className={'notebook-note-row ' + (file === entry.path ? 'active' : '')} to={noteFileUrl(notebookId, entry.path)} title={entry.path} aria-current={file === entry.path ? 'page' : undefined} onClick={event => { event.preventDefault(); if (file !== entry.path) showFile(entry) }} onDoubleClick={event => { event.preventDefault(); void run(() => writeClipboardText(entry.name)) }} onKeyDown={event => contextKey(event, entry)}>
      <span className="notebook-note-icon"><FileText size={16} /></span><span className="notebook-note-copy"><strong>{entry.name}</strong></span>
    </Link>
  </div>
  const category = (path: string, name: string, rootFiles?: FileEntry[]) => {
    const children = rootFiles ?? tree[path]
    const isOpen = expanded.has(path) || !!query.trim()
    const active = path ? file.startsWith(path + '/') || folder === path || folder.startsWith(path + '/') : !!file && !folder
    const entry: FileEntry = { path, name, kind: 'directory' }
    return <div className="asset-group notebook-target-group file-category" key={path} data-category-path={path}>
      <div className="notebook-group-heading" onContextMenu={event => { if (path) openContext(event, entry) }}>
        <button className="asset-group-head" type="button" aria-expanded={isOpen} data-active={active || undefined} onClick={() => toggleFolder(path)} onKeyDown={event => { if (path) contextKey(event, entry) }}>
          <span>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Target size={13} />{name}</span><span className="sr-only">{children ? children.length + ' 项' : '正在读取'}</span>
        </button>
        <button className="notebook-group-add" type="button" title="新建笔记" aria-label={'在' + name + '中创建笔记'} disabled={busy} onClick={() => { setExpanded(current => new Set([...current, path])); setDialog({ kind: 'file', path, name: '' }) }}>
          <span className="notebook-group-count" aria-hidden="true">{children?.length ?? ''}</span><Plus className="notebook-group-plus" size={15} />
        </button>
      </div>
      {isOpen && <div className="file-category-contents">{(children ?? []).filter(matches).map(child => child.kind === 'file' ? noteRow(child) : <div className="file-category-subtree" key={child.path}>{nestedRow(child, 0)}</div>)}</div>}
    </div>
  }
  const createCategory = async () => {
    await flushEditors()
    const created = await notebookCall<FileEntry>({ action: 'create', id: notebookId, path: '', name: categoryName, kind: 'directory' })
    await index(); await loadChildren('')
    setExpanded(current => new Set([...current, created.path]))
    setCategoryName(''); setCreatingCategory(false)
  }
  const currentSession = session.current
  const fileContext = useMemo(() => currentSession && book ? {
    ...fileDocumentTools(notebookId, file, href => { void run(() => go(href)) }),
    title: baseName(file),
    restoredDraft: !!documentRef.current?.draft,
    linkChoices: () => Object.values(treeRef.current).flat().filter(entry => entry.kind === 'file' && entry.path !== file).map(entry => ({ id: entry.path, title: entry.name, value: entry.path, href: relativeFileLink(file, entry.path) })),
    onDraft: (content: string) => { currentSession.draft = content; currentSession.dirty = true },
  } : null, [currentSession, book?.id, file, notebookId, externalVersion])
  const save = async (content: string) => {
    if (!currentSession) throw new Error('文件尚未读取')
    const result = await saveNoteFile(currentSession, content)
    if (result.conflict) {
      setNotice('磁盘文件已被修改；你的编辑已另存为冲突副本')
      await index()
      navigate(noteFileUrl(notebookId, result.path))
    }
  }
  const saveCopy = async () => {
    const current = session.current
    if (!current) return
    window.dispatchEvent(new Event('ledger-flush-editors'))
    await current.queue.catch(() => {})
    const opened = await notebookCall<(OpenedNotebook & { revision: string }) | null>({ action: 'saveCopy', name: baseName(file), content: current.draft })
    if (!opened) return
    acknowledgeFileCopy(current, opened)
    setError(''); setNotice('副本已保存')
    await index()
    navigate(noteFileUrl(opened.notebook.id, opened.path))
  }
  const filtered = books.filter(item => item.name.toLowerCase().includes(query.toLowerCase()) || item.root.toLowerCase().includes(query.toLowerCase()))
  return <div className={'file-notebooks notebook-workspace ' + (focused ? 'notebook-focused ' : '') + (sidebarOpen ? 'notebook-mobile-open' : '')} data-sidebar-expanded={sidebarExpanded}>
    <header className={notebookId ? 'workspace-header notebook-header' : 'home-topbar notebook-home-header'} data-tauri-drag-region="deep">
      <div className={notebookId ? 'workspace-header-left' : 'home-toolbar-left'}><NavigationControls /><ModeSwitch />{!notebookId && <Brand />}{notebookId && <><div className="crumb-divider" /><Link className="notebook-case-crumb" to="/notebooks" onClick={event => { event.preventDefault(); void run(() => go('/notebooks')) }}>笔记本索引</Link><span className="notebook-crumb-separator">/</span><strong title={book?.root}>{book?.name ?? '笔记本'}</strong></>}</div>
      <div className={notebookId ? 'workspace-header-right' : 'home-actions'}>
        {!notebookId && <div className="home-search"><Search size={16} /><input aria-label="搜索笔记本" placeholder="搜索笔记本" value={query} onChange={event => setQuery(event.target.value)} /></div>}
        <IconButton label={notebookId ? '打开分类文件夹' : '打开笔记本文件夹'} disabled={busy} onClick={() => void run(() => open(notebookId ? 'category' : 'notebook'))}><FolderOpen size={17} /></IconButton>
        <IconButton label="打开 Markdown 文件" disabled={busy} onClick={() => void run(() => open('file'))}><FileText size={17} /></IconButton>
        {!notebookId && <button className="primary-button" disabled={busy} onClick={() => setDialog({ kind: 'book', path: '', name: '' })}><Plus size={15} />新建笔记本</button>}
        {notebookId ? <ActionMenu label="笔记本操作" items={[
          ...(notebookId ? [{ label: '新建笔记', icon: <FilePlus size={15} />, onSelect: () => setDialog({ kind: 'file', path: folder, name: '' }) }] : []),
          { label: state.theme === 'dark' ? '日间主题' : '夜间主题', icon: state.theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />, onSelect: () => setTheme(state.theme === 'dark' ? 'light' : 'dark') },
          ...(notebookId ? [{ label: '返回笔记本索引', icon: <BookOpen size={15} />, onSelect: () => void run(() => go('/notebooks')) }] : []),
        ]} /> : <IconButton label="切换主题" onClick={() => setTheme(state.theme === 'dark' ? 'light' : 'dark')}>{state.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</IconButton>}<DesktopChrome />
      </div>
    </header>
    {(error || notice) && <div className={'file-notice ' + (error ? 'is-error' : '')} role={error ? 'alert' : 'status'}><span>{error || notice}</span><IconButton label="关闭提示" onClick={() => { setError(''); setNotice('') }}><X size={14} /></IconButton></div>}
    {failedFiles.length > 0 && <div className="file-notice is-error" role="alert"><span>{failedFiles.length} 篇笔记尚未保存</span><button className="text-button" onClick={() => void run(() => go(noteFileUrl(failedFiles[0].id, failedFiles[0].path)))}>继续编辑</button></div>}
    {!notebookId ? <main className="notebook-home-content file-notebook-home">
      <div className="notebook-home-title"><h1>笔记本</h1><span>{filtered.length} 个笔记本</span></div>
      <div className="file-book-list notebook-case-list">{filtered.map(item => <div className="file-book-row" key={item.id}><button className="notebook-case-row" onClick={() => void run(() => go(noteFileUrl(item.id)))}><span className="notebook-case-mark">{initials(item.name)}</span><span className="notebook-case-copy"><strong>{item.name}</strong><small title={item.root}>{item.root}</small></span><ChevronRight size={17} /></button><ActionMenu label={item.name + '笔记本操作'} items={[{ label: '从列表移除', icon: <X size={14} />, onSelect: () => void run(async () => { if (unsavedFiles().some(file => file.id === item.id)) throw new Error('此笔记本还有未保存草稿，请先继续编辑或另存副本'); await notebookCall({ action: 'forget', id: item.id }); await index() }) }]} /></div>)}</div>
      {!filtered.length && <div className="notebook-empty"><BookOpen size={26} /><p>{query ? '没有匹配的笔记本' : '尚无笔记本'}</p><button className="secondary-button" onClick={() => void run(() => open('notebook'))}><FolderOpen size={15} />打开文件夹</button></div>}
    </main> : <div className="workspace-body file-workspace">
      <div className="notebook-sidebar-control-position"><IconButton label={sidebarExpanded ? '收起侧边栏' : '展开侧边栏'} className="notebook-sidebar-control" aria-controls="file-notebook-sidebar" aria-expanded={sidebarExpanded} onClick={toggleSidebar}>{sidebarExpanded ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</IconButton></div>
      <div className={'sidebar-scrim ' + (sidebarOpen ? 'visible' : '')} onClick={() => setSidebarOpen(false)} />
      <aside id="file-notebook-sidebar" className={'asset-sidebar notebook-sidebar file-sidebar ' + (sidebarOpen ? 'open' : '')} aria-hidden={!sidebarExpanded} {...(!sidebarExpanded ? { inert: '' } : {})}>
        <div className="sidebar-brand notebook-sidebar-title"><span className="sidebar-case-icon"><FolderOpen size={20} strokeWidth={1.7} /></span><div><strong title={book?.root}>{book?.name}</strong></div></div>
        <nav className="notebook-index-links" aria-label="笔记本目录"><Link to={noteFileUrl(notebookId)} onClick={event => { event.preventDefault(); void run(() => go(noteFileUrl(notebookId))) }} aria-current={!file && !folder ? 'page' : undefined}><FileText size={15} />笔记目录</Link></nav>
        <div className="sidebar-tools notebook-search"><div className="sidebar-search"><Search size={14} /><input aria-label="筛选文件名" placeholder="搜索笔记" value={query} onChange={event => setQuery(event.target.value)} /></div></div>
        <div className="sidebar-label notebook-directory-label"><span>笔记</span><button className="notebook-category-add" title="新建分类" aria-label="新建分类" aria-expanded={creatingCategory} disabled={!book} onClick={() => { setCreatingCategory(value => !value); setCategoryName('') }}><Plus size={17} /></button></div>
        {creatingCategory && <form className="notebook-category-form" onSubmit={event => { event.preventDefault(); void run(createCategory) }}><div><input autoFocus aria-label="分类名称" placeholder="分类名称" value={categoryName} onChange={event => setCategoryName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setCreatingCategory(false) }} /><button type="submit" title="创建分类" aria-label="创建分类" disabled={busy || !categoryName.trim()}><Check size={15} /></button><button type="button" title="取消" aria-label="取消创建分类" onClick={() => setCreatingCategory(false)}><X size={15} /></button></div></form>}
        <nav className="asset-nav notebook-note-list" aria-label="笔记文件树">
          {(tree[''] ?? []).filter(entry => entry.kind === 'directory').map(entry => category(entry.path, entry.name))}
          {((tree[''] ?? []).some(entry => entry.kind === 'file') || !(tree[''] ?? []).some(entry => entry.kind === 'directory')) && category('', '未分类', (tree[''] ?? []).filter(entry => entry.kind === 'file'))}
        </nav>
        <div className="sidebar-bottom"><button className="sidebar-bottom-link" disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={14} />刷新目录</button></div>
      </aside>
      <section className="workspace-main notebook-main file-main">
        <div className="file-breadcrumb"><button onClick={() => void run(() => go(noteFileUrl(notebookId)))}>{book?.name}</button>{ancestors(folder).map(path => <span key={path}><ChevronRight size={12} /><button onClick={() => void run(() => go(noteFileUrl(notebookId, '', path)))}>{baseName(path)}</button></span>)}{file && <span><ChevronRight size={12} />{baseName(file)}</span>}
          {file && <ActionMenu label="文件操作" items={[{ label: '另存副本', icon: <FilePlus size={14} />, disabled: !document, onSelect: () => void run(saveCopy) }, ...entryMenu({ path: file, name: baseName(file), kind: 'file' })]} />}
        </div>
        <div className="file-reader" ref={reader} onScroll={event => { if (file) {
          readingPending.current = { key: fileReadingKey(notebookId, file), top: event.currentTarget.scrollTop }
          clearTimeout(readingTimer.current)
          readingTimer.current = setTimeout(() => { const pending = readingPending.current; if (pending) ledgerStorage.setItem(pending.key, String(pending.top)); readingPending.current = null }, 200)
        } }}>
          {loading ? <p className="notebook-empty" role="status">正在读取文件…</p> : file && document && fileContext ?
            <article className="notebook-document file-document" data-file-path={file}><FileDocumentContext.Provider value={fileContext}>
              <NotebookEditor key={notebookId + ':' + file + ':' + externalVersion} docId={'file:' + notebookId + ':' + file} value={document.content} onSave={save} footerTarget={footerTarget} />
            </FileDocumentContext.Provider></article> :
            <div className="file-directory"><h2>{baseName(folder) || book?.name}</h2>{(tree[folder] ?? []).map(entry => <div className="file-directory-row" key={entry.path}><button onClick={() => showFile(entry)}>{entry.kind === 'directory' ? <Folder size={17} /> : <FileText size={17} />}<span>{entry.name}</span>{entry.kind === 'directory' && <ChevronRight size={14} />}</button><ActionMenu label={entry.name + '操作'} items={entryMenu(entry)} /></div>)}{!tree[folder]?.length && <p className="notebook-empty">文件夹为空</p>}</div>}
        </div>
        <footer className="notebook-statusbar file-statusbar"><span>{file ? baseName(file) : '文件夹'}</span><div ref={setFooterTarget} className="notebook-status-editor" /></footer>
      </section>
    </div>}
    {context && <ContextMenu position={context} label="文件操作" items={[...(context.entry.kind === 'directory' ? [{ label: '打开文件夹', icon: <FolderOpen size={14} />, onSelect: () => showFile(context.entry) }] : []), ...entryMenu(context.entry)]} onClose={closeContext} />}
    <Modal open={!!dialog} title={dialog?.kind === 'book' ? '新建笔记本' : dialog?.kind === 'rename' ? '重命名' : dialog?.kind === 'directory' ? '新建文件夹' : '新建笔记'} onClose={() => setDialog(null)} footer={<><button className="secondary-button" disabled={busy} onClick={() => setDialog(null)}>取消</button><button className="primary-button" disabled={busy || !dialog?.name.trim()} onClick={() => void run(create)}>{dialog?.kind === 'book' ? '选择保存位置' : '保存'}</button></>}>
      <Field label="名称"><TextInput autoFocus value={dialog?.name ?? ''} onChange={event => setDialog(current => current ? { ...current, name: event.target.value } : null)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && dialog?.name.trim()) void run(create) }} /></Field>
      {error && <p role="alert" className="file-dialog-error">{error}</p>}
    </Modal>
  </div>
}
