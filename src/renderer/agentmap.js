'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const agentsKey = 'aipet.projectRoot';
  const agentStatusLabels = { open: '待办', assigned: '已分派', working: '进行中', ready: '待验收',
    blocked: '阻塞', waiting: '等待处理', failed: '失败', done: '已完成', ended: '已结束' };
  const agentRoleLabels = { L1_pm: '决策', L2_workstream: '工作线', L3_executor: '执行' };
  const ticketTone = (status) => ['done', 'ended'].includes(status) ? 'done'
    : ['blocked', 'failed'].includes(status) ? 'blocked' : status === 'ready' ? 'ready' : 'working';
  let lastLayout = null;

  function mmChip(text, cls) { const s = document.createElement('span'); s.className = 'mm-chip' + (cls ? ' ' + cls : ''); s.textContent = text; return s; }
  function mmLine(parent, text, sub) { const p = document.createElement('p'); if (sub) p.className = 'mm-sub'; p.textContent = text; parent.append(p); }

  function agentsNodeEl(node, tickets, relayout) {
    const card = document.createElement('div');
    card.className = 'mm-node' + (node.depth === 0 ? ' root' : '');
    const title = document.createElement('p'); title.className = 'mm-title';
    title.textContent = node.data.sessionLabel || node.data.title || node.data.id;
    title.title = node.data.title || '';
    card.append(title);
    const chips = document.createElement('div'); chips.className = 'mm-chips';
    if (node.data.role) chips.append(mmChip(agentRoleLabels[node.data.role] || node.data.role, 'role'));
    if (node.data.blocker) chips.append(mmChip('阻塞', 'st-blocked'));
    else if (node.data.state) chips.append(mmChip(node.data.state === 'ready' ? '就绪' : node.data.state, node.data.state === 'ready' ? 'ok' : ''));
    for (const t of tickets.slice(0, 3)) chips.append(mmChip(t.id + ' · ' + (agentStatusLabels[t.status] || t.status || '状态未知'), 'mm-task st-' + ticketTone(t.status)));
    if (tickets.length > 3) chips.append(mmChip('+' + (tickets.length - 3) + ' 项'));
    card.append(chips);
    if (tickets.length || node.data.blocker) {
      const detail = document.createElement('div'); detail.className = 'mm-detail'; detail.hidden = true;
      if (node.data.blocker) mmLine(detail, '阻塞原因 · ' + node.data.blocker);
      for (const t of tickets) {
        mmLine(detail, t.id + ' · ' + (t.title || '') + ' · ' + (agentStatusLabels[t.status] || t.status || '状态未知'));
        const a = t.assignment;
        if (a?.workerId || a?.sessionLabel) mmLine(detail, '执行 · ' + (a.workerId || '未知') + (a.sessionLabel ? '（' + a.sessionLabel + '）' : ''), true);
        if (a?.worktree) mmLine(detail, '工作树 · ' + a.worktree + (a.worktreeRegistered ? '（已登记）' : '（未核实）'), true);
        if (a?.branch) mmLine(detail, '分支 · ' + a.branch, true);
        if (t.lease) mmLine(detail, '租约 · ' + (t.lease.active ? '有效' : '已过期') + ' · ' + new Date(t.lease.expiresAt).toLocaleString(), true);
        if (t.evidence) mmLine(detail, '最近验证 · ' + (t.evidence.exit === 0 ? '通过' : '失败或未知') + (t.evidence.head ? ' · ' + t.evidence.head.slice(0, 8) : ''), true);
        if (t.summary) mmLine(detail, '报告 · ' + t.summary.slice(0, 140), true);
      }
      card.append(detail);
      card.addEventListener('click', () => {
        detail.hidden = !detail.hidden;
        card.classList.toggle('open', !detail.hidden);
        relayout();
      });
    }
    return card;
  }

  function agentsGraph(view) {
    const wrap = document.createElement('div'); wrap.className = 'mm-wrap';
    const graph = document.createElement('div'); graph.className = 'mm-graph';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    graph.append(svg);
    const tickets = Array.isArray(view.tickets) ? view.tickets : [];
    const org = Array.isArray(view.org) ? view.org.filter((o) => o && o.id) : [];
    const nodes = new Map();
    for (const o of org) nodes.set(o.id, { data: o, parent: null, children: [], depth: 0 });
    for (const n of nodes.values()) {
      const p = n.data.parentId && n.data.parentId !== n.data.id ? nodes.get(n.data.parentId) : null;
      if (p) { n.parent = p; n.depth = p.depth + 1; p.children.push(n); }
    }
    // 环保护：祖先链异常的节点拉回根层
    for (const n of nodes.values()) {
      let seen = 0, a = n.parent;
      while (a && seen <= nodes.size) { seen++; a = a.parent; }
      if (seen > nodes.size) { n.parent = null; n.depth = 0; }
    }
    const byNode = new Map();
    for (const t of tickets) {
      const key = t.nodeId && nodes.has(t.nodeId) ? t.nodeId : '__stray__';
      if (!byNode.has(key)) byNode.set(key, []);
      byNode.get(key).push(t);
    }
    let roots = [...nodes.values()].filter((n) => !n.parent);
    if (!roots.length) {
      const pseudo = { data: { id: '__root__', title: view.name || '项目', role: 'L1_pm' }, parent: null, children: [], depth: 0 };
      nodes.set('__root__', pseudo); roots = [pseudo];
    }
    const all = [...nodes.values()];
    const holder = byNode.get('__stray__') ? {
      data: { id: '__stray__', title: '未归属', role: '' }, parent: roots[0], children: [], depth: roots[0].depth + 1,
    } : null;
    if (holder) { roots[0].children.push(holder); all.push(holder); }
    for (const n of all) n.el = agentsNodeEl(n, n === holder ? byNode.get('__stray__') : (byNode.get(n.data.id) || []), () => layout());
    for (const n of all) graph.append(n.el);

    const NODE_W = 280, COL_GAP = 76, SIB_GAP = 18;
    function layout() {
      for (const n of all) { n.w = n.el.offsetWidth; n.h = n.el.offsetHeight; }
      const depths = [...new Set(all.map((n) => n.depth))].sort((a, b) => a - b);
      let x = 12; const colX = new Map();
      for (const d of depths) { colX.set(d, x); x += NODE_W + COL_GAP; }
      let cursor = 12;
      const place = (n) => {
        if (!n.children.length) { n.cy = cursor + n.h / 2; cursor += n.h + SIB_GAP; return; }
        for (const c of n.children) place(c);
        n.cy = (n.children[0].cy + n.children[n.children.length - 1].cy) / 2;
      };
      for (const r of roots) place(r);
      for (const n of all) if (n.cy === undefined) { n.cy = cursor + n.h / 2; cursor += n.h + SIB_GAP; }
      for (const n of all) {
        n.el.style.left = colX.get(n.depth) + 'px';
        n.el.style.top = Math.max(8, n.cy - n.h / 2) + 'px';
      }
      graph.style.width = x + 'px';
      graph.style.height = cursor + 'px';
      svg.setAttribute('width', x); svg.setAttribute('height', cursor);
      svg.replaceChildren();
      for (const n of all) {
        if (!n.parent || !n.parent.el) continue;
        const px = colX.get(n.parent.depth) + NODE_W, py = n.parent.cy;
        const cx = colX.get(n.depth), cy = n.cy, mid = (px + cx) / 2;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${px} ${py} C ${mid} ${py}, ${mid} ${cy}, ${cx} ${cy}`);
        svg.append(path);
      }
    }
    layout();
    lastLayout = layout;
    wrap.append(graph);
    const legend = document.createElement('div'); legend.className = 'mm-legend';
    legend.append('图例 · ');
    legend.append(mmChip('进行中', 'st-working'), mmChip('待验收', 'st-ready'), mmChip('已完成', 'st-done'), mmChip('阻塞', 'st-blocked'));
    legend.append(` · ${org.length || roots.length} 个节点 · ${tickets.length} 项任务 · 读取于 ${new Date().toLocaleTimeString()}`);
    wrap.append(legend);
    return wrap;
  }

  async function renderMap() {
    const host = $('#map-view');
    const root = $('#map-root').value.trim();
    if (!root) {
      host.replaceChildren();
      const p = document.createElement('p'); p.className = 'hint';
      p.textContent = '填项目目录后读取，或点「自动识别当前项目」。'; host.append(p); return;
    }
    host.textContent = '正在读取控制面…';
    try {
      const view = await window.projectPanel.read(root);
      try { localStorage.setItem(agentsKey, root); } catch {}
      host.replaceChildren(agentsGraph(view));
    } catch (e) { host.textContent = '读取失败：' + e.message; }
  }

  $('#map-read').addEventListener('click', renderMap);
  $('#map-root').addEventListener('keydown', (e) => { if (e.key === 'Enter') renderMap(); });
  $('#map-detect').addEventListener('click', async () => {
    const host = $('#map-view');
    try {
      const { project } = await window.pet.invoke('project:workspace');
      if (project) { $('#map-root').value = project; renderMap(); }
      else host.textContent = '没有检测到正在工作的项目；先填目录，或在对应项目里开着 AI 会话。';
    } catch (e) { host.textContent = '识别失败：' + e.message; }
  });
  try { $('#map-root').value = localStorage.getItem(agentsKey) || ''; } catch {}
  // 带着最近使用的项目自动出图；字体就绪后重排一次，避免测量偏差
  if ($('#map-root').value.trim()) renderMap();
  document.fonts.ready.then(() => { if (lastLayout) lastLayout(); });
})();
