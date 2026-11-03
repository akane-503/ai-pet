'use strict';
// 首次启动向导：所有模式都跑。第一步决定要不要工具转接、把技能部署到哪些本机工具；
// 第二步连一个额度来源（可跳过）。完成/跳过后写 setupWizardDone，设置页里随时能改。
(function (root) {
  const usable = s => !!(s && s.ok && (Number.isFinite(s.balance) || (s.windows || []).some(w => Number.isFinite(w.usedPercent))));
  const fieldsFor = p => ({ deepseek: ['apiKey'], codex: ['codexHome'], newapi: ['baseUrl', 'accessToken', 'userId'], zhipu: ['baseUrl', 'apiKey'], 'claude-oauth': ['credentialsPath'], gemini: p.auth === 'relay' ? ['baseUrl', 'accessToken', 'userId'] : ['credentialsPath'] }[p.type] || []);
  const LABELS = { baseUrl: '中转站地址', accessToken: '系统访问令牌', userId: '用户 ID', apiKey: 'API Key', codexHome: 'Codex 配置目录', credentialsPath: '本机登录凭据路径' };
  const TITLES = { deepseek: 'DeepSeek 账户余额', codex: 'Codex / ChatGPT 订阅', newapi: '中转站账户余额', zhipu: 'GLM Coding Plan', 'claude-oauth': 'Claude Code 订阅', gemini: 'Gemini CLI' };

  function mount({ cfg, meta, invoke, apply, done }) {
    if (!meta.setupNeeded) return;
    const clone = x => JSON.parse(JSON.stringify(x));
    const host = document.createElement('div');
    host.className = 'setup-guide setup-wizard';
    host.innerHTML = `<div class="wizard-inner">
      <div class="wizard-head"><p class="wizard-step" id="wizard-step"></p><h2 id="wizard-title"></h2></div>
      <section id="wizard-tools"></section>
      <section id="wizard-provider" hidden></section>
      <p id="wizard-msg" class="hint" role="status"></p>
      <div class="guide-actions wizard-actions">
        <button id="wizard-back" hidden>上一步</button>
        <button id="wizard-skip">稍后设置</button>
        <button id="wizard-next" class="primary">下一步</button>
      </div>
    </div>`;
    document.body.append(host);
    document.body.classList.add('wizard-open');
    const $ = s => host.querySelector(s);
    const title = $('#wizard-title'), stepText = $('#wizard-step');
    let step = 1, busy = false, skillTools = [], skillsLoaded = false, providerIndex = 0, draft = null, verified = false;

    // ---------- 第一步：转接与技能 ----------
    function renderTools() {
      stepText.textContent = '第 1 步 / 共 2 步 · 工具转接';
      title.textContent = '要不要让桌宠帮你换 AI 接着做';
      const enabled = cfg.features?.handoff !== false;
      const present = skillTools.filter(t => t.present);
      $('#wizard-tools').innerHTML = `
        <label class="wizard-toggle"><input id="wizard-handoff" type="checkbox" ${enabled ? 'checked' : ''}> 启用工具转接</label>
        <p class="hint">开启后，右键桌宠可以把当前会话交给另一个 AI（Claude Code、Codex、DSH…）接着做；关闭则只查额度、角色和提醒都保留。之后都能在「设置 → 接手与转接」里改。</p>
        <div class="wizard-sub"><h3>接手技能</h3>
        <p class="hint">技能会写进各工具的 skills 目录（例如 ~/.claude/skills、~/.codex/skills），只加 handoff 和 takeover 两个文件夹，不动其他技能。没列出来的工具说明本机没有它的目录。</p>
        <div id="wizard-skill-list">${!skillsLoaded ? '<p class="hint">正在检测本机 AI 工具…</p>' : present.length ? present.map(t => `<label class="wizard-tool"><input type="checkbox" value="${t.id}" ${t.managed ? 'disabled' : 'checked'}> <b>${t.name}</b><span class="hint">${t.path}${t.managed ? ' · Skills Manager 管理，跳过' : ''}</span></label>`).join('') : '<p class="hint">没检测到支持技能的 AI 工具。装好之后可以在设置里再部署，不用重装桌宠。</p>'}</div></div>`;
      $('#wizard-handoff').onchange = () => { $('#wizard-skill-list').classList.toggle('muted', !$('#wizard-handoff').checked); };
      $('#wizard-handoff').onchange();
    }

    // ---------- 第二步：额度来源 ----------
    function renderProvider() {
      stepText.textContent = '第 2 步 / 共 2 步 · 额度来源';
      title.textContent = '先连上一个额度来源';
      const host2 = $('#wizard-provider');
      host2.innerHTML = `<p class="hint">选择来源，填写信息，测试成功后启用。只查询额度，不发送聊天或生成内容。这一步也可以跳过，之后在「账号与额度」里连。</p>
        <label>选择来源 <select id="guide-source"></select></label><div id="guide-auth"></div><div id="guide-fields" class="guide-fields"></div>
        <p id="guide-help" class="hint"></p>
        <div class="wizard-test-row"><button id="guide-test">测试连接</button><span id="guide-result" class="hint" role="status" aria-live="polite">填写后先测试一下，确认能读到余额或额度。</span></div>`;
      const options = [];
      cfg.providers.forEach((p, i) => { const o = document.createElement('option'); o.value = i; o.textContent = TITLES[p.type] || p.name; $('#guide-source').append(o); options.push(i); });
      $('#guide-source').onchange = () => { providerIndex = Number($('#guide-source').value); draft = clone(cfg.providers[providerIndex]); verified = false; renderFields(); };
      $('#guide-test').onclick = testProvider;
      if (!cfg.providers.length) { host2.querySelector('#guide-source').closest('label').textContent = '没有可用的额度来源，稍后在设置里添加。'; }
      providerIndex = options[0] || 0; draft = clone(cfg.providers[providerIndex] || {}); renderFields();
    }
    function invalidate() { verified = false; $('#guide-result').textContent = '信息已修改，请重新测试。'; }
    function renderFields() {
      $('#guide-fields').replaceChildren(); $('#guide-auth').replaceChildren();
      if (!draft || !draft.type) return;
      if (draft.type === 'gemini') {
        const label = document.createElement('label'); label.textContent = '连接方式 ';
        const select = document.createElement('select');
        for (const [v, t] of [['oauth', '官方登录'], ['relay', '中转站账户']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; select.append(o); }
        select.value = draft.auth; select.onchange = () => { draft.auth = select.value; invalidate(); renderFields(); }; label.append(select); $('#guide-auth').append(label);
      }
      for (const key of fieldsFor(draft)) {
        const label = document.createElement('label'); label.textContent = LABELS[key];
        const input = document.createElement('input'); input.type = /apiKey|accessToken/.test(key) ? 'password' : 'text'; input.autocomplete = 'off'; input.value = draft[key] || '';
        input.oninput = () => { draft[key] = input.value.trim(); invalidate(); }; label.append(input); $('#guide-fields').append(label);
      }
      $('#guide-help').textContent = draft.type === 'newapi' || (draft.type === 'gemini' && draft.auth === 'relay')
        ? '登录中转站的个人设置，获取「系统访问令牌」和数字用户 ID。这里不是令牌管理里的模型 API Key；不限额 API Key 无法查账户余额。'
        : ['codex', 'claude-oauth', 'gemini'].includes(draft.type) ? '先安装并登录对应工具。默认读取本机登录信息；没装该工具可以换一个来源。不要粘贴完整凭据文件。'
        : '填写该服务自己的 Key。测试只查询余额或订阅额度，凭据保存在本机。';
    }
    async function testProvider() {
      if (busy || !draft) return;
      verified = false; lock(true); $('#guide-result').textContent = '正在查询，请稍候…';
      try {
        const needsAccount = draft.type === 'newapi' || (draft.type === 'gemini' && draft.auth === 'relay');
        if (needsAccount && (!draft.accessToken || !draft.userId || !draft.baseUrl)) throw new Error('请填写地址、系统访问令牌和用户 ID。');
        const r = await invoke('provider:test', { ...draft, enabled: true, announcements: false });
        verified = usable(r);
        $('#guide-result').textContent = verified ? '连接成功，已读到有效额度。点「完成设置」保存。' : r.error || '接口未返回可用余额或额度，请检查账户查询权限。';
      } catch (e) { $('#guide-result').textContent = '测试未通过：' + e.message; }
      finally { lock(false); }
    }

    // ---------- 步骤切换与完成 ----------
    function showStep(next) {
      step = next;
      $('#wizard-tools').hidden = step !== 1;
      $('#wizard-provider').hidden = step !== 2;
      $('#wizard-back').hidden = step === 1;
      $('#wizard-next').textContent = step === 1 ? '下一步' : '完成设置';
      $('#wizard-msg').textContent = '';
      if (step === 2) renderProvider(); else renderTools();
    }
    function lock(v) { busy = v; host.querySelectorAll('input,select,button').forEach(e => { e.disabled = v; }); }
    async function finish(skip) {
      if (busy) return;
      lock(true);
      $('#wizard-msg').textContent = skip ? '正在保存…' : '正在部署技能并保存…';
      try {
        const patch = { setupWizardDone: true };
        if (!skip) {
          const handoff = $('#wizard-handoff').checked;
          const ids = [...host.querySelectorAll('#wizard-skill-list input[type=checkbox]:checked')].map(i => i.value);
          if (handoff && ids.length) {
            const r = await invoke('skills:set', { action: 'install', tools: ids });
            if (!r.ok) $('#wizard-msg').textContent = '部分技能没装上，可以在设置里重试。';
          }
          patch.features = { ...(cfg.features || {}), handoff };
          if (step === 2 && verified && draft && cfg.providers[providerIndex]) {
            const providers = clone(cfg.providers);
            providers[providerIndex] = { ...draft, enabled: true };
            patch.providers = providers;
          }
        }
        await apply(patch);
        close(); done();
      } catch (e) { $('#wizard-msg').textContent = '保存失败：' + e.message; lock(false); }
    }
    function close() { document.body.classList.remove('wizard-open'); host.remove(); }

    $('#wizard-back').onclick = () => showStep(1);
    $('#wizard-skip').onclick = () => finish(true);
    $('#wizard-next').onclick = () => { if (step === 1) { showStep(2); } else finish(false); };
    showStep(1);
    // 工具列表异步读，不阻塞第一步渲染
    invoke('skills:list').then(r => { skillTools = r.tools || []; skillsLoaded = true; if (step === 1) renderTools(); }).catch(() => { skillsLoaded = true; $('#wizard-msg').textContent = '没能读取本机工具列表，技能可以稍后在设置里部署。'; });
  }

  const api = { usable, fieldsFor, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetOnboarding = api;
})(typeof globalThis === 'object' ? globalThis : this);
