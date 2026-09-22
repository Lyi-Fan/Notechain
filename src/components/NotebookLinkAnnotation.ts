import { Extension, getMarkRange, mergeAttributes, type Editor, type JSONContent } from '@tiptap/core'
import Link from '@tiptap/extension-link'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Mark } from '@tiptap/pm/model'
import { safeNoteLink } from '../notes'
import { displayUrl } from '../url-display'
import { linkAttributes, readLinkFields, type LinkTarget } from '../notebook-links'

type Field = 'target' | 'annotation'
interface LinkData { from: number; to: number; href: string; target: string; annotation: string; original: string; marks: readonly Mark[] }
interface Session { data: LinkData; field: Field; element: HTMLElement; input?: HTMLInputElement; finish?: (save: boolean, focus?: boolean) => void }
const sessionKey = new PluginKey<Session | null>('notebookLinkField')
const RESTORE_MS = 600

// Empty and bare targets remain editable, but are never executable browser URLs.
export const NotebookLink = Link.extend({
  renderHTML({ HTMLAttributes }) {
    const target = String(HTMLAttributes.href ?? '')
    const fields = readLinkFields(HTMLAttributes.title)
    return ['a', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
      href: safeNoteLink(target) ? target : '', 'data-notebook-target': target,
      title: fields ? fields.originalTitle ?? null : HTMLAttributes.title,
      'data-notebook-link': fields ? HTMLAttributes.title : null,
    }), 0]
  },
  parseHTML() { return [{ tag: 'a[href]' }] },
  addAttributes() {
    return { ...this.parent?.(), href: { default: '', parseHTML: (node) => node.getAttribute('data-notebook-target') ?? node.getAttribute('href') ?? '' }, title: { default: null, parseHTML: (node) => node.getAttribute('data-notebook-link') ?? node.getAttribute('title') } }
  },
  renderMarkdown(node, helpers) {
    const raw = String(node.attrs?.href ?? '')
    const href = /[\s()<>]/.test(raw) ? `<${raw.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\r?\n/g, '%0A')}>` : raw
    const title = String(node.attrs?.title ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return `[${helpers.renderChildren(node)}](${href || (title ? '<>' : '')}${title ? ` "${title}"` : ''})`
  },
})

export const NotebookLinkAnnotation = Extension.create({
  name: 'notebookLinkAnnotation',
  addProseMirrorPlugins() {
    return [new Plugin<Session | null>({
      key: sessionKey,
      state: {
        init: () => null,
        apply(transaction, session) {
          const action = transaction.getMeta(sessionKey)
          if (action !== undefined) return action
          if (!session || !transaction.docChanged) return session
          const from = transaction.mapping.mapResult(session.data.from, 1)
          const to = transaction.mapping.mapResult(session.data.to, -1)
          if (from.deleted || to.deleted || from.pos >= to.pos) return null
          return { ...session, data: { ...session.data, from: from.pos, to: to.pos } }
        },
      },
      props: {
        decorations(state) {
          const session = sessionKey.getState(state)
          if (!session) return null
          return DecorationSet.create(state.doc, [
            Decoration.inline(session.data.from, session.data.to, { class: 'notebook-link-edit-hidden' }),
            Decoration.widget(session.data.from, session.element, { side: -1, marks: [], stopEvent: () => true, ignoreSelection: true }),
          ])
        },
      },
    })]
  },
})

export function finishLinkAnnotation(editor: Editor | null, save = true) {
  if (editor && !editor.isDestroyed) sessionKey.getState(editor.state)?.finish?.(save)
}

function plainText(node: JSONContent): string {
  if (node.text !== undefined) return node.text
  if (node.type === 'hardBreak') return ' '
  return (node.content ?? []).map(plainText).join(['doc', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'table', 'tableRow', 'tableCell'].includes(node.type ?? '') ? ' ' : '')
}

export function normalizeNotebookLinks(editor: Editor, resolve: (value: string) => LinkTarget) {
  if (editor.isDestroyed || editor.view.composing || sessionKey.getState(editor.state)) return
  const { doc, schema } = editor.state
  const ranges = new Map<number, { from: number; to: number; mark: Mark }>()
  doc.descendants((node, pos) => {
    const mark = node.marks.find((item) => item.type === schema.marks.link)
    if (!mark) return
    const range = getMarkRange(doc.resolve(pos), mark.type, mark.attrs)
    if (range) ranges.set(range.from, { ...range, mark })
  })
  const transaction = editor.state.tr
  const sourceText = new Map<string, string>()
  const compact = (value: string) => value.replace(/\s+/gu, ' ').trim()
  for (const { from, to, mark } of [...ranges.values()].reverse()) {
    const href = String(mark.attrs.href ?? '')
    if (readLinkFields(mark.attrs.title)?.explanation) continue
    const target = resolve(href)
    if (target.secret && schema.nodes.notebookSecret) {
      transaction.replaceWith(from, to, schema.nodes.notebookSecret.create(target.secret))
      continue
    }
    const original = doc.textBetween(from, to)
    let fields = readLinkFields(mark.attrs.title)
    if (!fields && target.bodyPending) continue
    if (!fields) {
      let excerpt: string | undefined
      // Old tray links used a source excerpt as their label. Only
      // migrate verified excerpts; retain their text and ordinary custom labels.
      if (target.getContent && original !== target.label && original !== href && compact(original).length >= 12) {
        if (!sourceText.has(href)) sourceText.set(href, compact(plainText(editor.markdown!.parse(target.getContent()))))
        if (sourceText.get(href)?.includes(compact(original))) excerpt = original
      }
      fields = {
        annotation: excerpt || original === target.label || original === href ? '' : original,
        ...(excerpt ? { excerpt } : {}),
        ...(mark.attrs.title ? { originalTitle: String(mark.attrs.title) } : {}),
      }
    }
    const text = fields.annotation || (!target.getContent && fields.sourceTitle && displayUrl(fields.sourceTitle)) || target.label
    if (!text) continue
    const updated = mark.type.create({ ...mark.attrs, ...linkAttributes(href, fields) })
    if (text !== original) {
      const marks = (doc.nodeAt(from)?.marks ?? []).map((item) => item.type === mark.type ? updated : item)
      transaction.replaceWith(from, to, schema.text(text, marks))
    } else if (!updated.eq(mark)) transaction.addMark(from, to, updated)
  }
  if (transaction.docChanged) editor.view.dispatch(transaction.setMeta('notebookLinks', true).setMeta('linkAnnotation', true).setMeta('addToHistory', false))
}

// Links stay ordinary inline marks. At a link boundary, however, treat the
// deletion key as removing the complete related-note chip, like a code block.
export function deleteWholeLinkAtBoundary(editor: Editor, key: 'Backspace' | 'Delete') {
  const { selection, doc } = editor.state
  if (!selection.empty || editor.view.composing) return false
  const position = selection.from
  for (const probe of [position, Math.max(0, position - 1)]) {
    const node = doc.nodeAt(probe)
    const mark = node?.marks.find((item) => item.type === editor.schema.marks.link)
    if (!mark) continue
    const range = getMarkRange(doc.resolve(probe), mark.type, mark.attrs)
    if (!range || (key === 'Backspace' ? position !== range.to : position !== range.from)) continue
    const transaction = closeHistory(editor.state.tr).setMeta(sessionKey, null).setMeta('linkAnnotation', true).delete(range.from, range.to)
    transaction.setSelection(TextSelection.near(transaction.doc.resolve(range.from)))
    editor.view.dispatch(transaction)
    return true
  }
  return false
}

export function bindLinkInteractions(editor: Editor, root: HTMLElement, resolve: (target: string) => { href: string; label: string }, dismiss: () => void, open: (href: string) => void) {
  let hovered: HTMLAnchorElement | null = null
  let pointer: { x: number; y: number } | null = null
  let tabDown = false
  let locked = false
  let openingClick: { time: number; x: number; y: number; from: number; href: string } | null = null
  let restoreTimer: ReturnType<typeof setTimeout> | undefined
  const session = () => editor.isDestroyed ? null : sessionKey.getState(editor.state)
  const setSession = (value: Session | null) => {
    if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(sessionKey, value))
  }
  const close = () => { clearTimeout(restoreTimer); if (!session()?.input) { locked = false; openingClick = null; setSession(null) } }
  const restoreLater = () => {
    clearTimeout(restoreTimer)
    if (!tabDown && !session()?.input) restoreTimer = setTimeout(close, RESTORE_MS)
  }
  const read = (link: HTMLAnchorElement): LinkData | null => {
    if (!link.isConnected || editor.isDestroyed) return null
    const pos = editor.view.posAtDOM(link, 0)
    const mark = editor.state.doc.nodeAt(pos)?.marks.find((item) => item.type === editor.schema.marks.link)
    if (!mark) return null
    const range = getMarkRange(editor.state.doc.resolve(pos), mark.type, mark.attrs)
    if (!range) return null
    const href = String(mark.attrs.href ?? '')
    const target = resolve(href).label
    const original = editor.state.doc.textBetween(range.from, range.to)
    const fields = readLinkFields(mark.attrs.title)
    if (fields?.explanation) return null
    return { ...range, href, target, original, annotation: fields?.annotation ?? (original === target || original === href ? '' : original), marks: editor.state.doc.nodeAt(range.from)?.marks ?? [] }
  }
  const placeholder = (field: Field) => field === 'target' ? 'URL / IP / 笔记名' : '标注'
  const show = (data: LinkData, field: Field) => {
    clearTimeout(restoreTimer)
    const element = document.createElement('span')
    element.className = 'notebook-link-peek'
    element.contentEditable = 'false'
    element.dataset.field = field
    element.textContent = data[field] || placeholder(field)
    element.dataset.empty = String(!data[field])
    setSession({ data, field, element })
  }
  const edit = (data: LinkData, field: Field) => {
    clearTimeout(restoreTimer)
    locked = true
    const element = document.createElement('span')
    element.className = 'notebook-link-annotation'
    element.contentEditable = 'false'
    element.dataset.field = field
    const measure = document.createElement('span')
    measure.setAttribute('aria-hidden', 'true')
    const input = document.createElement('input')
    input.type = 'text'; input.size = 1
    input.setAttribute('aria-label', field === 'target' ? '链接目标' : '链接标注')
    input.placeholder = placeholder(field)
    input.value = data[field]
    const resize = () => { measure.textContent = input.value || input.placeholder; input.setCustomValidity(''); input.removeAttribute('aria-invalid') }
    resize(); element.append(measure, input)
    let finished = false
    const remove = (focus = false) => {
      if (finished || editor.isDestroyed) return
      const current = session()
      if (!current || current.element !== element) return
      finished = true
      const transaction = closeHistory(editor.state.tr).setMeta(sessionKey, null).setMeta('linkAnnotation', true).delete(current.data.from, current.data.to)
      transaction.setSelection(TextSelection.near(transaction.doc.resolve(current.data.from)))
      editor.view.dispatch(transaction)
      if (focus) editor.view.focus()
    }
    const finish = (save: boolean, focus = false) => {
      if (finished || editor.isDestroyed) return
      const current = session()
      if (!current || current.element !== element) return
      const value = input.value.trim()
      const updated = { ...current.data }
      if (save) {
        if (field === 'target') {
          const result = resolve(value)
          if (value && /^[a-z][a-z\d+.-]*:/i.test(value) && !safeNoteLink(result.href)) {
            input.setCustomValidity('不支持此链接协议'); input.setAttribute('aria-invalid', 'true')
            if (focus) input.reportValidity()
            return
          }
          updated.href = result.href; updated.target = result.label
        } else updated.annotation = value
      }
      const text = updated.annotation || updated.target
      if (!text) {
        input.setCustomValidity('至少保留链接目标或标注'); input.setAttribute('aria-invalid', 'true')
        if (focus) input.reportValidity()
        return
      }
      finished = true
      const transaction = editor.state.tr.setMeta(sessionKey, null).setMeta('linkAnnotation', true)
      if (save && (text !== current.data.original || updated.href !== current.data.href || readLinkFields(updated.marks.find((mark) => mark.type === editor.schema.marks.link)?.attrs.title)?.annotation !== updated.annotation)) {
        const marks = updated.marks.map((mark) => mark.type === editor.schema.marks.link ? mark.type.create({ ...mark.attrs, ...linkAttributes(updated.href, { ...readLinkFields(mark.attrs.title), ...(updated.href !== current.data.href ? { sourceTitle: undefined, sourceAnchor: undefined, excerpt: undefined } : {}), annotation: updated.annotation }) }) : mark)
        transaction.replaceWith(updated.from, updated.to, editor.schema.text(text, marks))
        updated.marks = marks; updated.to = updated.from + text.length
        transaction.setSelection(TextSelection.near(transaction.doc.resolve(updated.to))).setMeta('preventAutolink', true)
      }
      updated.original = text
      editor.view.dispatch(transaction)
      if (save) { show(updated, field); restoreLater() }
      if (focus) editor.view.focus()
    }
    input.addEventListener('input', () => { openingClick = null; resize() })
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return
      // Delete the selected display label as a chip, but allow the alternate
      // Tab field to be cleared independently without removing its annotation.
      const displayField: Field = data.annotation ? 'annotation' : 'target'
      if ((event.key === 'Backspace' || event.key === 'Delete') && !event.ctrlKey && !event.altKey && !event.metaKey && field === displayField && input.value.length > 0 && input.selectionStart === 0 && input.selectionEnd === input.value.length) {
        event.preventDefault(); event.stopPropagation(); remove(true); return
      }
      if (['Enter', 'Tab', 'Escape'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); finish(event.key !== 'Escape', true)
      }
    })
    input.addEventListener('blur', () => finish(true))
    setSession({ data, field, element, input, finish })
    input.focus({ preventScroll: true }); input.select(); dismiss()
  }
  const hover = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY }
    const current = session()
    if (current?.element.contains(event.target as Node)) { hovered = null; return }
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.tiptap a') : null
    hovered = link && root.contains(link) ? link : null
  }
  const down = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return
    if (tabDown) { event.preventDefault(); event.stopPropagation(); return }
    if (event.repeat || event.defaultPrevented || event.isComposing || editor.view.composing || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || session()?.input) return
    const focusedDialog = document.activeElement?.closest('[role="dialog"]')
    if (document.activeElement?.matches('input, textarea, select') || (focusedDialog && focusedDialog !== root.closest('[role="dialog"]'))) return
    const pointed = pointer ? document.elementFromPoint(pointer.x, pointer.y) : null
    if (pointer) {
      const link = pointed?.closest<HTMLAnchorElement>('.tiptap a')
      hovered = link && root.contains(link) ? link : null
    }
    const current = session()
    const onCurrent = current && pointed && current.element.contains(pointed)
    const data = onCurrent ? current.data : hovered ? read(hovered) : null
    if (!data) return
    const field = onCurrent ? current.field : data.annotation ? 'annotation' : 'target'
    tabDown = true
    locked = false
    openingClick = null
    event.preventDefault(); event.stopPropagation(); dismiss(); clearTimeout(restoreTimer)
    show(data, field === 'annotation' ? 'target' : 'annotation')
  }
  const up = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !tabDown) return
    event.preventDefault(); event.stopPropagation(); tabDown = false
    if (locked) restoreLater()
    else close()
  }
  const pointerDown = (event: PointerEvent) => {
    const current = session()
    if (event.button !== 0) { openingClick = null; return }
    const onCurrent = current?.element.contains(event.target as Node)
    // The first click replaces the anchor with an input, so native dblclick
    // may target a different node. Recognize only this opening click pair.
    if (!tabDown && onCurrent && openingClick && current?.data.from === openingClick.from && event.timeStamp - openingClick.time <= 450 && Math.hypot(event.clientX - openingClick.x, event.clientY - openingClick.y) <= 6) {
      event.preventDefault(); event.stopPropagation()
      const href = openingClick.href
      openingClick = null
      current.finish?.(false)
      close()
      open(href)
      return
    }
    openingClick = null
    if (onCurrent && current?.input) return
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.tiptap a') : null
    const data = onCurrent ? current?.data : link && root.contains(link) ? read(link) : null
    if (data) {
      event.preventDefault(); event.stopPropagation()
      const field = onCurrent && current ? current.field : data.annotation ? 'annotation' : 'target'
      const sizeBeforeSave = editor.state.doc.content.size
      finishLinkAnnotation(editor)
      if (current?.input && current.data.to <= data.from) {
        const shift = editor.state.doc.content.size - sizeBeforeSave
        data.from += shift; data.to += shift
      }
      edit(data, field)
      if (!tabDown) openingClick = { time: event.timeStamp, x: event.clientX, y: event.clientY, from: data.from, href: data.href }
    } else {
      restoreLater()
    }
  }
  const blur = () => { tabDown = false; openingClick = null; hovered = null; finishLinkAnnotation(editor); close() }
  const hidden = () => { if (document.hidden) blur() }
  document.addEventListener('pointermove', hover)
  document.addEventListener('pointerdown', pointerDown, true)
  document.addEventListener('keydown', down, true)
  document.addEventListener('keyup', up, true)
  document.addEventListener('visibilitychange', hidden)
  window.addEventListener('blur', blur)
  return () => {
    clearTimeout(restoreTimer); finishLinkAnnotation(editor)
    clearTimeout(restoreTimer); setSession(null)
    document.removeEventListener('pointermove', hover)
    document.removeEventListener('pointerdown', pointerDown, true)
    document.removeEventListener('keydown', down, true)
    document.removeEventListener('keyup', up, true)
    document.removeEventListener('visibilitychange', hidden)
    window.removeEventListener('blur', blur)
  }
}
