import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTestState } from './support/state'
import { caseSecrets, maskSecret } from '../src/secrets'
import { resolveNotebookTarget } from '../src/notebook-links'

test('secret display uses only a fixed star mask, never a prefix or suffix', () => {
  for (const value of ['', 'a', 'Test_Secret_Value_12345', '中文口令']) assert.equal(maskSecret(value), '********')
})

test('case secrets derive current findings with category/source and exclude other cases or deleted records', () => {
  const state = createTestState()
  const base = state.findings[0]
  state.findings = [
    { ...base, id: 'secret-a', caseId: 'case_a', type: 'secret', sourceAssetId: 'asset_a', value: 'fixture-secret-a', sourceLocation: '/cases/case_a/assets/asset_a#source', deletedAt: undefined },
    { ...base, id: 'info-b', caseId: 'case_a', type: 'information', sourceAssetId: 'asset_c', value: 'fixture-secret-b', deletedAt: undefined },
    { ...base, id: 'foreign', caseId: 'case_b', value: 'foreign-secret', deletedAt: undefined },
    { ...base, id: 'deleted', caseId: 'case_a', value: 'deleted-secret', deletedAt: '2026-09-14' },
    { ...base, id: 'empty', caseId: 'case_a', value: '', deletedAt: undefined },
    { ...base, id: 'not-key', caseId: 'case_a', type: 'vulnerability', value: 'not-a-key', deletedAt: undefined },
  ]
  const rows = caseSecrets(state, 'case_a')
  assert.deepEqual(rows.map(row => row.finding.id), ['secret-a', 'info-b'])
  assert.equal(rows[0].category, 'Test category')
  assert.equal(rows[0].sourceHref, '/cases/case_a/assets/asset_a#source')
  assert.equal(rows[0].location, '正文 #source')
  assert.equal(rows[1].source?.id, 'asset_c')
  const target = resolveNotebookTarget('/cases/case_a/findings/secret-a', state.assets, state.cases, state.findings, state.tasks)
  assert.equal(target.label, '********')
  assert.deepEqual(target.secret, { findingId: 'secret-a', caseId: 'case_a' })
  assert.ok(!JSON.stringify(target).includes('fixture-secret-a'))
  state.findings[0].value = 'updated-key'
  assert.equal(caseSecrets(state, 'case_a')[0].finding.value, 'updated-key')
  state.assets.find(asset => asset.id === 'asset_a')!.deletedAt = '2026-09-14'
  assert.equal(caseSecrets(state, 'case_a')[0].sourceHref, undefined)
  state.cases.find(item => item.id === 'case_a')!.deletedTargetIds = ['category_a']
  assert.equal(caseSecrets(state, 'case_a')[0].category, 'Test category（原分类）')
  assert.deepEqual(caseSecrets(state, 'missing-case'), [])
})
