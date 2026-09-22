import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { writeClipboardText } from '../platform'
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { common, createLowlight } from 'lowlight'
import { Check, ChevronDown, ChevronUp, Copy, ListOrdered } from 'lucide-react'
import './notebook-code-block.css'

const lowlight = createLowlight(common)
export const CodeBlockPreferences = createContext({ showLines: true, toggleLines: () => {} })

function NotebookCodeBlockView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const { showLines, toggleLines } = useContext(CodeBlockPreferences)
  const [collapsed, setCollapsed] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const languageInput = useRef<HTMLInputElement>(null)
  const language = String(node.attrs.language || 'plaintext')
  const languageLabel = language === 'plaintext' ? '' : language
  const [languageDraft, setLanguageDraft] = useState(languageLabel)
  const lineCount = node.textContent.split('\n').length
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    // Attribute updates re-render this node view. Do not overwrite text while
    // the native input is still receiving a sequence of keystrokes.
    if (document.activeElement !== languageInput.current) setLanguageDraft(languageLabel)
  }, [languageLabel])
  // A keyboard selection can enter a collapsed block without a pointer click.
  useEffect(() => {
    const revealSelection = () => {
      const pos = getPos()
      const { from, to } = editor.state.selection
      if (editor.isFocused && typeof pos === 'number' && from > pos && to < pos + node.nodeSize) setCollapsed(false)
    }
    editor.on('selectionUpdate', revealSelection)
    return () => { editor.off('selectionUpdate', revealSelection) }
  }, [editor, getPos, node.nodeSize])
  const copy = async () => {
    clearTimeout(timer.current)
    try {
      await writeClipboardText(node.textContent)
      setCopyState('copied')
    } catch { setCopyState('error') }
    timer.current = setTimeout(() => setCopyState('idle'), 1800)
  }
  const commitLanguage = () => {
    const next = (languageInput.current?.value ?? languageDraft).replace(/[\r\n`]/g, '')
    if (next !== languageLabel) updateAttributes({ language: next || 'plaintext' })
  }
  useEffect(() => {
    const leaveInput = () => {
      const input = languageInput.current
      if (!input || document.activeElement !== input) return
      commitLanguage()
      input.blur()
    }
    // Run before NotebookEditor's leave handler so its synchronous commit
    // includes a language draft that has not yet lost focus.
    window.addEventListener('blur', leaveInput, true)
    window.addEventListener('beforeunload', leaveInput, true)
    window.addEventListener('pagehide', leaveInput, true)
    return () => {
      window.removeEventListener('blur', leaveInput, true)
      window.removeEventListener('beforeunload', leaveInput, true)
      window.removeEventListener('pagehide', leaveInput, true)
    }
  })
  const collapseLabel = collapsed ? '展开代码块' : '收起代码块'
  const linesLabel = showLines ? '隐藏代码行号' : '显示代码行号'
  const copyLabel = copyState === 'copied' ? '代码已复制' : copyState === 'error' ? '复制失败，请重试' : '复制代码'
  return <NodeViewWrapper className={`notebook-code-block${collapsed ? ' is-collapsed' : ''}`} data-code-language={language}>
    <div className="notebook-code-toolbar" contentEditable={false}>
      <div className="notebook-code-controls">
        <button type="button" className="code-dot code-dot-red" aria-label={collapseLabel} aria-expanded={!collapsed} data-tooltip={collapseLabel} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronDown size={10} /> : <ChevronUp size={10} />}</button>
        <button type="button" className="code-dot code-dot-yellow" aria-label={linesLabel} aria-pressed={showLines} data-tooltip={linesLabel} onClick={toggleLines}><ListOrdered size={10} /></button>
        <button type="button" className="code-dot code-dot-green" aria-label="复制代码" data-tooltip={copyLabel} onClick={copy}>{copyState === 'copied' ? <Check size={10} /> : <Copy size={9} />}</button>
      </div>
      <input ref={languageInput} className="notebook-code-language" aria-label="代码语言" title="代码语言" value={languageDraft} spellCheck={false} autoComplete="off" maxLength={80}
        onChange={(event) => setLanguageDraft(event.target.value.replace(/[\r\n`]/g, ''))}
        onBlur={commitLanguage}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur() } }} />
      <span className="notebook-code-status" role="status">{copyState !== 'idle' ? copyLabel : collapsed ? `${lineCount} 行` : ''}</span>
    </div>
    <div className="notebook-code-body" hidden={collapsed}>
      {showLines && <div className="notebook-code-gutter" contentEditable={false} aria-hidden="true">{Array.from({ length: lineCount }, (_, index) => <span key={index}>{index + 1}</span>)}</div>}
      <pre spellCheck={false}><NodeViewContent<'code'> as="code" style={{ whiteSpace: 'pre' }} /></pre>
    </div>
  </NodeViewWrapper>
}

export const NotebookCodeBlock = CodeBlockLowlight.extend({
  addNodeView() { return ReactNodeViewRenderer(NotebookCodeBlockView) },
}).configure({ lowlight, defaultLanguage: 'plaintext', enableTabIndentation: true, tabSize: 2 })
