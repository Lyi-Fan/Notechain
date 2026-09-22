import { useEffect, useMemo, useRef, useState } from 'react'
import { fileDocumentTools, notebookCall, noteFileUrl, saveNoteFile, type FileLocation, type FileSession, type NoteFile } from '../file-notebooks'
import { FileDocumentContext } from './FileDocumentContext'
import { NotebookEditor } from './NotebookEditor'
import { MarkdownView } from './MarkdownView'

export function FileLinkPreview({ location, expanded, onOpen }: { location: FileLocation; expanded: boolean; onOpen: (href: string) => void }) {
  const [note, setNote] = useState<NoteFile | null>(null), [error, setError] = useState('')
  const session = useRef<FileSession | null>(null)
  useEffect(() => {
    let active = true; setNote(null); setError('')
    void notebookCall<NoteFile>({ action: 'read', id: location.id, path: location.path }).then(result => {
      if (!active) return
      const content = result.draft?.content ?? result.content
      session.current = { id: location.id, path: location.path, revision: result.draft?.revision ?? result.revision, draft: content, dirty: !!result.draft, queue: Promise.resolve() }
      setNote({ ...result, content })
    }).catch(error => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [location.id, location.path])
  const context = useMemo(() => ({
    ...fileDocumentTools(location.id, location.path, onOpen), title: location.path.split('/').at(-1) ?? '', restoredDraft: !!note?.draft,
    linkChoices: () => [], onDraft: (content: string) => { if (session.current) { session.current.draft = content; session.current.dirty = true } },
  }), [location.id, location.path, onOpen, !!note?.draft])
  if (error) return <p role="alert" className="notebook-image-notice">无法读取来源笔记：{error}</p>
  if (!note) return <p role="status">正在读取来源笔记…</p>
  return <FileDocumentContext.Provider value={context}>{expanded ? <NotebookEditor embedded docId={'file-preview:' + location.id + ':' + location.path} value={note.content} onSave={async content => {
    const saved = await saveNoteFile(session.current!, content)
    setNote(current => current ? { ...current, content, revision: saved.revision, draft: null } : current)
    if (saved.conflict) { setError('来源文件已改变，你的编辑已另存为冲突副本'); onOpen(noteFileUrl(location.id, saved.path)) }
  }} /> : <MarkdownView content={note.content} onInternalLink={onOpen} />}</FileDocumentContext.Provider>
}
