import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Eye, EyeOff } from 'lucide-react'
import { maskSecret } from '../secrets'
import { writeClipboardText } from '../platform'

export function SecretValue({ value, identity }: { value: string; identity: string }) {
  const [revealed, setRevealed] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const copyTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => { setRevealed(false); setCopyState('idle'); clearTimeout(copyTimer.current); return () => clearTimeout(copyTimer.current) }, [identity, value])
  useEffect(() => {
    if (!revealed) return
    const hide = () => setRevealed(false)
    const hidden = () => { if (document.hidden) hide() }
    window.addEventListener('blur', hide)
    document.addEventListener('visibilitychange', hidden)
    return () => { window.removeEventListener('blur', hide); document.removeEventListener('visibilitychange', hidden) }
  }, [revealed])
  const copy = async () => {
    clearTimeout(copyTimer.current)
    try { await writeClipboardText(value); setCopyState('copied') } catch { setCopyState('error') }
    copyTimer.current = setTimeout(() => setCopyState('idle'), 1400)
  }
  const copyLabel = copyState === 'copied' ? '已复制密钥' : copyState === 'error' ? '复制失败，请重试' : '复制密钥'
  return <span className="secret-value" data-revealed={revealed}>
    <code>{revealed ? value : maskSecret()}</code>
    <span className="secret-tools">
      <button type="button" className="secret-eye" title={revealed ? '隐藏密钥' : '显示密钥'} aria-label={revealed ? '隐藏密钥' : '显示密钥'} aria-pressed={revealed}
        onMouseDown={event => event.preventDefault()} onClick={event => { event.preventDefault(); event.stopPropagation(); setRevealed(current => !current) }}>
        {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
      <button type="button" className="secret-copy" title={copyLabel} aria-label={copyLabel}
        onMouseDown={event => event.preventDefault()} onClick={event => { event.preventDefault(); event.stopPropagation(); void copy() }}>
        {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </span>
  </span>
}
