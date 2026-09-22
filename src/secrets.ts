import type { AppState, FindingRecord } from './types'

export const maskSecret = (_value?: string) => '********'
export const isSecretFinding = (finding: FindingRecord) => !finding.deletedAt &&
  (finding.type === 'secret' || finding.type === 'information') && !!finding.value?.length

export function caseSecrets(state: AppState, caseId: string) {
  const record = state.cases.find(item => item.id === caseId && !item.deletedAt)
  if (!record) return []
  const assets = new Map(state.assets.map(asset => [asset.id, asset]))
  const targets = new Map(state.targets.map(target => [target.id, target]))
  return state.findings.filter(finding => finding.caseId === caseId && isSecretFinding(finding)).map(finding => {
    const source = assets.get(finding.sourceAssetId)
    const category = source?.targetId ? targets.get(source.targetId) : undefined
    const href = source && !source.deletedAt && record.assetIds.includes(source.id) ? `/cases/${caseId}/assets/${source.id}` : undefined
    const sourceHref = href && finding.sourceLocation.startsWith(`${href}#`) ? finding.sourceLocation : href
    const internalLocation = /^\/cases\//.test(finding.sourceLocation)
    const anchor = internalLocation ? finding.sourceLocation.split('#')[1] : undefined
    return {
      finding, source, sourceHref,
      category: category ? category.name + (record.deletedTargetIds?.includes(category.id) ? '（原分类）' : '') : '未归类',
      location: internalLocation ? (anchor ? `正文 #${anchor}` : '笔记正文') : finding.sourceLocation,
    }
  })
}
