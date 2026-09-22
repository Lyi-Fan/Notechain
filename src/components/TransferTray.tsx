import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { getMarkRange, type Editor } from '@tiptap/react'
import { FileText, Plus, Trash2, Undo2 } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useLedger } from '../store'
import { linkAttributes, readLinkFields, resolveNotebookTarget } from '../notebook-links'
import { safeNoteLink } from '../notes'
import './transfer-tray.css'
import { BrowserCaptureBridge } from './BrowserCaptureBridge'
import { flushNative, ledgerStorage, nativeInvoke } from '../native-storage'
import { flushNoteFiles, transferHref } from '../file-notebooks'
import { readTransferReferences, TRANSFER_MIME, TRANSFER_STORAGE, type TextCapture, type TransferClip } from '../transfer-reference'

interface Origin { title: string; href: string }
type Clip = TransferClip
interface Binding { editor: Editor; origin: () => Origin; commit: () => Promise<boolean> }
interface Drag { clip: Clip; x: number; y: number; width: number; height: number; compact: boolean; over: boolean }
interface TrayContext { register: (binding: Binding) => () => void }
const Context = createContext<TrayContext | null>(null)
const STORAGE = TRANSFER_STORAGE
const CARD_HEIGHT = 110
const CARD_STEP = 120
const STACK_STEP = 8
const readClips = (): Clip[] => {
  try {
    const value: unknown = JSON.parse(ledgerStorage.getItem(STORAGE) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is Clip => !!item && typeof item.id === 'string' && typeof item.text === 'string' && typeof item.title === 'string' && typeof item.href === 'string' && safeNoteLink(item.href)).map((item) => ({ ...item, fields: item.fields ? readLinkFields(linkAttributes('', item.fields).title) ?? undefined : undefined })) : []
  } catch { return [] }
}

function selectedClip(binding: Binding, resolve: (href: string) => ReturnType<typeof resolveNotebookTarget>): Clip | null {
  const { editor } = binding, { from, to, empty } = editor.state.selection
  if (empty) return null
  const text = editor.state.doc.textBetween(from, to, '\n')
  if (!text.trim()) return null
  const origin = binding.origin()
  const mark = editor.state.doc.nodeAt(from)?.marks.find(mark => mark.type === editor.schema.marks.link)
  const range = mark && getMarkRange(editor.state.doc.resolve(from), mark.type, mark.attrs)
  const fields = readLinkFields(mark?.attrs.title)
  if (mark && range && to <= range.to && !fields?.explanation) {
    const destination = resolve(transferHref(mark.attrs.href, origin.href))
    const label = editor.state.doc.textBetween(range.from, range.to)
    return { id: crypto.randomUUID(), createdAt: new Date().toISOString(), href: destination.href,
      title: fields?.sourceTitle || (destination.getContent ? destination.label : label), text: fields?.excerpt || label,
      fields: fields ?? { annotation: label === destination.label ? '' : label } }
  }
  let anchor = ''
  editor.state.doc.nodesBetween(0, from, node => { if (node.type.name === 'heading' && node.attrs.id) anchor = node.attrs.id })
  return { ...origin, href: origin.href.split('#')[0] + (anchor ? `#${encodeURIComponent(anchor)}` : ''), text, id: crypto.randomUUID(), createdAt: new Date().toISOString() }
}

export function TransferTrayProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const ledger = useLedger()
  const { assets, cases, findings, tasks } = ledger
  const insertRef = useRef<(clip: Clip, binding?: Binding) => Promise<void>>()
  const resolve = useRef((href: string) => resolveNotebookTarget(href, assets, cases, findings, tasks))
  resolve.current = (href) => resolveNotebookTarget(href, assets, cases, findings, tasks)
  const [clips, setClips] = useState<Clip[]>(readClips)
  const currentClips = useRef(clips)
  const [hovered, setHovered] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [ready, setReady] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [leaving, setLeaving] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [deletedClips, setDeletedClips] = useState<Clip[]>([])
  const drawer = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const dropArrival = useRef(false)
  const target = useRef<Binding | null>(null)
  const cancelDrag = useRef<(() => void) | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>()
  const removalTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const consumed = useRef(new Set<string>())
  const dragging = useRef(false)
  const visible = pathname.startsWith('/cases/') || pathname.startsWith('/notebooks/')
  const open = hovered || !!drag
  const expanded = browsing && !drag && clips.length > 1
  const stackHeight = CARD_HEIGHT + Math.min(Math.max(clips.length - 1, 0), 2) * STACK_STEP
  const showDelete = clips.length > 0 && !drag
  const drawerHeight = expanded ? 420 : clips.length ? stackHeight + 23 + (showDelete ? 38 : 0) : 132
  const updateClips = useCallback((transform: (current: Clip[]) => Clip[]) => {
    const next = transform(currentClips.current)
    try { ledgerStorage.setItem(STORAGE, JSON.stringify(next)) } catch (error) { window.dispatchEvent(new Event('ledger-storage-error')); throw error }
    currentClips.current = next
    setClips(next)
  }, [])
  const report = (message: string, deleted: Clip[] = []) => {
    setNotice(message)
    setDeletedClips(deleted)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => { setNotice(''); setDeletedClips([]) }, deleted.length ? 6000 : 2200)
  }
  const deleteClips = () => {
    const deleted = clips.filter((clip) => !consumed.current.has(clip.id))
    if (!deleted.length) return
    updateClips((current) => current.filter((clip) => consumed.current.has(clip.id)))
    report('已删除暂存', deleted)
  }
  const undoDelete = () => {
    updateClips((current) => [...deletedClips.filter((clip) => !consumed.current.has(clip.id) && !current.some((item) => item.id === clip.id)), ...current])
    report('已恢复暂存')
  }

  const register = useCallback((binding: Binding) => {
    const { editor } = binding
    const root = editor.view.dom
    const stage = () => {
      const clip = selectedClip(binding, resolve.current)
      if (!clip) { report('请先选中要收集的文字或关联块'); return }
      updateClips(items => [clip, ...items]); setHovered(true); setBrowsing(true); report('已加入中转站')
    }
    root.addEventListener('notechain-stage-selection', stage)
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame = 0
    let replaying = false
    let press: { clip: Clip; x: number; y: number; rect: DOMRect; pos: number; pointerId: number; active: boolean; link?: HTMLAnchorElement } | null = null
    const updateTarget = () => {
      if (!editor.isFocused) return
      const selection = editor.state.selection
      if (selection.empty && selection.$from.parent.inlineContent && !selection.$from.parent.type.spec.code) {
        target.current = binding; setReady(true)
      } else if (target.current?.editor === editor) { target.current = null; setReady(false) }
    }
    const insideDrawer = (x: number, y: number) => {
      const box = drawer.current?.getBoundingClientRect()
      return !!box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
    }
    const reset = () => {
      clearTimeout(timer); cancelAnimationFrame(frame)
      if (press) {
        if (press.active) { dragging.current = false; setDrag(null) }
        if (root.hasPointerCapture(press.pointerId)) root.releasePointerCapture(press.pointerId)
      }
      root.classList.remove('is-transferring')
      press = null
      if (cancelDrag.current === reset) cancelDrag.current = null
    }
    const start = (x: number, y: number) => {
      if (!press || press.active) return
      clearTimeout(timer)
      press.active = true
      dragging.current = true
      dropArrival.current = false
      setHovered(false)
      setBrowsing(false)
      root.classList.add('is-transferring')
      document.dispatchEvent(new Event('notebook-transfer-start'))
      setDrag({ clip: press.clip, x, y, width: Math.min(520, Math.max(180, press.rect.width + 24)), height: Math.min(150, Math.max(58, press.rect.height + 16)), compact: false, over: false })
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setDrag((current) => current ? { ...current, compact: true } : null)) })
    }
    const down = (event: PointerEvent) => {
      if (replaying || event.button !== 0 || !event.isPrimary || event.defaultPrevented || press || editor.isDestroyed || editor.view.composing) return
      const element = event.target instanceof Element ? event.target : null
      if (!element || !root.contains(element) || element.closest('input, textarea, button, [contenteditable="false"]')) return
      const selection = editor.state.selection
      const domSelection = window.getSelection()
      const range = !selection.empty && domSelection?.rangeCount ? domSelection.getRangeAt(0) : null
      const onSelection = range && root.contains(range.commonAncestorContainer) && [...range.getClientRects()].some((rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)
      const link = !onSelection ? element.closest<HTMLAnchorElement>('a[data-notebook-target], a[href]') ?? undefined : undefined
      let clip: Clip, rect: DOMRect
      if (link) {
        const raw = link.getAttribute('data-notebook-target') ?? link.getAttribute('href') ?? ''
        if (readLinkFields(link.getAttribute('data-notebook-link'))?.explanation) return
        const destination = resolve.current(transferHref(raw, binding.origin().href))
        if (!destination.href || !safeNoteLink(destination.href)) return
        const fields = readLinkFields(link.getAttribute('data-notebook-link')) ?? { annotation: link.textContent === destination.label ? '' : link.textContent ?? '' }
        clip = { title: fields.sourceTitle || destination.label, href: destination.href, fields, text: fields.excerpt || fields.annotation || destination.label, id: crypto.randomUUID(), createdAt: new Date().toISOString() }
        rect = link.getBoundingClientRect()
      } else {
        if (!onSelection || !range) return
        const selected = selectedClip(binding, resolve.current)
        if (!selected) return
        clip = selected
        rect = range.getBoundingClientRect()
      }
      const pos = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? selection.from
      event.preventDefault(); event.stopImmediatePropagation()
      press = { clip, x: event.clientX, y: event.clientY, rect, pos, pointerId: event.pointerId, active: false, link }
      cancelDrag.current = reset
      root.setPointerCapture(event.pointerId)
      timer = setTimeout(() => start(event.clientX, event.clientY), 190)
    }
    const move = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.pointerId) return
      if (!press.active && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 6) start(event.clientX, event.clientY)
      if (press.active) {
        event.preventDefault()
        setDrag((current) => current ? { ...current, x: event.clientX, y: event.clientY, over: insideDrawer(event.clientX, event.clientY) } : null)
      }
    }
    const up = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.pointerId) return
      const selected = press
      const dropped = selected.active && insideDrawer(event.clientX, event.clientY)
      event.preventDefault(); event.stopImmediatePropagation()
      if (dropped) dropArrival.current = true
      reset()
      if (dropped) {
        updateClips((current) => [selected.clip, ...current])
        setHovered(true)
      } else if (!selected.active) {
        if (selected.link?.isConnected) {
          // Defer the existing click-to-edit handler until release. A held
          // pointer can then become a drag without opening its inline input.
          replaying = true
          try { selected.link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY })) }
          finally { replaying = false }
        } else editor.commands.setTextSelection(selected.pos)
      }
    }
    const cancel = () => reset()
    const nativeDrag = (event: DragEvent) => { if (press) event.preventDefault() }
    const referenceDrop = (event: DragEvent) => {
      if (!event.dataTransfer) return
      const references = readTransferReferences(event.dataTransfer)
      if (!references.length) return
      event.preventDefault(); event.stopImmediatePropagation()
      if (references.some(reference => reference.libraryId !== ledgerStorage.getItem('asset-ledger-library-id'))) { report('此中转块属于另一个笔记库'); return }
      const clips = [...new Set(references.map(reference => reference.clipId))].map(id => currentClips.current.find(item => item.id === id))
      if (!clips.every((clip): clip is Clip => !!clip)) { report('此中转块已移除或已插入'); return }
      const position = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
      if (position) editor.commands.setTextSelection(position.pos)
      void (async () => { for (const clip of clips) await insertRef.current?.(clip, binding) })().catch(() => {})
    }
    const referenceOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes(TRANSFER_MIME) || event.dataTransfer?.types.includes('text/uri-list')) event.preventDefault()
    }
    editor.on('focus', updateTarget)
    editor.on('selectionUpdate', updateTarget)
    editor.on('transaction', updateTarget)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointerup', up, true)
    root.addEventListener('dragstart', nativeDrag)
    root.addEventListener('drop', referenceDrop, true)
    root.addEventListener('dragover', referenceOver)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    return () => {
      reset()
      root.removeEventListener('notechain-stage-selection', stage)
      if (target.current?.editor === editor) { target.current = null; setReady(false) }
      editor.off('focus', updateTarget); editor.off('selectionUpdate', updateTarget); editor.off('transaction', updateTarget)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerup', up, true)
      root.removeEventListener('dragstart', nativeDrag)
      root.removeEventListener('drop', referenceDrop, true)
      root.removeEventListener('dragover', referenceOver)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
    }
  }, [updateClips])

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (drawer.current?.contains(event.target as Node) || dragging.current) return
      setHovered(false)
      setBrowsing(false)
      dropArrival.current = false
      const element = event.target instanceof Element ? event.target : null
      if (!target.current?.editor.view.dom.contains(event.target as Node) || element?.closest('input, textarea, select, button, [contenteditable="false"]')) { target.current = null; setReady(false) }
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !cancelDrag.current) return
      event.preventDefault(); event.stopImmediatePropagation(); cancelDrag.current()
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', key, true)
      clearTimeout(hideTimer.current); clearTimeout(noticeTimer.current)
      for (const timer of removalTimers.current) clearTimeout(timer)
    }
  }, [])
  useEffect(() => { setHovered(false); setBrowsing(false); dropArrival.current = false; target.current = null; setReady(false); cancelDrag.current?.() }, [pathname])
  useEffect(() => { if (!expanded && list.current) list.current.scrollTop = 0 }, [expanded])

  const insert = async (clip: Clip, destination?: Binding) => {
    const fail = (message: string): never => { report(message); throw Object.assign(new Error(message), { status: 409 }) }
    const binding = destination ?? target.current
    if (!currentClips.current.some(item => item.id === clip.id)) return fail('此中转块已移除或已插入')
    if (consumed.current.has(clip.id)) fail('此条目正在插入')
    if (!binding || binding.editor.isDestroyed || !binding.editor.isEditable || binding.editor.view.composing || !binding.editor.state.selection.empty || !binding.editor.state.selection.$from.parent.inlineContent || binding.editor.state.selection.$from.parent.type.spec.code) return fail('请先在笔记正文点击插入位置')
    const { editor, commit } = binding
    const source = resolveNotebookTarget(clip.href, assets, cases, findings, tasks)
    const fields = { ...(clip.fields ?? { annotation: '', excerpt: clip.text }), transferId: clip.id }
    const from = editor.state.selection.from
    const { $from } = editor.state.selection
    const touchesLink = (node: typeof $from.nodeBefore) => node?.marks.some((mark) => mark.type === editor.schema.marks.link)
    const leadingGap = touchesLink($from.nodeBefore)
    const trailingGap = touchesLink($from.nodeAfter)
    let inserted = false
    editor.state.doc.descendants(node => {
      if (node.marks.some(mark => mark.type === editor.schema.marks.link && readLinkFields(mark.attrs.title)?.transferId === clip.id)) inserted = true
    })
    consumed.current.add(clip.id)
    let saved: Promise<boolean> | undefined
    // Persist the destination before consuming the source clip.
    flushSync(() => {
      // Unmarked separators keep adjacent clips from the same source distinct.
      if (!inserted) inserted = editor.chain().focus().insertContent([
        ...(leadingGap ? [{ type: 'text', text: ' ', marks: [] }] : []),
        { type: 'text', text: fields.annotation || (source.getContent ? source.label : fields.sourceTitle || clip.title.trim()) || source.label || clip.href, marks: [{ type: 'link', attrs: linkAttributes(source.href, fields) }] },
        ...(trailingGap ? [{ type: 'text', text: ' ', marks: [] }] : []),
      ]).run()
      if (inserted) saved = commit()
    })
    if (!inserted) { consumed.current.delete(clip.id); return fail('当前位置无法插入') }
    try { if (!await saved) throw new Error('Destination was not saved'); await flushNoteFiles(); await flushNative() } catch { consumed.current.delete(clip.id); return fail('保存失败，暂存已保留') }
    setLeaving((current) => [...current, clip.id])
    requestAnimationFrame(() => {
      if (editor.isDestroyed || matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const node = editor.view.domAtPos(Math.min(from + (leadingGap ? 2 : 1), editor.state.doc.content.size)).node
      const link = (node instanceof Element ? node : node.parentElement)?.closest('a')
      link?.animate([{ transform: 'scale(.88)' }, { transform: 'scale(1.045)', offset: .65 }, { transform: 'scale(1)' }], { duration: 300, easing: 'ease-out' })
    })
    await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      updateClips((current) => current.filter((item) => item.id !== clip.id))
      setLeaving((current) => current.filter((id) => id !== clip.id))
      consumed.current.delete(clip.id)
      removalTimers.current.delete(timer)
      resolve()
    }, 180)
    removalTimers.current.add(timer)
    })
    await flushNative()
  }
  insertRef.current = insert
  const context = useMemo(() => ({ register }), [register])
  return <Context.Provider value={context}><BrowserCaptureBridge tray={{
    notch: async (method, payload) => {
      const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 409 }) }
      if (method === 'snapshot') {
        await flushNative()
        const offset = Math.max(0, Math.floor(Number(payload.offset) || 0))
        return { libraryId: ledgerStorage.getItem('asset-ledger-library-id'), activeIds: currentClips.current.map(clip => clip.id), items: currentClips.current.slice(offset, offset + 30).map(clip => ({ id: clip.id, title: clip.title, href: clip.href, text: clip.text.slice(0, 160) })), total: currentClips.current.length, offset }
      }
      if (method === 'capture') {
        if (currentClips.current.length >= 1000) fail('中转站已满，请先整理')
        let clip: Clip | undefined
        const requestedId = `notch_${String(payload.id)}`
        if (ledger.state.assets.some(item => item.id === requestedId) && !currentClips.current.some(item => item.id === requestedId)) fail('该摘录已收集并移出中转站，请在收集箱查看来源资产')
        flushSync(() => {
          clip = ledger.captureText(payload as unknown as TextCapture)
          if (!currentClips.current.some(item => item.id === clip!.id)) updateClips(items => [clip!, ...items])
        })
        await flushNative()
        return { id: clip!.id, href: clip!.href, title: clip!.title }
      }
      const clip = currentClips.current.find(item => item.id === payload.id)
      if (!clip) return fail('中转块已移除或已插入')
      if (method === 'preview') return { title: clip.title, text: clip.text, href: clip.href }
      if (method === 'insert') {
        await insert(clip)
        await nativeInvoke?.('notch_show_main')
        return { ok: true }
      }
      if (method === 'open') {
        const destination = resolveNotebookTarget(clip.href, assets, cases, findings, tasks)
        if ((!destination.getContent || !destination.href.startsWith('/cases/')) && !destination.href.startsWith('/notebooks/')) return fail('此条目没有可打开的来源笔记')
        navigate(destination.href)
        await nativeInvoke?.('notch_show_main')
        return { ok: true }
      }
      if (method === 'remove') {
        if (consumed.current.has(clip.id)) return fail('此条目正在插入')
        flushSync(() => updateClips(items => items.filter(item => item.id !== clip.id)))
        await flushNative()
        return { ok: true }
      }
      return fail('不支持的刘海操作')
    },
    list: (offset, limit) => {
      const items = currentClips.current
      return { items: items.slice(offset, offset + limit).map(({ id, title, href, text }) => ({ id, title, href, text: text.slice(0, 160) })), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null }
    },
    capture: (input) => {
      const id = `web_${input.id}`
      if (!currentClips.current.some((item) => item.id === id)) updateClips((items) => [{ id, title: input.title.trim() || input.url, href: input.url, text: input.text || '', createdAt: new Date().toISOString(), fields: { annotation: '', excerpt: input.text || '', sourceTitle: input.title.trim() || input.url, sourceAnchor: input.anchor } }, ...items])
      report('已从浏览器收集')
      return id
    },
    remove: (id) => { if (consumed.current.has(id)) throw Object.assign(new Error('此条目正在插入，请稍后重试'), { status: 409 }); updateClips((items) => items.filter((item) => item.id !== id)) },
  }} />{children}{visible && createPortal(<>
    <aside ref={drawer} className={`transfer-drawer${open ? ' is-open' : ''}${drag?.over ? ' is-over' : ''}`} style={{ '--transfer-height': `${drawerHeight}px`, '--transfer-card-height': `${CARD_HEIGHT}px`, '--transfer-card-step': `${CARD_STEP}px`, '--transfer-stack-step': `${STACK_STEP}px` } as CSSProperties} aria-label="中转" data-ready={ready} data-layout={expanded ? 'expanded' : 'stacked'} data-dragging={!!drag} onPointerEnter={() => { clearTimeout(hideTimer.current); setHovered(true); if (!dragging.current && !dropArrival.current) setBrowsing(true) }} onPointerLeave={() => { clearTimeout(hideTimer.current); dropArrival.current = false; hideTimer.current = setTimeout(() => { setHovered(false); setBrowsing(false) }, 220) }}>
      <button className="transfer-handle" aria-label="打开中转" aria-expanded={open} onFocus={() => { setHovered(true); setBrowsing(true) }} onClick={() => { dropArrival.current = false; setHovered(true); setBrowsing(true) }} />
      <div className="transfer-content" ref={(node) => { if (node) node.inert = !open }}>
        <div className="transfer-body">
          {!!clips.length && <div ref={list} className="transfer-list" onMouseDown={(event) => { if ((event.target as Element).closest('.transfer-clip')) event.preventDefault() }}>
            <div className="transfer-cards" style={{ height: `${expanded ? clips.length * CARD_STEP - (CARD_STEP - CARD_HEIGHT) : stackHeight}px` }}>
              {clips.map((clip, index) => <button type="button" key={clip.id} className={`transfer-clip${leaving.includes(clip.id) ? ' is-leaving' : ''}`} style={{ '--item-index': index, '--stack-index': Math.min(index, 2) } as CSSProperties} aria-label={`插入暂存：${clip.text.slice(0, 32)}`} aria-hidden={!expanded && index > 0 || undefined} tabIndex={!expanded && index > 0 ? -1 : 0} aria-disabled={!ready || leaving.includes(clip.id)} title={ready ? clip.text : '未选择正文插入位置'} onClick={() => { void insert(clip).catch(() => {}) }}><span className="transfer-origin"><FileText size={13} /><span>{clip.title}</span></span><span className="transfer-excerpt">{clip.text.slice(0, 160)}{clip.text.length > 160 ? '…' : ''}</span></button>)}
            </div>
          </div>}
          {(!clips.length || !!drag) && <div className={`transfer-drop-overlay${clips.length ? ' is-over-cards' : ''}`}><div className="transfer-dropzone"><Plus size={24} strokeWidth={1.5} /><span>中转站</span></div></div>}
        </div>
        {showDelete && <button className="transfer-delete" type="button" aria-label="删除全部暂存" title="删除全部暂存" disabled={clips.every((clip) => consumed.current.has(clip.id))} onMouseDown={(event) => event.preventDefault()} onClick={deleteClips}><Trash2 size={14} /><span>删除暂存</span></button>}
      </div>
    </aside>
    {drag && <div className={`transfer-drag-chip${drag.compact ? ' is-compact' : ''}${drag.over ? ' is-over' : ''}`} style={{ left: drag.x, top: drag.y, width: drag.compact ? Math.min(220, Math.max(100, drag.width * .72)) : drag.width, height: drag.compact ? 42 : drag.height }}><FileText size={15} /><span>{drag.clip.text}</span></div>}
    {notice && <div className="notebook-toast transfer-toast" role="status">{notice}{deletedClips.length > 0 && <button type="button" aria-label="撤销删除暂存" onClick={undoDelete}><Undo2 size={14} />撤销</button>}</div>}
  </>, document.body)}</Context.Provider>
}

export function useTransferEditor(editor: Editor | null, origin: Origin, commit: () => Promise<boolean>, inactive: boolean) {
  const context = useContext(Context)
  const latest = useRef({ origin, commit })
  latest.current = { origin, commit }
  const register = context?.register
  useEffect(() => {
    if (!editor || inactive || !register) return
    return register({ editor, origin: () => latest.current.origin, commit: () => latest.current.commit() })
  }, [editor, inactive, register])
  return () => { if (editor && !inactive) editor.view.dom.dispatchEvent(new Event('notechain-stage-selection')) }
}
