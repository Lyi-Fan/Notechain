import type { AssetKind, AssetStatus, CaseStatus, Confidence, FindingStatus, FindingType, Severity } from './types'

export const assetKindMeta: Record<AssetKind, { label: string; short: string }> = {
  url: { label: '网页 URL', short: 'URL' },
  domain: { label: '域名', short: '域' },
  ip: { label: 'IP 地址', short: 'IP' },
  service: { label: '端口 / 服务', short: '服务' },
  endpoint: { label: '接口路径', short: '接口' },
}

export const statusLabel: Record<CaseStatus | AssetStatus | FindingStatus, string> = {
  active: '进行中', planning: '规划中', blocked: '已阻塞', complete: '已完成', archived: '已归档',
  unknown: '待验证', confirmed: '已确认', monitoring: '持续观察', unavailable: '不可用', closed: '已关闭',
  suspected: '待验证', verified: '已验证', not_reproducible: '暂不可复现', mitigated: '已缓解',
}

export const severityLabel: Record<Severity, string> = { info: '信息', low: '低', medium: '中', high: '高', critical: '严重' }
export const confidenceLabel: Record<Confidence, string> = { low: '低置信', medium: '中置信', high: '高置信' }
export const findingTypeLabel: Record<FindingType, string> = { secret: '敏感凭据', information: '信息泄露', vulnerability: '风险发现' }

export function formatRelative(value: string) {
  const then = new Date(value).getTime()
  const delta = Math.max(0, Date.now() - then)
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function normalizeValue(kind: AssetKind, value: string) {
  const trimmed = value.trim()
  if (kind === 'url') {
    try {
      const url = new URL(trimmed)
      url.hash = ''
      if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
      return url.toString()
    } catch { return trimmed.toLowerCase() }
  }
  if (kind === 'domain' || kind === 'ip') return trimmed.toLowerCase()
  return trimmed
}

export function autoTitleFromValue(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return '未命名资产'
  try {
    const url = new URL(trimmed)
    return url.hostname || trimmed
  } catch {
    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed
  }
}

export function initials(value: string) {
  const clean = value.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return clean.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'A'
}

export function clampProgress(value: number) { return Math.max(0, Math.min(100, Math.round(value))) }
