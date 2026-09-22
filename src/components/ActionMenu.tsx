import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'

export type ActionMenuItem = {
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

export function ActionMenu({ label, items }: { label: string; items: ActionMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus() }
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('pointerdown', closeOnOutside); document.removeEventListener('keydown', closeOnEscape) }
  }, [open])

  const focusItem = (from: number, direction: 1 | -1) => {
    for (let offset = 1; offset <= items.length; offset += 1) {
      const index = (from + direction * offset + items.length) % items.length
      if (!items[index].disabled) { itemRefs.current[index]?.focus(); return }
    }
  }

  return <div className="action-menu" ref={rootRef}>
    <button ref={triggerRef} className="action-menu-trigger icon-button" type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); requestAnimationFrame(() => itemRefs.current.find((item) => !item?.disabled)?.focus()) } }}><MoreHorizontal size={18} /></button>
    {open && <div id={menuId} className="action-menu-popover" role="menu" aria-label={label}>{items.map((item, index) => <button key={item.label} ref={(element) => { itemRefs.current[index] = element }} className={`action-menu-item ${item.danger ? 'danger' : ''}`} type="button" role="menuitem" disabled={item.disabled} onClick={() => { if (item.disabled) return; item.onSelect(); setOpen(false); triggerRef.current?.focus() }} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); focusItem(index, 1) } if (event.key === 'ArrowUp') { event.preventDefault(); focusItem(index, -1) } if (event.key === 'Home') { event.preventDefault(); itemRefs.current.find((button) => !button?.disabled)?.focus() } if (event.key === 'End') { event.preventDefault(); [...itemRefs.current].reverse().find((button) => !button?.disabled)?.focus() } }}>{item.icon}{item.label}</button>)}</div>}
  </div>
}
