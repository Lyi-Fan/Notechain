import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Maximize2, X } from 'lucide-react'
import type { AssetRecord, CaseRecord, FindingRecord, TaskRecord } from '../types'
import { assetMarkdown, assetIdFromNoteHref, caseMarkdown, findingMarkdown, noteHref } from '../notes'
import { MarkdownView } from './MarkdownView'
import { readLinkFields } from '../notebook-links'
import { positionPreviewReader } from '../preview-position'
import { displaySourceUrl } from '../url-display'
import { useNoteReady } from '../store'
import { parseNotebookHref, type FileLocation } from '../file-notebooks'
import { FileLinkPreview } from './FileLinkPreview'
import { explanationHref, type Explanation } from '../explanations'

interface Box { left: number; top: number; width: number; height: number }
export type PreviewItem =
  | { kind: 'asset'; key: string; href: string; title: string; subtitle: string; record: AssetRecord }
  | { kind: 'case'; key: string; href: string; title: string; subtitle: string; record: CaseRecord }
  | { kind: 'finding'; key: string; href: string; title: string; subtitle: string; record: FindingRecord }
  | { kind: 'file'; key: string; href: string; title: string; subtitle: string; location: FileLocation }
  | { kind: 'explanation'; key: string; href: string; title: string; subtitle: string; explanation: Explanation }
interface Preview { id: string; href: string; excerpt?: string; webTitle?: string; anchor: HTMLAnchorElement; box: Box; mode: 'compact' | 'expanded' | 'closing' }
interface Props { root: RefObject<HTMLElement>; assets: AssetRecord[]; cases: CaseRecord[]; findings: FindingRecord[]; tasks: TaskRecord[]; onOpen: (href: string) => void; renderEditor: (item: PreviewItem) => ReactNode; explanations?: Explanation[]; resolveFileLink?: (href: string) => FileLocation | null }
export interface AssetLinkPreviewHandle { dismiss: () => void; openExplanation: (id: string) => void }
const DURATION = 220

function compactBox(anchor: HTMLElement): Box {
  const rect = anchor.getBoundingClientRect(), width = Math.min(330, innerWidth - 24), height = Math.min(216, innerHeight - 24)
  return { left: Math.max(12, Math.min(innerWidth - width - 12, rect.left)), top: Math.max(12, Math.min(innerHeight - height - 12, rect.bottom + height + 20 <= innerHeight ? rect.bottom + 8 : rect.top - height - 8)), width, height }
}

function findPreviewItem(href: string, assets: AssetRecord[], cases: CaseRecord[], findings: FindingRecord[], caseNames: Map<string, string>, byKey = false): PreviewItem | undefined {
  const path = href.split('#')[0]
  const linkedAssetId = byKey ? undefined : assetIdFromNoteHref(path)
  const asset = assets.find(record => byKey ? path === `asset:${record.id}` : record.id === linkedAssetId || path === noteHref(record) || href === record.title || path === `asset://${record.id}`)
  if (asset) return { kind: 'asset', key: `asset:${asset.id}`, href: noteHref(asset), title: asset.title, subtitle: caseNames.get(asset.caseId) ?? '', record: asset }
  const caseRecord = cases.find(record => byKey ? path === `case:${record.id}` : path === `/cases/${record.id}` || href === record.name || path === `case://${record.id}`)
  if (caseRecord) return { kind: 'case', key: `case:${caseRecord.id}`, href: `/cases/${caseRecord.id}`, title: caseRecord.name, subtitle: caseRecord.code, record: caseRecord }
  const finding = findings.find(record => !record.deletedAt && (byKey ? path === `finding:${record.id}` : path === `/cases/${record.caseId}/findings/${record.id}` || href === record.title))
  if (finding) return { kind: 'finding', key: `finding:${finding.id}`, href: `/cases/${finding.caseId}/findings/${finding.id}`, title: finding.title, subtitle: caseNames.get(finding.caseId) ?? '', record: finding }
}

export const AssetLinkPreview = forwardRef<AssetLinkPreviewHandle, Props>(function AssetLinkPreview({ root, assets, cases, findings, tasks, onOpen, renderEditor, explanations = [], resolveFileLink }, ref) {
  const caseNames = useMemo(() => new Map(cases.map((record) => [record.id, record.name])), [cases])
  const [view, setView] = useState<Preview | null>(null)
  const previewKind = view?.id.split(':')[0]
  const previewReady = useNoteReady(previewKind === 'asset' ? 'assets' : previewKind === 'finding' ? 'findings' : 'cases', ['asset','case','finding'].includes(previewKind ?? '') ? view?.id.slice((previewKind?.length ?? 0) + 1) ?? '' : '')
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight })
  const current = useRef<Preview | null>(null), panel = useRef<HTMLElement>(null), reader = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(), closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const find = (href: string, byKey = false): PreviewItem | undefined => {
    const explanation = explanations.find(item => href === (byKey ? 'explanation:' + item.id : explanationHref(item.id)))
    if (explanation) return { kind: 'explanation', key: 'explanation:' + explanation.id, href: explanationHref(explanation.id), title: explanation.title, subtitle: '扩展解释', explanation }
    const fileHref = byKey && href.startsWith('file:') ? href.slice(5) : href
    const file = parseNotebookHref(fileHref) ?? resolveFileLink?.(fileHref)
    if (file) return { kind: 'file', key: 'file:' + file.href, href: file.href, title: file.path.split('/').at(-1) ?? '', subtitle: '来源笔记', location: file }
    return findPreviewItem(href, assets, cases, findings, caseNames, byKey)
  }
  const data = useRef({ find, onOpen }); data.current = { find, onOpen }
  const update = (next: Preview | null) => { current.current = next; setView(next) }
  const dismiss = () => { clearTimeout(hideTimer.current); hideTimer.current = undefined; if (current.current?.mode === 'compact') update(null) }
  const openExplanation = (id: string) => {
    const anchor = [...(root.current?.querySelectorAll<HTMLAnchorElement>('a[data-notebook-link]') ?? [])].find(link => readLinkFields(link.getAttribute('data-notebook-link'))?.explanation?.id === id)
    if (anchor) update({ id: 'explanation:' + id, href: explanationHref(id), anchor, box: compactBox(anchor), mode: 'expanded' })
  }
  useImperativeHandle(ref, () => ({ dismiss, openExplanation }), [])
  const close = () => {
    const next = current.current
    if (!next || next.mode === 'closing') return
    clearTimeout(hideTimer.current)
    if (next.mode === 'compact') { update(null); return }
    const focused = document.activeElement
    if (focused instanceof HTMLElement && panel.current?.contains(focused)) focused.blur()
    update({ ...next, mode: 'closing' })
    closeTimer.current = setTimeout(() => update(null), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : DURATION)
  }
  const expand = () => { const next = current.current; if (next?.mode === 'compact') { clearTimeout(hideTimer.current); update({ ...next, mode: 'expanded' }) } }

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (current.current && current.current.mode !== 'compact') return
      if (document.querySelector('.notebook-prose.is-transferring')) { dismiss(); return }
      if (panel.current?.contains(event.target as Node)) { clearTimeout(hideTimer.current); return }
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.notebook-prose a, .notebook-connections a') : null
      const scope = root.current?.closest('article') ?? root.current
      if (link && scope?.contains(link)) {
        const href = link.getAttribute('data-notebook-target') ?? link.getAttribute('href') ?? ''
        const fields = readLinkFields(link.getAttribute('data-notebook-link') ?? link.getAttribute('title'))
        const item = data.current.find(href)
        if (item) { clearTimeout(hideTimer.current); hideTimer.current = undefined; if (current.current?.anchor !== link || current.current.id !== item.key || current.current.href !== href) update({ id: item.key, href, excerpt: fields?.excerpt, anchor: link, box: compactBox(link), mode: 'compact' }); return }
        if (fields?.sourceTitle && /^https?:\/\//i.test(href)) {
          clearTimeout(hideTimer.current); hideTimer.current = undefined
          if (current.current?.anchor !== link || current.current.href !== href) update({ id: `web:${href}`, href, excerpt: fields.excerpt, webTitle: fields.sourceTitle, anchor: link, box: compactBox(link), mode: 'compact' })
          return
        }
      }
      if (current.current && !hideTimer.current) hideTimer.current = setTimeout(() => { hideTimer.current = undefined; dismiss() }, 180)
    }
    const pointerMove = (event: PointerEvent) => { if (panel.current?.contains(event.target as Node) || current.current?.anchor.contains(event.target as Node)) { clearTimeout(hideTimer.current); hideTimer.current = undefined }; move(event) }
    const key = (event: KeyboardEvent) => {
      const next = current.current
      if (!next) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
      if ((event.code !== 'Space' && event.key !== ' ') || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
      if (next.mode !== 'compact') {
        const focused = document.activeElement
        if (focused instanceof HTMLElement && (focused.isContentEditable || focused.matches('input, textarea, select') || focused.closest('.cm-editor'))) return
        event.preventDefault(); event.stopPropagation(); if (!event.repeat && next.mode === 'expanded') close(); return
      }
      if (document.activeElement?.matches('input, textarea, select') || document.activeElement?.closest('.cm-editor') || (!next.anchor.matches(':hover') && !panel.current?.matches(':hover'))) return
      event.preventDefault(); event.stopPropagation(); if (!event.repeat) expand()
    }
    const resize = () => { setViewport({ width: innerWidth, height: innerHeight }); const next = current.current; if (next) update({ ...next, box: compactBox(next.anchor) }) }
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) dismiss() }
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) dismiss() }
    const clickExplanation = (event: PointerEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-notebook-link]') : null
      const explanation = readLinkFields(link?.getAttribute('data-notebook-link'))?.explanation
      if (event.button === 0 && explanation && link && root.current?.contains(link)) { event.preventDefault(); event.stopPropagation(); openExplanation(explanation.id) }
    }
    document.addEventListener('pointerdown', clickExplanation, true)
    document.addEventListener('pointermove', pointerMove); document.addEventListener('pointerout', leave); document.addEventListener('keydown', key, true); document.addEventListener('scroll', scroll, true); document.addEventListener('notebook-transfer-start', dismiss); window.addEventListener('resize', resize); window.addEventListener('blur', dismiss)
    return () => { clearTimeout(hideTimer.current); clearTimeout(closeTimer.current); document.removeEventListener('pointerdown', clickExplanation, true); document.removeEventListener('pointermove', pointerMove); document.removeEventListener('pointerout', leave); document.removeEventListener('keydown', key, true); document.removeEventListener('scroll', scroll, true); document.removeEventListener('notebook-transfer-start', dismiss); window.removeEventListener('resize', resize); window.removeEventListener('blur', dismiss) }
  }, [root])

  const modal = view?.mode === 'expanded' || view?.mode === 'closing'
  useEffect(() => { if (current.current && !current.current.webTitle && !data.current.find(current.current.id, true)) update(null) }, [assets, cases, findings, caseNames, explanations, resolveFileLink])
  useEffect(() => {
    if (!modal) return
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; reader.current?.focus({ preventScroll: true })
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [modal])

  useEffect(() => {
    if (!view || view.mode === 'closing') return
    const readerElement = reader.current
    if (!readerElement) return
    let cancelled = false
    let settled = false
    let frame = 0, transitionTimer = 0, cutoffTimer = 0
    let observer: MutationObserver | undefined
    const stop = () => {
      cancelled = true
      cancelAnimationFrame(frame)
      clearTimeout(transitionTimer)
      clearTimeout(cutoffTimer)
      observer?.disconnect()
      readerElement.removeEventListener('wheel', stop)
      readerElement.removeEventListener('touchstart', stop)
      readerElement.removeEventListener('pointerdown', stop)
      readerElement.removeEventListener('input', stop)
    }
    const settle = () => {
      if (cancelled || settled) return
      positionPreviewReader(readerElement, view.href, view.excerpt)
    }
    const finish = () => {
      if (cancelled || settled) return
      settle()
      settled = true
      observer?.disconnect()
      clearTimeout(cutoffTimer)
    }
    observer = new MutationObserver(() => settle())
    observer.observe(readerElement, { childList: true, subtree: true })
    readerElement.addEventListener('wheel', stop, { passive: true })
    readerElement.addEventListener('touchstart', stop, { passive: true })
    readerElement.addEventListener('pointerdown', stop)
    readerElement.addEventListener('input', stop)
    // A first frame handles static Markdown. The final pass runs after the
    // panel's width/height transition and fonts have had a chance to reflow.
    frame = requestAnimationFrame(settle)
    transitionTimer = window.setTimeout(() => {
      if (cancelled) return
      document.fonts?.ready.then(() => {
        finish()
      })
    }, DURATION + 40)
    cutoffTimer = window.setTimeout(finish, 1000)
    return stop
  }, [view?.excerpt, view?.href, view?.mode])

  const item = useMemo(() => (view && !view.webTitle ? find(view.id, true) : undefined) ?? (view?.webTitle ? { kind: 'web' as const, title: view.webTitle, subtitle: new URL(view.href).hostname } : undefined), [assets, cases, findings, caseNames, view?.id, view?.webTitle, view?.href, explanations, resolveFileLink])
  const content = useMemo(() => {
    if (!item || item.kind === 'web') return ''
    if (item.kind === 'explanation') return item.explanation.content
    if (item.kind === 'file') return ''
    if (item.kind === 'asset') return assetMarkdown(item.record)
    if (item.kind === 'case') return caseMarkdown(item.record, assets.filter((asset) => item.record.assetIds.includes(asset.id)), tasks.filter((task) => item.record.taskIds.includes(task.id)))
    return findingMarkdown(item.record)
  }, [assets, item, tasks])
  if (!view || !item) return null
  const width = Math.min(800, viewport.width - 24), height = Math.min(680, viewport.height - 40)
  const box = view.mode === 'expanded' ? { left: (viewport.width - width) / 2, top: (viewport.height - height) / 2, width, height } : view.box
  const navigate = (href: string) => {
    if (href.startsWith('#')) positionPreviewReader(reader.current!, href)
    else { update(null); data.current.onOpen(href) }
  }
  return createPortal(<div className={`notebook-preview-layer${modal ? ' is-modal' : ''}`} onPointerDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); close() } }}>
    <section ref={panel} className="notebook-link-preview" data-mode={view.mode} data-kind={item.kind} role={modal ? 'dialog' : 'region'} aria-label={item.kind === 'explanation' ? '扩展解释' : '来源预览'} aria-modal={modal || undefined} style={box} onPointerDown={(event) => { const target = event.target as HTMLElement; if (modal && !target.closest('[contenteditable="true"], input, textarea, select, button, a, .cm-editor, .notebook-bubble, .notebook-picker')) reader.current?.focus({ preventScroll: true }) }} onKeyDown={(event) => {
      if (!modal || event.key !== 'Tab' || event.defaultPrevented) return
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex="0"], [contenteditable="true"]') ?? [])].filter((element) => element.getClientRects().length && !element.matches(':disabled'))
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
      <header className="notebook-preview-head"><div><small>{item.subtitle}</small><strong>{item.title}</strong></div>{item.kind !== 'explanation' && <button type="button" className="icon-button" aria-label="打开关联笔记" title="打开关联笔记" onClick={() => navigate(view.href)}><ArrowUpRight size={17} /></button>}<button type="button" className="icon-button" aria-label={modal ? '关闭预览' : '展开预览'} title={modal ? '关闭预览' : '展开预览'} onClick={modal ? close : expand}>{modal ? <X size={17} /> : <Maximize2 size={16} />}</button></header>
      <div ref={reader} className="notebook-preview-reader" tabIndex={modal ? 0 : -1}>{item.kind === 'file' ? <FileLinkPreview key={item.key} location={item.location} expanded={!!modal} onOpen={navigate} /> : item.kind === 'web' ? <div className="markdown-body"><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{view.excerpt || displaySourceUrl(view.href)}</p></div> : !previewReady ? <p role="status">正在读取笔记…</p> : modal ? renderEditor(item) : <MarkdownView content={content || '暂无解释'} onInternalLink={navigate} />}</div>
    </section>
  </div>, document.body)
})
