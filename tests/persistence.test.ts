import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACTIVITY_KEY, CONTENT_KEY, createSnapshotWriter, loadSnapshot } from '../src/persistence.ts'
import { createTestState } from './support/state'

function memoryStorage() {
  const data = new Map<string, string>(), writes: { key: string; length: number }[] = []
  return { data, writes, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); writes.push({ key, length: value.length }) } } as unknown as Storage & { data: Map<string, string>; writes: {key: string; length: number}[] }
}

test('legacy v1 loads without altering notes or reading', () => {
  const storage = memoryStorage(), original = createTestState()
  storage.setItem(CONTENT_KEY, JSON.stringify(original))
  assert.deepEqual(loadSnapshot(storage), original)
})

test('100 reading updates never serialize the note corpus', () => {
  const storage = memoryStorage(), writer = createSnapshotWriter(storage)
  let state = createTestState()
  state.assets[0].noteMarkdown = 'large document '.repeat(100000)
  writer.writeContent(state)
  for (let i = 0; i < 100; i++) {
    state = { ...state, reading: { ...state.reading, test: { assetId: 'test', offsetPx: i, progressRatio: 0.5, contentVersion: 1, updatedAt: new Date().toISOString() } } }
    writer.writeActivity(state)
    writer.writeContent(state)
  }
  assert.equal(storage.writes.filter(write => write.key === CONTENT_KEY).length, 1)
  assert(storage.writes.filter(write => write.key === ACTIVITY_KEY).every(write => write.length < 10000))
  assert.deepEqual(loadSnapshot(storage), state)
})

test('content edits, theme, deleted notes and activity survive reload', () => {
  const storage = memoryStorage(), writer = createSnapshotWriter(storage), state = createTestState()
  writer.writeContent(state)
  const updated = { ...state, assets: state.assets.map((asset, i) => i ? asset : { ...asset, deletedAt: '2026-09-09', noteMarkdown: 'edited' }), theme: 'dark' as const, lastLocation: null, reading: {} }
  writer.writeContent(updated)
  writer.writeActivity(updated)
  assert.deepEqual(loadSnapshot(storage), updated)
  assert.equal(storage.writes.filter(write => write.key === CONTENT_KEY).length, 2)
})

test('corrupt activity falls back to the complete content snapshot', () => {
  const storage = memoryStorage(), state = createTestState()
  storage.setItem(CONTENT_KEY, JSON.stringify(state))
  storage.setItem(ACTIVITY_KEY, '{broken')
  assert.deepEqual(loadSnapshot(storage), state)
})

test('failed persistence retries and emits no note/secret values', () => {
  const storage = memoryStorage(), state = createTestState(), events: string[] = []
  Object.assign(globalThis, { window: { dispatchEvent: (event: Event) => events.push(event.type) } })
  const originalSet = storage.setItem
  storage.setItem = () => { throw new Error('quota') }
  const writer = createSnapshotWriter(storage)
  writer.writeContent(state)
  writer.writeActivity(state)
  assert.deepEqual(events, ['ledger-storage-error', 'ledger-storage-error'])
  storage.setItem = originalSet
  writer.writeContent(state)
  writer.writeActivity(state)
  assert.deepEqual(loadSnapshot(storage), state)
})
