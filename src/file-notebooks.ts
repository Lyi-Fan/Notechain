import { nativeInvoke } from './native-storage'

export interface FileNotebook { id: string; name: string; root: string; scopes: string[] }
export interface FileEntry { name: string; path: string; kind: 'directory' | 'file' }
export interface OpenedNotebook { notebook: FileNotebook; path: string; kind: 'notebook' | 'category' | 'file' }
export interface NoteFile { path: string; content: string; revision: string; draft?: { content: string; revision: string } | null }
export interface FileSession { id: string; path: string; revision: string; draft: string; dirty: boolean; queue: Promise<unknown> }
const writes = new Set<Promise<unknown>>()
const failures = new Map<string, { session: FileSession; error: unknown }>()
const sessionKey = (session: FileSession) => session.id + '\0' + session.path
const notifySaves = () => window.dispatchEvent(new Event('notebook-save-state'))
export function unsavedFiles() { return [...failures.values()].map(item => item.session) }

export function notebookCall<T>(input: Record<string, unknown>): Promise<T> {
  if (!nativeInvoke) return Promise.reject(new Error('请在 Mac 客户端中打开本地文件夹'))
  return nativeInvoke<T>('notebook', { input })
}
export function noteFileUrl(id: string, path = '', folder = '') {
  const query = new URLSearchParams()
  if (path) query.set('file', path)
  else if (folder) query.set('folder', folder)
  return '/notebooks/' + encodeURIComponent(id) + (query.size ? '?' + query : '')
}
export function resolveFilePath(source: string, target: string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//') || target.includes('\\')) throw new Error('不支持此文件链接')
  const base = new URL(source.split('/').map(encodeURIComponent).join('/'), 'https://notebook.local/__root__/')
  const url = new URL(target.startsWith('/') ? '/__root__' + target : target, base)
  if (!url.pathname.startsWith('/__root__/')) throw new Error('链接超出笔记本目录')
  return { path: decodeURIComponent(url.pathname.slice('/__root__/'.length)), hash: url.hash }
}
export const isMarkdownLink = (value: string) => !/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith('//') && /\.(md|markdown)(?:[?#]|$)/i.test(value)
export function relativeFileLink(source: string, target: string) {
  const from = source.split('/').slice(0, -1), to = target.split('/')
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift() }
  return [...from.map(() => '..'), ...to.map(encodeURIComponent)].join('/')
}
export async function saveNoteFile(session: FileSession, content: string) {
  let key = sessionKey(session)
  const work = session.queue.catch(() => {}).then(async () => {
    key = sessionKey(session)
    const saved = await notebookCall<{ path: string; revision: string; conflict: boolean }>({
      action: 'save', id: session.id, path: session.path, revision: session.revision, content,
    })
    session.path = saved.path; session.revision = saved.revision
    if (session.draft === content) session.dirty = false
    failures.delete(key); notifySaves()
    return saved
  })
  session.queue = work
  writes.add(work)
  void work.then(() => writes.delete(work), error => { writes.delete(work); failures.set(key, { session, error }); notifySaves() })
  return work
}
export async function flushNoteFiles() {
  while (writes.size) await Promise.all([...writes])
  if (failures.size) throw [...failures.values()][0].error
}
export function acknowledgeFileCopy(session: FileSession, opened: OpenedNotebook & { revision: string }) {
  failures.delete(sessionKey(session))
  session.id = opened.notebook.id; session.path = opened.path; session.revision = opened.revision; session.dirty = false
  notifySaves()
}
export async function flushEditors(allowFailedFiles = false) {
  window.dispatchEvent(new Event('ledger-flush-editors'))
  await Promise.resolve()
  try { await flushNoteFiles() } catch (error) { if (!allowFailedFiles) throw error }
}
