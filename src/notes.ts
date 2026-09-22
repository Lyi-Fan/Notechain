import type { AssetRecord, CaseRecord, FindingRecord, TaskRecord } from './types'

// Legacy fields remain untouched; only an actual edit creates the freeform note.
export function assetMarkdown(asset: AssetRecord) {
  if (asset.noteMarkdown !== undefined) return asset.noteMarkdown
  return [
    asset.situation,
    asset.utility && `## 可利用情况\n\n${asset.utility}`,
    asset.nextSteps && `## 下一步\n\n${asset.nextSteps}`,
    [asset.provenance.source, asset.provenance.method, asset.provenance.reason].some(Boolean)
      ? `## 来源\n\n${[asset.provenance.source, asset.provenance.method, asset.provenance.reason].filter(Boolean).join('\n\n')}` : '',
    asset.details,
  ].filter(Boolean).join('\n\n')
}

const escapeMarkdown = (value: string) => value.replace(/([\\`*_{}[\]<>])/g, '\\$1')

export function caseMarkdown(caseRecord: CaseRecord, assets: AssetRecord[], tasks: TaskRecord[]) {
  if (caseRecord.noteMarkdown !== undefined) return caseRecord.noteMarkdown
  const sections: string[] = []
  if (caseRecord.summary) sections.push(caseRecord.summary)
  if (assets.length) sections.push(`## \u7b14\u8bb0\n\n${assets.map((asset) => `- [${escapeMarkdown(asset.title)}](${noteHref(asset)})`).join('\n')}`)
  if (tasks.length) sections.push(`## \u5f85\u529e\n\n${tasks.map((task) => `- [${task.status === 'done' ? 'x' : ' '}] ${task.title}${task.due ? ` (${task.due})` : ''}`).join('\n')}`)
  if (caseRecord.timeline.length) sections.push(`## \u8fdb\u5c55\n\n${caseRecord.timeline.map((entry) => `### ${entry.date} - ${entry.title}\n\n${entry.body}`).join('\n\n')}`)
  return sections.join('\n\n')
}

export function findingMarkdown(finding: FindingRecord) {
  if (finding.noteMarkdown !== undefined) return finding.noteMarkdown
  const sections: string[] = []
  if (finding.sourceLocation) sections.push(`\u6765\u6e90\uff1a${finding.sourceLocation}`)
  if (finding.howFound) sections.push(`## \u5982\u4f55\u53d1\u73b0\n\n${finding.howFound}`)
  if (finding.whySearched) sections.push(`## \u4e3a\u4ec0\u4e48\u68c0\u67e5\u8fd9\u91cc\n\n${finding.whySearched}`)
  if (finding.payload) {
    const fence = '`'.repeat(Math.max(3, ...(finding.payload.match(/`+/g) ?? []).map((run) => run.length + 1)))
    sections.push(`## \u590d\u73b0\u8bb0\u5f55\n\n${fence}text\n${finding.payload}\n${fence}`)
  }
  if (finding.principle) sections.push(`## \u539f\u7406\n\n${finding.principle}`)
  if (finding.impact) sections.push(`## \u5f71\u54cd\n\n${finding.impact}`)
  if (finding.limitations) sections.push(`## \u9650\u5236\n\n${finding.limitations}`)
  return sections.join('\n\n')
}

export function noteHref(asset: AssetRecord) {
  return `/cases/${asset.caseId}/assets/${asset.id}`
}

export function assetIdFromNoteHref(href: string): string | undefined {
  if (!href.startsWith('/cases/')) return undefined
  try {
    const parts = new URL(href, 'https://asset-ledger.invalid').pathname.split('/')
    return parts.length === 5 && parts[1] === 'cases' && parts[3] === 'assets' ? decodeURIComponent(parts[4]) : undefined
  } catch { return undefined }
}

export function headingSlug(text: string) {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section'
}

export function safeNoteLink(href: string) {
  return /^(https?:\/\/|mailto:|asset:\/\/|case:\/\/|\/cases\/|\/notebooks\/|#)/i.test(href)
}
