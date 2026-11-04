/**
 * Engagement (outsourcing) protocol — outbound / inbound across AI hosts.
 * Imported by team.mjs; copied beside .team/tools/team.mjs on init/--tools-only.
 *
 * State machine:
 *   draft -> out -> in-progress -> delivered -> accepted
 *                                \-> rejected -> out | cancelled
 *   draft -> cancelled
 *
 * Truth: board.json.engagements + .team/engagements/E-xxx/.
 */

import fs from 'node:fs';
import path from 'node:path';

export const ENGAGE_STATUSES = ['draft', 'out', 'in-progress', 'delivered', 'accepted', 'rejected', 'cancelled'];
export const HOSTS = ['cursor', 'codex', 'claude-code', 'zcode', 'dsh', 'generic', 'other'];

const TRANSITIONS = {
  draft: ['out', 'cancelled'],
  out: ['in-progress', 'cancelled'],
  'in-progress': ['delivered', 'cancelled'],
  delivered: ['accepted', 'rejected'],
  rejected: ['out', 'cancelled'],
  accepted: [],
  cancelled: [],
};

function ensureEngagements(st) {
  st.engagements ??= {};
  return st.engagements;
}

function nextEngageId(st) {
  let max = 0;
  for (const id of Object.keys(st.engagements || {})) {
    const m = /^E-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `E-${String(max + 1).padStart(3, '0')}`;
}

function engDir(ctx, id) {
  return path.join(ctx.teamDir, 'engagements', id);
}

function pushHistory(e, status, by, note = '') {
  e.history = e.history || [];
  e.history.push({ at: new Date().toISOString(), status, by: by || 'manager', note });
  e.status = status;
  e.updatedAt = new Date().toISOString();
}

function mustEngage(st, id) {
  const e = (st.engagements || {})[id];
  if (!e) {
    const err = new Error(`找不到外包包 ${id}`);
    err.code = 'NO_ENGAGE';
    throw err;
  }
  return e;
}

function assertTransition(from, to) {
  const ok = TRANSITIONS[from] || [];
  if (!ok.includes(to)) {
    const err = new Error(`非法状态迁移：${from} → ${to}（允许：${ok.join('|') || '无'}）`);
    err.code = 'BAD_ENGAGE_STATE';
    throw err;
  }
}

function normalizeHost(h) {
  const v = String(h || 'generic').toLowerCase();
  if (!HOSTS.includes(v)) return 'other';
  return v;
}

function adapterInstallHint(host, pmHome) {
  const home = pmHome || 'D:/01_Projects/Active/project-team-pm';
  return [
    `# 接包方宿主适配（${host}）`,
    '',
    '在接包方机器/会话执行：',
    '',
    '```powershell',
    `node ${home}/adapters/_install.mjs --host ${host} --repo <本产品仓> --skill`,
    '```',
    '',
    '然后用本 brief 作为接包会话的第一条消息；cwd 优先用任务 worktree（若有）。',
  ].join('\n');
}

function renderBrief(ctx, e, api) {
  const cfg = api.loadConfig(ctx);
  const pm = cfg.controlPlane?.home || 'D:/01_Projects/Active/project-team-pm';
  const st = api.readState(ctx);
  const task = e.taskId && st.tasks[e.taskId];
  const write = (e.scope?.write || task?.write || []).join('; ') || '（未声明 — 交付时必须列出文件）';
  const verify = e.verify || task?.verify || cfg.gateCommand || '（未设置）';
  const wt = task?.dispatch?.worktree || '（尚未 dispatch；接包方可在约定切片目录工作）';
  return [
    `# 外包接包 Brief · ${e.id}`,
    '',
    `> 状态：${e.status} · 发包：${e.fromHost} → 接包：${e.toHost}`,
    `> 生成：${new Date().toISOString()}`,
    '',
    '## 你是谁',
    '',
    `你是**接包方**（${e.toHost}）。只在声明的写集内改动；完成后按「交回」一节交付。`,
    '不要改 `.team/` 控制面；不要扩大范围；疑问写入交付说明，由发包 Manager 进 DECISIONS。',
    '',
    '## 范围',
    '',
    `- 标题：${e.title}`,
    `- 关联任务：${e.taskId || '（切片/无任务）'}`,
    `- 写集：\`${write}\``,
    `- 工作树/切片：\`${wt}\``,
    `- 验收命令：\`${verify}\``,
    e.acceptance ? `- 验收说明：${e.acceptance}` : null,
    '',
    '## 状态机（脉络）',
    '',
    '```text',
    'draft → out → in-progress → delivered → accepted',
    '                          ↘ rejected → out | cancelled',
    '```',
    '',
    '你当前应从 `out` 进入 `in-progress`（`engage start`），做完后 `engage deliver`。',
    '',
    '## 交回（inbound）',
    '',
    '在**发包方控制面**（产品仓根）执行：',
    '',
    '```bash',
    `node .team/tools/team.mjs engage start --id ${e.id} --by ${e.toHost}`,
    '# ... 在写集内提交 ...',
    `node .team/tools/team.mjs engage deliver --id ${e.id} --head <sha> --note "做了什么"`,
    '# 发包 Manager：',
    `node .team/tools/team.mjs engage accept --id ${e.id}   # 或 reject --reason "..."`,
    '```',
    '',
    adapterInstallHint(e.toHost, pm),
    '',
    '## 血缘',
    '',
    `- 外包包文件：\`.team/engagements/${e.id}/\``,
    '- 公告栏「外包 / 血缘」节；真相在 `board.json.engagements`。',
    '',
  ].filter((x) => x != null).join('\n');
}

function writeEngageFiles(ctx, e, api) {
  const dir = engDir(ctx, e.id);
  api.ensureDir(dir);
  const hist = (e.history || []).map((h) => `- ${h.at} · ${h.status} · ${h.by}${h.note ? ` — ${h.note}` : ''}`);
  const evid = (e.evidence || []).map((ev) => `- ${ev.at || ''} · ${ev.kind || ''} · ${ev.head || ''} · ${ev.note || ''}`);
  api.atomicWrite(path.join(dir, 'ENGAGEMENT.md'), [
    `# ${e.id} ${e.title}`,
    '',
    `- 状态：${e.status}`,
    `- 发包宿主：${e.fromHost}`,
    `- 接包宿主：${e.toHost}`,
    `- 任务：${e.taskId || '—'}`,
    `- 写集：${(e.scope?.write || []).join('; ') || '—'}`,
    `- 验收：${e.verify || '—'}`,
    `- 更新：${e.updatedAt}`,
    '',
    '## 历史',
    '',
    ...hist,
    '',
    '## 证据',
    '',
    ...(evid.length ? evid : ['- （无）']),
    '',
  ].join('\n'));
  api.atomicWrite(path.join(dir, 'BRIEF.md'), renderBrief(ctx, e, api));
  api.atomicWrite(path.join(dir, 'ADAPTER.md'), adapterInstallHint(e.toHost, api.loadConfig(ctx).controlPlane?.home) + '\n');
}

export function engagementBulletinSection(st, { cell, shortTime }) {
  const list = Object.values(st.engagements || {}).sort((a, b) => a.id.localeCompare(b.id));
  if (!list.length) return [];
  const lines = [
    '## 外包 / 血缘（engagements）',
    '',
    '| 包 | 方向 | 状态 | 范围 | 卡点 / 下一步 | 更新 |',
    '|---|---|---|---|---|---|',
  ];
  for (const e of list) {
    const dir = `${e.fromHost}→${e.toHost}`;
    const scope = e.taskId ? e.taskId : ((e.scope?.write || []).slice(0, 2).join(';') || 'slice');
    let next = '—';
    switch (e.status) {
      case 'draft': next = 'engage out'; break;
      case 'out': next = `等 ${e.toHost} start`; break;
      case 'in-progress': next = '等 deliver'; break;
      case 'delivered': next = 'manager accept/reject'; break;
      case 'rejected': next = '改完再 out 或 cancel'; break;
      default: next = '—';
    }
    lines.push(`| ${cell(`${e.id} ${e.title}`)} | ${cell(dir)} | ${cell(e.status)} | ${cell(scope)} | ${cell(next)} | ${shortTime(e.updatedAt)} |`);
  }
  lines.push('');
  return lines;
}

export function createEngagementApi(api) {
  const {
    TeamError, mutate, appendEvent, jsonOut, table, must, splitList,
    loadConfig, readState, ensureDir, atomicWrite, runShellToLog, resolveContext, requireInitialized,
  } = api;

  function wrap(fn) {
    return (opts) => {
      try { return fn(opts); }
      catch (e) {
        if (e instanceof TeamError) throw e;
        throw new TeamError(e.code || 'ENGAGE_ERR', e.message, e.exit || 2, e.hint || '');
      }
    };
  }

  function cmdNew(opts) {
    const ctx = resolveContext();
    requireInitialized(ctx);
    const title = must(opts.title, '--title');
    const toHost = normalizeHost(opts.to || opts.host);
    const fromHost = normalizeHost(opts.from || 'generic');
    const taskId = opts.task ? String(opts.task) : null;
    const write = splitList(opts.write);
    const verify = opts.verify ? String(opts.verify) : '';
    const acceptance = opts.accept || opts.acceptance || '';

    const result = mutate(ctx, (st) => {
      ensureEngagements(st);
      if (taskId) {
        const t = st.tasks[taskId];
        if (!t) throw new TeamError('NO_TASK', `任务不存在：${taskId}`, 2);
        if (!write.length && t.write?.length) write.push(...t.write);
      }
      const id = nextEngageId(st);
      const e = {
        id,
        title,
        status: 'draft',
        fromHost,
        toHost,
        taskId,
        scope: { type: taskId ? 'task' : (write.length ? 'slice' : 'repo'), write: write.slice() },
        verify: verify || (taskId && st.tasks[taskId]?.verify) || loadConfig(ctx).gateCommand || '',
        acceptance: String(acceptance || ''),
        evidence: [],
        history: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        by: opts.by || 'manager',
      };
      pushHistory(e, 'draft', e.by, 'created');
      st.engagements[id] = e;
      if (taskId && st.tasks[taskId]) {
        st.tasks[taskId].engagementId = id;
        st.tasks[taskId].updatedAt = e.updatedAt;
      }
      appendEvent(ctx, { event: 'engage.new', id, to: toHost, from: fromHost, taskId });
      return e;
    });
    writeEngageFiles(ctx, result, api);
    if (opts.json) return jsonOut(result);
    console.log(`已创建外包包 ${result.id} [${result.status}] ${result.fromHost}→${result.toHost}`);
    console.log(`  目录：${engDir(ctx, result.id)}`);
    console.log(`下一步：node .team/tools/team.mjs engage out --id ${result.id}`);
  }

  function cmdOut(opts) {
    const ctx = resolveContext();
    requireInitialized(ctx);
    const id = must(opts.id, '--id');
    const dry = opts['dry-run'] === true || opts.dry === true;
    const cfg = loadConfig(ctx);
    const ttl = Number(opts['ttl-ms'] || cfg.leaseTtlMs || 30 * 60 * 1000);

    const result = mutate(ctx, (st) => {
      const e = mustEngage(st, id);
      assertTransition(e.status === 'rejected' ? 'rejected' : e.status, 'out');
      // allow rejected→out via assert on rejected; if status is rejected, transition ok
      if (e.taskId && st.tasks[e.taskId] && !dry) {
        const t = st.tasks[e.taskId];
        for (const [lid, l] of Object.entries(st.leases)) {
          if (l.taskId === e.taskId && String(l.owner || '').startsWith('engage:')) delete st.leases[lid];
        }
        const leaseId = `L-eng-${id}-${Date.now().toString(36)}`;
        st.leases[leaseId] = {
          id: leaseId,
          taskId: e.taskId,
          owner: `engage:${e.toHost}`,
          paths: e.scope.write.length ? e.scope.write : (t.write || []),
          createdAt: new Date().toISOString(),
          expiresAt: Date.now() + ttl,
          engagementId: id,
        };
        t.claim = { owner: `engage:${e.toHost}`, at: new Date().toISOString(), leaseId, expiresAt: Date.now() + ttl, via: 'engagement' };
        if (t.status === '待认领') t.status = '进行中';
        t.updatedAt = new Date().toISOString();
        e.leaseId = leaseId;
      }
      pushHistory(e, 'out', opts.by || 'manager', dry ? 'dry-run out' : 'outbound dispatched');
      e.outbound = {
        at: new Date().toISOString(),
        dryRun: dry,
        briefPath: path.join('engagements', id, 'BRIEF.md'),
        adapterPath: path.join('engagements', id, 'ADAPTER.md'),
      };
      appendEvent(ctx, { event: 'engage.out', id, to: e.toHost, dryRun: dry });
      return e;
    });
    writeEngageFiles(ctx, result, api);
    const briefAbs = path.join(engDir(ctx, id), 'BRIEF.md');
    if (opts.json) return jsonOut({ engagement: result, brief: briefAbs, dryRun: dry });
    console.log(`外包已出站 ${id} → ${result.toHost}${dry ? ' (dry-run)' : ''}`);
    console.log(`  Brief：${briefAbs}`);
    console.log(`  适配：${path.join(engDir(ctx, id), 'ADAPTER.md')}`);
    console.log('将 BRIEF.md 贴给接包方会话；接包方：engage start → 改写集 → engage deliver');
  }

  function cmdStart(opts) {
    const ctx = resolveContext();
    requireInitialized(ctx);
    const id = must(opts.id, '--id');
    const by = opts.by || 'vendor';
    const result = mutate(ctx, (st) => {
      const e = mustEngage(st, id);
      assertTransition(e.status, 'in-progress');
      pushHistory(e, 'in-progress', by, opts.note || '');
      appendEvent(ctx, { event: 'engage.start', id, by });
      return e;
    });
    writeEngageFiles(ctx, result, api);
    if (opts.json) return jsonOut(result);
    console.log(`${id} → in-progress（接包方 ${by}）`);
  }

  function cmdDeliver(opts) {
    const ctx = resolveContext();
    requireInitialized(ctx);
    const id = must(opts.id, '--id');
    const head = opts.head ? String(opts.head) : '';
    const note = opts.note || '';
    const files = splitList(opts.files);
    const dry = opts['dry-run'] === true;
    const result = mutate(ctx, (st) => {
      const e = mustEngage(st, id);
      assertTransition(e.status, 'delivered');
      const allowed = e.scope?.write || [];
      if (files.length && allowed.length) {
        const bad = files.filter((f) => !api.matchAny(f, allowed));
        if (bad.length) throw new TeamError('WRITE_OVERFLOW', `交付文件超出写集：${bad.join(', ')}`, 3, '缩小改动或走 CR');
      }
      const ev = { kind: 'deliver', at: new Date().toISOString(), head: head || (dry ? 'dry-run' : ''), files, note, dryRun: dry };
      e.evidence.push(ev);
      e.inbound = { ...(e.inbound || {}), ...ev };
      pushHistory(e, 'delivered', opts.by || e.toHost, note || 'delivered');
      if (e.taskId && st.tasks[e.taskId]) {
        const t = st.tasks[e.taskId];
        t.status = '待验收';
        t.updatedAt = e.updatedAt;
        t.evidence = t.evidence || [];
        t.evidence.push({ at: ev.at, head: ev.head, exit: 0, files, via: id });
      }
      appendEvent(ctx, { event: 'engage.deliver', id, head: ev.head, files: files.length });
      return e;
    });
    writeEngageFiles(ctx, result, api);
    if (opts.json) return jsonOut(result);
    console.log(`${id} 已交付 (delivered)${dry ? ' dry-run' : ''}`);
    console.log(`下一步：engage accept --id ${id}  或  engage reject --id ${id} --reason "..."`);
  }

  function cmdAccept(opts) {
    const ctx = resolveContext();
    requireInitialized(ctx);
    const id = must(opts.id, '--id');
    const dry = opts['dry-run'] === true;
    const cfg = loadConfig(ctx);
    const runGate = opts['skip-gate'] !== true;
    const st0 = readState(ctx);
    const e0 = mustEngage(st0, id);
    if (e0.status !== 'delivered') throw new TeamError('BAD_ENGAGE_STATE', `仅 delivered 可 accept（当前 ${e0.status}）`, 2);
    let gate = { skipped: true };
    const verify = e0.verify || cfg.gateCommand;
    if (runGate && verify && !dry) {
      const logFile = path.join(engDir(ctx, id), `gate-${Date.now()}.log`);
      ensureDir(engDir(ctx, id));
      gate = { ...runShellToLog(verify, ctx.controlRoot, logFile), skipped: false, logFile };
      if (gate.status !== 0) throw new TeamError('GATE_FAIL', `验收门禁失败 exit=${gate.status}`, 4, `见 ${logFile}`);
    } else if (dry) gate = { skipped: true, dryRun: true };

    const result = mutate(ctx, (st) => {
      const e = mustEngage(st, id);
      assertTransition(e.status, 'accepted');
      pushHistory(e, 'accepted', opts.by || 'manager', opts.note || (dry ? 'dry-run accept' : 'accepted'));
      e.inbound = { ...(e.inbound || {}), acceptedAt: e.updatedAt, gate };
      e.evidence.push({ kind: 'accept', at: e.updatedAt, gate });
      if (e.taskId && st.tasks[e.taskId]) {
        const t = st.tasks[e.taskId];
        if (opts.finalize === true) t.status = '已完成';
        else if (t.status === '待验收' || t.status === '进行中') t.status = '待验收';
        t.updatedAt = e.updatedAt;
      }
      if (e.leaseId && st.leases[e.leaseId]) delete st.leases[e.leaseId];
      appendEvent(ctx, { event: 'engage.accept', id, dryRun: dry });
      if (opts.cr === true) {
        st.notes = st.notes || [];
        st.notes.push({ at: e.updatedAt, by: 'manager', text: `外包 ${id} 已接受；如需结构变更请另开 CR` });
      }
      return e;
    });
    writeEngageFiles(ctx, result, api);
    if (opts.json) return jsonOut({ engagement: result, gate });
    console.log(`${id} 已接受 (accepted)${dry ? ' dry-run' : ''}`);
    if (!gate.skipped) console.log(`  门禁：通过`);
    if (result.taskId) console.log(`  关联任务 ${result.taskId} → 待验收；integrate 走原任务流`);
  }

  function cmdReject(opts) {
    const ctx = resolveContext();
    requireInitialized(ctx);
    const id = must(opts.id, '--id');
    const reason = must(opts.reason, '--reason');
    const result = mutate(ctx, (st) => {
      const e = mustEngage(st, id);
      assertTransition(e.status, 'rejected');
      pushHistory(e, 'rejected', opts.by || 'manager', reason);
      e.inbound = { ...(e.inbound || {}), rejectedAt: e.updatedAt, reason };
      if (e.taskId && st.tasks[e.taskId]) {
        st.tasks[e.taskId].status = '进行中';
        st.tasks[e.taskId].blockedReason = `外包驳回：${reason}`;
        st.tasks[e.taskId].updatedAt = e.updatedAt;
      }
      appendEvent(ctx, { event: 'engage.reject', id, reason });
      return e;
    });
    writeEngageFiles(ctx, result, api);
    if (opts.json) return jsonOut(result);
    console.log(`${id} 已驳回：${reason}`);
    console.log(`脉络：.team/engagements/${id}/ENGAGEMENT.md ；返工：engage out --id ${id}`);
  }

  function cmdCancel(opts) {
    const ctx = resolveContext();
    requireInitialized(ctx);
    const id = must(opts.id, '--id');
    const result = mutate(ctx, (st) => {
      const e = mustEngage(st, id);
      assertTransition(e.status, 'cancelled');
      pushHistory(e, 'cancelled', opts.by || 'manager', opts.reason || '');
      if (e.leaseId && st.leases[e.leaseId]) delete st.leases[e.leaseId];
      appendEvent(ctx, { event: 'engage.cancel', id });
      return e;
    });
    writeEngageFiles(ctx, result, api);
    if (opts.json) return jsonOut(result);
    console.log(`${id} 已取消`);
  }

  function cmdList(opts) {
    const ctx = resolveContext();
    requireInitialized(ctx);
    const st = readState(ctx);
    const rows = Object.values(st.engagements || {}).sort((a, b) => a.id.localeCompare(b.id));
    if (opts.json) return jsonOut({ engagements: rows });
    if (!rows.length) { console.log('暂无外包包。engage new --title "..." --to codex'); return; }
    table(['ID', '标题', '方向', '状态', '任务', '更新'], rows.map((e) => [
      e.id, e.title, `${e.fromHost}→${e.toHost}`, e.status, e.taskId || '—', e.updatedAt,
    ]));
  }

  function cmdShow(opts) {
    const ctx = resolveContext();
    requireInitialized(ctx);
    const id = must(opts.id, '--id');
    const st = readState(ctx);
    const e = mustEngage(st, id);
    if (opts.json) return jsonOut(e);
    const p = path.join(engDir(ctx, id), 'ENGAGEMENT.md');
    console.log(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : JSON.stringify(e, null, 2));
  }

  function cmdBrief(opts) {
    const ctx = resolveContext();
    requireInitialized(ctx);
    const id = must(opts.id, '--id');
    const p = path.join(engDir(ctx, id), 'BRIEF.md');
    if (!fs.existsSync(p)) throw new TeamError('NO_BRIEF', `缺少 ${p}`, 2, '先 engage new / out');
    if (opts.json) return jsonOut({ path: p, content: fs.readFileSync(p, 'utf8') });
    console.log(fs.readFileSync(p, 'utf8'));
  }

  function dispatch(sub, opts) {
    const map = {
      new: wrap(cmdNew), out: wrap(cmdOut), start: wrap(cmdStart), deliver: wrap(cmdDeliver),
      accept: wrap(cmdAccept), reject: wrap(cmdReject), cancel: wrap(cmdCancel),
      list: wrap(cmdList), show: wrap(cmdShow), brief: wrap(cmdBrief),
    };
    if (!map[sub]) {
      throw new TeamError('BAD_SUB', `未知 engage 子命令：${sub || '(空)'}`, 2,
        'engage new|out|start|deliver|accept|reject|cancel|list|show|brief');
    }
    return map[sub](opts);
  }

  return { dispatch };
}