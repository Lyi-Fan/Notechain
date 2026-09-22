import { nativeInvoke } from './native-storage'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { MAX_IMAGE_BYTES } from './images'

export function fileReadingKey(id: string, path: string) {
  return 'asset-ledger-file-reading-v1:' + bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([id, path]))))
}

export interface FileNotebook { id: string; name: string; root: string; scopes: string[] }
export interface FileEntry { name: string; path: string; kind: 'directory' | 'file' }
export interface OpenedNotebook { notebook: FileNotebook; path: string; kind: 'notebook' | 'category' | 'file' }
export interface NoteFile { path: string; content: string; revision: string; draft?: { content: string; revision: string } | null }
export interface FileSession { id: string; path: string; revision: string; draft: string; dirty: boolean; queue: Promise<unknown> }
export interface FileLocation { id: string; path: string; href: string }
export function parseNotebookHref(href: string): FileLocation | null {
  if (!href.startsWith('/notebooks/')) return null
  try {
    const url = new URL(href, 'https://notebook.local'), parts = url.pathname.split('/')
    const id = decodeURIComponent(parts[2] ?? ''), file = url.searchParams.get('file')
    if (parts.length !== 3 || !id || !file || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')) return null
    return { id, path: file, href: noteFileUrl(id, file) + url.hash }
  } catch { return null }
}
export function fileLinkLocation(id: string, source: string, href: string): FileLocation | null {
  const internal = parseNotebookHref(href)
  if (internal) return internal
  if (!isMarkdownLink(href)) return null
  try { const target = resolveFilePath(source, href); return { id, path: target.path, href: noteFileUrl(id, target.path) + target.hash } } catch { return null }
}
export function transferHref(href: string, origin: string) {
  const source = parseNotebookHref(origin)
  if (source && isMarkdownLink(href)) return fileLinkLocation(source.id, source.path, href)?.href ?? href
  return href.startsWith('#') ? origin.split('#')[0] + href : href
}
export function fileDocumentTools(id: string, path: string, open: (href: string) => void) {
  return {
    href: noteFileUrl(id, path),
    resolveFileLink: (href: string) => fileLinkLocation(id, path, href),
    resolveLink: (href: string) => { const target = fileLinkLocation(id, path, href); return target ? { href, label: target.path.split('/').at(-1) ?? '', bodyPending: true } : null },
    openLink: (href: string) => {
      if (href.startsWith('#')) { open(noteFileUrl(id, path) + href); return true }
      const target = fileLinkLocation(id, path, href)
      if (!target) return false
      open(target.href); return true
    },
    importImage: async (image: File) => {
      if (image.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 20 MB')
      return notebookCall<{ src: string; name: string }>({ action: 'importImage', id, path, bytes: [...new Uint8Array(await image.arrayBuffer())] })
    },
    resolveImage: async (src: string, wiki = false) => {
      if (/^https?:\/\//i.test(src)) return { url: src }
      const result = await notebookCall<{ base64: string; mime: string }>({ action: 'resolveImage', id, path, reference: src, wiki })
      const bytes = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mime }))
      return { url, revoke: () => URL.revokeObjectURL(url) }
    },
  }
}
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
export const isMarkdownLink = (value: string) => !/^[a-z][a-z\d+.-]*:/i.test(value) && !/^\/\/(?:.|$)|^\/(?:cases|notebooks)\//.test(value) && /\.(md|markdown)(?:#|$)/i.test(value.split('?')[0])
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
