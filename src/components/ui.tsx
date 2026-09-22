import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { Globe, Maximize2, Minus, X, PanelTop } from 'lucide-react'
import type { Confidence, Severity } from '../types'
import { confidenceLabel, severityLabel } from '../lib'

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button {...props} className={`icon-button ${className}`} aria-label={label} title={label}>{children}</button>
}

export function StatusBadge({ value, tone = 'neutral' }: { value: string; tone?: string }) {
  return <span className={`status-badge ${tone}`}>{value}</span>
}

export function SeverityBadge({ value }: { value: Severity }) {
  return <span className={`severity-badge severity-${value}`}><i aria-hidden="true" />{severityLabel[value]}</span>
}

export function ConfidenceBadge({ value }: { value: Confidence }) {
  return <span className={`confidence-badge confidence-${value}`}>{confidenceLabel[value]}</span>
}

export function ProgressBar({ value, compact = false }: { value: number; compact?: boolean }) {
  return <div className={`progress-track ${compact ? 'compact' : ''}`} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${value}%` }} /></div>
}

export function Modal({ open, title, eyebrow, onClose, children, footer }: { open: boolean; title: string; eyebrow?: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  if (!open) return null
  return <div className="modal-scrim" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-head">
        <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>
        <IconButton label="关闭" onClick={onClose}><X size={17} /></IconButton>
      </header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </section>
  </div>
}

export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span className="field-label">{label}{hint && <small>{hint}</small>}</span>{children}</label>
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) { return <input className="text-input" {...props} /> }
export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea className="text-input text-area" {...props} /> }

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body: string; action?: ReactNode }) {
  return <div className="empty-state">{icon && <div className="empty-icon">{icon}</div>}<h3>{title}</h3><p>{body}</p>{action}</div>
}

export function SectionHeading({ kicker, title, action }: { kicker?: string; title: string; action?: ReactNode }) {
  return <div className="section-heading"><div>{kicker && <span className="section-kicker">{kicker}</span>}<h2>{title}</h2></div>{action}</div>
}

export function DesktopChrome() {
  const bridge = window.assetLedgerDesktop
  if (!bridge) return null
  return <div className="desktop-chrome" aria-label="窗口控制">{bridge.manageNotch && <button type="button" onClick={() => { void bridge.manageNotch?.() }} aria-label="刘海中转站" title="连接或断开刘海中转站"><PanelTop size={14} /></button>}{bridge.manageBrowser && <button type="button" onClick={() => { void bridge.manageBrowser?.() }} aria-label="浏览器连接" title="浏览器连接"><Globe size={14} /></button>}<button type="button" onClick={() => bridge.minimize()} aria-label="最小化"><Minus size={13} /></button><button type="button" onClick={() => bridge.maximize()} aria-label="最大化"><Maximize2 size={12} /></button><button type="button" className="close-window" onClick={() => bridge.close()} aria-label="关闭"><X size={13} /></button></div>
}
