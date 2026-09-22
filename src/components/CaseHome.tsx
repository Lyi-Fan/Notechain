import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, FolderPlus, Moon, Plus, Search, Sun } from 'lucide-react'
import { Brand } from './Brand'
import { useLedger } from '../store'
import { formatRelative, initials, severityLabel } from '../lib'
import { DesktopChrome, Field, Modal, TextArea, TextInput } from './ui'
import type { CaseRecord, Severity } from '../types'
import { NavigationControls } from './NavigationControls'
import { ModeSwitch } from './ModeSwitch'

function NotebookCaseRow({ item, noteCount, onOpen }: { item: CaseRecord; noteCount: number; onOpen: () => void }) {
  return <button className="notebook-case-row" onClick={onOpen} type="button">
    <span className="notebook-case-mark">{initials(item.name)}</span><span className="notebook-case-copy"><strong>{item.name}</strong><small>{item.summary || '尚未写下案件摘要。'}</small></span><span className="notebook-case-meta"><span>{noteCount} 篇笔记</span><time>{formatRelative(item.updatedAt)}</time></span><ArrowRight size={17} />
  </button>
}

export function CaseHome() {
  const navigate = useNavigate()
  const { cases, assets, state, addCase, setTheme } = useLedger()
  const [query, setQuery] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [code, setCode] = useState('CASE-')
  const [summary, setSummary] = useState('')
  const [priority, setPriority] = useState<Severity>('medium')
  const filtered = useMemo(() => cases.filter((item) => `${item.name} ${item.code} ${item.summary} ${item.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase().trim())), [cases, query])
  const noteCounts = useMemo(() => {
    const assetIds = new Set(assets.map((asset) => asset.id))
    return new Map(cases.map((item) => [item.id, [...new Set(item.assetIds)].filter((id) => assetIds.has(id)).length]))
  }, [assets, cases])
  const create = () => {
    if (!name.trim()) return
    const id = addCase({ name: name.trim(), code: code.trim() || 'CASE-NEW', summary: summary.trim(), priority, tags: [] })
    setShowCreate(false); setName(''); setSummary(''); setCode('CASE-'); navigate(`/cases/${id}`)
  }
  return <div className="home-screen notebook-home">
    <header className="home-topbar notebook-home-header" data-tauri-drag-region><div className="home-toolbar-left"><NavigationControls /><ModeSwitch /><Brand /></div><div className="home-actions"><div className="home-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索案件" aria-label="搜索案件" /></div><button className="quiet-button" type="button" onClick={() => setTheme(state.theme === 'light' ? 'dark' : 'light')} title="切换主题">{state.theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}</button><button className="primary-button" type="button" onClick={() => setShowCreate(true)}><Plus size={16} />新建案件</button><DesktopChrome /></div></header>
    <main className="home-content notebook-home-content"><div className="notebook-home-title"><h1>案件笔记</h1><span>{filtered.length} 个案件</span></div>
      {filtered.length ? <div className="notebook-case-list">{filtered.map((item) => <NotebookCaseRow key={item.id} item={item} noteCount={noteCounts.get(item.id) ?? 0} onOpen={() => navigate(`/cases/${item.id}`)} />)}</div> : <div className="empty-home notebook-empty"><FolderPlus size={22} /><h2>没有匹配的案件</h2><p>换一个关键词，或创建一份新的案件笔记。</p><button className="secondary-button" type="button" onClick={() => setShowCreate(true)}>新建案件</button></div>}
    </main>
    <Modal open={showCreate} onClose={() => setShowCreate(false)} eyebrow="NEW CASE" title="新建案件" footer={<><button className="secondary-button" type="button" onClick={() => setShowCreate(false)}>取消</button><button className="primary-button" type="button" onClick={create}>创建案件 <ArrowRight size={15} /></button></>}><div className="form-grid"><Field label="案件名称"><TextInput autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="案件名称" /></Field><Field label="编号"><TextInput value={code} onChange={(event) => setCode(event.target.value)} placeholder="CASE-2411" /></Field></div><Field label="优先级"><select className="text-input" value={priority} onChange={(event) => setPriority(event.target.value as Severity)}>{Object.entries(severityLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Field label="摘要"><TextArea rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="用一两句话记录范围、目标和当前问题。" /></Field></Modal>
  </div>
}
