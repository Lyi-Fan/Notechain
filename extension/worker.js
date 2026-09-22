const BASE = 'http://127.0.0.1:4281/bridge/v1';
const OUTBOX_KEY = 'captureOutbox';
const CONTEXT_KEY = 'cachedContext';
const EXCLUDED_KEY = 'excludedHosts';
const RETRY_ALARM = 'asset-ledger-outbox-retry';
const MAX_OUTBOX = 50;

let serial = Promise.resolve();

const get = async key => (await chrome.storage.local.get(key))[key];
const set = value => chrome.storage.local.set(value);
const cap = (value, max) => String(value || '').slice(0, max);
const id = () => crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, '');
const runSerial = task => {
  const next = serial.then(task, task);
  serial = next.catch(() => {});
  return next;
};

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

async function api(path, options = {}, { auth = true, timeout = 10_000 } = {}) {
  const token = await get('bridgeToken');
  if (auth && !token) throw Object.assign(new Error('请先完成桌面端配对'), { status: 401 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = {
      'X-Asset-Ledger': '1',
      'X-Asset-Ledger-Origin': `chrome-extension://${chrome.runtime.id}`,
      ...(options.headers || {})
    };
    if (auth) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${BASE}${path}`, { ...options, headers, signal: controller.signal });
    if (!response.ok) {
      let data = {};
      try { data = await response.json(); } catch {}
      if (auth && response.status === 401) await chrome.storage.local.remove('bridgeToken');
      throw Object.assign(new Error(data.message || data.error || '桌面端请求失败'), { status: response.status });
    }
    return response.status === 204 ? null : response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('桌面端连接超时'), { offline: true });
    if (error instanceof TypeError) throw Object.assign(new Error('桌面端暂不可用'), { offline: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readOutbox() {
  const value = await get(OUTBOX_KEY) || [];
  return value.map(item => item.body ? item : { body: item, state: 'pending' });
}
async function writeOutbox(items, { retry = true } = {}) {
  await set({ [OUTBOX_KEY]: items });
  const hasPending = items.some(item => item.state === 'pending');
  if (retry && hasPending) await chrome.alarms.create(RETRY_ALARM, { delayInMinutes: 1 });
  else await chrome.alarms.clear(RETRY_ALARM);
}

async function flushOutbox() {
  const items = await readOutbox();
  const startedAt = Date.now();
  let attempts = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (attempts >= 10 || Date.now() - startedAt >= 15_000) break;
    const item = items[index];
    if (item.state !== 'pending') continue;
    attempts += 1;
    try {
      await api('/capture', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item.body) });
      items.splice(index, 1);
      index -= 1;
      await writeOutbox(items);
    } catch (error) {
      if (error.status === 409 && item.body.mode === 'asset') {
        item.state = 'needs-reselect';
        item.message = '案件或分类已更新，请重新选择归属';
        await writeOutbox(items);
        continue;
      }
      if ([400, 413, 415].includes(error.status)) {
        item.state = 'failed';
        item.message = error.message || '该项目无法发送';
        await writeOutbox(items);
        continue;
      }
      if (error.status === 401) {
        item.state = 'paused-auth';
        item.message = '配对已失效，请重新连接桌面端';
        await writeOutbox(items, { retry: false });
        return items;
      }
      item.message = error.message || '桌面端暂不可用';
      await writeOutbox(items);
      break;
    }
  }
  if (items.some(item => item.state === 'pending')) await writeOutbox(items);
  return items;
}

async function enqueueCapture(body) {
  return runSerial(async () => {
    const items = await readOutbox();
    if (items.length >= MAX_OUTBOX) return { ok: false, message: '离线队列已满，请先处理待发送项目' };
    items.push({ body, state: 'pending', message: '' });
    await writeOutbox(items); // Persist before attempting network delivery.
    const after = await flushOutbox();
    const entry = after.find(item => item.body.id === body.id);
    if (!entry) return { ok: true, queued: false };
    return { ok: true, queued: true, message: entry.message || '已安全加入待发送队列' };
  });
}

async function sourceHttpTab(tabId) {
  const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.url || !/^https?:/i.test(tab.url)) throw new Error('当前页面不能收藏');
  return tab;
}

// Runs once in the current page's isolated world, without installing listeners.
function readPageSelection() {
  const source = { url: location.href, title: document.title, text: '', selectionState: 'none' };
  const selected = window.getSelection();
  if (!selected || selected.isCollapsed || !selected.rangeCount) return source;
  const range = selected.getRangeAt(0);
  const element = node => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const start = element(range.startContainer), end = element(range.endContainer);
  // Browser tools can mark whole articles editable; that is still explicitly selected page text.
  if (start?.closest('input,textarea,select') || end?.closest('input,textarea,select')) return { ...source, selectionState: 'form' };
  const text = selected.toString().trim();
  if (!text) return { ...source, selectionState: 'empty-range' };
  if (text.length > 24000) return { error: '单次摘录最多 24,000 字符，请缩小选区后重试' };
  const prefix = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.data.slice(Math.max(0, range.startOffset - 80), range.startOffset) : '';
  const suffix = range.endContainer.nodeType === Node.TEXT_NODE ? range.endContainer.data.slice(range.endOffset, range.endOffset + 80) : '';
  let heading = '', candidate = start?.closest('p,li,pre,blockquote,h1,h2,h3,h4,h5,h6') || start;
  for (let count = 0; candidate && count < 16; count++) {
    if (candidate.id) { heading = candidate.id.slice(0, 160); break; }
    candidate = candidate.previousElementSibling || candidate.parentElement;
    if (candidate === document.body || candidate === document.documentElement) break;
  }
  return { ...source, text, selectionState: 'text', anchor: { exact: text, heading, prefix, suffix } };
}

async function sourceWithSelection(tabId, snapshot) {
  const tab = await sourceHttpTab(tabId);
  let result, documentId;
  try {
    const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageSelection });
    result = frames?.[0]?.result;
    documentId = frames?.[0]?.documentId;
    if (!snapshot && result && !result.text && !result.error && result.selectionState !== 'form') {
      // Recheck the page world when an isolated-world selection is unavailable.
      const pageFrames = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: readPageSelection });
      const pageFrame = pageFrames?.[0];
      if (pageFrame?.documentId === documentId && pageFrame.result?.url === result.url && (pageFrame.result.text || pageFrame.result.error)) result = pageFrame.result;
    }
  } catch {
    throw new Error('无法读取当前网页选区，请回到网页重新打开插件；浏览器受限页面不支持读取');
  }
  if (!result) throw new Error('未能读取网页，请刷新后重试');
  if (snapshot) {
    if (snapshot.tabId !== tab.id || snapshot.sourceUrl !== result.url || !documentId || snapshot.documentId !== documentId) throw new Error('网页已切换或重新加载，请重新打开插件后收集');
    result = snapshot;
  }
  if (result.error) throw new Error(result.error);
  // URL, title and selection belong to the same document even after navigation.
  const sourceUrl = result.sourceUrl || result.url;
  return { ...sourceFromTab({ url: sourceUrl, title: result.title }, result.anchor), text: result.text, anchor: result.anchor,
    snapshot: { tabId: tab.id, sourceUrl, documentId, title: result.title, text: result.text, anchor: result.anchor, selectionState: result.selectionState } };
}

function sourceFromTab(tab, anchor) {
  const sourceUrl = new URL(tab.url);
  if (!['http:', 'https:'].includes(sourceUrl.protocol) || sourceUrl.username || sourceUrl.password) throw new Error('仅支持不含登录凭据的 HTTP(S) 网址');
  const url = fragmentUrl(tab.url, anchor);
  return {
    id: id(),
    url,
    title: cap(tab.title || tab.url, 1000)
  };
}

function fragmentUrl(raw, anchor) {
  if (!anchor?.exact) {
    if (raw.length > 12000) throw new Error('来源网址过长，无法收藏');
    return raw;
  }
  try {
    const url = new URL(raw);
    const baseHash = url.hash.split(':~:')[0] || (anchor.heading ? `#${encodeURIComponent(anchor.heading)}` : '');
    const exact = cap(anchor.exact.replace(/\s+/g, ' ').trim(), 512);
    const prefix = cap(anchor.prefix, 80);
    const suffix = cap(anchor.suffix, 80);
    const encode = value => encodeURIComponent(value).replace(/-/g, '%2D');
    // A truncated exact quote no longer ends beside the original suffix.
    url.hash = `${baseHash}:~:text=${prefix ? `${encode(prefix)}-,` : ''}${encode(exact)}${suffix && anchor.exact.replace(/\s+/g, ' ').trim().length <= 512 ? `,-${encode(suffix)}` : ''}`;
    if (url.href.length > 12000) { url.hash = baseHash; if (url.href.length > 12000) throw new Error('来源网址过长，无法收藏'); }
    return url.href;
  } catch (error) { throw error instanceof Error ? error : new Error('来源网址无效'); }
}

function popupSender(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
}

function contentSender(sender) {
  return sender.id === chrome.runtime.id && Boolean(sender.tab) && /^https?:/i.test(sender.tab.url || '');
}

async function cachedContext() {
  try {
    const context = await api('/context');
    await set({ [CONTEXT_KEY]: context });
    return { ...context, offline: false };
  } catch (error) {
    if (error.status === 401) return { cases: [], currentCaseId: null, offline: false, message: '配对已失效，请重新连接桌面端' };
    const cached = await get(CONTEXT_KEY);
    if (cached) return { ...cached, offline: true, message: '桌面端离线，正在使用上次保存的案件' };
    return { cases: [], currentCaseId: null, offline: true, message: error.message || '桌面端暂不可用' };
  }
}

async function registerTrayForTab(tabId) {
  await chrome.scripting.unregisterContentScripts({ ids: ['asset-ledger-tray'] }).catch(() => {});
  await chrome.scripting.registerContentScripts([{
    id: 'asset-ledger-tray', js: ['content.js'], matches: ['http://*/*', 'https://*/*'],
    runAt: 'document_idle', persistAcrossSessions: true
  }]);
  const tab = await sourceHttpTab(tabId);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  return { ok: true };
}

async function changeHost(exclude, tabId) {
  const tab = await sourceHttpTab(tabId);
  const host = new URL(tab.url).hostname;
  const hosts = new Set(await get(EXCLUDED_KEY) || []);
  exclude ? hosts.add(host) : hosts.delete(host);
  await set({ [EXCLUDED_KEY]: [...hosts] });
  return { ok: true, excluded: exclude, host };
}

async function handlePopup(message) {
  switch (message.type) {
    case 'popupState': return { paired: Boolean(await get('bridgeToken')) };
    case 'pair': {
      if (!/^\d{6}$/.test(message.code || '')) return { ok: false, message: '验证码格式不正确' };
      try {
        const data = await api('/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: message.code }) }, { auth: false, timeout: 60_000 });
        await set({ bridgeToken: data.token });
        const items = await readOutbox();
        for (const item of items) if (item.state === 'paused-auth') item.state = 'pending';
        await writeOutbox(items);
        runSerial(flushOutbox);
        return { ok: true };
      } catch (error) { return { ok: false, message: error.message }; }
    }
    case 'getContext': return cachedContext();
    case 'getSourceTab': {
      const tab = await sourceHttpTab();
      const { snapshot } = await sourceWithSelection(tab.id);
      return { ok: true, tabId: tab.id, url: snapshot.sourceUrl, title: cap(snapshot.title || snapshot.sourceUrl, 1000), snapshot };
    }
    case 'captureAsset': {
      if (!message.caseId) return { ok: false, message: '请选择案件' };
      const { snapshot: _snapshot, ...source } = await sourceWithSelection(message.sourceTabId, message.snapshot);
      return enqueueCapture({ ...source, mode: 'asset', caseId: message.caseId, targetId: message.targetId || null });
    }
    case 'captureTrayPage': {
      const { snapshot: _snapshot, ...source } = await sourceWithSelection(message.sourceTabId, message.snapshot);
      return enqueueCapture({ ...source, mode: 'tray' });
    }
    case 'registerTray': return registerTrayForTab(message.sourceTabId);
    case 'hostTrayState': {
      const tab = await sourceHttpTab(message.sourceTabId);
      const excluded = (await get(EXCLUDED_KEY) || []).includes(new URL(tab.url).hostname);
      const granted = await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
      const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['asset-ledger-tray'] });
      return { ok: true, excluded, enabled: granted && scripts.length > 0 && !excluded };
    }
    case 'setHostExcluded': return changeHost(Boolean(message.exclude), message.sourceTabId);
    case 'getOutbox': return { ok: true, items: await readOutbox() };
    case 'deleteOutbox': return runSerial(async () => {
      const items = (await readOutbox()).filter(item => item.body.id !== message.id);
      await writeOutbox(items);
      return { ok: true };
    });
    case 'repairOutbox': return runSerial(async () => {
      const items = await readOutbox();
      const item = items.find(candidate => candidate.body.id === message.id);
      if (!item) return { ok: false, message: '待发送项目不存在' };
      const previousId = item.body.id;
      const replacementId = id();
      item.body.caseId = message.caseId;
      item.body.targetId = message.targetId || null;
      item.body.id = replacementId;
      item.state = 'pending'; item.message = '';
      await writeOutbox(items);
      const after = await flushOutbox();
      return { ok: true, queued: Boolean(after.find(candidate => candidate.body.id === replacementId)), replacedId: previousId };
    });
    default: return { ok: false, message: '未知请求' };
  }
}

async function handleContent(message, sender) {
  const tab = sender.tab;
  switch (message.type) {
    case 'isHostExcluded': return { excluded: (await get(EXCLUDED_KEY) || []).includes(new URL(tab.url).hostname) };
    case 'excludeHost': {
      const hosts = new Set(await get(EXCLUDED_KEY) || []);
      const host = new URL(tab.url).hostname;
      message.exclude ? hosts.add(host) : hosts.delete(host);
      await set({ [EXCLUDED_KEY]: [...hosts] });
      return { ok: true };
    }
    case 'captureSelection': {
      const anchor = message.anchor && { exact: cap(message.anchor.exact, 24000), prefix: cap(message.anchor.prefix, 200), suffix: cap(message.anchor.suffix, 200), heading: cap(message.anchor.heading, 160) };
      return enqueueCapture({ ...sourceFromTab(tab, anchor), mode: 'tray', text: cap(message.text, 24000), anchor });
    }
    case 'getTray': {
      try { return { ok: true, ...(await api(`/tray?offset=${Number(message.offset) || 0}&limit=30`)) }; }
      catch (error) {
        const queued = (await readOutbox()).filter(item => item.body.mode === 'tray');
        if (!queued.length) return { ok: false, message: error.message };
        const offset = Math.max(0, Number(message.offset) || 0);
        return { ok: true, offline: true, message: '本地待发送', total: queued.length, nextOffset: offset + 30 < queued.length ? offset + 30 : null,
          items: queued.slice(offset, offset + 30).map(({ body }) => ({ id: body.id, title: body.title, href: body.url, text: (body.text || '').slice(0, 160) })) };
      }
    }
    default: return { ok: false, message: '不允许的页面请求' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    try {
      if (popupSender(sender)) return reply(await handlePopup(message));
      if (contentSender(sender)) return reply(await handleContent(message, sender));
      return reply({ ok: false, message: '来源无效' });
    } catch (error) {
      return reply({ ok: false, message: error.message || '扩展操作失败' });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RETRY_ALARM) runSerial(flushOutbox);
});

readOutbox().then(items => {
  if (items.some(item => item.state === 'pending')) runSerial(flushOutbox);
}).catch(() => {});
