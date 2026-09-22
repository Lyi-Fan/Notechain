import { Database, NotebookPen } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ledgerStorage, nativeInvoke } from '../native-storage'
import { flushEditors } from '../file-notebooks'

export function ModeSwitch() {
  const navigate = useNavigate(), { pathname } = useLocation()
  if (!nativeInvoke) return null
  const notes = pathname.startsWith('/notebooks')
  const select = async (mode: 'assets' | 'notes') => {
    try {
      await flushEditors(mode === 'notes')
      ledgerStorage.setItem('asset-ledger-mode', mode)
      navigate(mode === 'notes' ? '/notebooks' : '/')
    } catch (error) { window.dispatchEvent(new CustomEvent('ledger-native-error', { detail: String(error) })) }
  }
  return <div className="mode-switch" role="group" aria-label="工作模式">
    <button aria-pressed={!notes} title="资产收集模式" onClick={() => void select('assets')}><Database size={14} /><span>资产收集</span></button>
    <button aria-pressed={notes} title="笔记模式" onClick={() => void select('notes')}><NotebookPen size={14} /><span>笔记</span></button>
  </div>
}
