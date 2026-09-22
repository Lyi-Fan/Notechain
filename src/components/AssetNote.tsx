import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Archive, ArrowUpRight, Download, FileText, Flag, Link2, LockKeyhole, SlidersHorizontal } from 'lucide-react'
import { useLedger, useNoteReady } from '../store'
import { nativeInvoke } from '../native-storage'
import { assetMarkdown, noteHref } from '../notes'
import { formatRelative } from '../lib'
import { NotebookEditor, type NoteSelection } from './NotebookEditor'
import { ActionMenu } from './ActionMenu'
import { EditAssetModal, RelationModal, useReadingPosition } from './AssetDetail'
import { Field, Modal, TextInput } from './ui'
import type { AssetRecord } from '../types'
import { displaySourceUrl } from '../url-display'

export function AssetNote() {
  const { assetId = '', caseId = '' } = useParams()
  const { assets, cases } = useLedger()
  const ready = useNoteReady('assets', assetId)
  const asset = assets.find((item) => item.id === assetId && cases.find((item) => item.id === caseId)?.assetIds.includes(item.id))
  if (!asset) return <div className="notebook-empty">这篇笔记已归档或不存在。<Link to={`/cases/${caseId}`}>返回案件</Link></div>
  if (!ready) return <div className="notebook-empty" role="status">正在读取笔记…</div>
  return <AssetDocument key={`${caseId}:${assetId}`} asset={asset} caseId={caseId} />
}

function AssetDocument({ asset, caseId }: { asset: AssetRecord; caseId: string }) {
  const navigate = useNavigate()
  const { assets, cases, findings, relations, updateAsset, softDeleteAsset, addFinding } = useLedger()
  const reader = useRef<HTMLDivElement>(null)
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null)
  useReadingPosition(asset, reader, caseId)
  const [properties, setProperties] = useState(false)
  const [links, setLinks] = useState(false)
  const [selection, setSelection] = useState<{ selected: NoteSelection; sensitive: boolean } | null>(null)
  const [findingTitle, setFindingTitle] = useState('')
  const [findingNote, setFindingNote] = useState('')
  const [notice, setNotice] = useState('')
  const [nativeBacklinks, setNativeBacklinks] = useState<string[]>([])
  useEffect(() => {
    if (!nativeInvoke) return
    let active = true
    const timer = setTimeout(() => { void nativeInvoke!<string[]>('asset_backlinks', { href: noteHref(asset), assetId: asset.id }).then(ids => { if (active) setNativeBacklinks(ids) }).catch(() => { if (active) setNativeBacklinks([]) }) }, 100)
    return () => { active = false; clearTimeout(timer) }
  }, [asset.id, assets])
  const [title, setTitle] = useState(asset.title === '未命名笔记' ? '' : asset.title)
  useEffect(() => setTitle(asset.title === '未命名笔记' ? '' : asset.title), [asset.title])
  const markdown = useMemo(() => assetMarkdown(asset), [asset])
  const exportSnapshot = useRef({ title: asset.title, markdown })
  exportSnapshot.current = { title: asset.title, markdown }
  const backlinks = useMemo(() => {
    const relatedIds = new Set(relations.filter((relation) => relation.sourceId === asset.id || relation.targetId === asset.id).map((relation) => relation.sourceId === asset.id ? relation.targetId : relation.sourceId))
    const href = noteHref(asset), assetHref = `asset://${asset.id}`
    return assets.filter((item) => {
      if (item.id === asset.id) return false
      if (relatedIds.has(item.id)) return true
      if (nativeInvoke) return nativeBacklinks.includes(item.id)
      const itemMarkdown = assetMarkdown(item)
      return itemMarkdown.includes(href) || itemMarkdown.includes(assetHref)
    })
  }, [asset, assets, relations, nativeBacklinks])
  const noteFindings = useMemo(() => findings.filter((finding) => finding.sourceAssetId === asset.id && !finding.deletedAt), [asset.id, findings])
  const caseNames = useMemo(() => new Map(cases.map((entry) => [entry.id, entry.name])), [cases])
  let safeUrl = false
  try { safeUrl = ['http:', 'https:'].includes(new URL(asset.value).protocol) } catch { /* Non-URL notes have no external navigation. */ }
  const exportNote = () => {
    window.dispatchEvent(new CustomEvent('ledger-export-note', { detail: asset.id }))
    const current = exportSnapshot.current
    if (nativeInvoke) { void nativeInvoke('save_markdown', { title: current.title, text: `# ${current.title}\n\n${current.markdown}` }).catch(error => setNotice(String(error))); return }
    const blob = new Blob([`# ${current.title}\n\n${current.markdown}`], { type: 'text/markdown;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a'); link.href = href; link.download = `${asset.title.replace(/[<>:"/\\|?*]/g, '-') || 'note'}.md`; link.click()
    URL.revokeObjectURL(href)
  }
  const exportPdf = async () => {
    window.dispatchEvent(new CustomEvent('ledger-export-note', { detail: asset.id }))
    const current = exportSnapshot.current
    const print = window.assetLedgerDesktop?.exportPdf
    if (!print) { setNotice('请重启更新后的客户端，再导出 PDF'); return }
    try {
      setNotice('正在生成 PDF…')
      const { notePrintHtml } = await import('../pdf')
      const result = await print({ title: current.title, html: notePrintHtml(current.title, current.markdown) })
      setNotice(result.cancelled ? '' : 'PDF 已导出')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'PDF 导出失败') }
  }
  const recordFinding = () => {
    if (!selection || !findingTitle.trim()) return
    const { selected, sensitive } = selection
    const id = addFinding({
      caseId, sourceAssetId: asset.id, title: findingTitle.trim(), type: sensitive ? 'secret' : 'information',
      value: sensitive ? selected.text : undefined, severity: 'medium', confidence: 'medium', status: 'suspected',
      sourceLocation: `${noteHref(asset)}${selected.anchor ? `#${selected.anchor}` : ''}`,
      howFound: findingNote, whySearched: '', payload: '', principle: '', impact: '', limitations: '',
      noteMarkdown: sensitive ? findingNote : [selected.text, findingNote].filter(Boolean).join('\n\n'),
    })
    if (sensitive) selected.replace(`[敏感发现](/cases/${caseId}/findings/${id})`)
    setSelection(null)
    setNotice('已记录发现')
    window.setTimeout(() => setNotice(''), 2500)
  }
  return <div className="asset-page notebook-asset-page"><div className="asset-reader notebook-reader" ref={reader}>
    <article className="notebook-document" data-asset-id={asset.id}>
      <div className="notebook-document-actions"><span>{formatRelative(asset.updatedAt)}编辑</span><ActionMenu label="笔记操作" items={[
        { label: '资产属性', icon: <SlidersHorizontal size={15} />, onSelect: () => setProperties(true) },
        { label: '关联笔记', icon: <Link2 size={15} />, onSelect: () => setLinks(true) },
        { label: '导出 Markdown', icon: <Download size={15} />, onSelect: exportNote },
        { label: '导出 PDF', icon: <FileText size={15} />, onSelect: () => { void exportPdf() } },
        { label: '归档笔记', icon: <Archive size={15} />, onSelect: () => { if (confirm('归档这篇笔记？可以从回收站恢复。')) { softDeleteAsset(asset.id); navigate(`/cases/${caseId}`) } }, danger: true },
      ]} /></div>
      <input className="notebook-title" aria-label="笔记标题" autoFocus={asset.title === '未命名笔记' && !markdown} value={title} placeholder="未命名笔记" onInput={(event) => { const next = event.currentTarget.value; setTitle(next); updateAsset(asset.id, { title: next || '未命名笔记', customTitle: next || undefined }) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); (reader.current?.querySelector('.tiptap') as HTMLElement)?.focus() } }} />
      {asset.value && <div className="notebook-address">{safeUrl ? <a href={asset.value} target="_blank" rel="noreferrer">{displaySourceUrl(asset.value)}<ArrowUpRight size={13} /></a> : <button onClick={() => setProperties(true)}>{asset.value}</button>}</div>}
      <NotebookEditor docId={asset.id} footerTarget={footerTarget} value={markdown} onSave={(noteMarkdown) => updateAsset(asset.id, { noteMarkdown })} onFinding={(selected, sensitive) => { setSelection({ selected, sensitive }); setFindingTitle(sensitive ? '敏感信息' : selected.text.slice(0, 50)); setFindingNote('') }} />
    </article></div>
    <footer className="notebook-statusbar"><div ref={setFooterTarget} className="notebook-status-editor" />
      {(backlinks.length > 0 || noteFindings.length > 0) && <div className="notebook-connections">{backlinks.length > 0 && <details><summary><Link2 size={13} />{backlinks.length} 篇关联笔记</summary><div className="notebook-connection-popover">{backlinks.map((item) => <Link key={item.id} to={noteHref(item)}><FileText size={14} /><span>{item.title}</span><small>{caseNames.get(item.caseId)}</small></Link>)}</div></details>}{noteFindings.length > 0 && <details><summary><Flag size={13} />{noteFindings.length} 项发现</summary><div className="notebook-connection-popover">{noteFindings.map((item) => <Link key={item.id} to={`/cases/${item.caseId}/findings/${item.id}`}><LockKeyhole size={14} /><span>{item.title}</span><ArrowUpRight size={13} /></Link>)}</div></details>}</div>}
    </footer>
    {notice && <div className="notebook-toast" role="status">{notice}</div>}
    <EditAssetModal asset={asset} open={properties} onClose={() => setProperties(false)} />
    <RelationModal asset={asset} open={links} onClose={() => setLinks(false)} />
    <Modal open={Boolean(selection)} title={selection?.sensitive ? '收起为敏感发现' : '记为发现'} onClose={() => setSelection(null)} footer={<><button className="secondary-button" onClick={() => setSelection(null)}>取消</button><button className="primary-button" disabled={!findingTitle.trim()} onClick={recordFinding}><Flag size={14} />记录</button></>}>
      <Field label="名称"><TextInput autoFocus value={findingTitle} onChange={(event) => setFindingTitle(event.target.value)} /></Field>
      {!selection?.sensitive && <blockquote className="notebook-excerpt">{selection?.selected.text}</blockquote>}
      <Field label="备注"><textarea className="text-input" rows={3} value={findingNote} onChange={(event) => setFindingNote(event.target.value)} /></Field>
      <p className="notebook-origin"><Link2 size={13} />{asset.title}{selection?.selected.anchor && ` / ${selection.selected.anchor}`}</p>
    </Modal>
  </div>
}
