'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const fmtMoney = (v, cur) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (cur === 'USD' ? '$' : cur === 'CNY' ? '¥' : '') + (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2));
  const fmtLeft = (sec) => { if (!Number.isFinite(sec)) return ''; const s = Math.max(0, sec); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}天${h}h` : h ? `${h}h${m}m` : `${m}m`; };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const projectView = $('#project-view');
  const projectRoot = $('#project-root');
  const projectRefresh = $('#project-refresh');
  const projectMessage = $('#project-message');
  const projectSource = $('#project-source');
  const projectResults = $('#project-results');
  const projectKey = 'aipet.projectRoot';
  let projectSelection = 0;
  let projectOrigin = '手选目录';
  let projectMode = 'tree'; // tree = 任务树（默认）| map = Agent 架构图
  let projectWide = false;  // 拉开模式：折叠上方、面板向右扩宽
  let lastProjectData = null;
  const applyWide = () => { try { document.querySelector('.panel').classList.toggle('pm-focus', projectWide); } catch {} };
  const resize = () => requestAnimationFrame(() => window.pet.send('panel:size', {
    h: Math.ceil(document.querySelector('.panel').scrollHeight) + 16,
    w: projectWide ? 560 : 296,
  }));
  try { projectRoot.value = localStorage.getItem(projectKey) || ''; } catch {}

  function appendReference(parent, id) {
    if (typeof id !== 'string' || !/^[TE]-[a-z0-9-]{1,48}$/i.test(id)) return;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '复制编号';
    copy.setAttribute('aria-label', '复制编号 ' + id);
    copy.addEventListener('click', () => {
      try { copy.textContent = window.projectPanel.copyReference(id) ? '已复制' : '复制失败'; }
      catch { copy.textContent = '复制失败'; }
    });
    parent.append(copy);
  }

  function projectGroup(title, rows) {
    const heading = document.createElement('h2');
    heading.textContent = title;
    projectResults.append(heading);
    const list = document.createElement('ul');
    for (const { text, id } of rows) {
      const item = document.createElement('li');
      item.textContent = text;
      appendReference(item, id);
      list.append(item);
    }
    projectResults.append(list);
  }

  function projectTasks(project) {
    const heading = document.createElement('h2');
    heading.textContent = 'PM 任务树';
    projectResults.append(heading);
    const tree = document.createElement('ul');
    tree.className = 'project-task-tree';
    tree.id = 'project-task-tree';
    projectResults.append(tree);
    const labels = { open: '待办', assigned: '已分派', working: '进行中', ready: '待验收',
      blocked: '阻塞', waiting: '等待处理', failed: '失败', done: '已完成', ended: '已结束' };
    const nodes = project.org || [];
    const rendered = new Set();
    function taskRow(ticket, parent) {
      const row = document.createElement('li');
      const detail = document.createElement('details');
      const title = document.createElement('summary');
      title.textContent = ticket.id + ' · ' + ticket.title + ' · ' + (ticket.rawStatus || labels[ticket.status] || '状态未知');
      detail.append(title);
      const assignment = ticket.assignment;
      const facts = [
        'Agent · ' + (assignment?.workerId || (assignment ? '未知' : '未分派')),
        '会话 · ' + (assignment?.sessionLabel
          ? assignment.sessionLabel + (assignment.sessionId ? ' · ' + assignment.sessionId : '')
          : assignment?.sessionId || (assignment ? '未知' : '未分派')),
        '工作树 · ' + (assignment?.worktree
          ? assignment.worktree + (assignment.worktreeRegistered ? '（Git 已登记）' : '（未核实 Git 登记）')
          : '未关联'),
      ];
      if (assignment?.branch) facts.push('分支 · ' + assignment.branch);
      if (ticket.lease) facts.push('租约 · ' + (ticket.lease.active ? '有效' : '已过期') + ' · ' + new Date(ticket.lease.expiresAt).toLocaleString());
      if (ticket.evidence) facts.push('最近验证 · ' + (ticket.evidence.exit === 0 ? '通过' : '结果未知或失败')
        + (ticket.evidence.head ? ' · ' + ticket.evidence.head.slice(0, 8) : ''));
      if (ticket.summary) facts.push('报告 · ' + ticket.summary);
      for (const text of facts) {
        const fact = document.createElement('p');
        fact.className = 'task-meta';
        fact.textContent = text;
        detail.append(fact);
      }
      appendReference(detail, ticket.id);
      row.append(detail);
      parent.append(row);
    }
    function nodeRow(node, parent) {
      if (rendered.has(node.id)) return;
      rendered.add(node.id);
      const row = document.createElement('li');
      const title = document.createElement('p');
      title.textContent = node.title + ' · ' + ({ L1_pm: '项目管理', L2_workstream: '工作线', L3_executor: '执行' }[node.role] || node.role || '角色未知');
      row.append(title);
      const children = document.createElement('ul');
      row.append(children);
      parent.append(row);
      for (const ticket of project.tickets.filter((ticket) => ticket.nodeId === node.id)) taskRow(ticket, children);
      for (const child of nodes.filter((child) => child.parentId === node.id)) nodeRow(child, children);
    }
    for (const node of nodes.filter((node) => !node.parentId || !nodes.some((parent) => parent.id === node.parentId))) nodeRow(node, tree);
    for (const node of nodes) nodeRow(node, tree);
    for (const ticket of project.tickets.filter((ticket) => !nodes.some((node) => node.id === ticket.nodeId))) taskRow(ticket, tree);
    if (!nodes.length && !project.tickets.length) {
      const empty = document.createElement('li');
      empty.textContent = '暂无 PM 任务';
      tree.append(empty);
    }
  }

  // 项目区视图切换：任务树（默认）/ 架构图（组织思维导图）；「大图」在独立窗口打开
  function projectModeTabs() {
    const tabs = document.createElement('div'); tabs.className = 'pm-viewtabs';
    const make = (id, label, mode) => {
      const b = document.createElement('button');
      b.type = 'button'; b.id = id; b.textContent = label;
      b.className = mode === projectMode ? 'on' : '';
      b.addEventListener('click', () => {
        if (projectMode === mode) return;
        projectMode = mode;
        // 架构图信息密度高，首次切入自动拉开
        if (mode === 'map' && !projectWide) { projectWide = true; applyWide(); }
        readProject();
      });
      return b;
    };
    tabs.append(make('project-mode-tree', '任务树', 'tree'));
    tabs.append(make('project-mode-map', '架构图', 'map'));
    return tabs;
  }

  // 面板版 Agent 架构图：面向用户——先看到谁在忙、忙什么、最新一句进展；PM 细节（编号/工作树/租约）收进展开层
  function projectAgentMap(project) {
    const org = Array.isArray(project.org) ? project.org.filter((o) => o && o.id) : [];
    const tickets = Array.isArray(project.tickets) ? project.tickets : [];
    const statusLabels = { open: '未开始', assigned: '已分派', working: '工作中', ready: '待验收',
      blocked: '卡住了', waiting: '等人', failed: '失败了', done: '已完成', ended: '已结束' };
    const tone = (s) => ['done', 'ended'].includes(s) ? 'done' : ['blocked', 'failed'].includes(s) ? 'blocked' : s === 'ready' ? 'ready' : s === 'working' ? 'working' : 'open';
    const rank = (s) => s === 'working' ? 0 : s === 'ready' ? 1 : ['blocked', 'failed'].includes(s) ? 2 : ['done', 'ended'].includes(s) ? 4 : 3;
    const chip = (text, cls) => { const s = document.createElement('span'); s.className = 'pm-chip' + (cls ? ' ' + cls : ''); s.textContent = text; return s; };
    const factLine = (parent, text, sub) => { const p = document.createElement('p'); if (sub) p.className = 'sub'; p.textContent = text; parent.append(p); };
    const cleanName = (raw) => { const s = String(raw || '').trim(); if (!s) return ''; const parts = s.split('·'); return parts.length > 1 ? parts[parts.length - 1].trim() : s; };
    const nodes = new Map();
    for (const o of org) nodes.set(o.id, { data: o, parent: null, children: [] });
    for (const n of nodes.values()) {
      const p = n.data.parentId && n.data.parentId !== n.data.id ? nodes.get(n.data.parentId) : null;
      if (p) { n.parent = p; p.children.push(n); }
    }
    // 环保护：祖先链异常的节点拉回根层
    for (const n of nodes.values()) {
      let seen = 0, a = n.parent;
      while (a && seen <= nodes.size) { seen++; a = a.parent; }
      if (seen > nodes.size) { n.parent = null; n.children = []; }
    }
    const byNode = new Map();
    for (const t of tickets) {
      const key = t.nodeId && nodes.has(t.nodeId) ? t.nodeId : '__stray__';
      if (!byNode.has(key)) byNode.set(key, []);
      byNode.get(key).push(t);
    }
    let roots = [...nodes.values()].filter((n) => !n.parent);
    if (!roots.length) roots = [{ data: { id: '__root__', title: project.name || '项目', role: 'L1_pm' }, parent: null, children: [] }];
    if (byNode.has('__stray__')) roots[0].children.push({ data: { id: '__stray__', title: '未归属', role: '' }, parent: roots[0], children: [] });
    // 只画有动静的节点：没任务、没阻塞、后代也没动静的 PM 骨架直接折叠掉
    const active = (n) => (byNode.get(n.data.id) || []).length > 0 || !!n.data.blocker || n.children.some(active);
    const alive = (n) => ({ data: n.data, parent: n.parent, children: n.children.filter(active).map(alive).sort((a, b) => {
      const ra = (byNode.get(a.data.id) || []).reduce((m, t) => Math.min(m, rank(t.status)), 9);
      const rb = (byNode.get(b.data.id) || []).reduce((m, t) => Math.min(m, rank(t.status)), 9);
      return ra - rb;
    }) });
    const pruned = roots.map(alive).filter(active);

    const wrap = document.createElement('div'); wrap.className = 'pm-map-wrap';
    // 根卡片：项目名 + 总进度，一眼看到全局
    const done = tickets.filter((t) => ['done', 'ended'].includes(t.status)).length;
    const busy = tickets.filter((t) => t.status === 'working').length;
    const stuck = tickets.filter((t) => ['blocked', 'failed'].includes(t.status)).length;
    const root = document.createElement('div'); root.className = 'pm-root-card';
    const rname = document.createElement('b'); rname.textContent = project.name || '项目';
    root.append(rname);
    if (tickets.length) {
      const bar = document.createElement('span'); bar.className = 'pm-progress';
      const fill = document.createElement('i'); fill.setAttribute('style', 'width:' + Math.round(done / tickets.length * 100) + '%');
      bar.append(fill); root.append(bar);
      root.append(chip(done + '/' + tickets.length + ' 完成', 'ok'));
      if (busy) root.append(chip(busy + ' 项进行中', 'st-working'));
      if (stuck) root.append(chip(stuck + ' 项卡住', 'st-blocked'));
    } else root.append(chip('暂无任务'));
    wrap.append(root);

    let seq = 0;
    const list = document.createElement('ul'); list.className = 'pm-map';
    const nodeEl = (node) => {
      const li = document.createElement('li');
      li.setAttribute('style', '--i:' + seq++);
      const items = (byNode.get(node.data.id) || []).slice().sort((a, b) => rank(a.status) - rank(b.status));
      const current = items[0];
      const stateWord = node.data.blocker ? '卡住了' : current ? (statusLabels[current.status] || current.status) : '';
      const st = current ? tone(current.status) : 'blocked';
      const detail = document.createElement('details'); detail.className = 'pm-ag st-' + st;
      const summary = document.createElement('summary');
      const row = document.createElement('span'); row.className = 'pm-node-row';
      const dot = document.createElement('span'); dot.className = 'pm-dot' + (st === 'working' ? ' pulse' : '') + (st === 'blocked' ? ' alert' : '');
      row.append(dot);
      const name = document.createElement('b');
      name.textContent = cleanName(node.data.sessionLabel) || cleanName(node.data.title) || node.data.id;
      name.title = node.data.title || '';
      row.append(name);
      if (stateWord) row.append(chip(stateWord, 'st-' + st));
      for (const t of items.slice(0, 2)) row.append(chip(t.id, 'mm-task'));
      if (items.length > 2) row.append(chip('+' + (items.length - 2)));
      summary.append(row);
      detail.append(summary);
      // 一眼能读懂的直接铺开：在忙什么 + 最新一句进展
      if (items.length) {
        const brief = document.createElement('p'); brief.className = 'pm-brief';
        const doing = items.find((t) => ['working', 'assigned', 'ready'].includes(t.status)) || items[0];
        brief.textContent = (doing.summary || doing.title || '').replace(/\s+/g, ' ').slice(0, 110);
        detail.append(brief);
      }
      if (node.data.blocker) { const p = document.createElement('p'); p.className = 'pm-brief alert'; p.textContent = '阻塞：' + node.data.blocker; detail.append(p); }
      if (items.length) {
        const facts = document.createElement('div'); facts.className = 'task-meta';
        for (const t of items) {
          factLine(facts, t.id + ' · ' + (t.title || '') + ' · ' + (statusLabels[t.status] || t.status));
          const a = t.assignment;
          if (a?.workerId || a?.sessionLabel) factLine(facts, '执行 · ' + (a.workerId || '未知') + (a.sessionLabel ? '（' + a.sessionLabel + '）' : ''), true);
          if (a?.worktree) factLine(facts, '工作树 · ' + a.worktree + (a.worktreeRegistered ? '（已登记）' : '（未核实）'), true);
          if (a?.branch) factLine(facts, '分支 · ' + a.branch, true);
          if (t.lease) factLine(facts, '租约 · ' + (t.lease.active ? '有效' : '已过期'), true);
          if (t.evidence) factLine(facts, '最近验证 · ' + (t.evidence.exit === 0 ? '通过' : '失败或未知') + (t.evidence.head ? ' · ' + t.evidence.head.slice(0, 8) : ''), true);
          if (t.summary) factLine(facts, '报告 · ' + t.summary.slice(0, 110), true);
        }
        detail.append(facts);
      }
      li.append(detail);
      if (node.children.length) {
        const ul = document.createElement('ul');
        for (const c of node.children) ul.append(nodeEl(c));
        li.append(ul);
      }
      return li;
    };
    for (const r of pruned) list.append(nodeEl(r));
    if (!list.children.length) {
      const li = document.createElement('li'); li.textContent = tickets.length ? '当前没有进行中的工作，都在收档里。' : '这个项目还没有可显示的任务。';
      list.append(li);
    }
    wrap.append(list);
    return wrap;
  }

  async function readProject() {
    if (projectRefresh.disabled) return;
    const root = projectRoot.value.trim();
    projectSource.textContent = projectOrigin + (root ? '\n' + root : '');
    if (!root) {
      projectMessage.textContent = '输入包含 .team 的项目目录。';
      projectResults.replaceChildren();
      resize();
      return;
    }
    projectRoot.disabled = projectRefresh.disabled = true;
    projectMessage.textContent = '正在读取项目…';
    projectResults.replaceChildren();
    resize();
    try {
      const project = await window.projectPanel.read(root);
      if (projectRoot.value.trim() !== root) return;
      try { localStorage.setItem(projectKey, root); } catch {}
      lastProjectData = project;
      projectMessage.textContent = project.name || '项目进度';
      // 工作树明细在「架构图」视图里看，这里只留一行指引
      if (project.worktrees?.length) projectMessage.textContent += ` · 工作树 ${project.worktrees.length} 个（切「架构图」视图）`;
      else projectMessage.textContent += ' · 未检测到 Git 工作树';
      if (project.root && project.currentRoot && project.root !== project.currentRoot) {
        const control = document.createElement('p');
        control.textContent = '控制仓 · ' + project.root;
        projectResults.append(control);
      }
      if (project.compatibility === 'legacy') projectMessage.textContent += ' · 旧版 PM 状态';
      const done = project.tickets.filter((ticket) => ticket.status === 'done');
      const ended = project.tickets.filter((ticket) => ticket.status === 'ended');
      const counts = document.createElement('p');
      counts.id = 'project-counts';
      counts.textContent = '共 ' + project.tickets.length + ' 项 · 已完成 ' + done.length + ' · 已结束 ' + ended.length;
      projectResults.append(counts);
      projectResults.append(projectModeTabs());
      if (projectMode === 'map') {
        projectResults.append(projectAgentMap(project));
        return;
      }
      projectTasks(project);
      const attention = project.attention.filter(({ kind }) => !kind.startsWith('engage-') && !kind.startsWith('ticket-'));
      if (attention.length) projectGroup('待处理 · ' + attention.length, attention.map(({ summary, id }) => ({ text: summary, id })));
      if (project.engagements.length) projectGroup('外包 · ' + project.engagements.length,
        project.engagements.map(({ id, title, host, state, returnedAt }) => {
          const label = state === 'delivered' ? '待验收' : returnedAt ? '已交回' : state === 'in_progress' ? '接包处理中' : '已派出';
          return { text: [id, title, host, label].filter(Boolean).join(' · '), id };
        }));
      if (!project.tickets.length && !attention.length && !project.engagements.length) projectMessage.textContent += ' · 暂无任务';
    } catch (error) {
      if (projectRoot.value.trim() === root) projectMessage.textContent = error.message || '项目读取失败。';
    } finally {
      projectRoot.disabled = projectRefresh.disabled = false;
      resize();
      if (projectView.open && projectRoot.value.trim() !== root) void readProject();
    }
  }
  async function readCurrentProject() {
    const selection = ++projectSelection;
    projectSource.textContent = '正在识别当前项目…';
    try {
      const current = await window.pet.invoke('project:workspace');
      if (selection !== projectSelection || !projectView.open) return;
      if (typeof current?.project === 'string' && current.project) {
        projectRoot.value = current.project;
        projectOrigin = '自动识别当前项目';
      } else projectOrigin = '未识别到当前项目，保留原目录';
    } catch {
      if (selection !== projectSelection || !projectView.open) return;
      projectOrigin = '自动识别暂不可用，保留原目录';
    }
    if (selection === projectSelection && projectView.open) void readProject();
  }
  projectRoot.addEventListener('input', () => {
    projectSelection++;
    projectOrigin = '手选目录';
    projectSource.textContent = projectOrigin + '\n' + projectRoot.value.trim();
  });
  $('#project-form').addEventListener('submit', (event) => {
    event.preventDefault();
    projectSelection++;
    projectOrigin = '手选目录';
    void readProject();
  });
  projectView.addEventListener('toggle', () => {
    // 打开项目管理就拉开：折叠上方、面板向右扩宽；收起还原
    projectWide = projectView.open;
    applyWide();
    if (projectView.open) void readCurrentProject();
    else projectSelection++;
    resize();
  });
  function render(d) {
    const ap = d.config.appearance; const rows = [];
    const pal = d.colors || ['#203170', '#536ba9', '#9fb0d9'];
    document.documentElement.style.setProperty('--line', pal[0]); document.documentElement.style.setProperty('--text', pal[1]); document.documentElement.style.setProperty('--hint', pal[2]);
    const cur = (d.characters || []).find((c) => c.id === d.character);
    $('#why').textContent = (cur ? cur.name : (d.character || '')) + (d.why ? ' · ' + d.why : '');
    const nowSec = Date.now() / 1000;
    // 送额度待领取 / 额度卡住的出路提示：点一下标记已读，停止重复提醒
    for (const c of d.giftClaims || []) {
      const stuck = c.kind === 'stuck';
      const val = stuck
        ? (c.resetsAt ? fmtLeft(c.resetsAt - nowSec) + '后重置' : '点击知道了')
        : (Number.isFinite(c.remaining) ? '剩 ' + c.remaining.toLocaleString() + ' · ' : '') + (c.resetsAt ? fmtLeft(c.resetsAt - nowSec) + '后过期' : '点击领取');
      rows.push(`<div class="row claim" data-claim="${esc(c.key)}" title="点一下标记已读，停止提醒"><span class="k">${stuck ? '💡' : '🎁'} ${esc(c.providerName)} ${stuck ? esc(c.label) + '用完了' : '待领取'}</span><span class="v">${val}</span></div>`);
    }
    for (const p of (d.config.providers || []).filter((x) => x.enabled)) {
      const s = d.snapshots[p.id]; const led = d.ledgers[p.id];
      if (!s) { rows.push(`<div class="row"><span class="k">${esc(p.name)}</span><span class="v stale">…</span></div>`); continue; }
      if (!s.ok && !s.stale) { rows.push(`<div class="row"><span class="k">${esc(p.name)}</span><span class="v${s.unconfigured ? ' stale' : ' err'}" title="${esc(s.error)}">${s.unconfigured ? '未配置' : esc((s.error || '失败').slice(0, 22))}</span></div>`); continue; }
      if (window.PetUsage.isRelay(p, s)) {
        const metric = window.PetUsage.relayMetric(s, led);
        rows.push(`<div class="row"><span class="k">${esc(p.name)}</span><span class="v${s.stale ? ' stale' : ''}" title="${esc(metric.hint)}">${metric.label} ${fmtMoney(metric.value, metric.currency)}</span></div>`);
      }
      else if (s.balance !== null && s.balance !== undefined) rows.push(`<div class="row"><span class="k">${esc(p.name)}</span><span class="v${s.stale ? ' stale' : ''}">${fmtMoney(s.balance, s.currency)}${led && led.todayUsage ? ` <span class="k">今 -${fmtMoney(led.todayUsage, s.currency)}</span>` : ''}</span></div>`);
      else for (const w of s.windows || []) {
        const rem = Number.isFinite(w.remaining) ? `剩 ${w.remaining.toLocaleString()} · ` : '';
        const reset = w.resetsAt ? `${fmtLeft(w.resetsAt - nowSec)}后重置` : '';
        const tip = [Number.isFinite(w.remaining) ? `剩余 ${w.remaining.toLocaleString()}` : '', w.resetsAt ? `重置/过期 ${new Date(w.resetsAt * 1000).toLocaleString()}` : ''].filter(Boolean).join(' · ');
        rows.push(`<div class="row"><span class="k">${esc(p.name)} ${esc(w.label)}</span><span class="v${s.stale ? ' stale' : ''}" style="${w.usedPercent >= (Number(p.warnPercent) || 90) ? 'color:#e0433f' : ''}"${tip ? ` title="${esc(tip)}"` : ''}>${Math.round(w.usedPercent)}% <span class="k">${rem}${reset}</span></span></div>`);
      }
    }
    $('#info').innerHTML = rows.join('') || '<div class="row"><span class="k">还没有启用的数据源</span></div>';
    const sel = $('[data-cfg=character]'); sel.innerHTML = '<option value="auto">自动（跟随 agent）</option>' + (d.characters || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join(''); sel.value = ap.character || 'auto';
    $('[data-cfg=scale]').value = ap.scale; $('#scale-val').textContent = Math.round(ap.scale * 100) + '%';
    $('[data-cfg=sound]').value = ap.sound; $('[data-cfg=volume]').value = ap.volume; $('[data-cfg=peakMode]').value = ap.peakMode;
    for (const k of ['bubbleOn', 'quipsOn', 'snapWindows', 'alwaysOnTop']) $(`[data-cfg=${k}]`).checked = !!ap[k];
    // 启动按钮独占一行，正常长度都能完整显示；名字特别长时先省掉「打开」，再不行才省略号 + 悬停看全称
    $('#transfer-btn').hidden = !!d.quotaOnly;
    projectView.hidden = !!d.quotaOnly || !window.projectPanel;
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
    resize();
  }
  document.addEventListener('change', (e) => { const k = e.target.dataset.cfg; if (!k) return; let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value; if (k === 'scale' || k === 'volume') v = Number(v); window.pet.send('appearance:set', { [k]: v }); });
  document.addEventListener('input', (e) => { if (e.target.dataset.cfg === 'scale') $('#scale-val').textContent = Math.round(e.target.value * 100) + '%'; });
  document.addEventListener('click', (e) => { const a = e.target.closest('[data-act]'); if (!a) return; const act = a.dataset.act; if (act === 'launch') { window.pet.send('launch'); window.pet.send('panel:close'); } else if (act === 'transfer') window.pet.send('transfer:open'); else if (act === 'refresh') window.pet.send('refresh'); else if (act === 'bubble') { window.pet.send('cmd:pet', { name: 'bubble' }); window.pet.send('panel:close'); } else if (act === 'settings') { window.pet.send('open-settings', 'providers'); window.pet.send('panel:close'); } else if (act === 'quit') window.pet.send('quit'); });
  document.addEventListener('click', (e) => { const c = e.target.closest('[data-claim]'); if (!c) return; window.pet.send('gift:claim', c.dataset.claim); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.pet.send('panel:close'); });
  window.pet.on('data', render);
  window.pet.on('project:open', () => {
    if (projectView.hidden) return;
    if (!projectView.open) projectView.open = true;
    else void readCurrentProject();
  });
  window.pet.send('panel:ready');
})();
