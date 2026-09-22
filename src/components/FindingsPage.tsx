import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Check, ExternalLink, FileKey2, Plus, Trash2 } from 'lucide-react'
import { useLedger, useNoteReady } from '../store'
import { findingTypeLabel, severityLabel } from '../lib'
import { ActionMenu } from './ActionMenu'
import { NotebookEditor } from './NotebookEditor'
import { findingMarkdown } from '../notes'
import type { Confidence, FindingStatus, FindingType, Severity } from '../types'
import { SecretValue } from './SecretValue'

const findingFallback = findingMarkdown

export function FindingsPage() {
  const { caseId = '' } = useParams()
  const navigate = useNavigate()
  const { cases, findings } = useLedger()
  const current = cases.find((item) => item.id === caseId)
  const items = useMemo(() => findings.filter((item) => item.caseId === caseId && !item.deletedAt), [caseId, findings])
  if (!current) return null
  return <section className="notebook-page findings-notebook-page"><header className="notebook-page-head"><div><p className="eyebrow">案件发现 <span>/</span> {current.code}</p><h1>发现</h1></div><button className="primary-button compact-button" type="button" onClick={() => navigate(`/cases/${caseId}/findings/new`)}><Plus size={15} />新建发现</button></header><div className="notebook-finding-list">{items.length ? items.map((finding) => <Link key={finding.id} className="notebook-finding-item" to={`/cases/${caseId}/findings/${finding.id}`}><FileKey2 size={17} /><span><strong>{finding.title}</strong><small>{finding.sourceLocation || '未记录来源位置'}</small></span><em>{severityLabel[finding.severity]}</em></Link>) : <p className="notebook-empty">尚无发现。</p>}</div></section>
}

export function FindingRoute() {
  const { caseId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const findingId = useParams().findingId
  const ready = useNoteReady('findings', findingId ?? '')
  const { findings } = useLedger()
  const finding = findingId && findingId !== 'new' ? findings.find((item) => item.id === findingId && item.caseId === caseId && !item.deletedAt) : undefined
  if (finding && !ready) return <div className="notebook-empty" role="status">正在读取笔记…</div>
  if (finding) return <FindingStandalone key={finding.id} finding={finding} />
  if (findingId === 'new') return <FindingEditor caseId={caseId} sourceAssetId={searchParams.get('asset') ?? ''} />
  return <section className="notebook-page"><p className="notebook-empty">未找到该发现。</p></section>
}

function FindingStandalone({ finding }: { finding: ReturnType<typeof useLedger>['findings'][number] }) {
  const navigate = useNavigate()
  const { assets, updateFinding } = useLedger()
  const source = assets.find((item) => item.id === finding.sourceAssetId)
  const remove = () => { if (window.confirm('确定删除这条发现吗？')) { updateFinding(finding.id, { deletedAt: new Date().toISOString() }); navigate(`/cases/${finding.caseId}/findings`) } }
  const sourceHref = finding.sourceLocation.startsWith('/cases/') ? finding.sourceLocation : `/cases/${finding.caseId}/assets/${finding.sourceAssetId}`
  return <article className="notebook-page finding-notebook-page"><header className="notebook-page-head"><div><p className="eyebrow">{findingTypeLabel[finding.type]} <span>/</span> {finding.id}</p><input className="notebook-title" value={finding.title} aria-label="发现标题" onChange={(event) => updateFinding(finding.id, { title: event.target.value })} /></div><ActionMenu label="发现操作" items={[{ label: '打开来源', icon: <ExternalLink size={16} />, onSelect: () => navigate(sourceHref) }, { label: '删除发现', icon: <Trash2 size={16} />, onSelect: remove, danger: true }]} /></header><div className="notebook-finding-context"><Link to={sourceHref}>{source?.title ?? finding.sourceAssetId}</Link><span>{finding.sourceLocation}</span>{finding.value && <span className="notebook-secret"><SecretValue identity={finding.id} value={finding.value} /></span>}</div><NotebookEditor key={finding.id} docId={finding.id} value={finding.noteMarkdown ?? findingFallback(finding)} label={`${finding.title}笔记`} onSave={(noteMarkdown) => updateFinding(finding.id, { noteMarkdown })} /></article>
}

function FindingEditor({ caseId, sourceAssetId }: { caseId: string; sourceAssetId: string }) {
  const navigate = useNavigate()
  const { assets, cases, addFinding } = useLedger()
  const currentCase = cases.find((item) => item.id === caseId)
  const availableAssets = assets.filter((item) => currentCase?.assetIds.includes(item.id))
  const [title, setTitle] = useState('')
  const [assetId, setAssetId] = useState(sourceAssetId || availableAssets[0]?.id || '')
  const [sourceLocation, setSourceLocation] = useState('')
  const save = () => { if (!title.trim() || !assetId) return; const id = addFinding({ caseId, type: 'information' as FindingType, title: title.trim(), severity: 'medium' as Severity, confidence: 'medium' as Confidence, status: 'suspected' as FindingStatus, sourceAssetId: assetId, sourceLocation: sourceLocation || '未记录来源位置', howFound: '', whySearched: '', payload: '', principle: '', impact: '', limitations: '', noteMarkdown: '' }); navigate(`/cases/${caseId}/findings/${id}`) }
  return <article className="notebook-page finding-new-page"><header className="notebook-page-head"><div><p className="eyebrow">新建发现</p><h1>新建发现</h1></div><button className="primary-button compact-button" type="button" disabled={!title.trim() || !assetId} onClick={save}><Check size={15} />保存</button></header><div className="notebook-new-meta"><input className="text-input" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="发现标题" aria-label="发现标题" /><select className="text-input" value={assetId} onChange={(event) => setAssetId(event.target.value)} aria-label="来源资产"><option value="">选择来源资产</option>{availableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select><input className="text-input" value={sourceLocation} onChange={(event) => setSourceLocation(event.target.value)} placeholder="来源位置" aria-label="来源位置" /></div><button className="back-to-case notebook-cancel" type="button" onClick={() => navigate(-1)}><ArrowLeft size={14} />取消</button></article>
}
