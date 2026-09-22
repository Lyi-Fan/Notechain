import type { AppState, AssetRecord } from './types'
import { find } from 'linkifyjs'

export interface BrowserCapture {
  id: string
  mode: 'asset' | 'tray'
  url: string
  title: string
  text: string
  caseId: string
  targetId: string | null
  anchor?: { heading: string; exact: string; prefix: string; suffix: string }
}

export function selectionMarkdown(value: string) {
  const text = value.replace(/\r\n?/g, '\n').trim()
  const escape = (part: string) => part.replace(/([\\`*_{}[\]<>()!#+\-.|~=])/g, '\\$1')
  let result = '', offset = 0
  // Explicit links avoid GFM auto-linking the backslashes in escaped URL text.
  for (const link of find(text).filter((link) => link.type === 'url' && /^https?:\/\//i.test(link.href))) {
    result += escape(text.slice(offset, link.start))
    const href = link.href.replace(/[<>\s]/g, (character) => encodeURIComponent(character))
    result += `[${escape(link.value)}](<${href}>)`
    offset = link.end
  }
  return result + escape(text.slice(offset))
}

export function captureAsset(state: AppState, input: BrowserCapture): { state: AppState; id: string } {
  const id = `web_${input.id}`
  if (state.assets.some((asset) => asset.id === id)) return { state, id }
  const record = state.cases.find((item) => item.id === input.caseId && !item.deletedAt && item.status !== 'archived')
  if (!record || (input.targetId && (!record.targetIds.includes(input.targetId) || !state.targets.some((item) => item.id === input.targetId)))) {
    throw Object.assign(new Error('案件或分类已移除，请重新选择收集位置'), { status: 409 })
  }
  const time = new Date().toISOString()
  const asset: AssetRecord = {
    id, caseId: record.id, targetId: input.targetId || undefined, kind: 'url', value: input.url,
    title: input.title.trim() || input.url, autoTitle: input.title.trim(), status: 'unknown', severity: 'info', confidence: 'low',
    // A browser selection is plain text, not trusted Markdown or HTML.
    tags: [], situation: '', utility: '', nextSteps: '', details: '', noteMarkdown: selectionMarkdown(input.text || ''),
    provenance: { source: input.url, method: input.text?.trim() ? '浏览器划词收集' : '浏览器收集', reason: '', capturedAt: time },
    relationIds: [], findingIds: [], createdAt: time, updatedAt: time, version: 1,
  }
  return { id, state: { ...state, assets: [asset, ...state.assets], cases: state.cases.map((item) => item.id === record.id ? { ...item, assetIds: [id, ...item.assetIds], updatedAt: time } : item) } }
}

export function browserContext(state: AppState, currentCaseId: string | null) {
  const targets = new Map(state.targets.map((item) => [item.id, item.name]))
  const active = state.cases.filter((item) => !item.deletedAt && item.status !== 'archived')
  const current = active.find((item) => item.id === currentCaseId) ?? active.find((item) => item.id === state.lastLocation?.caseId) ?? active.reduce<typeof active[number] | undefined>((latest, item) => !latest || item.createdAt > latest.createdAt ? item : latest, undefined)
  return { currentCaseId: current?.id ?? null, cases: active.map((item) => ({ id: item.id, name: item.name, categories: item.targetIds.filter((id) => targets.has(id)).map((id) => ({ id, name: targets.get(id)! })) })) }
}
