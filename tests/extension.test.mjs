import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '../extension');
const local = file => join(extensionDir, file);
const manifest = JSON.parse(readFileSync(local('manifest.json'), 'utf8'));
const workerSource = readFileSync(local('worker.js'), 'utf8');

function workerHarness(fetchPlan) {
  const storage = { bridgeToken: 'test-token' };
  const alarms = [];
  const chrome = {
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, onMessage: { addListener() {} } },
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(value) { Object.assign(storage, value); },
      async remove(key) { delete storage[key]; },
      async setAccessLevel(value) { storage.accessLevel = value.accessLevel; }
    } },
    alarms: { async create(name) { alarms.push(name); }, async clear() {}, onAlarm: { addListener() {} } },
    tabs: { async query() { return []; }, async get() { throw new Error('unused'); } },
    scripting: { async unregisterContentScripts() {}, async registerContentScripts() {}, async executeScript() {} }
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, fetch: fetchPlan, URL, AbortController, setTimeout, clearTimeout, console });
  vm.runInContext(`${workerSource}\nglobalThis.__workerTest = { enqueueCapture, readOutbox, flushOutbox, handlePopup, readPageSelection };`, context, { filename: 'worker.js' });
  return { storage, alarms, chrome, context, api: context.__workerTest };
}

test('package has MV3 worker, icons, content script, and valid JavaScript', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'worker.js');
  for (const file of ['worker.js', 'popup.js', 'content.js', 'options.js', manifest.options_ui.page, 'fonts/MiSans-Semibold.min.css', 'icons/category-folder.svg', 'icons/category-inbox.svg', 'icons/capture-note.svg', ...Object.values(manifest.icons)]) {
    assert.ok(existsSync(local(file)), `missing ${file}`);
    if (file.endsWith('.js')) assert.equal(spawnSync(process.execPath, ['--check', file], { cwd: extensionDir }).status, 0, `${file} syntax`);
  }
});

test('popup detects selection per click for asset and tray without a persistent content script', async () => {
  const captures = [], injections = [];
  const { api, chrome } = workerHarness(async (_url, options) => {
    captures.push(JSON.parse(options.body));
    return { ok: true, status: 200, async json() { return {}; } };
  });
  chrome.tabs.get = async id => ({ id, url: 'https://example.test/old', title: 'old' });
  let selected = { url: 'https://example.test/current', title: '来源网页', text: '选中内容', anchor: { exact: '选中内容', heading: 'part', prefix: '', suffix: '' } };
  chrome.scripting.executeScript = async options => { injections.push(options); return [{ result: selected }]; };
  const message = { type: 'captureAsset', sourceTabId: 42, caseId: 'case-a', targetId: 'cat-a' };
  assert.equal((await api.handlePopup(message)).ok, true);
  assert.equal(captures[0].text, '选中内容');
  assert.equal(captures[0].title, '来源网页');
  assert.ok(captures[0].url.startsWith('https://example.test/current#part:~:text='));
  assert.equal(captures[0].targetId, 'cat-a');
  assert.equal((await api.handlePopup({ type: 'captureTrayPage', sourceTabId: 42 })).ok, true);
  assert.equal(captures[1].text, '选中内容');
  assert.equal(captures[1].mode, 'tray');
  selected = { url: 'https://example.test/current', title: '来源网页', text: '' };
  await api.handlePopup(message);
  await api.handlePopup({ type: 'captureTrayPage', sourceTabId: 42 });
  assert.equal(captures[2].text, '');
  assert.equal(captures[3].text, '');
  assert.equal(captures[2].url, selected.url);
  assert.equal(injections.length, 6);
  assert.ok(injections.every(call => call.target.tabId === 42 && call.func === api.readPageSelection && !call.target.allFrames));
  selected = { error: '单次摘录最多 24,000 字符' };
  await assert.rejects(api.handlePopup(message), /24,000/);
  chrome.scripting.executeScript = async () => { throw new Error('denied'); };
  await assert.rejects(api.handlePopup(message), /无法读取当前网页选区/);
  assert.equal(captures.length, 4, 'never silently discard a selection on read failure');
});

test('actual worker serializes outbox and isolates bridge token', async () => {
  let calls = 0;
  const headers = [];
  const { storage, api } = workerHarness(async (_url, options) => {
    headers.push(options.headers);
    calls += 1;
    if (calls === 1) return { ok: false, status: 409, async json() { return { message: 'destination changed' }; } };
    if (calls === 2) return { ok: true, status: 200, async json() { return { ok: true }; } };
    throw new TypeError('offline');
  });
  const asset = { id: 'asset0001', mode: 'asset', url: 'https://example.test/a', title: 'A', caseId: 'case-a', targetId: 'cat-a' };
  const later = { id: 'asset0002', mode: 'asset', url: 'https://example.test/b', title: 'B', caseId: 'case-a', targetId: 'cat-a' };
  const offline = { id: 'asset0003', mode: 'tray', url: 'https://example.test/c', title: 'C' };
  await Promise.all([api.enqueueCapture(asset), api.enqueueCapture(later), api.enqueueCapture(offline)]);
  const outbox = await api.readOutbox();
  assert.equal(storage.accessLevel, 'TRUSTED_CONTEXTS');
  assert.equal(headers[0]['X-Asset-Ledger-Origin'], 'chrome-extension://test-extension');
  assert.deepEqual(JSON.parse(JSON.stringify(outbox.map(item => [item.body.id, item.state]))), [['asset0001', 'needs-reselect'], ['asset0003', 'pending']]);
  assert.equal(calls, 3);
});

test('popup snapshot preserves full selection after blur, expires on document change, and never leaks into the outbox', async () => {
  const captures = [];
  const { api, chrome } = workerHarness(async (_url, options) => {
    captures.push(JSON.parse(options.body));
    return { ok: true, status: 200, async json() { return {}; } };
  });
  const tab = { id: 42, url: 'https://example.test/article', title: '网页 title' };
  chrome.tabs.get = async () => tab;
  chrome.tabs.query = async () => [tab];
  const text = '第一段正文\n列表内容\n' + '不能截断这段正文。'.repeat(100) + '\n最后一段正文';
  let selected = { url: tab.url, title: tab.title, text, anchor: { exact: text, heading: 'article', prefix: '', suffix: '' } };
  let documentId = 'document-one';
  chrome.scripting.executeScript = async () => [{ result: selected, documentId }];
  const opened = await api.handlePopup({ type: 'getSourceTab' });
  selected = { url: tab.url, title: tab.title, text: '' };
  const message = { type: 'captureAsset', sourceTabId: 42, caseId: 'case-a', targetId: null, snapshot: opened.snapshot };
  await api.handlePopup(message);
  await api.handlePopup({ ...message, type: 'captureTrayPage' });
  assert.equal(captures[0].text, text);
  assert.equal(captures[1].text, text);
  assert.equal(captures[0].title, tab.title);
  assert.equal(captures[0].snapshot, undefined);
  const reopened = await api.handlePopup({ type: 'getSourceTab' });
  await api.handlePopup({ ...message, snapshot: reopened.snapshot });
  assert.equal(captures[2].text, '');
  documentId = 'document-two';
  await assert.rejects(api.handlePopup(message), /重新打开插件/);
  assert.equal(captures.length, 3);
});

test('selection reader supports editable articles but excludes form fields and oversize selections', () => {
  const { api, context } = workerHarness(async () => { throw new Error('unused'); });
  const element = { nodeType: 1, id: 'section-one', closest: () => null };
  const textNode = { nodeType: 3, data: '前文 选中文字 后文', parentElement: element };
  const range = { startContainer: textNode, endContainer: textNode, startOffset: 3, endOffset: 7 };
  let text = '选中文字', collapsed = false;
  context.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  context.location = { href: 'https://example.test/article' };
  context.document = { title: '网页标题', body: {}, documentElement: {} };
  context.window = { getSelection: () => ({ isCollapsed: collapsed, rangeCount: 1, getRangeAt: () => range, toString: () => text }) };
  let result = api.readPageSelection();
  assert.equal(result.text, text);
  assert.equal(result.anchor.heading, 'section-one');
  assert.equal(result.anchor.prefix, '前文 ');
  assert.equal(result.anchor.suffix, ' 后文');
  assert.equal(result.title, '网页标题');
  element.closest = selector => selector.includes('contenteditable') ? element : null;
  assert.equal(api.readPageSelection().text, text, 'editable ancestors must not discard article selections');
  collapsed = true;
  assert.equal(api.readPageSelection().text, '');
  collapsed = false; text = ' ';
  assert.equal(api.readPageSelection().text, '');
  text = 'x'.repeat(24001);
  assert.match(api.readPageSelection().error, /24,000/);
  text = 'private field';
  element.closest = () => ({});
  result = api.readPageSelection();
  assert.equal(result.text, '');
  assert.equal(result.anchor, undefined);
  assert.equal(result.selectionState, 'form');
});

test('empty isolated selection is rechecked in page world, without changing the source document', async () => {
  const { api, chrome } = workerHarness(async () => { throw new Error('unused'); });
  const tab = { id: 42, url: 'https://example.test/article', title: '网页标题' };
  chrome.tabs.get = async () => tab;
  chrome.tabs.query = async () => [tab];
  const calls = [];
  chrome.scripting.executeScript = async options => {
    calls.push(options.world || 'ISOLATED');
    return [{ documentId: 'doc-one', result: { url: tab.url, title: tab.title, text: options.world === 'MAIN' ? '网页选区全文' : '', selectionState: options.world === 'MAIN' ? 'text' : 'none' } }];
  };
  const source = await api.handlePopup({ type: 'getSourceTab' });
  assert.equal(source.snapshot.text, '网页选区全文');
  assert.deepEqual(calls, ['ISOLATED', 'MAIN']);
});
