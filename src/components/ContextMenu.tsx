import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ActionMenuItem } from './ActionMenu'

export interface ContextMenuPosition { x: number; y: number; trigger: HTMLElement }

export function ContextMenu({ position, label, items, onClose }: { position: ContextMenuPosition; label: string; items: ActionMenuItem[]; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const menu = root.current!
    const box = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(position.x, innerWidth - box.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(position.y, innerHeight - box.height - 8))}px`
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const outside = (event: Event) => { if (!menu.contains(event.target as Node)) onClose() }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('scroll', outside, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('scroll', outside, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [position, onClose])
  return createPortal(<div ref={root} className="action-menu-popover notebook-context-menu" role="menu" aria-label={label} style={{ left: position.x, top: position.y }} onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); position.trigger.focus(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }}>{items.map((item) => <button key={item.label} type="button" role="menuitem" className={`action-menu-item ${item.danger ? 'danger' : ''}`} disabled={item.disabled} onClick={() => { onClose(); item.onSelect() }}>{item.icon}{item.label}</button>)}</div>, document.body)
}
