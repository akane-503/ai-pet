#!/usr/bin/env node
/**
 * Manager daemon v0 — local file-event watcher + decision/dispatch queue.
 *
 * Design (P2 = AB):
 *   Core truth remains Manager session + DECISIONS.md / board.json.
 *   This process only *notifies and queues*; it never auto-decides or writes code.
 *
 * Events watched:
 *   - .team/DECISIONS.md          (pending decision blocks)
 *   - .team/local/events.jsonl    (CLI append-only event log)
 *   - .team/local/board.json      (status transitions → queue integrate/accept hints)
 *   - .team/local/queue/*.json    (explicit enqueue by CLI/adapters)
 *
 * Commands:
 *   node services/manager-daemon.mjs start  [--cwd <repo>] [--once] [--interval-ms N]
 *   node services/manager-daemon.mjs status [--cwd <repo>]
 *   node services/manager-daemon.mjs drain  [--cwd <repo>] [--limit N]
 *   node services/manager-daemon.mjs enqueue --kind <kind> [--task T-001] [--text "..."]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function atomicAppend(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n', 'utf8');
}

function resolveRepo(cwdOpt) {
  const cwd = path.resolve(cwdOpt || process.cwd());
  let dir = cwd;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.team', 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`找不到 .team/（从 ${cwd} 向上搜）。先对目标仓跑 team.mjs init。`);
    }
    dir = parent;
  }
}

function paths(repo) {
  const team = path.join(repo, '.team');
  const local = path.join(team, 'local');
  return {
    repo,
    team,
    local,
    decisions: path.join(team, 'DECISIONS.md'),
    board: path.join(local, 'board.json'),
    events: path.join(local, 'events.jsonl'),
    queueDir: path.join(local, 'queue'),
    daemonState: path.join(local, 'manager-daemon.json'),
    notify: path.join(local, 'manager-notify.md'),
  };
}

function hashFile(file) {
  if (!fs.existsSync(file)) return null;
  const h = createHash('sha1');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** Detect open decision requests: headings like `### D-00x` with no `决定：` / `决定:**` filled. */
function scanPendingDecisions(text) {
  if (!text) return [];
  const blocks = text.split(/\n(?=###\s+D-\d+)/);
  const pending = [];
  for (const block of blocks) {
    const m = block.match(/^###\s+(D-\d+[^\n]*)/);
    if (!m) continue;
    const decided = /决定[：:]\s*\*\*/.test(block) || /决定[：:]\s*[^\s*\n]/.test(block);
    const waiting = /待决|等人|等待|未决|PENDING/i.test(block) || !decided;
    // Heuristic: has 选项 but 决定 line empty or missing
    const decideLine = block.match(/[-*]\s*决定[：:][ \t]*(.*)/);
    const emptyDecide = !decideLine || !String(decideLine[1] || '').replace(/[*_\s]/g, '');
    if (waiting && (emptyDecide || /待决|等人/.test(block))) {
      pending.push({ id: m[1].trim(), excerpt: block.slice(0, 240).replace(/\s+/g, ' ') });
    }
  }
  return pending;
}

function boardHints(board) {
  const hints = [];
  if (!board?.tasks) return hints;
  for (const [id, t] of Object.entries(board.tasks)) {
    if (t.status === '待验收') hints.push({ kind: 'integrate', task: id, text: `${id} 待验收 → manager 跑 integrate` });
    if (t.status === '已集成') hints.push({ kind: 'accept', task: id, text: `${id} 已集成 → manager 跑 accept` });
    if (t.status === '待仲裁') hints.push({ kind: 'arbitrate', task: id, text: `${id} 待仲裁 → 读 ARB 后 arbitrate --decide` });
    if (t.status === '等人') hints.push({ kind: 'decision', task: id, text: `${id} 等人 → 查 DECISIONS.md` });
  }
  return hints;
}


function engagementHints(board) {
  const hints = [];
  const engs = board?.engagements || {};
  for (const [id, e] of Object.entries(engs)) {
    if (e.status === 'out') {
      hints.push({ kind: 'engage-out', task: e.taskId || id, engagementId: id, text: `${id} out → 等 ${e.toHost} start / 读 LAUNCH.md` });
    }
    if (e.status === 'delivered') {
      hints.push({ kind: 'engage-delivered', task: e.taskId || id, engagementId: id, text: `${id} delivered → Manager accept [--integrate]` });
    }
    if (e.status === 'accepted' && e.taskId && !(e.inbound?.integrate?.ok)) {
      hints.push({ kind: 'engage-integrate', task: e.taskId, engagementId: id, text: `${id} accepted → integrate ${e.taskId}` });
    }
  }
  return hints;
}

function loadWakeHook(repo) {
  const cfgPath = path.join(repo, '.team', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* */ }
  const fromCfg = cfg.hooks?.managerWake || cfg.managerWakeCommand || null;
  const scriptCandidates = [
    path.join(repo, '.team', 'hooks', 'manager-wake.ps1'),
    path.join(repo, '.team', 'hooks', 'manager-wake.sh'),
    path.join(repo, '.team', 'hooks', 'manager-wake.cmd'),
  ];
  const script = scriptCandidates.find((f) => fs.existsSync(f)) || null;
  return { command: fromCfg, script };
}

function runWakeHook(repo, payload) {
  const hook = loadWakeHook(repo);
  const metaPath = path.join(repo, '.team', 'local', 'wake-last.json');
  ensureDir(path.dirname(metaPath));
  const record = { at: new Date().toISOString(), payload, hook, ran: false, result: null };
  if (!hook.command && !hook.script) {
    record.result = 'no-hook-configured';
    writeJson(metaPath, record);
    return record;
  }
  try {
    let r;
    const env = { ...process.env, TEAM_WAKE_PAYLOAD: JSON.stringify(payload) };
    if (hook.command) {
      r = spawnSync(hook.command, { shell: true, cwd: repo, encoding: 'utf8', env, windowsHide: true });
    } else if (hook.script.endsWith('.ps1')) {
      r = spawnSync('pwsh', ['-NoProfile', '-File', hook.script], { cwd: repo, encoding: 'utf8', env, windowsHide: true });
    } else {
      r = spawnSync(hook.script, { shell: true, cwd: repo, encoding: 'utf8', env, windowsHide: true });
    }
    record.ran = true;
    record.result = { status: r.status, stdout: (r.stdout || '').slice(0, 500), stderr: (r.stderr || '').slice(0, 500) };
  } catch (e) {
    record.ran = true;
    record.result = { error: e.message };
  }
  writeJson(metaPath, record);
  return record;
}

function loadQueue(p) {
  ensureDir(p.queueDir);
  return fs.readdirSync(p.queueDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const full = path.join(p.queueDir, f);
      return { file: full, ...(readJson(full, {}) || {}) };
    });
}

function enqueue(p, item) {
  ensureDir(p.queueDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = item.id || `${ts}-${item.kind || 'note'}`;
  const file = path.join(p.queueDir, `${id}.json`);
  const payload = {
    id,
    kind: item.kind || 'note',
    task: item.task || null,
    text: item.text || '',
    source: item.source || 'manual',
    createdAt: new Date().toISOString(),
    status: 'pending',
  };
  writeJson(file, payload);
  return payload;
}

function renderNotify(p, snapshot) {
  const lines = [
    `# Manager 通知板（daemon 生成，可手读；勿当 board 真相）`,
    ``,
    `> 生成：${snapshot.scannedAt}`,
    `> 仓：\`${p.repo}\``,
    ``,
    `## 待处理队列（${snapshot.queue.length}）`,
    ``,
  ];
  if (!snapshot.queue.length) lines.push('_空_');
  else {
    for (const q of snapshot.queue) {
      lines.push(`- \`${q.kind}\` ${q.task || ''} — ${q.text || q.id}`);
    }
  }
  lines.push('', '## 决策门扫描', '');
  if (!snapshot.pendingDecisions.length) lines.push('_无待决块（启发式）_');
  else {
    for (const d of snapshot.pendingDecisions) {
      lines.push(`- **${d.id}**：${d.excerpt.slice(0, 120)}…`);
    }
  }
  lines.push('', '## Board 提示', '');
  if (!snapshot.hints.length) lines.push('_无_');
  else for (const h of snapshot.hints) lines.push(`- \`${h.kind}\` ${h.text}`);
  lines.push('', '## Wake hook', '');
  if (snapshot.wake) lines.push(`- ran=${snapshot.wake.ran} result=${JSON.stringify(snapshot.wake.result)}`);
  else lines.push('_no wake this scan (configure .team/hooks/manager-wake.* or config.hooks.managerWake)_');
  lines.push('', '## 下一步（Manager 会话）', '');
  lines.push('1. 读 `.team/DECISIONS.md` 与本通知板');
  lines.push('2. `node .team/tools/team.mjs status` / `doctor`');
  lines.push('3. 对队列项做决定、integrate/accept/arbitrate；做完后 `managerd drain` 或删对应 queue 文件');
  lines.push('');
  fs.writeFileSync(p.notify, lines.join('\n'), 'utf8');
}

function scanOnce(p, state) {
  const decisionsText = fs.existsSync(p.decisions) ? fs.readFileSync(p.decisions, 'utf8') : '';
  const board = readJson(p.board, { tasks: {} });
  const pendingDecisions = scanPendingDecisions(decisionsText);
  const hints = [...boardHints(board), ...engagementHints(board)];

  const fingerprints = {
    decisions: hashFile(p.decisions),
    board: hashFile(p.board),
    eventsSize: fileSize(p.events),
  };

  const changed = [];
  if (state.last?.decisions !== fingerprints.decisions) changed.push('DECISIONS.md');
  if (state.last?.board !== fingerprints.board) changed.push('board.json');
  if ((state.last?.eventsSize || 0) !== fingerprints.eventsSize) changed.push('events.jsonl');

  // Auto-enqueue on new pending decisions / board hints (dedupe by kind+task+id)
  const existing = loadQueue(p);
  const keyOf = (x) => `${x.kind}|${x.task || ''}|${(x.text || '').slice(0, 80)}`;
  const have = new Set(existing.map(keyOf));

  for (const d of pendingDecisions) {
    const item = { kind: 'decision', task: null, text: `待决 ${d.id}`, source: 'watch:DECISIONS' };
    if (!have.has(keyOf(item))) enqueue(p, item);
  }
  for (const h of hints) {
    const item = { kind: h.kind, task: h.task, text: h.text, source: 'watch:board' };
    if (!have.has(keyOf(item))) enqueue(p, item);
  }

  const queue = loadQueue(p);
  const engageHints = hints.filter((h) => String(h.kind || '').startsWith('engage-'));
  let wake = null;
  if (engageHints.length && changed.includes('board.json')) {
    wake = runWakeHook(p.repo, { type: 'engagement', hints: engageHints });
  }
  const snapshot = {
    scannedAt: new Date().toISOString(),
    changed,
    fingerprints,
    pendingDecisions,
    hints,
    wake,
    queue: queue.filter((q) => q.status !== 'done'),
  };
  renderNotify(p, snapshot);

  const nextState = {
    ...state,
    last: fingerprints,
    lastScanAt: snapshot.scannedAt,
    pid: process.pid,
    running: true,
  };
  writeJson(p.daemonState, nextState);

  if (changed.length) {
    atomicAppend(p.events, JSON.stringify({
      at: snapshot.scannedAt,
      type: 'manager.watch',
      changed,
      queueLen: snapshot.queue.length,
    }));
  }
  return snapshot;
}

function cmdStatus(opts) {
  const repo = resolveRepo(opts.cwd);
  const p = paths(repo);
  const state = readJson(p.daemonState, {});
  const queue = loadQueue(p).filter((q) => q.status !== 'done');
  const out = {
    repo,
    daemon: state,
    queueLen: queue.length,
    queue: queue.slice(0, 20),
    notify: fs.existsSync(p.notify) ? p.notify : null,
  };
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`repo: ${repo}`);
    console.log(`lastScan: ${state.lastScanAt || '(never)'}`);
    console.log(`queue: ${queue.length}`);
    for (const q of queue.slice(0, 10)) console.log(`  - [${q.kind}] ${q.task || ''} ${q.text || q.id}`);
    if (out.notify) console.log(`notify: ${out.notify}`);
  }
}

function cmdDrain(opts) {
  const repo = resolveRepo(opts.cwd);
  const p = paths(repo);
  const limit = Number(opts.limit || 50);
  let n = 0;
  for (const q of loadQueue(p)) {
    if (q.status === 'done') continue;
    if (n >= limit) break;
    q.status = 'done';
    q.drainedAt = new Date().toISOString();
    writeJson(q.file, q);
    n++;
  }
  console.log(`drained ${n} queue item(s)`);
}

function cmdEnqueue(opts) {
  const repo = resolveRepo(opts.cwd);
  const p = paths(repo);
  const kind = opts.kind || 'note';
  const item = enqueue(p, {
    kind,
    task: opts.task || null,
    text: opts.text || opts._.join(' ') || kind,
    source: 'cli',
  });
  console.log(JSON.stringify(item, null, 2));
}

async function cmdStart(opts) {
  const repo = resolveRepo(opts.cwd);
  const p = paths(repo);
  ensureDir(p.queueDir);
  const interval = Math.max(500, Number(opts['interval-ms'] || 2000));
  let state = readJson(p.daemonState, {});

  const tick = () => {
    try {
      const snap = scanOnce(p, state);
      state = readJson(p.daemonState, state);
      if (!opts.quiet) {
        const ch = snap.changed.length ? ` changed=${snap.changed.join(',')}` : '';
        console.log(`[managerd] ${snap.scannedAt} queue=${snap.queue.length}${ch}`);
      }
    } catch (e) {
      console.error(`[managerd] scan error: ${e.message}`);
    }
  };

  tick();
  if (opts.once) return;

  console.log(`[managerd] watching ${repo} every ${interval}ms (Ctrl+C to stop)`);
  console.log(`[managerd] notify → ${p.notify}`);
  const timer = setInterval(tick, interval);

  // Light fs.watch when available (best-effort; still polled)
  const watchTargets = [p.decisions, p.board, p.events, p.queueDir];
  const watchers = [];
  for (const t of watchTargets) {
    try {
      if (!fs.existsSync(t) && t === p.queueDir) ensureDir(t);
      if (!fs.existsSync(t) && path.extname(t)) continue;
      const w = fs.watch(t, { persistent: true }, () => tick());
      watchers.push(w);
    } catch { /* ignore */ }
  }

  const stop = () => {
    clearInterval(timer);
    for (const w of watchers) try { w.close(); } catch { /* */ }
    const st = readJson(p.daemonState, {});
    st.running = false;
    st.stoppedAt = new Date().toISOString();
    writeJson(p.daemonState, st);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function printHelp() {
  console.log(`project-team Manager daemon (v0)

Usage:
  node services/manager-daemon.mjs start   [--cwd <repo>] [--once] [--interval-ms 2000] [--quiet]
  node services/manager-daemon.mjs status  [--cwd <repo>] [--json]
  node services/manager-daemon.mjs drain   [--cwd <repo>] [--limit 50]
  node services/manager-daemon.mjs enqueue --kind decision|integrate|accept|arbitrate|dispatch|note
                                           [--task T-001] [--text "..."] [--cwd <repo>]

Does NOT auto-decide. Writes .team/local/manager-notify.md and queue files for the Manager session.
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0] || 'help';
  opts._ = opts._.slice(1);
  switch (cmd) {
    case 'start': return cmdStart(opts);
    case 'status': return cmdStatus(opts);
    case 'drain': return cmdDrain(opts);
    case 'enqueue': return cmdEnqueue(opts);
    case 'help':
    case '--help':
    case '-h':
      return printHelp();
    default:
      console.error(`unknown command: ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

export {
  parseArgs,
  scanPendingDecisions,
  boardHints,
  engagementHints,
  runWakeHook,
  resolveRepo,
  paths,
  enqueue,
  scanOnce,
};

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  main().catch((e) => {
    console.error(`[managerd] ${e.stack || e.message}`);
    process.exit(1);
  });
}
