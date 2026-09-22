import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureAsset, browserContext, type BrowserCapture } from '../src/browser-capture'
import { createTestState } from './support/state'
import { displaySourceUrl, displayUrl } from '../src/url-display'
import { resolveNotebookTarget } from '../src/notebook-links'

test('Chinese URL display keeps encoded delimiters, navigation and malformed input intact', () => {
  const raw = 'https://example.test/%E4%B8%AD%E6%96%87%2Fnote?q=%E6%B5%8B%E8%AF%95%26x%3D1&literal=%252F#%E9%94%9A%E7%82%B9'
  const shown = displayUrl(raw)
  assert.equal(shown, 'https://example.test/中文%2Fnote?q=测试%26x%3D1&literal=%252F#锚点')
  assert.equal(new URL(shown).href, new URL(raw).href)
  assert.equal(displayUrl(shown), shown)
  for (const suffix of ['%E4%ZZ', '%FF', '%E2%80%AE', '%C2%A0', '%0A', '%2525']) {
    const unsafe = 'https://example.test/' + suffix
    assert.equal(displayUrl(unsafe), unsafe)
  }
  assert.equal(displayUrl('笔记 %E4%B8%AD'), '笔记 %E4%B8%AD')
  assert.deepEqual(resolveNotebookTarget(raw, [], [], [], []), { href: raw, label: shown })
})

test('capture creates empty note in requested category, retry cannot resurrect deleted note', () => {
  const state = createTestState(), item = state.cases[0]
  const input: BrowserCapture = { id: 'test-browser-capture', mode: 'asset', url: 'http://127.0.0.1:8080/', title: '管理面板', text: '', caseId: item.id, targetId: item.targetIds[0] }
  const result = captureAsset(state, input)
  assert.equal(result.state.assets[0].title, '管理面板')
  assert.equal(result.state.assets[0].noteMarkdown, '')
  assert.equal(result.state.assets[0].targetId, item.targetIds[0])
  assert.equal(result.state.cases[0].assetIds[0], result.id)
  const again = captureAsset(result.state, input)
  assert.equal(again.state, result.state)
  result.state.assets[0].deletedAt = new Date().toISOString()
  assert.equal(captureAsset(result.state, input).state, result.state)
  assert.throws(() => captureAsset(state, { ...input, targetId: 'missing' }), /重新选择/)
  assert.throws(() => captureAsset(state, { ...input, caseId: 'missing' }), /重新选择/)
})

test('source address hides quoted text without changing the stored navigation target', () => {
  const raw = 'https://example.test/%E4%B8%AD%E6%96%87?q=%E6%B5%8B%E8%AF%95%26x%3D1#section:~:text=%E6%AD%A3%E6%96%87'
  assert.equal(displaySourceUrl(raw), 'https://example.test/中文?q=测试%26x%3D1#section')
  assert.ok(raw.endsWith(':~:text=%E6%AD%A3%E6%96%87'))
  assert.equal(displaySourceUrl('https://example.test/#:~:text=long%20excerpt'), 'https://example.test/')
  assert.equal(displaySourceUrl('https://example.test/?text=keep#normal'), 'https://example.test/?text=keep#normal')
  assert.equal(displaySourceUrl('https://example.test/#route:~:other=keep'), 'https://example.test/#route:~:other=keep')
  assert.equal(displaySourceUrl('https://example.test/#%3A~%3Atext=keep'), 'https://example.test/#%3A~%3Atext=keep')
  assert.equal(displaySourceUrl('笔记 #:~:text=原文'), '笔记 #:~:text=原文')
})

test('selected text becomes note body while title and source remain independent', () => {
  const state = createTestState(), item = state.cases[0]
  const input: BrowserCapture = { id: 'selection-capture', mode: 'asset', url: 'https://example.test/#:~:text=selected', title: '来源网页', text: '中文摘录\r\n第二行 <script>alert(1)</script> **原文**', caseId: item.id, targetId: item.targetIds[0] }
  const { state: result } = captureAsset(state, input)
  const asset = result.assets[0]
  assert.equal(asset.title, '来源网页')
  assert.equal(asset.value, input.url)
  assert.equal(asset.provenance.source, input.url)
  assert.equal(asset.provenance.method, '浏览器划词收集')
  assert.equal(asset.noteMarkdown, '中文摘录\n第二行 \\<script\\>alert\\(1\\)\\</script\\> \\*\\*原文\\*\\*')
  assert.equal(captureAsset(state, { ...input, text: ' \n ' }).state.assets[0].noteMarkdown, '')
})

test('context follows current case and excludes note bodies, secrets and archived cases', () => {
  const state = createTestState()
  const item = state.cases[1]
  assert.equal(browserContext(state, item.id).currentCaseId, item.id)
  const context = browserContext(state, item.id)
  assert.deepEqual(Object.keys(context.cases[0]).sort(), ['categories', 'id', 'name'])
  state.cases[1].status = 'archived'
  assert.ok(!browserContext(state, item.id).cases.some((entry) => entry.id === item.id))
})
