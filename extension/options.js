const toggle = document.getElementById('webTray');
const status = document.getElementById('status');
const origins = ['http://*/*', 'https://*/*'];
const scriptId = 'asset-ledger-tray';

async function refresh() {
  const granted = await chrome.permissions.contains({ origins });
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] });
  toggle.checked = granted && scripts.length > 0;
}

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  // Keep the optional permission request inside the user's checkbox gesture.
  const permission = enabled ? chrome.permissions.request({ origins }) : Promise.resolve(true);
  toggle.disabled = true;
  try {
    if (!await permission) { status.textContent = '未授予网站访问权限'; return; }
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] });
    if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
    if (enabled) {
      await chrome.scripting.registerContentScripts([{
        id: scriptId, js: ['content.js'], matches: origins,
        runAt: 'document_idle', persistAcrossSessions: true
      }]);
    }
    // Update existing tabs once on this explicit setting change, never poll.
    for (const tab of await chrome.tabs.query({ url: origins })) {
      if (enabled) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
      else await chrome.tabs.sendMessage(tab.id, { type: 'ledger-site-toggle', enabled: false }).catch(() => {});
    }
    status.textContent = enabled ? '已启用' : '已关闭';
  } catch { status.textContent = '设置未完成，请稍后重试'; }
  finally { await refresh(); toggle.disabled = false; }
});
refresh().catch(() => { status.textContent = '无法读取设置'; });
