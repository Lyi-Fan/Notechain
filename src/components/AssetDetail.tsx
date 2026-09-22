import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Link2, Save } from 'lucide-react'
import { useLedger } from '../store'
import { assetKindMeta, severityLabel } from '../lib'
import { displayUrl } from '../url-display'
import { Field, Modal, TextArea, TextInput } from './ui'
import type { AssetKind, AssetRecord, AssetStatus, Confidence, ReadingState, RelationRecord, Severity } from '../types'

export function useReadingPosition(asset: AssetRecord, contentRef: React.RefObject<HTMLDivElement | null>, caseContextId = asset.caseId) {
  const { state, setReadingState, setLastLocation } = useLedger()
  const location = useLocation()
  const timer = useRef<number | undefined>(undefined)
  const restoredLocation = useRef('')
  const saved = state.reading[asset.id] ?? (state.lastLocation?.assetId === asset.id ? {
    assetId: asset.id,
    anchorId: state.lastLocation.anchorId,
    offsetPx: state.lastLocation.offsetPx,
    progressRatio: state.lastLocation.progressRatio ?? 0,
    contentVersion: state.lastLocation.contentVersion ?? asset.version,
    updatedAt: state.lastLocation.updatedAt,
  } : undefined)
  // Keep offsets keyed by asset. During a route transition React may render
  // the next document before the previous effect cleanup runs; a single
  // mutable offset would then write the next asset's pixels into the old one.
  const offsetsRef = useRef<Record<string, number>>({})
  const snapshotsRef = useRef<Record<string, ReadingState>>({})

  const persist = useCallback((next: ReadingState) => {
    setReadingState(next)
    setLastLocation({ caseId: caseContextId, assetId: asset.id, anchorId: next.anchorId, offsetPx: next.offsetPx, progressRatio: next.progressRatio, contentVersion: next.contentVersion, updatedAt: next.updatedAt })
  }, [asset.id, caseContextId, setLastLocation, setReadingState])

  const save = useCallback((offsetOverride?: number, elementOverride?: HTMLDivElement) => {
    const element = elementOverride ?? contentRef.current
    if (!element) return null
    const max = Math.max(0, element.scrollHeight - element.clientHeight)
    const offsetPx = Math.min(max, Math.max(0, Math.round(offsetOverride ?? element.scrollTop)))
    offsetsRef.current[asset.id] = offsetPx
    const progressRatio = max > 0 ? Math.min(1, Math.max(0, offsetPx / max)) : 0
    const headings = [...element.querySelectorAll<HTMLElement>('.detail-section[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], [data-live-anchor][id]')].filter(node => node.id && node.getClientRects().length)
    const nearest = headings.filter((heading) => heading.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop <= offsetPx + 72).at(-1)
    const next: ReadingState = { assetId: asset.id, anchorId: nearest?.id, offsetPx, progressRatio, contentVersion: asset.version, updatedAt: new Date().toISOString() }
    snapshotsRef.current[asset.id] = next
    return next
  }, [asset, contentRef])

  useEffect(() => {
    const element = contentRef.current
    if (!element) return
    const assetId = asset.id
    const previous = saved
    let restored = false
    let interacted = false
    const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value))
    const restore = () => {
      const key = `${caseContextId}/${assetId}${location.hash}`
      // Autosaving a focused editor changes the asset version, not the page.
      // Do not reposition the document underneath the cursor on each save.
      if (restoredLocation.current === key) {
        offsetsRef.current[assetId] = Math.round(element.scrollTop)
        restored = true
        return
      }
      restoredLocation.current = key
      let hash = ''
      try { hash = decodeURIComponent(location.hash.replace(/^#/, '')) } catch { hash = location.hash.replace(/^#/, '') }
      const findAnchor = (id: string) => [...element.querySelectorAll<HTMLElement>('[id]')].find((node) => node.id === id)
      const headingTop = (node: HTMLElement) => node.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
      if (hash) {
        const target = findAnchor(hash)
        if (target) { element.scrollTop = Math.max(0, headingTop(target) - 24); offsetsRef.current[assetId] = Math.round(element.scrollTop); restored = true; return }
      }
      if (previous) {
        const anchor = previous.anchorId ? findAnchor(previous.anchorId) : null
        const max = Math.max(0, element.scrollHeight - element.clientHeight)
        let desired: number
        if (previous.contentVersion === asset.version) {
          // The stored pixel offset is the most faithful position. ReadingState
          // always carries a numeric offset, so a deliberate top-of-page value
          // must not be replaced by an older heading anchor.
          desired = Number.isFinite(previous.offsetPx) ? previous.offsetPx : (anchor ? headingTop(anchor) - 24 : 0)
        } else {
          const proportional = previous.progressRatio > 0 ? previous.progressRatio * max : previous.offsetPx
          const headings = [...element.querySelectorAll<HTMLElement>('.detail-section[id], h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], [data-live-anchor][id]')].filter(node => node.id && node.getClientRects().length)
          // When content changed, use the closest surviving heading before the
          // old position, then fall back to the proportional/pixel position.
          const prior = headings.filter((heading) => headingTop(heading) <= proportional + 72).at(-1)
          desired = anchor ? headingTop(anchor) - 24 : prior ? headingTop(prior) - 24 : proportional
        }
        element.scrollTop = clamp(desired, max)
      } else element.scrollTop = 0
      offsetsRef.current[assetId] = Math.round(element.scrollTop)
      restored = true
    }
    let innerFrame = 0
    let frame = 0
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (cancelled) return
      frame = window.requestAnimationFrame(() => { innerFrame = window.requestAnimationFrame(() => {
        restore()
        save(offsetsRef.current[assetId], element)
      }) })
    })
    const onScroll = () => {
      interacted = true
      offsetsRef.current[assetId] = Math.round(element.scrollTop)
      save(offsetsRef.current[assetId], element)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = undefined
        const snapshot = snapshotsRef.current[assetId]
        if (snapshot) persist(snapshot)
      }, 500)
    }
    // Cleanup can see the next asset's DOM. Persist the last captured snapshot,
    // including its heading and progress, without measuring that new document.
    const onCommit = () => { window.clearTimeout(timer.current); timer.current = undefined; const snapshot = snapshotsRef.current[assetId]; if ((restored || interacted) && snapshot) persist(snapshot) }
    const onVisibility = () => { if (document.visibilityState === 'hidden') onCommit() }
    element.addEventListener('scroll', onScroll, { passive: true }); window.addEventListener('blur', onCommit); window.addEventListener('ledger-flush-editors', onCommit); window.addEventListener('beforeunload', onCommit); window.addEventListener('pagehide', onCommit); document.addEventListener('visibilitychange', onVisibility)
    return () => { cancelled = true; window.cancelAnimationFrame(frame); window.cancelAnimationFrame(innerFrame); window.clearTimeout(timer.current); onCommit(); element.removeEventListener('scroll', onScroll); window.removeEventListener('blur', onCommit); window.removeEventListener('ledger-flush-editors', onCommit); window.removeEventListener('beforeunload', onCommit); window.removeEventListener('pagehide', onCommit); document.removeEventListener('visibilitychange', onVisibility) }
  }, [asset.id, asset.version, contentRef, location.hash, save, persist])

  return { saved }
}

const relationTypeLabels: Record<RelationRecord['type'], string> = {
  references: '引用 / 指向',
  derived_from: '派生自',
  hosted_on: '托管于',
  runs: '运行于',
  depends_on: '依赖',
  duplicate_of: '重复于',
}

export function RelationModal({ asset, open, onClose }: { asset: AssetRecord; open: boolean; onClose: () => void }) {
  const { assets, addRelation } = useLedger()
  const [type, setType] = useState<RelationRecord['type']>('references')
  const [targetId, setTargetId] = useState('')
  const [note, setNote] = useState('')
  const candidates = useMemo(() => assets.filter((item) => item.id !== asset.id), [assets, asset.id])
  useEffect(() => {
    if (!open) return
    setType('references')
    setTargetId(candidates[0]?.id ?? '')
    setNote('')
  }, [open, asset.id])
  const save = () => {
    if (!targetId) return
    addRelation({ sourceType: 'asset', sourceId: asset.id, type, targetType: 'asset', targetId, note: note.trim() || undefined })
    onClose()
  }
  return <Modal open={open} onClose={onClose} eyebrow="NEW RELATION" title="建立资产关联" footer={<><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={save} disabled={!targetId}><Link2 size={15} />保存关系</button></>}>
    <Field label="关系类型"><select className="text-input" value={type} onChange={(event) => setType(event.target.value as RelationRecord['type'])}>{Object.entries(relationTypeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
    <Field label="跳转目标" hint="可选择同案件或其他案件的资产"><select className="text-input" value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">选择一项资产</option>{candidates.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.value}</option>)}</select></Field>
    <Field label="关系说明"><TextArea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录为什么建立这条关系，或补充验证上下文。" /></Field>
  </Modal>
}

export function EditAssetModal({ asset, open, onClose }: { asset: AssetRecord; open: boolean; onClose: () => void }) {
  const { updateAsset, targets } = useLedger()
  const [draft, setDraft] = useState(asset)
  useEffect(() => setDraft(asset), [asset, open])
  const save = () => {
    updateAsset(asset.id, { value: draft.value, kind: draft.kind, targetId: draft.targetId, status: draft.status, severity: draft.severity, confidence: draft.confidence })
    onClose()
  }
  return <Modal open={open} onClose={onClose} eyebrow="ASSET" title="资产属性" footer={<><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={save}><Save size={15} />保存更改</button></>}>
    <Field label="地址"><TextInput value={displayUrl(draft.value)} onChange={(event) => setDraft({ ...draft, value: event.target.value })} placeholder="URL、域名或服务地址" /></Field>
    <div className="form-grid"><Field label="归属目标"><select className="text-input" value={draft.targetId ?? ''} onChange={(event) => setDraft({ ...draft, targetId: event.target.value || undefined })}><option value="">未归类</option>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></Field><Field label="类型"><select className="text-input" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as AssetKind })}>{Object.entries(assetKindMeta).map(([kind, meta]) => <option key={kind} value={kind}>{meta.label}</option>)}</select></Field></div>
    <div className="form-grid three"><Field label="状态"><select className="text-input" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as AssetStatus })}><option value="unknown">待验证</option><option value="confirmed">已确认</option><option value="monitoring">持续观察</option><option value="unavailable">不可用</option><option value="closed">已关闭</option></select></Field><Field label="严重性"><select className="text-input" value={draft.severity} onChange={(event) => setDraft({ ...draft, severity: event.target.value as Severity })}>{Object.entries(severityLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Field label="置信度"><select className="text-input" value={draft.confidence} onChange={(event) => setDraft({ ...draft, confidence: event.target.value as Confidence })}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></Field></div>
  </Modal>
}
