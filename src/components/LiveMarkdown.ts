import { Extension, getMarkRange, type Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { markdown } from '@codemirror/lang-markdown'

interface Session {
  from: number
  to: number
  inline: boolean
  raw: string
  original: string
  token: string
  anchorId?: string
  list?: { type: string; attrs: Record<string, unknown>; item: string }
  dom: HTMLElement
  cm?: EditorView
}
const liveKey = new PluginKey<Session | null>('liveMarkdown')

export function hasLiveMarkdown(editor: Editor | null) {
  return !!editor && !editor.isDestroyed && !!liveKey.getState(editor.state)
}

function withSource(editor: Editor, session: Session) {
  if (session.list) return editor.markdown!.serialize(editor.state.tr.replaceWith(session.from, session.to, listContent(editor, session)).doc.toJSON())
  const placeholder = editor.schema.text(session.token)
  const transaction = editor.state.tr.replaceWith(session.from, session.to,
    session.inline ? placeholder : editor.schema.nodes.paragraph.create(null, placeholder))
  return editor.markdown!.serialize(transaction.doc.toJSON()).replace(session.token, () => session.raw)
}

function listContent(editor: Editor, session: Session) {
  const parsed = editor.schema.nodeFromJSON(editor.markdown!.parse(session.raw))
  const list = session.list!
  if (parsed.childCount === 1 && parsed.firstChild?.type.name === list.type) return parsed.firstChild.content
  return Fragment.from(editor.schema.nodes[list.item].create(list.attrs,
    parsed.content.size ? parsed.content : editor.schema.nodes.paragraph.create()))
}

export function finishLiveMarkdown(editor: Editor | null, focus = false) {
  if (!editor || editor.isDestroyed) return
  const session = liveKey.getState(editor.state)
  if (!session) return
  if (session.cm?.composing) {
    session.dom.addEventListener('compositionend', () => queueMicrotask(() => {
      if (!editor.isDestroyed && liveKey.getState(editor.state)?.token === session.token) finishLiveMarkdown(editor, focus)
    }), { once: true })
    return
  }
  let transaction = editor.state.tr.setMeta(liveKey, null)
  if (session.raw !== session.original) {
    const parsed = editor.schema.nodeFromJSON(editor.markdown!.parse(session.raw))
    let content = session.list ? listContent(editor, session) : parsed.content
    if (session.inline) {
      const children = []
      for (let index = 0; index < parsed.childCount; index++) {
        const node = parsed.child(index)
        if (!node.inlineContent) {
          children.length = 0
          if (session.raw) children.push(editor.schema.text(session.raw))
          break
        }
        if (index && editor.schema.nodes.hardBreak) children.push(editor.schema.nodes.hardBreak.create())
        node.forEach(child => children.push(child))
      }
      content = Fragment.from(children)
    } else if (!content.size) content = Fragment.from(editor.schema.nodes.paragraph.create())
    transaction = closeHistory(transaction.replaceWith(session.from, session.to, content))
    if (focus) transaction.setSelection(TextSelection.near(transaction.doc.resolve(Math.min(session.from + content.size, transaction.doc.content.size))))
  } else transaction.setMeta('addToHistory', false)
  editor.view.dispatch(transaction)
  session.cm?.destroy()
  if (focus) editor.view.focus()
}

export const LiveMarkdown = Extension.create<{ onChange: (markdown: string) => void }>({
  name: 'liveMarkdown',
  addOptions() { return { onChange: () => {} } },
  addProseMirrorPlugins() {
    const editor = this.editor
    const changed = this.options.onChange
    return [new Plugin<Session | null>({
      key: liveKey,
      state: {
        init: () => null,
        apply(transaction, session) {
          if (transaction.getMeta(liveKey) !== undefined) return transaction.getMeta(liveKey)
          if (!session || !transaction.docChanged) return session
          const from = transaction.mapping.mapResult(session.from, 1)
          const to = transaction.mapping.mapResult(session.to, -1)
          if (from.deleted && to.deleted) { session.cm?.destroy(); return null }
          return { ...session, from: from.pos, to: to.pos }
        },
      },
      props: {
        decorations(state) {
          const session = liveKey.getState(state)
          if (!session) return null
          return DecorationSet.create(state.doc, [
            session.inline
              ? Decoration.inline(session.from, session.to, { class: 'notebook-live-hidden' })
              : Decoration.node(session.from, session.to, { class: 'notebook-live-hidden', ...(session.anchorId ? { id: '' } : {}) }),
            Decoration.widget(session.from, session.dom, { key: session.token, side: -1, marks: [], stopEvent: () => true, ignoreSelection: true }),
          ])
        },
        handleClick(view, position, event) {
          if (event.detail > 1 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || liveKey.getState(view.state)) return false
          const target = event.target as HTMLElement
          if (!window.getSelection()?.isCollapsed) return false
          if (target.closest('a,button,input,textarea,.notebook-code-block,.cm-editor,img')) return false
          const formatted = target.closest('code,strong,b,em,i,s,del,h1,h2,h3,h4,h5,h6,blockquote')
          const listMarker = !!target.closest('li')
          if (!formatted && !listMarker) return false
          const tag = formatted?.tagName.toLowerCase() ?? ''
          const markName = ({ code: 'code', strong: 'bold', b: 'bold', em: 'italic', i: 'italic', s: 'strike', del: 'strike' } as Record<string, string>)[tag]
          const $position = view.state.doc.resolve(position)
          let from = 0, to = 0, raw = '', inline = false
          let list: Session['list']
          if (markName) {
            const range = getMarkRange($position, editor.schema.marks[markName])
            if (!range) return false
            from = range.from; to = range.to; inline = true
            const content = view.state.doc.slice(from, to).content.toJSON()
            raw = editor.markdown!.serialize({ type: 'doc', content: [{ type: 'paragraph', content }] }).trimEnd()
          } else {
            const type = listMarker ? ['listItem', 'taskItem'] : tag === 'blockquote' ? ['blockquote'] : ['heading']
            let depth = $position.depth
            while (depth > 0 && !type.includes($position.node(depth).type.name)) depth--
            if (!depth) return false
            from = $position.before(depth); to = $position.after(depth)
            const node = $position.node(depth)
            let sourceNode = node.toJSON()
            if (listMarker) {
              const parent = $position.node(depth - 1)
              list = { type: parent.type.name, attrs: node.attrs, item: node.type.name }
              sourceNode = { type: parent.type.name, attrs: { ...parent.attrs, ...(parent.type.name === 'orderedList' ? { start: (parent.attrs.start ?? 1) + $position.index(depth - 1) } : {}) }, content: [sourceNode] }
            }
            raw = editor.markdown!.serialize({ type: 'doc', content: [sourceNode] }).trimEnd()
          }
          event.preventDefault()
          const dom = document.createElement(inline ? 'span' : 'div')
          dom.className = `notebook-live-source ${inline ? 'is-inline' : 'is-block'}`
          dom.contentEditable = 'false'
          if (!inline && formatted) {
            const style = getComputedStyle(formatted)
            dom.style.fontSize = style.fontSize
            dom.style.fontWeight = style.fontWeight
            dom.style.lineHeight = style.lineHeight
            dom.style.marginTop = style.marginTop
            dom.style.marginBottom = style.marginBottom
          }
          const anchorId = !inline ? view.state.doc.nodeAt(from)?.attrs.id as string | undefined : undefined
          if (anchorId) { dom.id = anchorId; dom.dataset.liveAnchor = 'true' }
          const session: Session = { from, to, inline, raw, original: raw, anchorId, token: `ledgerSource${crypto.randomUUID().replace(/-/g, '')}`, dom }
          session.list = list
          dom.addEventListener('focusout', () => queueMicrotask(() => {
            if (!editor.isDestroyed && liveKey.getState(editor.state)?.token === session.token && !dom.contains(document.activeElement)) finishLiveMarkdown(editor)
          }))
          const tabCode = () => {
            const cm = session.cm!
            const { from: start, to: end } = cm.state.selection.main
            if (start === end) return false
            const text = cm.state.sliceDoc(start, end)
            if (Array.from(text).length <= 2 || text.includes('\n')) return false
            const wrapped = text.startsWith('`') && text.endsWith('`')
            const replacement = wrapped ? text.slice(1, -1) : '`' + text + '`'
            cm.dispatch({ changes: { from: start, to: end, insert: replacement }, selection: { anchor: start, head: start + replacement.length } })
            return true
          }
          session.cm = new EditorView({
            parent: dom,
            state: EditorState.create({
              doc: raw,
              selection: { anchor: Math.max(0, Math.min(raw.length, position - from - (inline ? 0 : 1) + (inline ? raw.match(/^(?:`+|\*+|_+|~+)/)?.[0].length ?? 0 : raw.match(/^(?:#{1,6}|>) /)?.[0].length ?? 0))) },
              extensions: [markdown(), history(), EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{', "'", '"', '`'] } }]), closeBrackets(), EditorView.lineWrapping,
                keymap.of([
                  { key: 'Escape', run: () => { finishLiveMarkdown(editor, true); return true } },
                  ...(inline ? [{ key: 'Enter', run: () => { finishLiveMarkdown(editor, true); return true } }] : []),
                  { key: 'Tab', run: tabCode }, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap,
                ]),
                EditorView.contentAttributes.of({ 'aria-label': 'Markdown 就地编辑', spellcheck: 'false' }),
                EditorView.updateListener.of(update => {
                  if (!update.docChanged) return
                  const active = liveKey.getState(editor.state)
                  if (!active) return
                  active.raw = update.state.doc.toString()
                  changed(withSource(editor, active))
                }),
              ],
            }),
          })
          view.dispatch(view.state.tr.setMeta(liveKey, session).setMeta('addToHistory', false))
          session.cm.focus()
          return true
        },
      },
      view() {
        const outside = (event: PointerEvent) => {
          const session = liveKey.getState(editor.state)
          if (session && !session.dom.contains(event.target as Node)) finishLiveMarkdown(editor)
        }
        const blur = () => finishLiveMarkdown(editor)
        document.addEventListener('pointerdown', outside, true)
        window.addEventListener('blur', blur)
        return { destroy() {
          document.removeEventListener('pointerdown', outside, true)
          window.removeEventListener('blur', blur)
          liveKey.getState(editor.state)?.cm?.destroy()
        } }
      },
    })]
  },
})
