'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let cfg = null, baseline = null, meta = null, data = null, environment = null;
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
    if (patch.features) meta = await window.pet.invoke('meta');
    if (patch.agents) { meta = await window.pet.invoke('meta'); launchDefaults = await window.pet.invoke('launch:defaults'); renderProviders(); renderAgents(); }
    renderAppearance(); renderNotify(); renderLaunch(); renderEnvironment();
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
    project: { label: 'GCP 项目（可选）', type: 'text', placeholder: '留空自动查', hint: '官方 OAuth 查配额需要项目 ID，一般能自动拿到' },
    auth: { label: '取数方式', type: 'text', placeholder: 'auto / relay / oauth', hint: 'auto：有中转站地址就走中转站，否则读 ~/.gemini 的登录凭据' },
    lowBalance: { label: '余额低于提醒', type: 'number' },
    warnPercent: { label: '用量超过 % 提醒', type: 'number' },
    codexHome: { label: 'Codex 目录', type: 'text', wide: true },
    credentialsPath: { label: '凭据文件', type: 'text', wide: true },
    announcements: { label: '抓取公告', type: 'checkbox' },
    dbPath: { label: 'state.vscdb', type: 'text', wide: true, placeholder: '留空：%APPDATA%\\Cursor\\User\\globalStorage\\state.vscdb' },
    agentDir: { label: 'kimi-agent 数据目录', type: 'text', wide: true, placeholder: '留空：%APPDATA%\\kimi-desktop\\kimi-agent' },
    cookie: { label: 'Cookie（可选）', type: 'password', wide: true, hint: '读不到本机登录时，填网页版 WorkosCursorSessionToken' },
    balancePath: { label: '余额字段', type: 'text', placeholder: 'data.balance' },
    usedPath: { label: '已用字段', type: 'text', placeholder: 'data.used' },
    limitPath: { label: '总额字段', type: 'text', placeholder: 'data.limit' },
    currency: { label: '币种', type: 'text', placeholder: 'CNY / USD' },
  };

  // ---------- Tabs ----------
  function goto(tab) {
    if (!document.getElementById('tab-' + tab)) tab = 'tools';
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + tab));
    if (tab === 'notifications') renderNotifications();
    if (tab === 'appearance') renderPreview();
    if (tab === 'tools' && !environment && cfg) scanEnvironment();
  }
  document.querySelectorAll('#nav a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); location.hash = a.dataset.tab; goto(a.dataset.tab); }));
  window.pet.on('goto', goto);
  window.addEventListener('hashchange', () => goto(location.hash.slice(1)));

  // ---------- Machine environment ----------
  let scanning = false;
  async function scanEnvironment() {
    if(scanning || !cfg) return;
    scanning = true; $('#environment-scan').disabled = true;
    $('#environment-status').textContent = '正在检查运行进程、安装入口、数据目录与读取能力…';
    try {
      environment = await window.pet.invoke('environment:scan', { agents:cfg.agents, launch:cfg.launch, activity:cfg.activity, providers:cfg.providers.map(p => ({id:p.id,type:p.type,name:p.name,enabled:p.enabled,dbPath:p.dbPath})) });
      launchDefaults = await window.pet.invoke('launch:defaults');
      renderActivity(); renderEnvironment(); renderLaunch();
      $('#environment-status').textContent = `本机发现 ${environment.tools.filter(t=>t.installed||t.dataFound).length} 个工具环境，${environment.tools.filter(t=>t.modelSupported).length} 个可读取模型状态。检查于 ${new Date(environment.at).toLocaleTimeString()}。未修改设置。`;
    } catch(e) { $('#environment-status').textContent = '检测失败：' + e.message; }
    finally { scanning = false; $('#environment-scan').disabled = false; }
  }
  function renderEnvironment() {
    if(!environment) return;
    const query = $('#tool-search').value.trim().toLowerCase(), filter = $('#tool-filter').value;
    const tools = environment.tools.filter(t => (filter === 'all' || filter === 'attention' ? filter !== 'attention' || ((t.installed||t.configured||t.dataFound)&&(!t.launchAvailable||!t.dataFound)) : t.installed||t.configured||t.dataFound) && `${t.name} ${t.entry} ${t.dataPath} ${t.model?.label||''}`.toLowerCase().includes(query));
    $('#environment-list').innerHTML = tools.map(t=>`<article class="tool-row" data-tool="${esc(t.id)}">
      <div class="tool-heading"><h2>${esc(t.name)}</h2><span class="status ${t.installed?'available':''}">${t.installed?'入口可用':t.dataFound?'发现本地数据':t.configured?'已配置，待检查':'未发现本机入口'}</span></div>
      <div class="tool-capabilities"><span>额度：${t.providers.some(p=>p.enabled)?'已关联':t.providers.length?'未启用':'可手动关联'}</span><span>模型：${esc(t.model?.ok?(t.model.auto?`${t.model.label || '自动'}（未公开实际模型）`:t.model.label):t.modelSupported?'读取失败':'未提供读取器')}</span><span>直接转接来源：${t.handoffReadable?'可读取':t.transcript?'未找到会话位置':'暂不支持'}</span></div>
      <p class="entry-path">${esc(t.entry || '可在启动覆盖中设置入口')}</p>
      <div class="tool-actions"><button data-tool-action="launch">启动设置</button>${t.activityKey?'<button data-tool-action="activity">检测规则</button>':''}<button data-tool-action="providers">账号与额度</button>${t.preset?'<button data-tool-action="add">添加识别规则</button>':''}</div>
      <details><summary>能力与路径详情</summary><dl><dt>本地数据</dt><dd>${esc(t.dataPath || '未配置')}（${t.dataFound?'存在':'未找到'}）</dd><dt>接手技能</dt><dd>${t.skillInstalled?'已发现技能文件；实际调用仍需目标工具支持':'未发现技能文件，转接时使用文字指令'}</dd><dt>模型说明</dt><dd>${esc(t.model?.error || t.modelNote || '模型不可识别或使用 Auto 时保留默认形象。可为自定义工具指定本地状态文件。')}</dd></dl></details>
    </article>`).join('') || '<p class="empty-state">没有匹配的工具。可查看全部支持的工具，或在下方添加自定义工具。</p>';
    $('#takeover-capabilities').innerHTML = environment.tools.filter(t=>t.transcript).map(t=>`<div class="capability-line"><b>${esc(t.name)}</b><span>${t.handoffReadable?'发现来源数据':'来源路径未就绪'}</span><span>${t.skillInstalled?'已发现接手技能':'使用文字指令接手'}</span></div>`).join('');
  }
  $('#environment-scan').addEventListener('click', scanEnvironment);
  $('#tool-search').addEventListener('input', renderEnvironment);
  $('#tool-filter').addEventListener('change', renderEnvironment);
  $('#launch-search').addEventListener('input', renderLaunch);
  $('#launch-show-all').addEventListener('change', renderLaunch);
  $('#environment-list').addEventListener('click', e=> {
    const action=e.target.dataset.toolAction, row=e.target.closest('[data-tool]'); if(!action||!row) return;
    const t=environment.tools.find(t=>t.id===row.dataset.tool);
    if(action==='add') { if(t.preset && !(cfg.agents||[]).some(a=>a.id===t.id)) { (cfg.agents=cfg.agents||[]).push({...t.preset}); renderAgents(); renderAgentPresets(); e.target.textContent='已添加，保存后生效'; e.target.disabled=true; } return; }
    location.hash=action; goto(action);
    if(action==='launch') { $('#launch-search').value=t.name; $('#launch-show-all').checked=true; renderLaunch(); }
    if(action==='activity') document.querySelector(`[data-act="${t.activityKey}"]`)?.focus();
  });
  $('#feature-handoff').addEventListener('change', e => { cfg.features = { ...(cfg.features || {}), handoff:e.target.checked }; $('#save-msg').textContent='有未保存的更改'; });
  $('#takeover-check').addEventListener('click', async e=> {
    e.target.disabled=true; $('#takeover-result').textContent='正在只读校验…';
    try { const r=await window.pet.invoke('takeover:inspect',$('#takeover-ref').value.trim()); $('#takeover-result').textContent=r.ok?`${r.title || '指定会话'}\n项目：${r.project || '未识别，转接时需选择'}\n尾部可读消息：${r.messages}${r.truncated?'（有截断）':''}${r.repaired?'\n已修复缺失的路径分隔符':''}\n引用：${r.ref}`:'无法接手：'+r.error; }
    catch(err) { $('#takeover-result').textContent='校验失败：'+err.message; }
    finally { e.target.disabled=false; }
  });

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
      <details class="provider-config"><summary>连接与提醒设置</summary><div class="fields">${fields}<label><span>对应角色</span><select data-f="character">${chars}</select></label></div></details>
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
      const relay = window.PetUsage.isRelay(p, s) ? window.PetUsage.relayMetric(s, data.ledgers && data.ledgers[p.id]) : null;
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
    if (type === 'zhipu') p.baseUrl = 'https://api.z.ai';
    if (m.kind === 'balance') p.lowBalance = 1; else p.warnPercent = 90;
    cfg.providers.push(p); renderProviders();
    window.scrollTo(0, document.body.scrollHeight);
  });
  $('#scan').addEventListener('click', async () => {
    const box = $('#scan-result'); box.classList.remove('hidden'); box.innerHTML = '扫描中…';
    const r = await window.pet.invoke('importers:scan');
    const rows = [];
    for (const d of r.deepseek) rows.push({ label: 'DeepSeek Key', from: d.from, apply: { type: 'deepseek', apiKey: d.key } });
    for (const x of r.relays) rows.push({ label: (x.type === 'zhipu' ? 'GLM' : x.type === 'newapi' ? '中转站' : x.type === 'gemini' ? 'Gemini 中转站' : x.type) + ' ' + x.baseUrl, from: x.from, apply: { type: x.type === 'official' ? 'newapi' : x.type, baseUrl: x.baseUrl, apiKey: x.apiKey } });
    rows.push({ label: 'Codex auth.json', from: r.codexAuth ? '已找到' : '未找到', apply: r.codexAuth ? { type: 'codex' } : null });
    for (const c of r.claudeCreds) rows.push({ label: 'Claude 登录凭据', from: c, apply: { type: 'claude-oauth', credentialsPath: c } });
    if (r.geminiCreds) rows.push({ label: 'Gemini CLI 登录凭据', from: '~/.gemini/oauth_creds.json', apply: { type: 'gemini', auth: 'oauth' } });
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
    renderNewsStatus(data && data.newsStatus);
  }
  document.querySelectorAll('[data-n]').forEach((el) => el.addEventListener('input', () => { cfg.notify[el.dataset.n] = el.type === 'checkbox' ? el.checked : el.value; }));
  function renderRss() {
    $('#rss-list').innerHTML = (cfg.notify.rssFeeds || []).map((f, i) => `<div class="rss-row" data-i="${i}"><input type="checkbox" data-r="enabled" ${f.enabled !== false ? 'checked' : ''}><input type="text" data-r="name" value="${esc(f.name)}" placeholder="名称" style="max-width:140px"><input type="url" data-r="url" value="${esc(f.url)}" placeholder="https://.../feed.xml"><button data-r="del">×</button></div>`).join('');
  }
  $('#rss-add').addEventListener('click', () => { (cfg.notify.rssFeeds = cfg.notify.rssFeeds || []).push({ name: '', url: '', enabled: true }); renderRss(); });
  function renderNewsStatus(status) {
    $('#news-status').textContent = Object.values(status || {}).map(s => `${s.ok ? '✓' : '×'} ${s.name}：${s.ok ? (s.stale ? '最近条目超过 7 天，请留意源是否停更' : '可读取') : s.error}${s.latest ? '\n最新条目：' + s.latest : ''}`).join('\n') || '尚未检查；启用并保存后会自动建立基线。';
  }
  $('#news-test').addEventListener('click', async (e) => {
    e.target.disabled = true; $('#news-status').textContent = '正在检查…';
    try {
      const status = await window.pet.invoke('news:check', cfg.notify);
      renderNewsStatus(status);
    } catch (err) { $('#news-status').textContent = '检查失败：' + err.message; }
    finally { e.target.disabled = false; }
  });
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
  function renderActivity() {
    $('#activity-fields').innerHTML = (environment?.activityFields || []).map(f => `<label>${esc(f.label)}<input type="${f.type === 'number' ? 'number' : 'text'}" ${f.min ? `min="${f.min}"` : ''} data-act="${esc(f.key)}" value="${esc(cfg.activity[f.key] ?? '')}" placeholder="${esc(f.suggested || '')}">${f.type !== 'number' ? `<button data-pick-activity="${esc(f.key)}" data-path-kind="${esc(f.type)}">选择</button><button data-auto-activity="${esc(f.key)}">自动</button>` : ''}</label>`).join('');
  }
  $('#activity-fields').addEventListener('input', e => { const key = e.target.dataset.act; if(key) cfg.activity[key] = e.target.type === 'number' ? Number(e.target.value) : e.target.value; });
  $('#activity-fields').addEventListener('click', async e => {
    if(e.target.dataset.autoActivity) { cfg.activity[e.target.dataset.autoActivity] = ''; renderActivity(); return; }
    const key = e.target.dataset.pickActivity; if(!key) return;
    const file = await window.pet.invoke(e.target.dataset.pathKind === 'file' ? 'pick-file' : 'pick-directory');
    if(file) { cfg.activity[key] = file; renderActivity(); }
  });
  $('#act-test').addEventListener('click', async () => { const r = await window.pet.invoke('activity:now'); $('#act-result').textContent = JSON.stringify({ active: r.active, at: r.at ? new Date(r.at).toLocaleString() : null, details: Object.fromEntries(Object.entries(r.details).map(([k, v]) => [k, v ? new Date(v).toLocaleString() : null])) }, null, 2); });

  // ---------- Agents ----------
  const AGENT_FIELDS = [['name', '名称'], ['process', '进程名（| 分隔）'], ['title', '窗口标题正则'], ['dir', '会话目录（可选）'], ['url', '网页地址'], ['image', '立绘图片路径（可选）'], ['modelFile', '模型状态文件（文本 / JSON）'], ['modelPath', 'JSON 模型字段（例如 chat.model）'], ['dbPath', '模型数据库覆盖（读取器支持时）']];
  function renderAgents() {
    cfg.agents = cfg.agents || [];
    const looks = meta.characters.filter((c) => !c.look);
    $('#agents').innerHTML = cfg.agents.map((a, i) => `<div class="card grid2" data-agent="${i}">
      ${AGENT_FIELDS.map(([k, l]) => `<label>${l} <input type="text" data-g="${k}" value="${esc(a[k] || '')}"></label>`).join('')}
      <label>借用立绘 <select data-g="look">${looks.map((c) => `<option value="${c.id}" ${a.look === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <div><button class="danger" data-del-agent="${i}">删除</button></div></div>`).join('');
  }
  $('#agents').addEventListener('input', (e) => { const card = e.target.closest('[data-agent]'); const k = e.target.dataset.g; if (card && k) cfg.agents[+card.dataset.agent][k] = e.target.value; });
  $('#agents').addEventListener('click', (e) => { const i = e.target.dataset.delAgent; if (i !== undefined && confirm(`删除「${cfg.agents[+i].name}」？`)) { cfg.agents.splice(+i, 1); renderAgents(); renderAgentPresets(); } });
  let presets = [];
  function renderAgentPresets() {
    const left = presets.filter((p) => !(cfg?.agents || []).some((a) => a.id === p.id));
    $('#agent-preset').innerHTML = left.map((p) => `<option value="${p.id}">${esc(p.name)}${p.installed ? '（本机已装）' : ''}</option>`).join('') + '<option value="">自定义…</option>';
  }
  window.pet.invoke('agents:presets').then((r) => { presets = r; renderAgentPresets(); });
  $('#add-agent').addEventListener('click', () => {
    const p = presets.find((x) => x.id === $('#agent-preset').value);
    const { installed, ...preset } = p || {};
    cfg.agents.push(p ? preset : { id: 'agent-' + Date.now().toString(36), name: '新 Agent', process: '', look: 'deepseek' });
    renderAgents(); renderAgentPresets();
  });

  // ---------- Launch ----------
  let launchDefaults = {};
  const launchFindMiss = {};
  const KINDS = [['app', '桌面应用 (exe)'], ['store', '商店应用 (AppID)'], ['wsl-cli', 'WSL 里的 CLI'], ['cli', 'Windows CLI'], ['url', '网页']];
  const CLI_COMMANDS = { claude: 'claude', codex: 'codex', gemini: 'gemini', qwen: 'qwen' };
  function renderLaunch() {
    cfg.launch = cfg.launch || {};
    const query = ($('#launch-search').value || '').toLowerCase();
    const showAll = $('#launch-show-all').checked;
    $('#launch-list').innerHTML = meta.characters.filter(c => {
      const tool = environment?.tools.find(t => t.id === c.id);
      return (showAll || !environment || tool?.installed || tool?.configured || tool?.dataFound || cfg.launch[c.id]) && (!query || `${tool?.name || c.name} ${c.id}`.toLowerCase().includes(query));
    }).map((c) => {
      const d = launchDefaults[c.id] || {}; const u = cfg.launch[c.id] || {}; const v = { ...d, ...u };
      const custom = !!u.kind;
      const cli = v.kind === 'cli' || v.kind === 'wsl-cli';
      const workspace = cli || (v.kind === 'store' && /^OpenAI\.Codex_/.test(v.target || '')) || (v.kind === 'app' && /(?:^|[\\/])(code|cursor|windsurf|kiro|trae( cn)?|qoder( ide)?|codebuddy|workbuddy|zcode|dsh desktop)\.exe$/i.test(v.target || ''));
      const targetLabel = v.kind === 'url' ? '网页地址' : v.kind === 'store' ? '应用 AppID' : '应用路径';
      const entry = cli ? v.command : v.target;
      return `<div class="card" data-launch="${c.id}">
        <h3>${esc(environment?.tools.find(t => t.id === c.id)?.name || d.label || c.name)} <span class="hint" style="display:inline">${custom ? '手动覆盖' : '跟随本机探测'}</span></h3>
        <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:4px 20px">
          <label>方式 <select data-l="kind">${KINDS.map(([k, n]) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label>名称 <input type="text" data-l="label" value="${esc(v.label || '')}"></label>
          ${cli ? `<label style="grid-column:1/-1">启动命令 <input type="text" data-l="command" value="${esc(v.command || '')}" placeholder="${esc(CLI_COMMANDS[c.id] || '输入已安装工具的启动命令')}"></label>` : `<label style="grid-column:1/-1">${targetLabel} <input type="text" data-l="target" value="${esc(v.target || '')}" placeholder="路径 / 网址 / 命令，自动判断方式">${v.kind === 'app' ? `<button data-pick-exe="${c.id}">选择程序…</button>` : ''}</label>`}
          ${v.kind === 'wsl-cli' ? `<label>WSL 发行版 <input type="text" data-l="distro" value="${esc(v.distro || '')}" list="wsl-distro-list" placeholder="留空 = 默认发行版，可下拉选检测到的"></label>` : ''}
          ${workspace ? `<label>默认工作目录 <input type="text" data-l="cwd" value="${esc(v.cwd || '')}" placeholder="留空使用工具默认目录"><button data-pick-workspace="${c.id}">选择文件夹…</button></label>` : ''}
          ${v.kind === 'app' || v.kind === 'store' ? `<label>已开检测（窗口标题正则） <input type="text" data-l="match" value="${esc(v.match || '')}"></label>` : ''}
        </div>
        <p class="hint" data-launch-entry style="overflow-wrap:anywhere">${custom ? '当前启动' : '自动检测'}：${esc(entry || '尚未配置，请填写启动入口')}${launchFindMiss[c.id] ? '（自动找没找到；可手动填、点「选择程序…」，或装好工具后重启桌宠再找）' : ''}</p>
        ${workspace ? `<p class="hint">支持工作区的工具会打开这个目录；交接时优先使用交接文件所在目录。${v.kind === 'wsl-cli' ? 'WSL 也可填 Linux 路径。' : ''}</p>` : '<p class="hint">此启动方式不支持指定工作区。</p>'}
        <div style="display:flex;gap:8px;margin-top:8px"><button data-find="${c.id}">帮我找</button><button data-test-launch="${c.id}">试一下</button>${custom ? `<button data-reset-launch="${c.id}">恢复默认</button>` : ''}</div>
      </div>`;
    }).join('');
  }
  $('#launch-list').addEventListener('input', (e) => {
    const card = e.target.closest('[data-launch]'); const k = e.target.dataset.l; if (!card || !k) return;
    const id = card.dataset.launch; cfg.launch[id] = cfg.launch[id] || { ...(launchDefaults[id] || {}) };
    if (k === 'kind') {
      const old = cfg.launch[id]; const kind = e.target.value; const d = launchDefaults[id] || {};
      cfg.launch[id] = kind === d.kind ? { ...d, ...(old.cwd ? { cwd: old.cwd } : {}) } : {
        kind, label: meta.characters.find(c => c.id === id)?.name || id,
        ...(kind === 'cli' || kind === 'wsl-cli' ? { command: old.command || CLI_COMMANDS[id] || '', cwd: old.cwd || '', ...(kind === 'wsl-cli' ? { distro: old.distro || '' } : {}) } : { target: kind === 'url' ? (d.fallbackUrl || (d.kind === 'url' ? d.target : '')) : '' }),
      };
      renderLaunch();
    } else {
      cfg.launch[id][k] = e.target.value;
      if (k === 'command' || k === 'target') card.querySelector('[data-launch-entry]').textContent = '当前启动：' + (e.target.value || '尚未配置，请填写启动入口');
    }
  });
  // 方式不用硬选：填的内容明确是另一类（网址 / 路径 / 命令）就在失焦时纠正过去
  $('#launch-list').addEventListener('change', (e) => {
    const card = e.target.closest('[data-launch]'); const k = e.target.dataset.l;
    if (!card || (k !== 'target' && k !== 'command')) return;
    const id = card.dataset.launch; const u = cfg.launch[id]; if (!u) return;
    const want = window.LaunchFind.judgeKind(u[k]);
    if (want && want !== u.kind) {
      const keep = { ...(u.cwd ? { cwd: u.cwd } : {}), ...(u.label ? { label: u.label } : {}) };
      cfg.launch[id] = { ...(launchDefaults[id] || {}), kind: want, ...(want === 'cli' || want === 'wsl-cli' ? { command: u.command || u.target || '' } : { target: u.target || u.command || '' }), ...keep };
      renderLaunch();
    }
  });
  window.pet.invoke('wsl:distros').then((ds) => { $('#wsl-distro-list').innerHTML = (ds || []).map((d) => `<option value="${esc(d)}">`).join(''); }).catch(() => {});
  $('#launch-list').addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset.testLaunch) { await persistSettings(); window.pet.send('launch', t.dataset.testLaunch); }
    if (t.dataset.resetLaunch) { delete cfg.launch[t.dataset.resetLaunch]; renderLaunch(); }
    if (t.dataset.find) {
      const id = t.dataset.find;
      t.disabled = true; t.textContent = '找中…';
      const found = await window.pet.invoke('launch:find', id).catch(() => null);
      // 找到了且当前自定义是个空壳（没填入口）就撤掉覆盖，让自动检测接管；有自定义入口时不覆盖
      const u = cfg.launch[id];
      if (found && (!u || (!u.target && !u.command))) delete cfg.launch[id];
      launchFindMiss[id] = !found;
      launchDefaults = await window.pet.invoke('launch:defaults');
      renderLaunch();
    }
    if (t.dataset.pickExe) { const f = await window.pet.invoke('pick-file'); if (f) { const id = t.dataset.pickExe; cfg.launch[id] = cfg.launch[id] || { ...(launchDefaults[id] || {}) }; cfg.launch[id].target = f; cfg.launch[id].kind = 'app'; renderLaunch(); } }
    if (t.dataset.pickWorkspace) { const folder = await window.pet.invoke('pick-directory'); if (folder) { const id = t.dataset.pickWorkspace; cfg.launch[id] = cfg.launch[id] || { ...(launchDefaults[id] || {}) }; cfg.launch[id].cwd = folder; renderLaunch(); } }
  });

  // ---------- Notifications ----------
  function renderNotifications() {
    const list = (data && data.notifications) || [];
    const pending = new Set(((data && data.giftClaims) || []).filter((c) => !c.claimed && !c.resolved).map((c) => c.key));
    $('#n-list').innerHTML = list.length ? list.map((n) => `<div class="n-item ${n.read ? '' : 'unread'}"><span class="t">${new Date(n.ts).toLocaleString()}</span><div class="b"><b>${esc(n.title)}</b>${esc(n.body)}${n.link ? ` <a href="#" data-link="${esc(n.link)}">打开</a>` : ''}${n.claimKey && pending.has(n.claimKey) ? ` <a href="#" data-claim="${esc(n.claimKey)}">已领取</a>` : ''}</div></div>`).join('') : '<p class="hint">还没有消息。额度重置、送额度、模型上新、公告都会出现在这里。</p>';
    const unread = list.filter((n) => !n.read).length; $('#unread').textContent = unread; $('#unread').classList.toggle('hidden', !unread);
  }
  $('#n-list').addEventListener('click', (e) => { const l = e.target.dataset.link; if (l) { e.preventDefault(); window.pet.send('open-external', l); } const ck = e.target.dataset.claim; if (ck) { e.preventDefault(); window.pet.send('gift:claim', ck); } });
  $('#n-read').addEventListener('click', () => window.pet.send('notifications:read'));
  $('#n-clear').addEventListener('click', () => { if (confirm('清空全部消息？')) window.pet.send('notifications:clear'); });

  // ---------- Save ----------
  document.querySelector('main').addEventListener('input', () => {
    if(cfg && baseline && JSON.stringify(configDiff(baseline,cfg)) !== '{}') $('#save-msg').textContent = '有未保存的更改';
  });
  $('#save').addEventListener('click', async () => {
    $('#save').disabled = true; $('#save-msg').textContent = '保存中…';
    try { await persistSettings(); $('#save-msg').textContent = '✓ 已保存'; }
    catch(e) { $('#save-msg').textContent = '保存失败：' + e.message; }
    finally { $('#save').disabled = false; }
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
    data = { ...(data || {}), snapshots: st.snapshots, ledgers: st.ledgers, notifications: st.notifications, newsStatus: st.newsStatus, giftClaims: st.giftClaims };
    applyTheme(data.colors ? data : { character: cfg.appearance.character === 'auto' ? cfg.appearance.favorite : cfg.appearance.character });
    $('#userdata').textContent = meta.userData;
    $('#about-meta').textContent = `版本 ${meta.version} · Electron ${meta.electron} · 窗口吸附 ${meta.snapAvailable ? '可用' : '不可用（koffi 未加载）'} · 程序目录 ${meta.root}`;
    $('#feature-handoff').checked = cfg.features?.handoff !== false;
    renderProviders(); renderNotify(); renderAppearance(); renderQuips(); renderActivity(); renderAgents(); renderLaunch(); renderNotifications();
    if (meta.quotaOnly) {
      // 仅额度模式（安装时未启用工具转接）：入口菜单已由主进程收起；「打开工具」标签隐藏，引导页改走额度首启

      window.PetOnboarding.mount({ cfg, meta, invoke: (name, p) => window.pet.invoke(name, p), save: async (provider, index) => { cfg.providers[index] = provider; cfg.quotaOnboardingDone = true; try { await persistSettings(); } catch (e) { cfg.quotaOnboardingDone = false; throw e; } }, done: () => { renderProviders(); window.pet.send('refresh'); } });
    }
    goto((location.hash || '#tools').slice(1));
    scanEnvironment();
  })().catch(e => { $('#environment-status').textContent = '设置初始化失败：' + e.message; });
})();
