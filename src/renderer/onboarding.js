'use strict';
(function (root) {
  const usable = s => !!(s && s.ok && (Number.isFinite(s.balance) || (s.windows || []).some(w => Number.isFinite(w.usedPercent))));
  const fieldsFor = p => ({ deepseek: ['apiKey'], codex: ['codexHome'], newapi: ['baseUrl', 'accessToken', 'userId'], zhipu: ['baseUrl', 'apiKey'], 'claude-oauth': ['credentialsPath'], gemini: p.auth === 'relay' ? ['baseUrl', 'accessToken', 'userId'] : ['credentialsPath'] }[p.type] || []);
  function mount({ cfg, meta, invoke, save, done }) {
    if (!meta.quotaOnly || cfg.quotaOnboardingDone) return;
    const host = document.createElement('div'); host.className = 'setup-guide';
    host.innerHTML = '<h2>先连上一个额度来源</h2><p>选择来源，填写信息，测试成功后启用。只查询额度，不发送聊天或生成内容。</p><label>1 · 选择来源 <select id="guide-source"></select></label><div id="guide-auth"></div><div id="guide-fields" class="guide-fields"></div><p id="guide-help" class="hint"></p><p id="guide-result" role="status" aria-live="polite">填写后先测试一下，确认能读到余额或额度。</p><div class="guide-actions"><button id="guide-test">2 · 测试连接</button><button id="guide-finish" class="primary" disabled>3 · 启用额度检测</button><button id="guide-later">稍后设置</button></div>';
    document.querySelector('#tab-providers h1').after(host);
    const details = document.querySelectorAll('#tab-providers .toolbar, #providers');
    details.forEach(e => { e.hidden = true; });
    const close = () => { details.forEach(e => { e.hidden = false; }); host.remove(); };
    const $ = s => host.querySelector(s);
    const clone = x => JSON.parse(JSON.stringify(x));
    const labels = { baseUrl: '中转站地址', accessToken: '系统访问令牌', userId: '用户 ID', apiKey: 'API Key', codexHome: 'Codex 配置目录', credentialsPath: '本机登录凭据路径' };
    const titles = { deepseek: 'DeepSeek 账户余额', codex: 'Codex / ChatGPT 订阅', newapi: '中转站账户余额', zhipu: 'GLM Coding Plan', 'claude-oauth': 'Claude Code 订阅', gemini: 'Gemini CLI' };
    let index = 0, draft, busy = false, verified = false;
    cfg.providers.forEach((p, i) => { const o = document.createElement('option'); o.value = i; o.textContent = titles[p.type] || p.name; $('#guide-source').append(o); });
    const invalidate = () => { verified = false; $('#guide-finish').disabled = true; $('#guide-result').textContent = '信息已修改，请重新测试。'; };
    function render() {
      $('#guide-fields').replaceChildren();
      $('#guide-auth').replaceChildren();
      if (draft.type === 'gemini') {
        const label = document.createElement('label'); label.textContent = '连接方式 ';
        const select = document.createElement('select');
        for (const [v, t] of [['oauth', '官方登录'], ['relay', '中转站账户']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; select.append(o); }
        select.value = draft.auth; select.onchange = () => { draft.auth = select.value; invalidate(); render(); }; label.append(select); $('#guide-auth').append(label);
      }
      for (const key of fieldsFor(draft)) {
        const label = document.createElement('label'); label.textContent = labels[key];
        const input = document.createElement('input'); input.type = /apiKey|accessToken/.test(key) ? 'password' : 'text'; input.autocomplete = 'off'; input.value = draft[key] || '';
        input.oninput = () => { draft[key] = input.value.trim(); invalidate(); }; label.append(input); $('#guide-fields').append(label);
      }
      $('#guide-help').textContent = draft.type === 'newapi' || (draft.type === 'gemini' && draft.auth === 'relay')
        ? '登录中转站的个人设置，获取「系统访问令牌」和数字用户 ID。这里不是令牌管理里的模型 API Key；不限额 API Key 无法查账户余额。'
        : ['codex', 'claude-oauth', 'gemini'].includes(draft.type) ? '先安装并登录对应工具。默认读取本机登录信息；没装该工具可以换一个来源。不要粘贴完整凭据文件。'
        : '填写该服务自己的 Key。测试只查询余额或订阅额度，凭据保存在本机。';
    }
    function choose() { index = Number($('#guide-source').value); draft = clone(cfg.providers[index]); if (draft.type === 'gemini' && draft.auth !== 'relay') draft.auth = 'oauth'; invalidate(); render(); }
    $('#guide-source').onchange = choose;
    const lock = v => { busy = v; host.querySelectorAll('input,select,button').forEach(e => { e.disabled = v; }); $('#guide-finish').disabled = v || !verified; };
    $('#guide-test').onclick = async () => {
      if (busy) return;
      verified = false; lock(true); $('#guide-result').textContent = '正在查询，请稍候…';
      try {
        const needsAccount = draft.type === 'newapi' || (draft.type === 'gemini' && draft.auth === 'relay');
        if (needsAccount && (!draft.accessToken || !draft.userId || !draft.baseUrl)) throw new Error('请填写地址、系统访问令牌和用户 ID。');
        const r = await invoke('provider:test', { ...draft, enabled: true, announcements: false });
        verified = usable(r);
        $('#guide-result').textContent = verified ? '连接成功，已读到有效额度。点击「启用额度检测」保存。' : r.error || '接口未返回可用余额或额度，请检查账户查询权限。';
      } catch (e) { $('#guide-result').textContent = '测试未通过：' + e.message; }
      finally { lock(false); }
    };
    $('#guide-finish').onclick = async () => {
      if (busy || !verified) return;
      lock(true);
      try { await save({ ...draft, enabled: true }, index); close(); done(); }
      catch (e) { $('#guide-result').textContent = '保存失败：' + e.message; lock(false); }
    };
    $('#guide-later').onclick = close;
    choose();
  }
  const api = { usable, fieldsFor, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetOnboarding = api;
})(typeof globalThis === 'object' ? globalThis : this);
