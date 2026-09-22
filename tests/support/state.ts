import { createEmptyState } from '../../src/data'
import { newGraphAsset } from '../../src/architecture/model'
import type { CaseRecord, FindingRecord } from '../../src/types'

// Construct minimal records in memory. No notebook or database fixture is shipped.
export function createTestState() {
  const state = createEmptyState(), at = '2026-01-01T00:00:00.000Z'
  state.cases = ['a', 'b'].map(suffix => ({
    id: `case_${suffix}`, name: `Test ${suffix}`, code: suffix, summary: '', status: 'active', progress: 0,
    priority: 'low', tags: [], targetIds: ['category_a'], assetIds: suffix === 'a' ? ['asset_a', 'asset_b', 'asset_c'] : ['asset_d'],
    findingIds: [], taskIds: [], timeline: [], createdAt: at, updatedAt: at,
  } satisfies CaseRecord))
  state.targets = [{ id: 'category_a', name: 'Test category', kind: '', identifier: '', note: '' }]
  state.assets = ['a', 'b', 'c', 'd'].map(suffix => newGraphAsset(`asset_${suffix}`, suffix === 'd' ? 'case_b' : 'case_a', { title: suffix, categoryId: 'category_a' }))
  state.findings = [{ id: 'finding_a', caseId: 'case_a', title: '', type: 'secret', value: '', maskedValue: '********', sourceAssetId: 'asset_a', sourceLocation: '', howFound: '', whySearched: '', payload: '', principle: '', impact: '', limitations: '', severity: 'low', confidence: 'low', status: 'suspected', createdAt: at, updatedAt: at, version: 1 } satisfies FindingRecord]
  return state
}
