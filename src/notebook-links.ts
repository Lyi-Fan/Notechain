import type { AssetRecord, CaseRecord, FindingRecord, TaskRecord } from './types'
import { assetMarkdown, assetIdFromNoteHref, caseMarkdown, findingMarkdown, noteHref } from './notes'
import { displayUrl } from './url-display'
import { isSecretFinding, maskSecret } from './secrets'

const PREFIX = 'asset-ledger-link:v1:'
export interface LinkFields { annotation: string; excerpt?: string; originalTitle?: string; sourceTitle?: string; sourceAnchor?: { heading: string; exact: string; prefix: string; suffix: string } }
export interface LinkTarget { href: string; label: string; getContent?: () => string; bodyPending?: boolean; secret?: { findingId: string; caseId: string } }

// A standard Markdown link title preserves the independent fields on roundtrip.
export function readLinkFields(title: unknown): LinkFields | null {
  if (typeof title !== 'string' || !title.startsWith(PREFIX)) return null
  try {
    const fields: unknown = JSON.parse(decodeURIComponent(title.slice(PREFIX.length)))
    if (!fields || typeof fields !== 'object' || !('annotation' in fields) || typeof fields.annotation !== 'string') return null
    return {
      annotation: fields.annotation,
      ...('excerpt' in fields && typeof fields.excerpt === 'string' ? { excerpt: fields.excerpt } : {}),
      ...('originalTitle' in fields && typeof fields.originalTitle === 'string' ? { originalTitle: fields.originalTitle } : {}),
      ...('sourceTitle' in fields && typeof fields.sourceTitle === 'string' ? { sourceTitle: fields.sourceTitle } : {}),
      ...('sourceAnchor' in fields && fields.sourceAnchor && typeof fields.sourceAnchor === 'object' && ['heading', 'exact', 'prefix', 'suffix'].every((key) => typeof (fields.sourceAnchor as Record<string, unknown>)[key] === 'string') ? { sourceAnchor: fields.sourceAnchor as NonNullable<LinkFields['sourceAnchor']> } : {}),
    }
  } catch { return null }
}

export function linkAttributes(href: string, fields: LinkFields) {
  return { href, title: PREFIX + encodeURIComponent(JSON.stringify(fields)) }
}

export function resolveNotebookTarget(value: string, assets: AssetRecord[], cases: CaseRecord[], findings: FindingRecord[], tasks: TaskRecord[]): LinkTarget {
  const raw = value.trim()
  if (!raw) return { href: '', label: '' }
  const index = raw.indexOf('#')
  const path = index < 0 ? raw : raw.slice(0, index)
  const hash = index < 0 ? '' : raw.slice(index)
  const linkedAssetId = assetIdFromNoteHref(path)
  const asset = assets.find((item) => !item.deletedAt && (item.id === linkedAssetId || path === noteHref(item) || path === `asset://${item.id}` || raw === item.title || raw === item.value))
  if (asset) return { href: noteHref(asset) + hash, label: displayUrl(asset.title.trim() || asset.autoTitle?.trim() || asset.value), getContent: () => assetMarkdown(asset), bodyPending: asset._bodyPending }
  const caseRecord = cases.find((item) => !item.deletedAt && (path === `/cases/${item.id}` || path === `case://${item.id}` || raw === item.name))
  if (caseRecord) return { href: `/cases/${caseRecord.id}` + hash, label: caseRecord.name, getContent: () => caseMarkdown(caseRecord, assets.filter((item) => caseRecord.assetIds.includes(item.id)), tasks.filter((item) => caseRecord.taskIds.includes(item.id))), bodyPending: caseRecord._bodyPending }
  const finding = findings.find((item) => !item.deletedAt && (path === `/cases/${item.caseId}/findings/${item.id}` || raw === item.title))
  if (finding) return { href: `/cases/${finding.caseId}/findings/${finding.id}` + hash, label: isSecretFinding(finding) ? maskSecret() : finding.title, getContent: () => findingMarkdown(finding), bodyPending: finding._bodyPending, ...(isSecretFinding(finding) ? { secret: { findingId: finding.id, caseId: finding.caseId } } : {}) }
  return { href: raw, label: displayUrl(raw) }
}
