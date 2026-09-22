export type CaseStatus = 'active' | 'planning' | 'blocked' | 'complete' | 'archived'
export type AssetKind = 'url' | 'domain' | 'ip' | 'service' | 'endpoint'
export type AssetStatus = 'unknown' | 'confirmed' | 'monitoring' | 'unavailable' | 'closed'
export type FindingType = 'secret' | 'information' | 'vulnerability'
export type FindingStatus = 'suspected' | 'verified' | 'not_reproducible' | 'mitigated'
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'
export type Confidence = 'low' | 'medium' | 'high'

export interface TargetRecord {
  id: string
  name: string
  kind: string
  identifier: string
  note: string
}

export interface TimelineEntry {
  id: string
  date: string
  title: string
  body: string
  tone: 'neutral' | 'positive' | 'warning'
}

export interface TaskRecord {
  id: string
  title: string
  status: 'todo' | 'active' | 'blocked' | 'done'
  priority: Severity
  due?: string
  assetId?: string
}

export interface ProvenanceRecord {
  source: string
  method: string
  reason: string
  capturedAt: string
}

export interface RelationRecord {
  id: string
  sourceType?: 'asset' | 'case' | 'finding'
  sourceId?: string
  type: 'references' | 'derived_from' | 'hosted_on' | 'runs' | 'depends_on' | 'duplicate_of'
  targetType: 'asset' | 'case' | 'finding'
  targetId: string
  note?: string
}

export interface AssetRecord {
  _bodyPending?: boolean
  noteMarkdown?: string
  id: string
  caseId: string
  kind: AssetKind
  value: string
  title: string
  autoTitle?: string
  customTitle?: string
  targetId?: string
  status: AssetStatus
  severity: Severity
  confidence: Confidence
  tags: string[]
  situation: string
  utility: string
  nextSteps: string
  provenance: ProvenanceRecord
  details: string
  relationIds: string[]
  findingIds: string[]
  createdAt: string
  updatedAt: string
  version: number
  deletedAt?: string
}

export interface FindingRecord {
  _bodyPending?: boolean
  noteMarkdown?: string
  id: string
  caseId: string
  type: FindingType
  title: string
  value?: string
  maskedValue?: string
  severity: Severity
  confidence: Confidence
  status: FindingStatus
  sourceAssetId: string
  sourceLocation: string
  howFound: string
  whySearched: string
  payload: string
  principle: string
  impact: string
  limitations: string
  createdAt: string
  updatedAt: string
  version: number
  deletedAt?: string
}

export interface CaseRecord {
  architecture?: import('./architecture/model').GraphDocument
  inbox?: boolean
  _bodyPending?: boolean
  noteMarkdown?: string
  id: string
  name: string
  code: string
  summary: string
  status: CaseStatus
  progress: number
  priority: Severity
  tags: string[]
  targetIds: string[]
  deletedTargetIds?: string[]
  assetIds: string[]
  findingIds: string[]
  taskIds: string[]
  timeline: TimelineEntry[]
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export interface ReadingState {
  assetId: string
  anchorId?: string
  offsetPx: number
  progressRatio: number
  contentVersion: number
  updatedAt: string
}

export interface LastLocation {
  caseId: string
  assetId?: string
  anchorId?: string
  offsetPx: number
  progressRatio?: number
  contentVersion?: number
  updatedAt: string
}

export interface AppState {
  cases: CaseRecord[]
  targets: TargetRecord[]
  assets: AssetRecord[]
  findings: FindingRecord[]
  tasks: TaskRecord[]
  relations: RelationRecord[]
  reading: Record<string, ReadingState>
  lastLocation: LastLocation | null
  theme: 'light' | 'dark'
}
