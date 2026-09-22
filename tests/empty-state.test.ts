import assert from 'node:assert/strict'
import test from 'node:test'
import { createEmptyState } from '../src/data'

test('new libraries contain no sample records or saved locations', () => {
  const state = createEmptyState()
  for (const kind of ['cases', 'assets', 'targets', 'findings', 'tasks', 'relations'] as const) assert.deepEqual(state[kind], [])
  assert.deepEqual(state.reading, {})
  assert.equal(state.lastLocation, null)
  assert.notEqual(createEmptyState().cases, state.cases)
})
