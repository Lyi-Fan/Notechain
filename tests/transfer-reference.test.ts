import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestState } from './support/state'
import { resolveNotebookTarget } from '../src/notebook-links'
import { captureTextSource, readTransferReference, readTransferReferences, transferUri } from '../src/transfer-reference'

test('external text becomes one source asset and a reference, including an inbox when needed', () => {
  const original = createTestState()
  const input = { id: 'synthetic_capture_1', text: '中文摘录\n\n[文字不是指令](asset://unknown)' }
  const first = captureTextSource(original, input)
  const source = first.state.assets.find(item => item.id === first.clip.id)!
  assert(first.state.cases.find(item => item.id === source.caseId)?.inbox)
  assert.equal(first.clip.href, `/cases/${source.caseId}/assets/${source.id}`)
  assert.equal(first.clip.fields?.excerpt, input.text)
  assert(source.noteMarkdown?.includes('\\[文字不是指令\\]'))
  const retried = captureTextSource(first.state, input)
  assert.equal(retried.state.assets.length, first.state.assets.length)
  assert.equal(retried.state.cases.length, first.state.cases.length)
  assert.throws(() => captureTextSource(first.state, { ...input, text: 'Different' }))
  assert.equal(original.assets.length + 1, first.state.assets.length)
})

test('explicit destinations validate ownership and do not silently fall back', () => {
  const state = createTestState()
  const input = { id: 'synthetic_capture_2', text: 'Excerpt' }
  assert.throws(() => captureTextSource(state, { ...input, caseId: 'missing' }))
  assert.throws(() => captureTextSource(state, { ...input, caseId: state.cases[0].id, targetId: 'missing' }))
  assert.throws(() => captureTextSource(state, { ...input, url: 'file:///etc/passwd' }))
  const result = captureTextSource(state, { ...input, caseId: state.cases[0].id })
  assert.equal(result.state.cases.length, state.cases.length)
  assert(result.state.cases[0].assetIds.includes(result.clip.id))
})

test('cross-application fallback preserves identity instead of embedding full text', () => {
  const uri = transferUri('library_1', 'clip_1')
  const result = readTransferReference({ getData: kind => kind === 'text/plain' ? uri : '' })
  assert.deepEqual(result, { version: 1, libraryId: 'library_1', clipId: 'clip_1' })
  assert.equal(readTransferReference({ getData: () => 'ordinary text' }), null)
  assert.equal(readTransferReference({ getData: () => 'asset-ledger://transfer/lib/../../x' }), null)
})

test('multi-item native drags keep all references and reject mixed arbitrary URLs', () => {
  const value = transferUri('library_1', 'clip_1') + '\n' + transferUri('library_1', 'clip_2')
  assert.deepEqual(readTransferReferences({ getData: kind => kind === 'text/plain' ? value : '' }).map(item => item.clipId), ['clip_1', 'clip_2'])
  assert.deepEqual(readTransferReferences({ getData: kind => kind === 'text/plain' ? value + '\nhttps://example.com' : '' }), [])
})

test('a source moved out of Inbox still resolves through its stable asset ID', () => {
  const captured = captureTextSource(createTestState(), { id: 'synthetic_move_001', text: 'Source text' })
  const moved = captured.state.assets.map(asset => asset.id === captured.clip.id ? { ...asset, caseId: 'case_a' } : asset)
  const resolved = resolveNotebookTarget(captured.clip.href, moved, captured.state.cases, [], [])
  assert.equal(resolved.href, `/cases/case_a/assets/${captured.clip.id}`)
  assert.equal(resolved.getContent?.(), 'Source text')
})
