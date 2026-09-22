import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import './notebook-selection.css'

const notebookSelectionKey = new PluginKey('notebookSelection')

function decorationsForSelection(state: EditorState) {
  const { selection } = state
  if (selection.empty || !selection.$from.parent.inlineContent || selection.$from.parent.type.spec.code) return DecorationSet.empty
  return DecorationSet.create(state.doc, [Decoration.inline(selection.from, selection.to, { class: 'notebook-selection' })])
}

/**
 * Mirrors the active text selection with a decoration, keeping the document and
 * its serialized Markdown unchanged while allowing a rounded selection surface.
 */
export const NotebookSelection = Extension.create({
  name: 'notebookSelection',

  addProseMirrorPlugins() {
    return [new Plugin({
      key: notebookSelectionKey,
      state: {
        init: (_, state) => decorationsForSelection(state),
        apply: (transaction, previous, _oldState, nextState) => {
          if (!transaction.docChanged && !transaction.selectionSet) return previous
          return decorationsForSelection(nextState)
        },
      },
      props: {
        decorations: (state) => notebookSelectionKey.getState(state),
      },
      view: (view) => {
        let frame = 0
        const sync = () => {
          frame = 0
          const { selection } = view.state
          const active = view.hasFocus()
            && !view.composing
            && !selection.empty
            && selection.$from.parent.inlineContent
            && !selection.$from.parent.type.spec.code
            && !view.dom.classList.contains('is-transferring')
          view.dom.classList.toggle('notebook-has-custom-selection', active)
        }
        const scheduleSync = () => {
          if (!frame) frame = requestAnimationFrame(sync)
        }
        const observer = new MutationObserver(scheduleSync)
        view.dom.addEventListener('focus', scheduleSync, true)
        view.dom.addEventListener('blur', scheduleSync, true)
        observer.observe(view.dom, { attributes: true, attributeFilter: ['class'] })
        scheduleSync()
        return {
          update: scheduleSync,
          destroy: () => {
            cancelAnimationFrame(frame)
            observer.disconnect()
            view.dom.removeEventListener('focus', scheduleSync, true)
            view.dom.removeEventListener('blur', scheduleSync, true)
          },
        }
      },
    })]
  },
})
