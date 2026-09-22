import type { AppState, AssetRecord, CaseRecord } from './types'
import type { LinkFields } from './notebook-links'
import { selectionMarkdown } from './browser-capture'
import { noteHref } from './notes'

export const TRANSFER_MIME = 'application/x-asset-ledger-transfer+json'
export const TRANSFER_STORAGE = 'asset-ledger-transfer-v1'
export interface TransferClip { id: string; title: string; href: string; text: string; createdAt: string; fields?: LinkFields }
export interface TextCapture { id: string; text: string; title?: string; caseId?: string; targetId?: string; url?: string }
export interface TransferReference { version: 1; libraryId: string; clipId: string }
const identifier = /^[a-zA-Z0-9_-]{1,100}$/

export function transferUri(libraryId: string, clipId: string) {
  if (!identifier.test(libraryId) || !identifier.test(clipId)) throw new Error('Invalid transfer reference')
  return `asset-ledger://transfer/${libraryId}/${clipId}`
}

export function readTransferReferences(data: Pick<DataTransfer, 'getData'>): TransferReference[] {
  try {
    const text = (data.getData('text/uri-list') || data.getData('text/plain')).trim()
    const lines = text.split(/\r?\n/).filter(line => line && !line.startsWith('#'))
    const fromUri = (uri: string): TransferReference | null => {
      const match = /^asset-ledger:\/\/transfer\/([a-zA-Z0-9_-]{1,100})\/([a-zA-Z0-9_-]{1,100})$/.exec(uri)
      return match ? { version: 1, libraryId: match[1], clipId: match[2] } : null
    }
    if (lines.length > 1) {
      if (lines.length > 100) return []
      const references = lines.map(fromUri)
      return references.every((reference): reference is TransferReference => reference !== null) ? references : []
    }
    const custom = data.getData(TRANSFER_MIME)
    if (custom) {
      const value = JSON.parse(custom)
      if (value.version === 1 && identifier.test(value.libraryId ?? '') && identifier.test(value.clipId ?? '')) return [value]
      return []
    }
    const reference = fromUri(text)
    return reference ? [reference] : []
  } catch { return [] }
}

export function readTransferReference(data: Pick<DataTransfer, 'getData'>): TransferReference | null {
  const references = readTransferReferences(data)
  return references.length === 1 ? references[0] : null
}

export function captureTextSource(state: AppState, input: TextCapture): { state: AppState; clip: TransferClip } {
  const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 409 }) }
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{8,70}$/.test(input.id) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 24000) fail('摘录为空或超过 24,000 字符')
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 1000)) fail('标题过长')
  let sourceUrl = ''
  if (input.url) {
    const parsed = new URL(input.url)
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('来源网址不受支持')
    sourceUrl = parsed.href
  }
  const text = input.text.replace(/\r\n?/g, '\n').trim()
  const title = input.title?.trim() || [...text.split('\n')[0]].slice(0, 48).join('')
  const id = `notch_${input.id}`
  const existing = state.assets.find(asset => asset.id === id)
  const markdown = selectionMarkdown(text)
  if (existing && (existing.deletedAt || existing.noteMarkdown !== markdown || existing.title !== title || existing.value !== sourceUrl)) fail('该收集请求已存在，内容不一致')
  let record = input.caseId ? state.cases.find(item => item.id === input.caseId) : state.cases.find(item => item.inbox && !item.deletedAt && item.status !== 'archived')
  if (input.caseId && (!record || record.deletedAt || record.status === 'archived')) fail('案件已移除或归档')
  if (input.targetId && (!record?.targetIds.includes(input.targetId) || !state.targets.some(item => item.id === input.targetId))) fail('分类不属于当前案件')
  const time = new Date().toISOString()
  let next = state
  if (!record) {
    record = { id: `inbox_${crypto.randomUUID()}`, name: '收集箱', code: 'INBOX', summary: '', status: 'active', progress: 0, priority: 'low', tags: [], targetIds: [], assetIds: [], findingIds: [], taskIds: [], timeline: [], createdAt: time, updatedAt: time, inbox: true } satisfies CaseRecord
    next = { ...state, cases: [record, ...state.cases] }
  }
  if (existing && (existing.caseId !== record.id || (existing.targetId || '') !== (input.targetId || ''))) fail('该收集请求的保存位置已改变')
  const asset: AssetRecord = existing ?? { id, caseId: record.id, targetId: input.targetId || undefined, title, kind: 'url', value: sourceUrl, status: 'unknown', severity: 'info', confidence: 'low', tags: [], situation: '', utility: '', nextSteps: '', details: '', provenance: { source: sourceUrl || '外部摘录', method: '刘海中转站', reason: '', capturedAt: time }, relationIds: [], findingIds: [], createdAt: time, updatedAt: time, version: 1, noteMarkdown: markdown }
  if (!existing) next = { ...next, assets: [asset, ...next.assets], cases: next.cases.map(item => item.id === asset.caseId ? { ...item, assetIds: [id, ...item.assetIds], updatedAt: time } : item) }
  return { state: next, clip: { id, title, href: noteHref(asset), text, createdAt: asset.createdAt, fields: { annotation: '', excerpt: text, sourceTitle: title } } }
}
