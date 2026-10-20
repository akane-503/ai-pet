'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let cfg = null, baseline = null, meta = null, data = null;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  function configDiff(before, after) {
    const patch = {};
    for (const [key, value] of Object.entries(after)) {
      if (JSON.stringify(before[key]) === JSON.stringify(value)) continue;
      patch[key] = value && typeof value === 'object' && !Array.isArray(value) && before[key] && typeof before[key] === 'object'
        ? configDiff(before[key], value) : value;
    }
    // 删除自定义图、启动配置等字典项时，用 null 明确清除，避免合并后残留。
    for (const key of Object.keys(before)) if (!(key in after)) patch[key] = null;
    return patch;
  }
  async function persistSettings() {
    const patch = configDiff(baseline, cfg);
    cfg = await window.pet.invoke('config:set', patch);
    baseline = clone(cfg);
    renderAppearance(); renderNotify(); renderLaunch();
    return cfg;
  }
  function applyTheme(d) {
    const pal = d.colors || (meta && meta.characters.find((c) => c.id === d.character) || {}).colors;
    if (!pal) return;
    ['--line', '--text', '--hint'].forEach((k, i) => document.documentElement.style.setProperty(k, pal[i]));
  }

  const FIELD_DEFS = {
    apiKey: { label: 'API Key', type: 'password', wide: true },
    accessToken: { label: '系统访问令牌', type: 'password', hint: '可选：new-api 个人设置里的“系统访问令牌”，配合用户ID查余额更准' },
    userId: { label: '用户 ID', type: 'text' },
    baseUrl: { label: '地址', type: 'url', wide: true, placeholder: 'https://xxx.com' },
    lowBalance: { label: '余额低于提醒', type: 'number' },
    warnPercent: { label: '用量超过 % 提醒', type: 'number' },
    codexHome: { label: 'Codex 目录', type: 'text', wide: true },
    credentialsPath: { label: '凭据文件', type: 'text', wide: true },
    announcements: { label: '抓取公告', type: 'checkbox' },
  };

  // ---------- Tabs ----------
  function goto(tab) {
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + tab));
    if (tab === 'notifications') renderNotifications();
    if (tab === 'appearance') renderPreview();
  }
  document.querySelectorAll('#nav a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); location.hash = a.dataset.tab; goto(a.dataset.tab); }));
  window.pet.on('goto', goto);

  // ---------- Providers ----------
  function providerCard(p, i) {
    const m = meta.types[p.type] || { label: p.type, fields: [] };
    const fields = m.fields.map((f) => {
      const d = FIELD_DEFS[f] || { label: f, type: 'text' };
      if (d.type === 'checkbox') return `<label><span>${d.label}</span><input type="checkbox" data-f="${f}" ${p[f] !== false ? 'checked' : ''}></label>`;
      const val = p[f] ?? '';
      const pw = d.type === 'password';
      return `<label class="${d.wide ? 'wide' : ''}" title="${esc(d.hint || '')}"><span>${d.label}</span><input type="${pw ? 'password' : d.type}" data-f="${f}" value="${esc(val)}" placeholder="${esc(d.placeholder || '')}">${pw ? '<span class="eye" title="显示/隐藏">👁</span>' : ''}</label>`;
    }).join('');
    const chars = meta.characters.map((c) => `<option value="${c.id}" ${p.character === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    return `<div class="prov ${p.enabled ? '' : 'off'}" data-i="${i}">
      <div class="head"><input type="checkbox" data-f="enabled" ${p.enabled ? 'checked' : ''} title="启用"><input class="name" data-f="name" value="${esc(p.name)}"><span class="type">${esc(m.label)}</span></div>
      <div class="prov-status hint"></div>
      <div class="fields">${fields}<label><span>对应角色</span><select data-f="character">${chars}</select></label></div>
      <div class="foot"><button data-act="test">测试</button><span class="test-result"></span><button class="danger" data-act="del">删除</button></div>
    </div>`;
  }
  function renderProviders() {
    $('#providers').innerHTML = cfg.providers.map(providerCard).join('');
    $('#add-type').innerHTML = Object.entries(meta.types).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    renderProviderStatus();
  }
  function renderProviderStatus() {
    if (!cfg) return;
    document.querySelectorAll('.prov').forEach((card) => {
      const p = cfg.providers[+card.dataset.i], out = card.querySelector('.prov-status');
      const s = data && data.snapshots && data.snapshots[p.id];
      if (!p.enabled) { out.textContent = '已停用'; return; }
      if (!s) { out.textContent = '等待查询'; return; }
      const time = s.at ? new Date(s.at).toLocaleString() : '时间未知';
      if (!s.ok && !s.stale) { out.textContent = '获取失败：' + (s.error || '无数据'); return; }
      const fmt = (n) => Number.isFinite(n) ? (s.currency === 'CNY' ? '¥' : s.currency === 'USD' ? '$' : '') + n.toFixed(2) : '未知';
      const relay = window.PetUsage.isRelay(p) ? window.PetUsage.relayMetric(s, data.ledgers && data.ledgers[p.id]) : null;
      const value = relay ? relay.label + ' ' + fmt(relay.value) + ' · ' + relay.hint
        : s.balance != null ? '余额 ' + fmt(s.balance) + (s.granted != null ? ' · 其中赠送 ' + fmt(s.granted) : '')
        : (s.windows || []).map((w) => `${w.label} 已用 ${Math.round(w.usedPercent)}%`).join(' · ');
      out.textContent = value + ' · ' + (s.stale ? '刷新失败，保留最近值' : s.source === 'session-log' ? '本地会话记录' : '接口查询') + ' · ' + time;
      if (s.stale && s.error) out.title = s.error;
      else out.removeAttribute('title');
    });
  }
  $('#providers').addEventListener('input', (e) => {
    const card = e.target.closest('.prov'); if (!card) return;
    const p = cfg.providers[+card.dataset.i]; const f = e.target.dataset.f; if (!f) return;
    p[f] = e.target.type === 'checkbox' ? e.target.checked : (e.target.type === 'number' ? Number(e.target.value) : e.target.value);
    if (f === 'enabled') card.classList.toggle('off', !p.enabled);
  });
  $('#providers').addEventListener('click', async (e) => {
    if (e.target.classList.contains('eye')) { const inp = e.target.previousElementSibling; inp.type = inp.type === 'password' ? 'text' : 'password'; return; }
    const act = e.target.dataset.act; if (!act) return;
    const card = e.target.closest('.prov'); const i = +card.dataset.i; const p = cfg.providers[i];
    if (act === 'del') { if (confirm(`删除数据源「${p.name}」？`)) { cfg.providers.splice(i, 1); renderProviders(); } return; }
    if (act === 'test') {
      const out = card.querySelector('.test-result'); out.textContent = '测试中…'; out.className = 'test-result';
      const r = await window.pet.invoke('provider:test', p);
      if (r.ok) { out.classList.add('ok'); out.textContent = '✓ ' + (r.lines || []).join(' | ') + (r.models ? `\n模型 ${r.models.length} 个：${r.models.slice(0, 12).join(', ')}${r.models.length > 12 ? '…' : ''}` : '') + (r.announcements && r.announcements.length ? `\n公告 ${r.announcements.length} 条，最新：${r.announcements[0].content.slice(0, 80)}` : ''); }
      else { out.classList.add('err'); out.textContent = '✗ ' + r.error; }
    }
  });
  $('#add-provider').addEventListener('click', () => {
    const type = $('#add-type').value; const m = meta.types[type];
    const p = { id: type + '-' + Date.now().toString(36), type, name: m.label, enabled: true, character: m.defaultCharacter };
    if (type === 'zhipu') p.baseUrl = 'https://open.bigmodel.cn';
    if (m.kind === 'balance') p.lowBalance = 1; else p.warnPercent = 90;
    cfg.providers.push(p); renderProviders();
    window.scrollTo(0, document.body.scrollHeight);
  });
  $('#scan').addEventListener('click', async () => {
    const box = $('#scan-result'); box.classList.remove('hidden'); box.innerHTML = '扫描中…';
    const r = await window.pet.invoke('importers:scan');
    const rows = [];
    for (const d of r.deepseek) rows.push({ label: 'DeepSeek Key', from: d.from, apply: { type: 'deepseek', apiKey: d.key } });
    for (const x of r.relays) rows.push({ label: (x.type === 'zhipu' ? 'GLM' : x.type === 'newapi' ? '中转站' : x.type) + ' ' + x.baseUrl, from: x.from, apply: { type: x.type === 'official' ? 'newapi' : x.type, baseUrl: x.baseUrl, apiKey: x.apiKey } });
    rows.push({ label: 'Codex auth.json', from: r.codexAuth ? '已找到' : '未找到', apply: r.codexAuth ? { type: 'codex' } : null });
    for (const c of r.claudeCreds) rows.push({ label: 'Claude 登录凭据', from: c, apply: { type: 'claude-oauth', credentialsPath: c } });
    box.innerHTML = rows.map((row, i) => `<div class="scan-item"><b>${esc(row.label)}</b><code>${esc(row.from)}</code>${row.apply ? `<button data-scan="${i}">填入</button>` : ''}</div>`).join('') || '没扫到什么';
    box.onclick = (e) => {
      const i = e.target.dataset.scan; if (i === undefined) return;
      const a = rows[+i].apply;
      let p = cfg.providers.find((x) => x.type === a.type && (!a.baseUrl || !x.baseUrl || x.baseUrl === a.baseUrl));
      if (!p) { const m = meta.types[a.type]; p = { id: a.type + '-' + Date.now().toString(36), type: a.type, name: m.label, enabled: true, character: m.defaultCharacter, lowBalance: 1, warnPercent: 90 }; cfg.providers.push(p); }
      Object.assign(p, a, { enabled: true }); if (a.baseUrl && a.type === 'newapi') p.name = '中转站 ' + a.baseUrl.replace(/^https?:\/\//, '');
      if (a.type === 'zhipu') p.baseUrl = a.baseUrl.replace(/\/api\/(anthropic|paas\/v4).*$/, '');
      renderProviders(); e.target.textContent = '已填入';
    };
  });

  // ---------- Notify ----------
  function renderNotify() {
    document.querySelectorAll('[data-n]').forEach((el) => { const k = el.dataset.n; if (el.type === 'checkbox') el.checked = !!cfg.notify[k]; else el.value = cfg.notify[k] ?? ''; });
    renderRss();
  }
  document.querySelectorAll('[data-n]').forEach((el) => el.addEventListener('input', () => { cfg.notify[el.dataset.n] = el.type === 'checkbox' ? el.checked : el.value; }));
  function renderRss() {
    $('#rss-list').innerHTML = (cfg.notify.rssFeeds || []).map((f, i) => `<div class="rss-row" data-i="${i}"><input type="checkbox" data-r="enabled" ${f.enabled !== false ? 'checked' : ''}><input type="text" data-r="name" value="${esc(f.name)}" placeholder="名称" style="max-width:140px"><input type="url" data-r="url" value="${esc(f.url)}" placeholder="https://.../feed.xml"><button data-r="del">×</button></div>`).join('');
  }
  $('#rss-add').addEventListener('click', () => { (cfg.notify.rssFeeds = cfg.notify.rssFeeds || []).push({ name: '', url: '', enabled: true }); renderRss(); });
  $('#rss-list').addEventListener('input', (e) => { const row = e.target.closest('.rss-row'); const f = cfg.notify.rssFeeds[+row.dataset.i]; const k = e.target.dataset.r; f[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; });
  $('#rss-list').addEventListener('click', (e) => { if (e.target.dataset.r === 'del') { cfg.notify.rssFeeds.splice(+e.target.closest('.rss-row').dataset.i, 1); renderRss(); } });

  // ---------- Appearance ----------
  function renderAppearance() {
    const ap = cfg.appearance;
    const charOpts = meta.characters.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('[data-a=character]').innerHTML = '<option value="auto">自动（跟随当前 agent）</option>' + charOpts;
    $('[data-a=favorite]').innerHTML = charOpts;
    document.querySelectorAll('[data-a]').forEach((el) => { const k = el.dataset.a; if (el.type === 'checkbox') el.checked = !!ap[k]; else el.value = ap[k] ?? ''; });
    $('#scale-val').textContent = Math.round(ap.scale * 100) + '%';
    $('#autostart').checked = !!cfg.autostart; $('#interval').value = cfg.refresh.intervalSec; $('#news-interval').value = cfg.refresh.newsIntervalMin;
  }
  document.querySelectorAll('[data-a]').forEach((el) => el.addEventListener('input', () => {
    const k = el.dataset.a; cfg.appearance[k] = el.type === 'checkbox' ? el.checked : (el.type === 'number' || el.type === 'range' ? Number(el.value) : el.value);
    if (k === 'scale') $('#scale-val').textContent = Math.round(el.value * 100) + '%';
    if (k === 'deepseekSkin') renderPreview();
  }));
  $('#autostart').addEventListener('input', (e) => { cfg.autostart = e.target.checked; });
  $('#recover-pet').addEventListener('click', () => window.pet.send('pet:recover'));
  $('#interval').addEventListener('input', (e) => { cfg.refresh.intervalSec = Number(e.target.value); });
  $('#news-interval').addEventListener('input', (e) => { cfg.refresh.newsIntervalMin = Number(e.target.value); });
  function imgFor(id) {
    const ap = cfg.appearance; const custom = (ap.customImages || {})[id];
    if (custom) return custom.replace(/\\/g, '/');
    if (id === 'deepseek') return window.pet.assetsDir + (ap.deepseekSkin === 'chibi' ? '/characters/deepseek-chibi.png' : '/characters/deepseek-classic.png');
    return (meta.characterImages || {})[id] || null;
  }
  function renderPreview() {
    $('#preview').innerHTML = meta.characters.map((c) => { const img = imgFor(c.id); return `<div class="pv" data-mood="happy" data-id="${c.id}">${img ? `<img src="file:///${img.replace(/^\/+/, '')}">` : '<div style="width:140px;height:168px;display:flex;align-items:center;justify-content:center;color:#99a">无立绘</div>'}<div>${esc(c.name)}</div><div class="pv-btns"><button data-pick="${c.id}">选图…</button>${(cfg.appearance.customImages || {})[c.id] ? `<button data-unpick="${c.id}">还原</button>` : ''}</div></div>`; }).join('');
  }
  $('#preview').addEventListener('click', async (e) => {
    const pick = e.target.dataset.pick, un = e.target.dataset.unpick;
    if (pick) { const f = await window.pet.invoke('pick-file'); if (f) { cfg.appearance.customImages = cfg.appearance.customImages || {}; cfg.appearance.customImages[pick] = f; renderPreview(); } }
    if (un) { delete cfg.appearance.customImages[un]; renderPreview(); }
  });

  // ---------- Quips ----------
  function renderQuips() {
    cfg.quips = cfg.quips || {};
    document.querySelectorAll('[data-q]').forEach((el) => { const k = el.dataset.q; if (el.type === 'checkbox') el.checked = !!cfg.quips[k]; else el.value = cfg.quips[k] ?? ''; });
    window.pet.invoke('quips:state').then((st) => { const n = Object.values(st.counts || {}).reduce((a, b) => a + b, 0); $('#quips-msg').textContent = (st.updatedAt ? `上次 ${new Date(st.updatedAt).toLocaleString()}，已有 ${n} 句` : '还没生成过') + (st.hasKey ? '' : '（没有 DeepSeek Key）') + (st.lastError ? ' · 上次有错误' : ''); });
  }
  document.querySelectorAll('[data-q]').forEach((el) => el.addEventListener('input', () => { cfg.quips[el.dataset.q] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value); }));
  $('#quips-gen').addEventListener('click', async () => { $('#quips-msg').textContent = '保存并开始生成…'; await persistSettings(); const r = await window.pet.invoke('quips:generate'); $('#quips-msg').textContent = (r.ok ? '✓ ' : '✗ ') + r.message; setTimeout(renderQuips, 1500); });
  window.pet.on('quips:progress', (p) => { $('#quips-msg').textContent = p.text; });

  // ---------- Activity ----------
  function renderActivity() { document.querySelectorAll('[data-act]').forEach((el) => { el.value = cfg.activity[el.dataset.act] ?? ''; }); }
  document.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('input', () => { cfg.activity[el.dataset.act] = el.type === 'number' ? Number(el.value) : el.value; }));
  $('#act-test').addEventListener('click', async () => { const r = await window.pet.invoke('activity:now'); $('#act-result').textContent = JSON.stringify({ active: r.active, at: r.at ? new Date(r.at).toLocaleString() : null, details: Object.fromEntries(Object.entries(r.details).map(([k, v]) => [k, v ? new Date(v).toLocaleString() : null])) }, null, 2); });

  // ---------- Launch ----------
  let launchDefaults = {};
  const KINDS = [['app', '桌面应用 (exe)'], ['store', '商店应用 (AppID)'], ['wsl-cli', 'WSL 里的 CLI'], ['cli', 'Windows CLI'], ['url', '网页']];
  function renderLaunch() {
    cfg.launch = cfg.launch || {};
    $('#launch-list').innerHTML = meta.characters.map((c) => {
      const d = launchDefaults[c.id] || {}; const u = cfg.launch[c.id] || {}; const v = { ...d, ...u };
      const custom = !!u.kind;
      return `<div class="card" data-launch="${c.id}">
        <h3>${esc(c.name)} <span class="hint" style="display:inline">默认：${esc(d.label || '无')}${custom ? ' · 已自定义' : ''}</span></h3>
        <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:4px 20px">
          <label>方式 <select data-l="kind">${KINDS.map(([k, n]) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label>名称 <input type="text" data-l="label" value="${esc(v.label || '')}"></label>
          <label style="grid-column:1/-1">目标（exe 路径 / AppID / 网址） <input type="text" data-l="target" value="${esc(v.target || '')}"><button data-pick-exe="${c.id}">…</button></label>
          <label>命令（CLI） <input type="text" data-l="command" value="${esc(v.command || '')}" placeholder="claude"></label>
          <label>WSL 发行版 <input type="text" data-l="distro" value="${esc(v.distro || '')}" placeholder="Ubuntu-24.04"></label>
          <label>工作目录 <input type="text" data-l="cwd" value="${esc(v.cwd || '')}" placeholder="~"></label>
          <label>已开检测（窗口标题正则） <input type="text" data-l="match" value="${esc(v.match || '')}"></label>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px"><button data-test-launch="${c.id}">试一下</button>${custom ? `<button data-reset-launch="${c.id}">恢复默认</button>` : ''}</div>
      </div>`;
    }).join('');
  }
  $('#launch-list').addEventListener('input', (e) => {
    const card = e.target.closest('[data-launch]'); const k = e.target.dataset.l; if (!card || !k) return;
    const id = card.dataset.launch; cfg.launch[id] = cfg.launch[id] || { ...(launchDefaults[id] || {}) };
    cfg.launch[id][k] = e.target.value;
  });
  $('#launch-list').addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset.testLaunch) { await persistSettings(); window.pet.send('launch', t.dataset.testLaunch); }
    if (t.dataset.resetLaunch) { delete cfg.launch[t.dataset.resetLaunch]; renderLaunch(); }
    if (t.dataset.pickExe) { const f = await window.pet.invoke('pick-file'); if (f) { const id = t.dataset.pickExe; cfg.launch[id] = cfg.launch[id] || { ...(launchDefaults[id] || {}) }; cfg.launch[id].target = f; cfg.launch[id].kind = 'app'; renderLaunch(); } }
  });

  // ---------- Notifications ----------
  function renderNotifications() {
    const list = (data && data.notifications) || [];
    $('#n-list').innerHTML = list.length ? list.map((n) => `<div class="n-item ${n.read ? '' : 'unread'}"><span class="t">${new Date(n.ts).toLocaleString()}</span><div class="b"><b>${esc(n.title)}</b>${esc(n.body)}${n.link ? ` <a href="#" data-link="${esc(n.link)}">打开</a>` : ''}</div></div>`).join('') : '<p class="hint">还没有消息。额度重置、送额度、模型上新、公告都会出现在这里。</p>';
    const unread = list.filter((n) => !n.read).length; $('#unread').textContent = unread; $('#unread').classList.toggle('hidden', !unread);
  }
  $('#n-list').addEventListener('click', (e) => { const l = e.target.dataset.link; if (l) { e.preventDefault(); window.pet.send('open-external', l); } });
  $('#n-read').addEventListener('click', () => window.pet.send('notifications:read'));
  $('#n-clear').addEventListener('click', () => { if (confirm('清空全部消息？')) window.pet.send('notifications:clear'); });

  // ---------- Save ----------
  $('#save').addEventListener('click', async () => {
    $('#save-msg').textContent = '保存中…';
    await persistSettings();
    $('#save-msg').textContent = '✓ 已保存';
    setTimeout(() => { $('#save-msg').textContent = ''; }, 3000);
  });

  // ---------- Init ----------
  window.pet.on('data', (d) => { data = d; applyTheme(d); renderProviderStatus(); renderNotifications(); });
  window.pet.on('notification', () => { window.pet.invoke('notifications:list').then((l) => { data = data || {}; data.notifications = l; renderNotifications(); }); });
  (async () => {
    meta = await window.pet.invoke('meta');
    cfg = await window.pet.invoke('config:get');
    baseline = clone(cfg);
    launchDefaults = await window.pet.invoke('launch:defaults');
    const st = await window.pet.invoke('state:get');
    data = { ...(data || {}), notifications: st.notifications };
    applyTheme(data.colors ? data : { character: cfg.appearance.character === 'auto' ? cfg.appearance.favorite : cfg.appearance.character });
    $('#userdata').textContent = meta.userData;
    $('#about-meta').textContent = `版本 ${meta.version} · Electron ${meta.electron} · 窗口吸附 ${meta.snapAvailable ? '可用' : '不可用（koffi 未加载）'} · 程序目录 ${meta.root}`;
    renderProviders(); renderNotify(); renderAppearance(); renderQuips(); renderActivity(); renderLaunch(); renderNotifications();
    goto((location.hash || '#providers').slice(1));
  })();
})();
