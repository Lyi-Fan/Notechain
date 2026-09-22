(() => {
  if (!/^https?:$/.test(location.protocol) || document.getElementById('asset-ledger-tray-host')) return;
  const send = message => chrome.runtime.sendMessage(message).catch(() => ({ ok: false, message: '扩展已更新，请刷新网页' }));
  send({ type: 'isHostExcluded' }).then(result => { if (result && !result.excluded) mount(); });

  function mount() {
    if (document.getElementById('asset-ledger-tray-host')) return;
    const host = document.createElement('div');
    host.id = 'asset-ledger-tray-host';
    host.style.cssText = 'all:initial;position:fixed;right:8px;top:40%;width:0;height:0;z-index:2147483647;color-scheme:light';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${styles}</style><button class="handle" title="中转站" aria-label="打开中转站"></button>`;
    document.documentElement.append(host);
    const lifetime = new AbortController();
    const signal = lifetime.signal;
    let panel, list, status, overlay, pager, ghost, press, holdTimer, hideTimer, loadId = 0;
    let hover = false, dragging = false, expanded = false, total = 0, offset = 0, nextOffset = null;
    const handle = shadow.querySelector('.handle');
    function ensurePanel() {
      if (panel) return;
      panel = document.createElement('section');
      panel.className = 'panel'; panel.setAttribute('aria-label', '中转站');
      panel.innerHTML = '<div class="cards"></div><div class="dropzone"><span class="plus">+</span><span>中转站</span></div><div class="pager" hidden><button class="prev" aria-label="上一页">↑</button><span></span><button class="next" aria-label="下一页">↓</button></div><p class="status" role="status"></p>';
      shadow.append(panel); list = panel.querySelector('.cards'); status = panel.querySelector('.status'); overlay = panel.querySelector('.dropzone'); pager = panel.querySelector('.pager');
      panel.addEventListener('pointerenter', () => { clearTimeout(hideTimer); hover = true; if (!dragging) { expanded = true; paint(); load(offset); } });
      panel.addEventListener('pointerleave', leave);
      pager.querySelector('.prev').onclick = () => load(Math.max(0, offset - 30));
      pager.querySelector('.next').onclick = () => { if (nextOffset !== null) load(nextOffset); };
    }
    function paint() {
      ensurePanel();
      panel.classList.toggle('open', hover || dragging);
      panel.classList.toggle('dragging', dragging);
      panel.classList.toggle('expanded', expanded && !dragging && total > 1);
      panel.classList.toggle('has-items', total > 0);
      const height = expanded && !dragging && total > 1 ? 420 : total ? 116 + Math.min(total - 1, 2) * 7 : 136;
      panel.style.height = `${Math.min(height, innerHeight - 48)}px`;
      panel.style.top = `${Math.min(0, innerHeight - 24 - (innerHeight * .4 + height))}px`;
      overlay.hidden = total > 0 && !dragging;
      pager.hidden = !(expanded && !dragging && total > 30);
      handle.classList.toggle('hidden', hover || dragging);
    }
    async function load(start = 0) {
      const requestId = ++loadId;
      const result = await send({ type: 'getTray', offset: start });
      if (requestId !== loadId || !host.isConnected) return;
      if (!result?.ok) { status.textContent = result?.message || '客户端尚未连接'; return; }
      offset = start; total = result.total || 0; nextOffset = result.nextOffset;
      list.replaceChildren();
      for (const [index, item] of (result.items || []).slice(0, 30).entries()) {
        const card = document.createElement('article');
        card.className = 'card'; card.style.setProperty('--index', Math.min(index, 2));
        const title = document.createElement('strong'), excerpt = document.createElement('p');
        title.textContent = item.title || item.href || '未命名笔记'; excerpt.textContent = item.text || item.href || '';
        card.append(title, excerpt); list.append(card);
      }
      pager.querySelector('span').textContent = `${total ? offset + 1 : 0}–${Math.min(offset + 30, total)} / ${total}`;
      pager.querySelector('.prev').disabled = offset === 0; pager.querySelector('.next').disabled = nextOffset === null;
      status.textContent = result.offline ? result.message || '本地待发送' : ''; paint();
    }
    function open() { clearTimeout(hideTimer); hover = true; expanded = true; paint(); load(0); }
    function leave() { hover = false; clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!dragging && !hover) { expanded = false; paint(); } }, 200); }
    handle.addEventListener('pointerenter', open); handle.addEventListener('click', open); handle.addEventListener('pointerleave', leave);

    function selectionAt(event) {
      const selection = getSelection();
      if (!selection?.rangeCount || selection.isCollapsed || event.composedPath().includes(host)) return null;
      const range = selection.getRangeAt(0), rects = [...range.getClientRects()];
      if (!rects.some(rect => event.clientX >= rect.left - 2 && event.clientX <= rect.right + 2 && event.clientY >= rect.top - 2 && event.clientY <= rect.bottom + 2)) return null;
      const node = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
      if (node?.closest('input,textarea,[contenteditable="true"],select')) return null;
      const text = selection.toString().trim();
      if (!text) return null;
      if (text.length > 24000) { open(); status.textContent = '单次摘录最多 24,000 字符，请分段收集'; return null; }
      // Only inspect the selected block and bounded neighbouring siblings.
      const block = node?.closest('p,li,pre,blockquote,h1,h2,h3,h4,h5,h6') || node;
      const prefix = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.data.slice(Math.max(0, range.startOffset - 80), range.startOffset) : '';
      const suffix = range.endContainer.nodeType === Node.TEXT_NODE ? range.endContainer.data.slice(range.endOffset, range.endOffset + 80) : '';
      let heading = '', candidate = block;
      for (let count = 0; candidate && count < 16; count++) {
        if (candidate.id) { heading = candidate.id.slice(0, 1000); break; }
        candidate = candidate.previousElementSibling || candidate.parentElement;
        if (candidate === document.body || candidate === document.documentElement) break;
      }
      return { text, rect: range.getBoundingClientRect(), anchor: { exact: text, heading, prefix, suffix } };
    }
    function begin() {
      if (!press) return;
      dragging = true; expanded = false; hover = false; paint(); load(0);
      ghost = document.createElement('div'); ghost.className = 'ghost';
      const text = document.createElement('span'); text.textContent = press.text; ghost.append(text); shadow.append(ghost);
      ghost.style.left = `${press.x}px`; ghost.style.top = `${press.y}px`;
      const w = Math.min(520, Math.max(170, press.rect.width)), h = Math.min(140, Math.max(42, press.rect.height));
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) ghost.animate([
        { width: `${w}px`, height: `${h}px`, transform: 'translate(-50%, -50%) scale(1)', opacity: .8 },
        { width: '172px', height: '36px', transform: 'translate(-50%, -50%) scale(.94)', offset: .72 },
        { width: '180px', height: '38px', transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
      ], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    function over(x, y) {
      if (!panel) return false;
      const rect = panel.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }
    function cleanup() {
      clearTimeout(holdTimer); press = null; dragging = false;
      ghost?.remove(); ghost = null; panel?.classList.remove('over'); if (panel) paint();
    }
    document.addEventListener('pointerdown', event => {
      if (!event.isTrusted || event.button !== 0 || event.pointerType === 'touch') return;
      const selected = selectionAt(event); if (!selected) return;
      event.preventDefault();
      press = { ...selected, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      holdTimer = setTimeout(begin, 190);
    }, { capture: true, signal });
    document.addEventListener('pointermove', event => {
      if (!press || event.pointerId !== press.pointerId) return;
      if (!dragging) { if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) cleanup(); return; }
      event.preventDefault(); ghost.style.left = `${event.clientX}px`; ghost.style.top = `${event.clientY}px`;
      panel.classList.toggle('over', over(event.clientX, event.clientY));
    }, { capture: true, signal });
    document.addEventListener('pointerup', async event => {
      if (!press || event.pointerId !== press.pointerId) return;
      const selected = press, dropped = dragging && over(event.clientX, event.clientY);
      if (dragging) { event.preventDefault(); event.stopPropagation(); }
      cleanup(); if (!dropped) return;
      hover = true; expanded = false; paint(); status.textContent = '正在收集…';
      const result = await send({ type: 'captureSelection', text: selected.text, anchor: selected.anchor });
      if (result?.ok) {
        await load(0); status.textContent = result.queued ? '已暂存，客户端上线后送达' : '已收集';
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) panel.animate([{ transform: 'scale(.97)' }, { transform: 'scale(1.025)', offset: .65 }, { transform: 'scale(1)' }], { duration: 280 });
      } else status.textContent = result?.message || '收集失败，请重试';
      hideTimer = setTimeout(() => { hover = false; paint(); }, result?.ok ? 1800 : 5000);
    }, { capture: true, signal });
    document.addEventListener('pointercancel', cleanup, { capture: true, signal });
    document.addEventListener('dragstart', event => { if (press) event.preventDefault(); }, { capture: true, signal });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { hover = false; cleanup(); } }, { capture: true, signal });
    window.addEventListener('blur', () => { hover = false; cleanup(); }, { signal });
    window.addEventListener('resize', () => { if (panel && (hover || dragging)) paint(); }, { signal });
    const toggle = (message, sender) => {
      if (sender.id !== chrome.runtime.id || message.type !== 'ledger-site-toggle' || message.enabled) return;
      hover = false; cleanup(); clearTimeout(hideTimer); lifetime.abort(); host.remove();
      chrome.runtime.onMessage.removeListener(toggle);
    };
    chrome.runtime.onMessage.addListener(toggle);
  }

  const styles = `
    *{box-sizing:border-box;letter-spacing:0}button{font:inherit;cursor:pointer}button:focus-visible{outline:2px solid #708878;outline-offset:3px}
    .handle{position:absolute;right:-5px;top:0;width:10px;height:64px;padding:0;border:1px solid #bfc1be;border-radius:8px;background:#dedfdb;box-shadow:0 2px 8px #292c2512;transition:opacity .18s;opacity:.85}.handle.hidden{opacity:0;pointer-events:none}
    .panel{position:absolute;right:0;top:0;width:204px;height:136px;padding:8px;border:1px solid #dadbd6;border-radius:16px;background:#f5f5f2;color:#454741;font:500 13px/1.5 'MiSans','Microsoft YaHei UI',sans-serif;box-shadow:0 8px 28px #24282424;transform:translateX(228px);visibility:hidden;transition:transform .28s cubic-bezier(.2,1.35,.4,1),height .22s ease,visibility .28s;overflow:hidden}
    .panel.open{transform:translateX(0);visibility:visible}.cards{height:100%;position:relative;overflow:hidden}.card{position:absolute;inset:0 0 auto;padding:11px 12px;height:96px;border:1px solid #d7d8d3;border-radius:11px;background:#ebede8;transform:translateY(calc(var(--index)*7px)) scale(calc(1 - var(--index)*.035));transform-origin:bottom;z-index:calc(3 - var(--index));overflow:hidden}.card:nth-child(n+4){display:none}.card strong{display:block;font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card p{margin:7px 0 0;font-size:12px;line-height:1.6;color:#777970;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .expanded .cards{overflow-y:auto;height:calc(100% - 36px);scrollbar-width:thin;scrollbar-color:#c3c5be transparent}.expanded .card{display:block;position:relative;inset:auto;transform:none;margin:0 0 7px;min-height:92px}.dropzone{position:absolute;inset:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border:1px dashed #b5b8ae;border-radius:11px;color:#7a7e73;background:#f3f4efb8}.plus{font-size:26px;line-height:1;font-weight:400}.dragging.has-items .cards{filter:blur(3px);opacity:.5}.over .dropzone{background:#e5e8dfdd;border-color:#89917e}.pager{position:absolute;bottom:8px;left:8px;right:8px;display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#73796a}.pager button{width:26px;height:24px;border:0;border-radius:7px;background:#e5e7df;color:#535b4a}.pager button:disabled{opacity:.35}.status{position:absolute;bottom:7px;left:10px;right:10px;margin:0;font-size:11px;line-height:1.4;color:#64695b;text-align:center;background:#f5f5f2e8;border-radius:6px}.status:empty{display:none}[hidden]{display:none!important}
    .ghost{position:fixed;pointer-events:none;width:180px;height:38px;padding:8px 12px;display:flex;align-items:center;justify-content:center;border:1px solid #c9ccc2;border-radius:10px;background:#e6e8e0;color:#626759;box-shadow:0 5px 16px #2a302320;transform:translate(-50%,-50%);font:500 13px/1.5 'MiSans','Microsoft YaHei UI',sans-serif;overflow:hidden}.ghost span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:100%}
    @media(prefers-reduced-motion:reduce){.panel,.handle{transition:none}}
  `;
})();
