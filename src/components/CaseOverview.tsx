import { lazy, Suspense, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useLedger, useNoteReady } from '../store'
import { caseMarkdown } from '../notes'
import { NotebookEditor } from './NotebookEditor'
import { CaseSecretsTable } from './CaseSecretsTable'
const AssetArchitecture = lazy(() => import('./AssetArchitecture').then(module => ({ default: module.AssetArchitecture })))

export function CaseOverview() {
  const { caseId = '' } = useParams()
  const [view, setView] = useState<'note' | 'graph'>('graph')
  const ready = useNoteReady('cases', caseId)
  const { cases, assets, tasks, updateCase } = useLedger()
  const current = cases.find((item) => item.id === caseId)
  const caseAssets = useMemo(() => assets.filter((asset) => current?.assetIds.includes(asset.id)), [assets, current])
  const caseTasks = useMemo(() => tasks.filter((task) => current?.taskIds.includes(task.id)), [tasks, current])
  if (!current) return null
  if (!ready) return <div className="notebook-empty" role="status">正在读取笔记…</div>
  return <article className="notebook-page case-notebook-page">
    <header className="notebook-page-head"><input className="notebook-title" value={current.name} aria-label={'\u6848\u4ef6\u6807\u9898'} onChange={(event) => updateCase(current.id, { name: event.target.value })} /></header>
    <nav className="case-overview-tabs" role="tablist" aria-label="案件概览"><button role="tab" aria-selected={view === 'graph'} onClick={() => setView('graph')}>资产架构</button><button role="tab" aria-selected={view === 'note'} onClick={() => setView('note')}>概览笔记</button></nav>
    {view === 'graph' ? <Suspense fallback={<div role="status">正在读取资产架构…</div>}><AssetArchitecture caseId={current.id} /></Suspense> : <><CaseSecretsTable caseId={current.id} />
    <NotebookEditor key={current.id} docId={current.id} value={caseMarkdown(current, caseAssets, caseTasks)} label={`${current.name}\u7b14\u8bb0`} onSave={(noteMarkdown) => updateCase(current.id, { noteMarkdown })} /></>}
    <footer className="notebook-page-links"><Link to={`/cases/${current.id}/findings`}>{'\u53d1\u73b0'}</Link><span>{caseAssets.length} {'\u9879\u8d44\u4ea7'}</span></footer>
  </article>
}
