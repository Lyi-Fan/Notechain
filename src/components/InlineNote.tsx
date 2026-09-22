import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Check, Loader2 } from 'lucide-react'
import { MarkdownEditor } from './MarkdownEditor'
import { MarkdownView } from './MarkdownView'

export function InlineNote({ value, label, onSave, onInternalLink }: {
  value: string
  label: string
  onSave: (value: string) => void
  onInternalLink?: (href: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const commit = useCallback(() => {
    clearTimeout(timer.current)
    if (pending.current === null) return
    const next = pending.current
    pending.current = null
    saveRef.current(next)
    setDirty(false)
  }, [])

  useEffect(() => {
    if (pending.current === null) setDraft(value)
  }, [value])
  useEffect(() => {
    const leave = () => { if (pending.current !== null) flushSync(commit) }
    const hidden = () => { if (document.visibilityState === 'hidden') leave() }
    window.addEventListener('pagehide', leave)
    window.addEventListener('beforeunload', leave)
    window.addEventListener('blur', leave)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      commit()
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('beforeunload', leave)
      window.removeEventListener('blur', leave)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [commit])

  return <div className={`inline-note ${editing ? 'editing' : ''}`} onBlur={(event) => {
    const root = event.currentTarget
    // The preview is replaced by CodeMirror, which briefly blurs while mounting.
    queueMicrotask(() => {
      if (root.isConnected && !root.contains(document.activeElement)) { commit(); setEditing(false) }
    })
  }}>
    {editing ? <>
      <MarkdownEditor inline autoFocus minHeight={48} value={draft} placeholder={label} onChange={(next) => {
        setDraft(next)
        setDirty(true)
        pending.current = next
        clearTimeout(timer.current)
        timer.current = setTimeout(commit, 500)
      }} />
      <span className="inline-save-state" role="status">{dirty ? <Loader2 size={12} /> : <Check size={12} />}{dirty ? '保存中' : '已保存'}</span>
    </> : <div className="inline-note-preview" tabIndex={0} aria-label={`编辑${label}`} onClick={(event) => {
      if ((event.target as HTMLElement).closest('a, button, input')) return
      if (window.getSelection()?.toString()) return
      setEditing(true)
    }} onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setEditing(true) }
    }}><MarkdownView content={draft} onInternalLink={onInternalLink} /></div>}
  </div>
}
