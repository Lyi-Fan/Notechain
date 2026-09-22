import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { FileDocumentContext } from './FileDocumentContext'
import { isMarkdownLink } from '../file-notebooks'
import { createPortal, flushSync } from 'react-dom'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { createNotebookMarkdown } from '../notebook-markdown'
import { MarkdownTyping, NotebookBold, NotebookHorizontalRule, NotebookInlineCode, NotebookItalic, NotebookStrike } from '../markdown-formatting'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { TableKit } from '@tiptap/extension-table'
import Placeholder from '@tiptap/extension-placeholder'
import Heading from '@tiptap/extension-heading'
import { Bold, Check, Code2, Copy, Flag, Heading2, ImagePlus, Inbox, Italic, ListTodo, LockKeyhole, MessageSquarePlus, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useLedger } from '../store'
import { assetMarkdown, caseMarkdown, findingMarkdown, headingSlug, noteHref, safeNoteLink } from '../notes'
import { MarkdownEditor } from './MarkdownEditor'
import { CodeBlockPreferences, NotebookCodeBlock } from './NotebookCodeBlock'
import { NotebookSelection } from './NotebookSelection'
import { bindLinkInteractions, deleteWholeLinkAtBoundary, finishLinkAnnotation, normalizeNotebookLinks, NotebookLink, NotebookLinkAnnotation } from './NotebookLinkAnnotation'
import { linkAttributes, readLinkFields, resolveNotebookTarget } from '../notebook-links'
import { explanationHref, explanationsIn, updateExplanation } from '../explanations'
import { ContextMenu, type ContextMenuPosition } from './ContextMenu'
import { AssetLinkPreview, type AssetLinkPreviewHandle, type PreviewItem } from './AssetLinkPreview'
import { flushNative, nativeInvoke } from '../native-storage'
import { openExternalUrl, writeClipboardText } from '../platform'
import { useTransferEditor } from './TransferTray'
import { finishLiveMarkdown, hasLiveMarkdown, LiveMarkdown } from './LiveMarkdown'
import { ManagedImage } from './ManagedImage'
import { storeImage } from '../images'
import { closeHistory } from '@tiptap/pm/history'
import { NotebookSecret } from './NotebookSecret'

export interface NoteSelection { text: string; anchor: string; from: number; to: number; replace: (markdown: string) => void }
interface Props { docId: string; value: string; onSave: (markdown: string) => void | Promise<unknown>; label?: string; onFinding?: (selection: NoteSelection, sensitive: boolean) => void; embedded?: boolean; footerTarget?: HTMLElement | null }
const AnchoredHeading = Heading.extend({
  addAttributes() { return { ...this.parent?.(), id: { default: null } } },
})

export function NotebookEditor({ docId, value, onSave, label = '笔记正文', onFinding, embedded = false, footerTarget }: Props) {
  const file = useContext(FileDocumentContext)
  const fileRef = useRef(file); fileRef.current = file
  const [saveError, setSaveError] = useState('')
  const { assets, cases, findings, tasks, updateAsset, updateCase, updateFinding } = useLedger()
  const navigate = useNavigate()
  const markdownExtension = useMemo(createNotebookMarkdown, [docId])
  const [dirty, setDirty] = useState(!!file?.restoredDraft)
  const [source, setSource] = useState(false)
  const [showCodeLines, setShowCodeLines] = useState(true)
  const [draft, setDraft] = useState(value)
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null)
  const [context, setContext] = useState<{ position: ContextMenuPosition; explanationId?: string } | null>(null)
  const closeContext = useCallback(() => setContext(null), [])
  const [imageNotice, setImageNotice] = useState('')
  const imageInput = useRef<HTMLInputElement>(null)
  const previewRef = useRef<AssetLinkPreviewHandle>(null)
  const pending = useRef<string | null>(file?.restoredDraft ? value : null)
  const savedNote = useRef(false)
  savedNote.current = assets.some((item) => item.id === docId && item.noteMarkdown !== undefined) || cases.some((item) => item.id === docId && item.noteMarkdown !== undefined) || findings.some((item) => item.id === docId && item.noteMarkdown !== undefined)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const saveRef = useRef(onSave)
  const rootRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const composing = useRef(false)
  const savingVersion = useRef(0)
  saveRef.current = onSave
  const commit = useCallback(() => {
    clearTimeout(timer.current)
    if (composing.current) return Promise.resolve(false)
    if (pending.current === null) return Promise.resolve(true)
    const content = pending.current
    const version = ++savingVersion.current
    pending.current = null
    let saved: void | Promise<unknown>
    try { saved = saveRef.current(content) } catch (error) { saved = Promise.reject(error) }
    return Promise.resolve(saved).then(() => new Promise(resolve => setTimeout(resolve, 0))).then(() => flushNative()).then(() => {
      if (version === savingVersion.current) { setSaveError(''); if (pending.current === null) setDirty(false) }
      return true
    }).catch(error => { if (version === savingVersion.current) { setDirty(true); setSaveError(String(error)); if (pending.current === null) pending.current = content } return false })
  }, [])
  const change = useCallback((content: string) => {
    setDraft(content)
    fileRef.current?.onDraft(content)
    pending.current = content
    setDirty(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(commit, 500)
  }, [commit])
  useEffect(() => {
    if (fileRef.current?.restoredDraft) timer.current = setTimeout(commit, 500)
    return () => clearTimeout(timer.current)
  }, [docId, commit])
  const assignAnchors = useCallback(() => {
    const current = editorRef.current
    if (!current || current.isDestroyed || hasLiveMarkdown(current)) return
    const counts = new Map<string, number>()
    const transaction = current.state.tr
    current.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'heading') return
      const slug = headingSlug(node.textContent)
      const count = counts.get(slug) ?? 0
      counts.set(slug, count + 1)
      const id = count ? `${slug}-${count}` : slug
      if (node.attrs.id !== id) transaction.setNodeMarkup(pos, undefined, { ...node.attrs, id })
    })
    if (transaction.docChanged) current.view.dispatch(transaction.setMeta('addToHistory', false).setMeta('notebookAnchors', true))
    normalizeNotebookLinks(current, (target) => targetRef.current(target))
  }, [])
  const resolveTarget = (value: string) => fileRef.current?.resolveLink(value) ?? resolveNotebookTarget(value, assets, cases, findings, tasks)
  const targetRef = useRef(resolveTarget)
  targetRef.current = resolveTarget
  const openLink = (target: string) => {
    if (fileRef.current?.openLink(target)) return
    let href = resolveTarget(target).href
    if (/^(?:\d{1,3}(?:\.\d{1,3}){3}|localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]|$)/i.test(href)) href = `http://${href}`
    commit()
    if (href.startsWith('asset://')) {
      const [id, anchor] = href.slice(8).split('#')
      const target = assets.find((asset) => asset.id === id)
      if (target) navigate(noteHref(target) + (anchor ? `#${anchor}` : ''))
    } else if (href.startsWith('case://')) navigate(`/cases/${href.slice(7)}`)
    else if (href.startsWith('/cases/') || href.startsWith('/notebooks/') || href.startsWith('#')) navigate(href.startsWith('#') ? { hash: href } : href)
    else if (safeNoteLink(href)) void openExternalUrl(href).catch(() => setImageNotice('无法打开外部链接，请检查地址。'))
  }
  const linkRef = useRef(openLink)
  linkRef.current = openLink
  const updateBubble = (editor: Editor) => {
    const { from, to, empty } = editor.state.selection
    if (empty || !editor.isFocused || editor.isActive('codeBlock')) { setBubble(null); return }
    const start = editor.view.coordsAtPos(from)
    const end = editor.view.coordsAtPos(to)
    setBubble({ x: Math.max(12, Math.min(window.innerWidth - 296, (start.left + end.left) / 2 - 140)), y: Math.max(56, start.top - 46) })
  }
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, link: false, bold: false, italic: false, code: false, strike: false, horizontalRule: false }), NotebookBold, NotebookItalic, NotebookInlineCode, NotebookStrike, NotebookHorizontalRule, MarkdownTyping, NotebookLink.configure({ openOnClick: false, protocols: ['asset', 'case'], isAllowedUri: (url) => safeNoteLink(url) || (!!fileRef.current && isMarkdownLink(url)) }), AnchoredHeading, NotebookCodeBlock, NotebookLinkAnnotation, NotebookSelection,
      markdownExtension, TaskList, TaskItem.configure({ nested: true }), TableKit,
      ManagedImage, NotebookSecret, LiveMarkdown.configure({ onChange: change }), Placeholder.configure({ placeholder: '写点什么…' }),
    ],
    content: value, contentType: 'markdown',
    editorProps: {
      attributes: { class: 'notebook-prose', 'aria-label': label, spellcheck: 'false' },
      handlePaste: (_view, event) => {
        const current = editorRef.current, text = event.clipboardData?.getData('text/plain')
        if (!current || !text || event.clipboardData?.getData('text/html') || current.isActive('codeBlock') || current.isActive('code')) return false
        const parsed = current.markdown!.parse(text)
        const blocks = parsed.content ?? []
        const content = blocks.length === 1 && blocks[0].type === 'paragraph' ? blocks[0].content : blocks
        if (!content?.length) return false
        event.preventDefault()
        return current.commands.insertContent(content)
      },
      handleKeyDown: (view, event) => {
        if (!event.isComposing && !view.composing && !event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'Backspace' || event.key === 'Delete') && editorRef.current && deleteWholeLinkAtBoundary(editorRef.current, event.key)) {
          event.preventDefault()
          return true
        }
        if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || view.composing) return false
        const { from, to, empty, $from, $to } = view.state.selection
        if (empty || !$from.sameParent($to) || !$from.parent.inlineContent || $from.parent.type.spec.code) return false
        const text = view.state.doc.textBetween(from, to, '\n', '\n')
        if (Array.from(text).length <= 2 || !text.trim() || /[\r\n]/.test(text)) return false
        return editorRef.current?.commands.toggleCode() ?? false
      },
      handleClick: (_view, _pos, event) => {
        const link = (event.target as HTMLElement).closest('a')
        if (!link) return false
        event.preventDefault()
        return true
      },
    },
    onCreate: () => requestAnimationFrame(assignAnchors),
    onUpdate: ({ editor: next, transaction }) => {
      if (transaction.getMeta('notebookAnchors')) return
      if (transaction.getMeta('notebookLinks')) {
        // Rendering generated summaries must not freeze them into saved notes.
        if (pending.current !== null || savedNote.current) change(next.getMarkdown())
        else setDraft(next.getMarkdown())
        return
      }
      change(next.getMarkdown())
      requestAnimationFrame(assignAnchors)
    },
    onSelectionUpdate: ({ editor: next }) => updateBubble(next),
    onBlur: () => { commit(); setBubble(null) },
  }, [docId])
  editorRef.current = editor
  const sourceAsset = assets.find((asset) => asset.id === docId)
  const sourceCase = cases.find((item) => item.id === docId)
  const sourceFinding = findings.find((item) => item.id === docId)
  const stageSelection = useTransferEditor(editor, {
    title: sourceAsset?.title ?? sourceCase?.name ?? sourceFinding?.title ?? fileRef.current?.title ?? label,
    href: sourceAsset ? noteHref(sourceAsset) : sourceCase ? `/cases/${sourceCase.id}` : sourceFinding ? `/cases/${sourceFinding.caseId}/findings/${sourceFinding.id}` : fileRef.current?.href ?? location.pathname + location.search,
  }, commit, source)
  useEffect(() => {
    if (!editor || source) return
    const frame = requestAnimationFrame(() => normalizeNotebookLinks(editor, (target) => targetRef.current(target)))
    return () => cancelAnimationFrame(frame)
  }, [editor, source, assets, cases, findings, tasks])
  useEffect(() => {
    if (!editor || source || !rootRef.current) return
    return bindLinkInteractions(editor, rootRef.current, (target) => targetRef.current(target), () => { previewRef.current?.dismiss(); setBubble(null) }, (href) => linkRef.current(href))
  }, [editor, source])
  useEffect(() => {
    const leave = () => { finishLiveMarkdown(editorRef.current); finishLinkAnnotation(editorRef.current); if (pending.current !== null) flushSync(commit) }
    const exporting = (event: Event) => { if ((event as CustomEvent).detail === docId) leave() }
    const hidden = () => { if (document.visibilityState === 'hidden') leave() }
    const closeBubble = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.notebook-link-preview')) return
      setBubble(null); previewRef.current?.dismiss()
    }
    window.addEventListener('beforeunload', leave)
    window.addEventListener('ledger-flush-editors', leave)
    window.addEventListener('pagehide', leave)
    window.addEventListener('blur', leave)
    window.addEventListener('ledger-export-note', exporting)
    document.addEventListener('visibilitychange', hidden)
    document.addEventListener('scroll', closeBubble, true)
    return () => {
      commit()
      window.removeEventListener('beforeunload', leave)
      window.removeEventListener('ledger-flush-editors', leave)
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('blur', leave)
      window.removeEventListener('ledger-export-note', exporting)
      document.removeEventListener('visibilitychange', hidden)
      document.removeEventListener('scroll', closeBubble, true)
    }
  }, [commit, docId])
  useEffect(() => {
    if (pending.current !== null || !editor || editor.isFocused || hasLiveMarkdown(editor)) return
    if (editor.getMarkdown() !== value) editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
    setDraft(value)
    requestAnimationFrame(assignAnchors)
  }, [value, editor, assignAnchors])
  const selectFinding = (sensitive: boolean) => {
    if (!editor || !onFinding) return
    const { from, to } = editor.state.selection
    const text = editor.state.doc.textBetween(from, to, '\n')
    const anchor = [...(rootRef.current?.querySelectorAll<HTMLElement>('.tiptap [id]') ?? [])].filter((heading) => heading.getBoundingClientRect().top <= editor.view.coordsAtPos(from).top).at(-1)?.id ?? ''
    onFinding({ text, anchor, from, to, replace: (markdown) => { editor.chain().focus().insertContentAt({ from, to }, markdown, { contentType: 'markdown' }).run(); commit() } }, sensitive)
    setBubble(null)
  }
  const explanations = useMemo(() => explanationsIn(editor), [editor, draft])
  const addExplanation = () => {
    if (!editor || embedded || editor.state.selection.empty) return
    const { from, to, $from, $to } = editor.state.selection
    if (!$from.sameParent($to) || !$from.parent.inlineContent || editor.isActive('codeBlock')) return
    const title = editor.state.doc.textBetween(from, to)
    if (!title.trim()) return
    const id = crypto.randomUUID()
    editor.chain().focus().setMark('link', linkAttributes(explanationHref(id), { annotation: title, explanation: { id, content: '' } })).run()
    setBubble(null)
    requestAnimationFrame(() => previewRef.current?.openExplanation(id))
  }
  const insertImages = async (files: File[]) => {
    if (!editor || editor.isDestroyed || !files.length) return
    if (source) { setImageNotice('请返回笔记后插入图片'); return }
    finishLiveMarkdown(editor, true)
    finishLinkAnnotation(editor)
    let bookmark = editor.state.selection.getBookmark()
    const map = ({ transaction }: { transaction: import('@tiptap/pm/state').Transaction }) => { bookmark = bookmark.map(transaction.mapping) }
    editor.on('transaction', map)
    setImageNotice('正在导入图片…')
    try {
      const images = []
      for (const image of files) images.push(await (fileRef.current ? fileRef.current.importImage(image) : storeImage(image)))
      if (editor.isDestroyed) return
      const selection = bookmark.resolve(editor.state.doc)
      editor.view.dispatch(closeHistory(editor.state.tr))
      editor.chain().focus().insertContentAt({ from: selection.from, to: selection.to }, images.map(image => ({ type: 'image', attrs: { src: image.src, alt: image.name } }))).run()
      editor.view.dispatch(closeHistory(editor.state.tr))
      commit()
      setImageNotice('')
    } catch (error) { if (!editor.isDestroyed) setImageNotice(error instanceof Error ? error.message : '图片导入失败') }
    finally { editor.off('transaction', map) }
  }
  const renderPreviewEditor = (item: PreviewItem) => {
    if (item.kind === 'explanation') return <FileDocumentContext.Provider value={file ? { ...file, title: item.title, restoredDraft: false, onDraft: () => {} } : null}><NotebookEditor key={item.key} embedded docId={docId + ':' + item.key} value={item.explanation.content} label="扩展解释正文" onSave={async content => {
      if (!editor) throw new Error('原笔记已关闭')
      updateExplanation(editor, item.explanation.id, content)
      if (!await commit()) throw new Error('扩展解释尚未保存到原笔记')
    }} /></FileDocumentContext.Provider>
    if (item.kind === 'file') return null
    if (item.kind === 'asset') return <NotebookEditor key={item.record.id} embedded docId={item.record.id} value={assetMarkdown(item.record)} label={`${item.record.title}笔记正文`} onSave={(noteMarkdown) => updateAsset(item.record.id, { noteMarkdown })} />
    if (item.kind === 'case') {
      const caseAssets = assets.filter((asset) => item.record.assetIds.includes(asset.id))
      const caseTasks = tasks.filter((task) => item.record.taskIds.includes(task.id))
      return <NotebookEditor key={item.record.id} embedded docId={item.record.id} value={caseMarkdown(item.record, caseAssets, caseTasks)} label={`${item.record.name}笔记`} onSave={(noteMarkdown) => updateCase(item.record.id, { noteMarkdown })} />
    }
    return <NotebookEditor key={item.record.id} embedded docId={item.record.id} value={findingMarkdown(item.record)} label={`${item.record.title}笔记`} onSave={(noteMarkdown) => updateFinding(item.record.id, { noteMarkdown })} />
  }
  return <div className="notebook-editor" ref={rootRef} onContextMenu={event => {
    if (source || embedded || !editor) return
    const link = event.target instanceof Element ? event.target.closest('a[data-notebook-link]') : null
    const explanationId = readLinkFields(link?.getAttribute('data-notebook-link'))?.explanation?.id
    if (!explanationId && editor.state.selection.empty) return
    event.preventDefault(); setBubble(null)
    setContext({ position: { x: event.clientX, y: event.clientY, trigger: editor.view.dom }, explanationId })
  }} onCompositionStartCapture={() => { composing.current = true }} onCompositionEndCapture={() => { composing.current = false; clearTimeout(timer.current); timer.current = setTimeout(commit, 0) }} onPasteCapture={(event) => {
    const files = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'))
    if (files.length) { event.preventDefault(); event.stopPropagation(); void insertImages(files) }
  }} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDropCapture={(event) => {
    const files = [...event.dataTransfer.files].filter(file => file.type.startsWith('image/'))
    if (!files.length) return
    event.preventDefault(); event.stopPropagation()
    finishLiveMarkdown(editor)
    const position = editor?.view.posAtCoords({ left: event.clientX, top: event.clientY })
    if (position) editor?.commands.setTextSelection(position.pos)
    void insertImages(files)
  }} onKeyDown={(event) => { if (event.key === 'Escape' && !(event.target as HTMLElement).closest('.notebook-live-source')) { setContext(null); setBubble(null); previewRef.current?.dismiss(); editor?.commands.focus() } }}>
    <CodeBlockPreferences.Provider value={{ showLines: showCodeLines, toggleLines: () => setShowCodeLines((visible) => !visible) }}>
      {source ? <MarkdownEditor inline value={draft} minHeight={420} placeholder="Markdown 源码" onChange={change} /> : <EditorContent editor={editor} />}
    </CodeBlockPreferences.Provider>
    {imageNotice && <p className="notebook-image-notice" role="status">{imageNotice}</p>}
    {saveError && <p className="notebook-image-notice" role="alert">保存失败：{saveError}</p>}
    <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => { const files = [...event.target.files ?? []]; event.target.value = ''; void insertImages(files) }} />
    {((footer) => footerTarget ? createPortal(footer, footerTarget) : footer)(<div className="notebook-editor-foot"><span role="status">{dirty ? '保存中…' : <><Check size={12} />已保存</>}</span><span>{(source ? draft : editor?.state.doc.textContent ?? '').replace(/\s/g, '').length} 字</span>{!source && <button type="button" title="插入图片" aria-label="插入图片" onClick={() => imageInput.current?.click()}><ImagePlus size={16} /></button>}<button type="button" title={source ? '返回笔记' : 'Markdown 源码'} aria-label={source ? '返回笔记' : 'Markdown 源码'} onClick={() => { finishLiveMarkdown(editor); if (source) { editor?.commands.setContent(draft, { contentType: 'markdown', emitUpdate: false }); requestAnimationFrame(assignAnchors) } commit(); setSource(!source); setBubble(null) }}><Code2 size={15} /></button></div>)}
    {bubble && !source && !context && <div className="notebook-bubble" role="toolbar" aria-label="选中文本操作" style={{ left: bubble.x, top: bubble.y }} onMouseDown={(event) => event.preventDefault()}>
      <button title="加粗" aria-label="加粗" onClick={() => editor?.chain().focus().toggleBold().run()}><Bold size={16} /></button><button title="斜体" aria-label="斜体" onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic size={16} /></button><button title="标题" aria-label="标题" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={17} /></button><button title="待办" aria-label="待办" onClick={() => editor?.chain().focus().toggleTaskList().run()}><ListTodo size={17} /></button>{!embedded && <button title="添加扩展解释" aria-label="添加扩展解释" onClick={addExplanation}><MessageSquarePlus size={16} /></button>}<button title="加入中转站" aria-label="加入中转站" onClick={stageSelection}><Inbox size={16} /></button>{onFinding && <><i /><button title="记为发现" aria-label="记为发现" onClick={() => selectFinding(false)}><Flag size={16} /></button><button title="收起为敏感发现" aria-label="收起为敏感发现" onClick={() => selectFinding(true)}><LockKeyhole size={16} /></button></>}
    </div>}
    {context && editor && <ContextMenu position={context.position} label="正文操作" onClose={closeContext} items={context.explanationId ? [
      { label: '编辑扩展解释', icon: <MessageSquarePlus size={15} />, onSelect: () => previewRef.current?.openExplanation(context.explanationId!) },
      { label: '移除解释，保留文字', icon: <Trash2 size={15} />, onSelect: () => { updateExplanation(editor, context.explanationId!, null); void commit() } },
    ] : [
      { label: '添加扩展解释', icon: <MessageSquarePlus size={15} />, onSelect: addExplanation, disabled: !editor.state.selection.$from.sameParent(editor.state.selection.$to) || editor.isActive('codeBlock') },
      { label: '加入中转站', icon: <Inbox size={15} />, onSelect: stageSelection },
      { label: '复制', icon: <Copy size={15} />, onSelect: () => { void writeClipboardText(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, '\n')) } },
    ]} />}
    {!embedded && !source && <FileDocumentContext.Provider value={null}><AssetLinkPreview ref={previewRef} root={rootRef} assets={assets} cases={cases} findings={findings} tasks={tasks} explanations={explanations} resolveFileLink={file?.resolveFileLink} onOpen={(href) => linkRef.current(href)} renderEditor={renderPreviewEditor} /></FileDocumentContext.Provider>}
  </div>
}
