import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, placeholder as cmPlaceholder } from '@codemirror/view'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  minHeight?: number
  placeholder?: string
  inline?: boolean
  autoFocus?: boolean
}

/** Small controlled CodeMirror 6 wrapper used by the asset editor. */
export function MarkdownEditor({ value, onChange, minHeight = 220, placeholder, inline = false, autoFocus = false }: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!hostRef.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        ...(inline ? [] : [lineNumbers()]),
        history(),
        markdown(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString())
        }),
        EditorView.theme({
          '&': { minHeight: `${minHeight}px` },
          '.cm-scroller': { minHeight: `${minHeight}px` },
          '.cm-content': { minHeight: `${inline ? minHeight : Math.max(120, minHeight - 28)}px` },
          '.cm-placeholder': { color: 'var(--faint)' },
        }),
        ...(placeholder ? [cmPlaceholder(placeholder), EditorView.contentAttributes.of({ 'aria-label': placeholder })] : []),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    if (autoFocus) view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [minHeight, placeholder, inline, autoFocus])

  useEffect(() => {
    const view = viewRef.current
    if (!view || value === view.state.doc.toString()) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  return <div className={`markdown-editor${inline ? ' inline-markdown-editor' : ''}`} ref={hostRef} data-placeholder={placeholder} />
}
