const $ = id => document.getElementById(id);
const send = message => chrome.runtime.sendMessage(message);
let context = null;
let selectedCaseId = null;
let repairingId = null;
let sourceTabId = null;
let sourceSnapshot = null;

function say(message = '') { $('status').textContent = message; }
function show(view) { for (const id of ['pairView', 'captureView', 'caseView']) $(id).hidden = id !== view; }
function selectedCase() { return context?.cases?.find(item => item.id === selectedCaseId); }

async function load() {
  sourceSnapshot = null;
  sourceTabId = null;
  // Read selection before waiting on the desktop; keep it only for this popup.
  const sourcePromise = send({ type: 'getSourceTab' });
  const state = await send({ type: 'popupState' });
  if (!state.paired) { show('pairView'); return false; }
  context = await send({ type: 'getContext' });
  const source = await sourcePromise;
  if (!source.ok) { say(source.message); return false; }
  sourceTabId = source.tabId;
  sourceSnapshot = source.snapshot;
  $('sourceTitle').textContent = source.title || source.url;
  $('sourceTitle').title = source.title || source.url;
  selectedCaseId = context.currentCaseId || context.cases?.[0]?.id || null;
  const selectionStatus = sourceSnapshot?.text ? `已选中 ${Array.from(sourceSnapshot.text).length} 字` : '未选中文字';
  $('status').title = sourceSnapshot?.text ? '' : sourceSnapshot?.selectionState === 'form' ? '选区位于输入框，未读取表单内容' : sourceSnapshot?.selectionState === 'empty-range' ? '浏览器保留了选区范围，但未返回文字' : '浏览器未向当前网页返回文字选区';
  say([context?.message, selectionStatus].filter(Boolean).join(' · '));
  renderCapture();
  await renderRepairItems();
  return true;
}

function renderCapture() {
  const item = selectedCase();
  $('caseName').textContent = item?.name || '未选择案件';
  const choices = item ? (item.categories || []).map(category => ({ id: category.id, name: category.name })) : [];
  if (item) choices.unshift({ id: null, name: '未分类收集' });
  $('choices').replaceChildren(...choices.map(category => {
    const button = document.createElement('button');
    button.className = 'choice'; button.type = 'button';
    const icon = category.id === null ? 'category-inbox' : 'category-folder';
    button.innerHTML = `<img class="choice-icon" src="icons/${icon}.svg" width="18" height="18" alt=""><span class="choice-label">${escape(category.name)}</span><span class="choice-add" aria-hidden="true">+</span>`;
    button.onclick = () => repairingId ? repairCapture(category.id) : captureAsset(category.id, button);
    return button;
  }));
  show('captureView');
}

function renderCases() {
  const list = $('caseList');
  list.replaceChildren(...(context?.cases || []).map(item => {
    const button = document.createElement('button'); button.className = 'case-item'; button.type = 'button'; button.textContent = item.name;
    button.onclick = () => { selectedCaseId = item.id; renderCapture(); };
    return button;
  }));
  show('caseView');
}

function escape(value) { const span = document.createElement('span'); span.textContent = value; return span.innerHTML; }

async function captureAsset(targetId, button) {
  if (button.disabled) return;
  button.disabled = true;
  say('正在收藏…');
  try {
    const result = await send({ type: 'captureAsset', caseId: selectedCaseId, targetId, sourceTabId, snapshot: sourceSnapshot });
    say(result.ok ? (result.queued ? result.message : '已收藏') : result.message);
    await renderRepairItems();
  } finally { button.disabled = false; }
}

async function repairCapture(targetId) {
  const result = await send({ type: 'repairOutbox', id: repairingId, caseId: selectedCaseId, targetId });
  repairingId = null;
  say(result.ok ? (result.queued ? '已更新归属，仍在等待桌面端' : '已发送') : result.message);
  await renderRepairItems();
}

async function renderRepairItems() {
  const data = await send({ type: 'getOutbox' });
  const recoverable = (data.items || []).filter(item => ['needs-reselect', 'pending', 'failed', 'paused-auth'].includes(item.state));
  $('repair').hidden = recoverable.length === 0;
  $('repairList').replaceChildren(...recoverable.map(item => {
    const row = document.createElement('div'); row.className = 'repair-item';
    const label = document.createElement('span'); label.textContent = item.body.title || item.body.url;
    if (item.state === 'needs-reselect') {
      const fix = document.createElement('button'); fix.className = 'repair-action'; fix.type = 'button'; fix.textContent = '重新归属';
      fix.onclick = () => { repairingId = item.body.id; selectedCaseId = item.body.caseId || selectedCaseId; renderCases(); say('选择案件后，再选择分类'); };
      row.append(fix);
    }
    const remove = document.createElement('button'); remove.className = 'repair-action'; remove.type = 'button'; remove.textContent = '移除';
    remove.onclick = async () => { await send({ type: 'deleteOutbox', id: item.body.id }); await renderRepairItems(); };
    row.prepend(label); row.append(remove); return row;
  }));
}

$('pair').onclick = async () => {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  $('pairCode').textContent = code; $('pairCode').hidden = false; say('等待桌面端确认…');
  const result = await send({ type: 'pair', code });
  if (!result.ok) { say(result.message); return; }
  if (await load()) say('已连接桌面端');
};
$('changeCase').onclick = async () => {
  context = await send({ type: 'getContext' });
  say(context.message || '');
  renderCases();
};
$('back').onclick = () => { repairingId = null; renderCapture(); };
$('trayPage').onclick = async event => {
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  try {
    const result = await send({ type: 'captureTrayPage', sourceTabId, snapshot: sourceSnapshot });
    say(result.ok ? (result.queued ? result.message : '当前网页已暂存到中转站') : result.message);
    await renderRepairItems();
  } finally { button.disabled = false; }
};
load().catch(error => { show('pairView'); say(error.message || '扩展服务不可用'); });
