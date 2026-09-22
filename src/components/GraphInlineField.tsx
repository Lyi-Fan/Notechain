import { useCallback, useEffect, useRef, useState } from 'react'

export function GraphInlineField({ value, label, placeholder, rows = 1, multiline = rows > 1, maxLength, onSave, onFocus, focus = false }: {
  value: string; label: string; placeholder?: string; rows?: number; maxLength: number
  onSave: (value: string) => boolean; onFocus?: () => void; focus?: boolean; multiline?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const latest = useRef({ value, onSave }); latest.current = { value, onSave }
  const pending = useRef<string | null>(null), composing = useRef(false), focused = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const flush = useCallback(() => {
    clearTimeout(timer.current)
    if (composing.current || pending.current === null) return
    const text = pending.current
    pending.current = null
    if (text !== latest.current.value && !latest.current.onSave(text)) pending.current = text
  }, [])
  const schedule = () => { clearTimeout(timer.current); if (!composing.current) timer.current = setTimeout(flush, 300) }
  useEffect(() => { if (!focused.current && pending.current === null) setDraft(value) }, [value, editing])
  useEffect(() => {
    window.addEventListener('ledger-flush-editors', flush)
    return () => { flush(); window.removeEventListener('ledger-flush-editors', flush) }
  }, [flush])
  useEffect(() => { if (focus) { input.current?.focus({ preventScroll: true }); input.current?.select() } }, [focus])
  return <textarea ref={input} className="graph-inline-input nodrag nopan" aria-label={label} rows={rows} maxLength={maxLength}
    placeholder={placeholder} value={draft} spellCheck={false}
    onFocus={() => { focused.current = true; setEditing(true); onFocus?.() }}
    onBlur={() => { focused.current = false; setEditing(false); flush() }}
    onChange={event => { setDraft(event.target.value); pending.current = event.target.value; schedule() }}
    onCompositionStart={() => { composing.current = true; clearTimeout(timer.current) }}
    onCompositionEnd={event => { composing.current = false; pending.current = event.currentTarget.value; setDraft(event.currentTarget.value); flush() }}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.nativeEvent.isComposing || composing.current) return
      if (event.key === 'Escape') { pending.current = null; clearTimeout(timer.current); setDraft(latest.current.value); input.current?.blur() }
      if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); flush(); input.current?.blur() }
    }} />
}
