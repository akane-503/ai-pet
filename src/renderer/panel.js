'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const fmtMoney = (v, cur) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (cur === 'USD' ? '$' : cur === 'CNY' ? '¥' : '') + (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2));
  const fmtLeft = (sec) => { const s = Math.max(0, sec); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}天${h}h` : h ? `${h}h${m}m` : `${m}m`; };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function render(d) {
    const ap = d.config.appearance; const rows = [];
    const pal = d.colors || ['#203170', '#536ba9', '#9fb0d9'];
    document.documentElement.style.setProperty('--line', pal[0]); document.documentElement.style.setProperty('--text', pal[1]); document.documentElement.style.setProperty('--hint', pal[2]);
    const cur = (d.characters || []).find((c) => c.id === d.character);
    $('#why').textContent = (cur ? cur.name : (d.character || '')) + (d.why ? ' · ' + d.why : '');
    for (const p of (d.config.providers || []).filter((x) => x.enabled)) {
      const s = d.snapshots[p.id]; const led = d.ledgers[p.id];
      if (!s) { rows.push(`<div class="row"><span class="k">${esc(p.name)}</span><span class="v stale">…</span></div>`); continue; }
      if (!s.ok && !s.stale) { rows.push(`<div class="row"><span class="k">${esc(p.name)}</span><span class="v err" title="${esc(s.error)}">${esc((s.error || '失败').slice(0, 22))}</span></div>`); continue; }
      if (window.PetUsage.isRelay(p)) {
        const metric = window.PetUsage.relayMetric(s, led);
        rows.push(`<div class="row"><span class="k">${esc(p.name)}</span><span class="v${s.stale ? ' stale' : ''}" title="${esc(metric.hint)}">${metric.label} ${fmtMoney(metric.value, metric.currency)}</span></div>`);
      }
      else if (s.balance !== null && s.balance !== undefined) rows.push(`<div class="row"><span class="k">${esc(p.name)}</span><span class="v${s.stale ? ' stale' : ''}">${fmtMoney(s.balance, s.currency)}${led && led.todayUsage ? ` <span class="k">今 -${fmtMoney(led.todayUsage, s.currency)}</span>` : ''}</span></div>`);
      else for (const w of s.windows || []) rows.push(`<div class="row"><span class="k">${esc(p.name)} ${esc(w.label)}</span><span class="v${s.stale ? ' stale' : ''}" style="${w.usedPercent >= (Number(p.warnPercent) || 90) ? 'color:#e0433f' : ''}">${Math.round(w.usedPercent)}%${w.resetsAt ? ` <span class="k">${fmtLeft(w.resetsAt - Date.now() / 1000)}</span>` : ''}</span></div>`);
    }
    $('#info').innerHTML = rows.join('') || '<div class="row"><span class="k">还没有启用的数据源</span></div>';
    const sel = $('[data-cfg=character]'); sel.innerHTML = '<option value="auto">自动（跟随 agent）</option>' + (d.characters || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join(''); sel.value = ap.character || 'auto';
    $('[data-cfg=scale]').value = ap.scale; $('#scale-val').textContent = Math.round(ap.scale * 100) + '%';
    $('[data-cfg=sound]').value = ap.sound; $('[data-cfg=volume]').value = ap.volume; $('[data-cfg=peakMode]').value = ap.peakMode;
    for (const k of ['bubbleOn', 'quipsOn', 'snapWindows', 'alwaysOnTop']) $(`[data-cfg=${k}]`).checked = !!ap[k];
    // 启动按钮独占一行，正常长度都能完整显示；名字特别长时先省掉「打开」，再不行才省略号 + 悬停看全称
    const lb = $('#launch-btn');
    if (lb) {
      lb.hidden = !!d.quotaOnly;
      lb.style.display = d.quotaOnly ? 'none' : '';
      const name = d.launchLabel || '工具';
      lb.textContent = '打开 ' + name;
      if (lb.scrollWidth > lb.clientWidth) lb.textContent = name;
      lb.title = '打开 ' + name + '（双击角色也可以）';
    }
    // 内容高度上报，主进程据此调整窗口高度
    requestAnimationFrame(() => { const panel = document.querySelector('.panel'); window.pet.send('panel:size', { h: Math.ceil(panel.scrollHeight) + 16 }); });
  }
  document.addEventListener('change', (e) => { const k = e.target.dataset.cfg; if (!k) return; let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value; if (k === 'scale' || k === 'volume') v = Number(v); window.pet.send('appearance:set', { [k]: v }); });
  document.addEventListener('input', (e) => { if (e.target.dataset.cfg === 'scale') $('#scale-val').textContent = Math.round(e.target.value * 100) + '%'; });
  document.addEventListener('click', (e) => { const a = e.target.closest('[data-act]'); if (!a) return; const act = a.dataset.act; if (act === 'launch') { window.pet.send('launch'); window.pet.send('panel:close'); } else if (act === 'refresh') window.pet.send('refresh'); else if (act === 'bubble') { window.pet.send('cmd:pet', { name: 'bubble' }); window.pet.send('panel:close'); } else if (act === 'settings') { window.pet.send('open-settings', 'providers'); window.pet.send('panel:close'); } else if (act === 'quit') window.pet.send('quit'); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.pet.send('panel:close'); });
  window.pet.on('data', render);
  window.pet.send('panel:ready');
})();
