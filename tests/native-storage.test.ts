import assert from 'node:assert/strict'
import test from 'node:test'
import { createTestState } from './support/state'

test('native persistence writes changed entities and activity without resending all bodies', async () => {
  const { configureNative, createNativeWriter, flushNative } = await import('../src/native-storage')
  Object.assign(globalThis, { window: new EventTarget() })
  const initial = createTestState()
  const writes: Array<Array<{ kind?: string; id?: string; key?: string }>> = []
  configureNative(async (_command, args) => { writes.push(args!.operations as typeof writes[number]); return undefined as never }, { state: initial, kv: {} })
  const writer = createNativeWriter()
  const next = { ...initial, assets: initial.assets.map((asset, index) => index ? asset : { ...asset, noteMarkdown: 'Incremental synthetic edit' }) }
  writer.writeContent(next)
  writer.writeActivity({ reading: { a: { assetId: 'a', offsetPx: 10, progressRatio: .1, contentVersion: 1, updatedAt: '2026-09-15' } }, lastLocation: null })
  await flushNative()
  assert.equal(writes.flat().filter(op => op.kind === 'assets').length, 1)
  assert.equal(writes.flat().filter(op => op.key === 'activity').length, 1)
  assert(!writes.flat().some(op => op.kind === 'findings'))
})

test('native failed transactions are retained for explicit retry and acknowledgements reject', async () => {
  const { configureNative, enqueueNative, flushNative } = await import('../src/native-storage')
  let fail = true
  let committed = 0
  configureNative(async () => { if (fail) throw new Error('Synthetic disk failure'); committed++; return undefined as never }, { state: null, kv: {} })
  enqueueNative([{ key: 'theme', value: 'dark' }])
  await assert.rejects(flushNative())
  fail = false
  await flushNative()
  assert.equal(committed, 1)
})

test('loading and evicting cached bodies does not write them back, but edits still commit', async () => {
  const { configureNative, createNativeWriter, flushNative } = await import('../src/native-storage')
  const initial = createTestState()
  initial.assets[0] = { ...initial.assets[0], _bodyPending: true }
  let operations = 0
  configureNative(async (_command, args) => { operations += (args!.operations as unknown[]).length; return undefined as never }, { state: initial, kv: {} })
  const writer = createNativeWriter()
  const hydrated = { ...initial, assets: initial.assets.map((record, i) => i ? record : { ...record, _bodyPending: undefined, noteMarkdown: 'Loaded synthetic body' }) }
  writer.writeContent(hydrated)
  await flushNative()
  assert.equal(operations, 0)
  const edited = { ...hydrated, assets: hydrated.assets.map((record, i) => i ? record : { ...record, version: record.version + 1, noteMarkdown: 'Edited body' }) }
  writer.writeContent(edited)
  await flushNative()
  assert.equal(operations, 1)
  writer.writeContent({ ...edited, assets: edited.assets.map((record, i) => i ? record : { ...record, _bodyPending: true, noteMarkdown: undefined }) })
  await flushNative()
  assert.equal(operations, 1)
})
