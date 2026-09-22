import { Extension, InputRule, nodeInputRule } from '@tiptap/core'
import Bold from '@tiptap/extension-bold'
import Italic from '@tiptap/extension-italic'
import Strike from '@tiptap/extension-strike'
import Code from '@tiptap/extension-code'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import { codeSpan } from './markdown-serialization'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

const noRules = { addInputRules: () => [], addPasteRules: () => [] }
export const NotebookBold = Bold.extend(noRules)
export const NotebookItalic = Italic.extend(noRules)
export const NotebookStrike = Strike.extend(noRules)
export const NotebookHorizontalRule = HorizontalRule.extend({
  addInputRules() {
    return [...(this.parent?.() ?? []), nodeInputRule({ find: /^(?:\*{3,}|_{3,}|-{3,})\s$/, type: this.type })]
  },
  addKeyboardShortcuts() {
    return { ...this.parent?.(), Enter: () => {
      const { empty, $from } = this.editor.state.selection
      if (!empty || $from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size || !/^ {0,3}(?:(?:\* *){3,}|(?:_ *){3,}|(?:- *){3,})$/.test($from.parent.textContent)) return false
      return this.editor.commands.setHorizontalRule()
    } }
  },
})
export const NotebookInlineCode = Code.extend({
  ...noRules,
  addKeyboardShortcuts() {
    return { ...this.parent?.(), Enter: () => {
      if (this.editor.state.selection.empty && this.editor.isActive('code')) this.editor.commands.unsetCode()
      // Let the paragraph/list handler create the next line without a code mark.
      return false
    } }
  },
  renderMarkdown(node) {
    const text = (node.content ?? []).map(child => child.text ?? '').join('')
    return codeSpan(text)
  },
})

export function inlineMarkdownMatch(text: string) {
  if (!/[*_`~]$/.test(text)) return null
  const close = /([*_`~]+)$/.exec(text)?.[1]
  if (!close || !/^([*_])\1*$|^`+$|^~{2,}$/.test(close)) return null
  const char = close[0], size = close.length
  // Match the complete delimiter run. This avoids Marked's permissive
  // partial match turning ***text*** into bold text wrapped around a star.
  for (let index = text.length - close.length - 1; index >= 0; index--) {
    if (text.slice(index, index + size) !== close) continue
    if (text[index - 1] === char || /\\+$/.test(text.slice(0, index)) && (text.slice(0, index).match(/\\+$/)![0].length % 2 === 1)) continue
    if (new RegExp('\\' + char + '{' + (size + 1) + ',}').test(text.slice(0, index))) continue
    const body = text.slice(index + size, text.length - size)
    if (!body || /^\s|\s$/.test(body)) continue
    if (body[0] === char || body.at(-1) === char) continue
    if (char === '`' && body.includes(close)) continue
    return { index, text: text.slice(index) }
  }
  return null
}

export function inlineMarkdownAtCursor(text: string, cursor: number) {
  for (let end = text.length; end > 0; end--) {
    const match = inlineMarkdownMatch(text.slice(0, end))
    if (!match) continue
    const from = match.index, to = end
    const delimiter = text.slice(from, from + 1).repeat(match.text.match(/^([*_`~]+)/)![1].length)
    if (from < cursor && cursor < to && cursor >= from + delimiter.length && cursor <= to - delimiter.length) {
      return { from, to, raw: match.text, delimiter: delimiter.length }
    }
  }
  return null
}

export const MarkdownTyping = Extension.create({
  name: 'notebookMarkdownTyping', priority: 1100,
  addProseMirrorPlugins() {
    const editor = this.editor
    let generated = false
    const insidePair = (view: EditorView, from: number, to: number, text: string) => {
      if (view.composing || from !== to || /[\r\n]/.test(text)) return false
      const $from = view.state.doc.resolve(from)
      if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false
      const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc')
      const after = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, '', '\ufffc')
      const match = inlineMarkdownAtCursor(before + text + after, before.length + text.length)
      if (!match) return false
      const start = $from.start() + match.from, end = $from.start() + match.to - text.length
      let plain = true
      view.state.doc.nodesBetween(start, end, node => { if (node.isInline && (!node.isText || node.marks.length)) plain = false })
      if (!plain) return false
      const content = editor.markdown?.parse(match.raw).content?.[0]?.content
      // A pair being filled is one text span. Do not reinterpret existing rich content.
      if (content?.length !== 1 || content[0].type !== 'text' || !content[0].marks?.length) return false
      const body = match.raw.slice(match.delimiter, -match.delimiter)
      const rendered = content[0].text ?? ''
      const padding = body !== rendered && body.slice(1, -1) === rendered ? 1 : 0
      if (body !== rendered && !padding) return false
      const node = view.state.schema.nodeFromJSON(content[0])
      const tr = view.state.tr.replaceWith(start, end, node)
      const cursor = start + Math.max(0, Math.min(node.nodeSize, before.length + text.length - match.from - match.delimiter - padding))
      tr.setSelection(TextSelection.create(tr.doc, cursor)).setStoredMarks(node.marks)
      view.dispatch(tr)
      return true
    }
    const finishGenerated = (view: EditorView) => {
      const selection = view.state.selection
      const $from = view.state.doc.resolve(selection.from)
      const raw = $from.parent.textContent
      const match = inlineMarkdownMatch(raw)
      if (!match) { generated = false; return }
      const parsed = editor.markdown?.parse(raw)?.content?.[0]
      if (!parsed?.content) { generated = false; return }
      const start = $from.start(), end = $from.end()
      const content = parsed.content.map((node: any) => editor.schema.nodeFromJSON(node))
      const tr = view.state.tr.replaceWith(start, end, content)
      view.dispatch(tr)
      generated = false
    }
    const autoPair = (view: EditorView, from: number, to: number, text: string) => {
      if (view.composing || from !== to || !['*', '**'].includes(text)) return false
      const $from = view.state.doc.resolve(from)
      if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false
      const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc')
      const after = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, '', '\ufffc')
      if (text === '*' && before.endsWith('*') && !before.endsWith('**')) {
        const tr = view.state.tr.insertText('***', from)
        tr.setSelection(TextSelection.create(tr.doc, from + 1))
        view.dispatch(tr)
        generated = true
        return true
      }
      if (text === '**' && !after.startsWith('*') && !before.endsWith('*')) {
        const tr = view.state.tr.insertText('****', from)
        tr.setSelection(TextSelection.create(tr.doc, from + 2))
        view.dispatch(tr)
        generated = true
        return true
      }
      // When a generated closing delimiter is under the cursor, consume it
      // instead of inserting another pair of stars.
      const closingBold = /\*\*[^*]+\*?$/.test(before)
      if (text === '*' && after.startsWith('*') && (generated || closingBold)) {
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1)))
        if (after.length === 1) finishGenerated(view)
        return true
      }
      return false
    }
    return [new Plugin({ props: {
      handleKeyDown: (view, event) => {
        if (event.key !== '*' || event.metaKey || event.ctrlKey || event.altKey || !view.state.selection.empty) return false
        const { from } = view.state.selection, $from = view.state.doc.resolve(from)
        const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc')
        const after = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, '', '\ufffc')
        if (!after.startsWith('*') || !(/\*\*[^*]+\*?$/.test(before) || generated)) return false
        event.preventDefault()
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1)))
        if (after.length === 1) finishGenerated(view)
        return true
      },
      handleTextInput: (view, from, to, text) => {
        if (generated) {
          const $from = view.state.doc.resolve(from)
          const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc')
          const after = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, '', '\ufffc')
          if (!before.includes('*') || !after.includes('*')) generated = false
        }
        return autoPair(view, from, to, text) || (!generated && insidePair(view, from, to, text))
      },
      handleDOMEvents: { compositionend: view => {
        setTimeout(() => {
          if (!editor.isDestroyed && view.state.selection.empty) insidePair(view, view.state.selection.from, view.state.selection.to, '')
        }, 0)
        return false
      } },
    } })]
  },
  addInputRules() {
    return [new InputRule({ find: inlineMarkdownMatch, handler: ({ state, range, match, commands }) => {
      let linked = false
      state.doc.nodesBetween(range.from, range.to, node => { if (node.marks.some(mark => mark.type.name === 'link')) linked = true })
      if (linked) return null
      const parsed = this.editor.markdown?.parse(match[0])
      const content = parsed?.content?.[0]?.content
      if (!content?.some(node => node.marks?.length)) return null
      commands.insertContentAt(range, content)
      commands.unsetAllMarks()
    } })]
  },
})
