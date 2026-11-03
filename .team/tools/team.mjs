#!/usr/bin/env node
/**
 * project-team CLI — 项目管理系统（多会话并行 / 公告栏 / 写域租约 / 仲裁 / 变更重排）
 *
 * 零依赖，Node >= 20。设计原则：
 *  - 控制面固定在主工作树根（git common dir 的父目录），任务 worktree 只改业务代码。
 *  - 所有可变状态走 .team/local/board.json，目录互斥 + 临时文件 rename 原子写。
 *  - 公告栏 .team/BULLETIN.md 由本 CLI 渲染，是唯一人读交接渠道，禁止手改。
 *  - 租约是建议性的：submit 检查写集，挡不住编辑器；靠 AGENTS.md 硬规则兜底。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_ROOT = fs.existsSync(path.join(SKILL_ROOT, 'templates'))
  ? path.join(SKILL_ROOT, 'templates')
  : path.join(__dirname, 'templates');

const TEAM = '.team';
const LOCAL = 'local';
const STATUSES = ['待认领', '进行中', '待验收', '待仲裁', '已集成', '已完成', '关闭', '阻塞', '等人'];
const ACTIVE = new Set(['待认领', '进行中', '待验收', '待仲裁', '已集成', '阻塞', '等人']);
const DEFAULT_TTL = 30 * 60 * 1000;
const DEFAULT_PROTECTED = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  '.github/**', '**/*.lock', '.team/**',
];

class TeamError extends Error {
  constructor(code, message, exit = 2, hint = '') {
    super(message);
    this.code = code;
    this.exit = exit;
    this.hint = hint;
  }
}

// ---------------------------------------------------------------- 基础工具

const nowIso = () => new Date().toISOString();
const shortTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function sleepSync(ms) {
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, ms);
}

function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

function samePath(a, b) {
  const real = (p) => {
    try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); }
  };
  return real(a) === real(b);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

function splitList(v) {
  if (!v) return [];
  const s = String(v);
  const parts = s.includes('{') ? s.split(';') : s.split(/[;,]/);
  return parts.map((x) => x.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1; } else { out[key] = true; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function jsonOut(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(strWidth(h), ...rows.map((r) => strWidth(r[i] ?? ''))));
  const line = (cells) => cells.map((c, i) => pad(c ?? '', widths[i])).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  rows.forEach((r) => console.log(line(r)));
}

function strWidth(s) {
  // 中文按 2 列近似
  return [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
}

function pad(s, w) {
  const n = strWidth(s);
  return n >= w ? s : s + ' '.repeat(w - n);
}

function must(v, name) {
  if (v === undefined || v === true || v === '') throw new TeamError('MISSING_ARG', `缺少参数 --${name}`);
  return String(v);
}

// ---------------------------------------------------------------- 进程执行

function tmpFile(tag) {
  return path.join(os.tmpdir(), `team-${process.pid}-${tag}-${crypto.randomBytes(4).toString('hex')}`);
}

/** 用临时文件接 stdout/stderr，避免受限沙箱下 piped stdio 的 EPERM。 */
function runCapture(cmd, args, cwd) {
  const outFile = tmpFile('out');
  const errFile = tmpFile('err');
  const fo = fs.openSync(outFile, 'w');
  const fe = fs.openSync(errFile, 'w');
  let r;
  try {
    r = spawnSync(cmd, args, { cwd, stdio: ['ignore', fo, fe], windowsHide: true });
  } finally {
    fs.closeSync(fo); fs.closeSync(fe);
  }
  const stdout = readText(outFile);
  const stderr = readText(errFile);
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });
  return { status: r.status, signal: r.signal, error: r.error, stdout, stderr };
}

/** 运行门禁命令：输出落日志文件（不占管道），再把尾部回显。 */
function runShellToLog(command, cwd, logFile) {
  ensureDir(path.dirname(logFile));
  const fo = fs.openSync(logFile, 'w');
  const fe = fs.openSync(logFile, 'a');
  let r;
  try {
    r = spawnSync(command, { cwd, shell: true, stdio: ['ignore', fo, fe], windowsHide: true });
  } finally {
    fs.closeSync(fo); fs.closeSync(fe);
  }
  const text = readText(logFile);
  const tail = text.split('\n').slice(-40).join('\n');
  if (tail.trim()) console.log(`\n--- 门禁输出（尾部） ---\n${tail}\n--- 结束 ---`);
  return { status: r.status, signal: r.signal, error: r.error, logFile };
}

// ---------------------------------------------------------------- git

function git(args, cwd, { allowFail = false } = {}) {
  const r = runCapture('git', args, cwd);
  if (r.status !== 0 && !allowFail) {
    throw new TeamError('GIT_FAILED', `git ${args.join(' ')} 失败: ${(r.stderr || r.stdout).trim()}`, 2,
      '确认当前目录是 git 仓库且分支/工作树未被占用');
  }
  return r.status === 0 ? r.stdout.trim() : '';
}

function resolveContext() {
  const cwd = process.cwd();
  let top;
  try {
    top = git(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    throw new TeamError('NOT_GIT', '当前目录不在 git 仓库内。并行模式需要 git；请先 git init 并提交一次。');
  }
  const commonRaw = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  const common = path.resolve(cwd, commonRaw);
  const controlRoot = path.basename(common) === '.git' ? path.dirname(common) : path.resolve(top);
  return {
    cwd,
    top: path.resolve(top),
    controlRoot,
    teamDir: path.join(controlRoot, TEAM),
    localDir: path.join(controlRoot, TEAM, LOCAL),
  };
}

function requireInitialized(ctx) {
  if (!fs.existsSync(path.join(ctx.teamDir, 'config.json'))) {
    throw new TeamError('NOT_INITIALIZED', '当前仓库未初始化 project-team。先运行：node <skill>/scripts/team.mjs init',
      2, 'team init');
  }
}

function loadConfig(ctx) {
  const cfg = readJson(path.join(ctx.teamDir, 'config.json'));
  if (!cfg) throw new TeamError('NO_CONFIG', '缺少 .team/config.json');
  return cfg;
}

function worktreeRoot(ctx, cfg) {
  if (cfg.worktreeRoot) return path.resolve(ctx.controlRoot, cfg.worktreeRoot);
  return path.join(path.dirname(ctx.controlRoot), `${path.basename(ctx.controlRoot)}.team-worktrees`);
}

function integrationWorktree(ctx, cfg) {
  return path.join(worktreeRoot(ctx, cfg), 'integration');
}

/** 把控制面的重依赖目录（如 node_modules）以 junction/symlink 链进任务工作树。 */
function linkWorktreeDirs(ctx, cfg, wt) {
  const linked = [];
  for (const rel of cfg.linkDirs || []) {
    const target = path.join(ctx.controlRoot, rel);
    const dest = path.join(wt, rel);
    if (!fs.existsSync(target)) {
      console.log(`  ⚠ link 目标不存在，跳过：${target}`);
      continue;
    }
    if (fs.existsSync(dest)) { linked.push(rel); continue; }
    ensureDir(path.dirname(dest));
    try {
      fs.symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(rel);
    } catch (e) {
      throw new TeamError('LINK_FAILED', `无法链接 ${rel} → ${dest}: ${e.message}`, 2,
        '检查目标目录是否存在、是否有权限；也可改成每个工作树独立安装');
    }
  }
  return linked;
}

function unlinkWorktreeDirs(ctx, cfg, wt) {
  for (const rel of cfg.linkDirs || []) {
    const dest = path.join(wt, rel);
    try {
      if (fs.lstatSync(dest).isSymbolicLink()) fs.unlinkSync(dest);
    } catch { /* 不存在或不是链接 */ }
  }
}

function branchExists(ctx, branch) {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], ctx.controlRoot, { allowFail: true }) !== '';
}

function worktreeList(ctx) {
  const raw = git(['worktree', 'list', '--porcelain'], ctx.controlRoot);
  const out = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: normPath(line.slice(9)) }; out.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (cur && line === 'detached') cur.detached = true;
  }
  return out;
}

function isClean(dir) {
  return git(['status', '--porcelain'], dir) === '';
}

// ---------------------------------------------------------------- 互斥与状态

function acquireMutex(ctx) {
  const lockDir = path.join(ctx.localDir, '.mutex');
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > 60000) fs.rmSync(lockDir, { recursive: true, force: true });
      } catch { /* 已被别人清掉 */ }
      if (Date.now() > deadline) {
        throw new TeamError('MUTEX_TIMEOUT', `等待控制面互斥超时：${lockDir}`, 3, '检查是否有卡死的 team 进程；60 秒后会自动视为过期');
      }
      sleepSync(50);
    }
  }
}

function releaseMutex(ctx) {
  fs.rmSync(path.join(ctx.localDir, '.mutex'), { recursive: true, force: true });
}

function statePath(ctx) { return path.join(ctx.localDir, 'board.json'); }

function readState(ctx) {
  const st = readJson(statePath(ctx));
  if (!st) throw new TeamError('NO_STATE', '缺少 .team/local/board.json；控制面状态丢失，先跑 doctor 或重新 init --repair');
  st.tasks ??= {};
  st.leases ??= {};
  st.crs ??= {};
  st.arbitrations ??= {};
  st.notes ??= [];
  return st;
}

function writeState(ctx, st) {
  st.updatedAt = nowIso();
  writeJson(statePath(ctx), st);
}

function appendEvent(ctx, event) {
  ensureDir(ctx.localDir);
  fs.appendFileSync(path.join(ctx.localDir, 'events.jsonl'), JSON.stringify({ at: nowIso(), ...event }) + '\n');
}

/** 所有写操作：互斥 → 读 → 改 → 写状态 → 渲染公告栏。fn 抛错时不落盘。 */
function mutate(ctx, fn) {
  acquireMutex(ctx);
  try {
    const st = readState(ctx);
    pruneLeases(st);
    const result = fn(st);
    writeState(ctx, st);
    writeBulletin(ctx, st);
    return result;
  } finally {
    releaseMutex(ctx);
  }
}

function pruneLeases(st) {
  const now = Date.now();
  for (const [id, lease] of Object.entries(st.leases)) {
    if (!lease || Number(lease.expiresAt) <= now) delete st.leases[id];
  }
}

// ---------------------------------------------------------------- glob / 写集

function expandBraces(glob) {
  const m = glob.match(/\{([^{}]+)\}/);
  if (!m) return [glob];
  return m[1].split(',').flatMap((alt) => expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)));
}

function globToRegExp(glob) {
  const s = normPath(glob).toLowerCase();
  let re = '^';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '*') {
      if (s[i + 1] === '*') {
        i += 1;
        if (s[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else { re += '.*'; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('/\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`${re}$`);
}

function matchGlob(file, glob) {
  const f = normPath(file).toLowerCase();
  return expandBraces(glob).some((g) => globToRegExp(g).test(f));
}

function matchAny(file, globs) {
  return (globs || []).some((g) => matchGlob(file, g));
}

function literalPrefix(glob) {
  const s = normPath(glob).toLowerCase();
  const idx = s.search(/[*?{]/);
  const head = idx === -1 ? s : s.slice(0, idx);
  const slash = head.lastIndexOf('/');
  return slash === -1 ? '' : head.slice(0, slash + 1);
}

function globMayOverlap(a, b) {
  for (const x of expandBraces(a)) {
    for (const y of expandBraces(b)) {
      const A = normPath(x).toLowerCase();
      const B = normPath(y).toLowerCase();
      if (A === B) return true;
      if (!/[*?]/.test(A) && globToRegExp(B).test(A)) return true;
      if (!/[*?]/.test(B) && globToRegExp(A).test(B)) return true;
      const pa = literalPrefix(A);
      const pb = literalPrefix(B);
      if (pa && pb && !pa.startsWith(pb) && !pb.startsWith(pa)) continue;
      return true;
    }
  }
  return false;
}

function setsOverlap(a, b) {
  return (a || []).some((x) => (b || []).some((y) => globMayOverlap(x, y)));
}

function isTeamPath(file) {
  const f = normPath(file);
  return f === '.team' || f.startsWith('.team/');
}

/** 只对"窄写集/精确文件"报保护文件风险，宽 glob 交给 submit 按实际文件判断。 */
function protectedRelevant(glob, protectedList) {
  const g = normPath(glob).toLowerCase();
  if (!/[*?{]/.test(g)) return matchAny(g, protectedList);
  const prefix = literalPrefix(g);
  if (!prefix) return false;
  return (protectedList || []).some((p) => {
    const pl = normPath(p).toLowerCase();
    if (/[*?{]/.test(pl)) {
      const pp = literalPrefix(pl);
      return Boolean(pp) && (prefix.startsWith(pp) || pp.startsWith(prefix));
    }
    return pl.startsWith(prefix) || `${prefix}`.startsWith(pl.endsWith('/') ? pl : `${pl}/`);
  });
}

// ---------------------------------------------------------------- 模板与公告栏

function renderTemplate(name, vars, fallback = '') {
  const file = path.join(TEMPLATE_ROOT, name);
  const text = readText(file, '');
  const base = text || fallback;
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v)), base);
}

function taskRows(st, status) {
  return Object.values(st.tasks)
    .filter((t) => t.status === status)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function cell(v) {
  return String(v ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function ownerLabel(t) {
  if (t.sessionId) return `\`${String(t.sessionId).slice(-8)}\``;
  if (t.claim && t.claim.owner) return `\`${t.claim.owner}\``;
  return '—';
}

function evidenceCell(t) {
  const ev = (t.evidence || [])[t.evidence?.length - 1];
  if (!ev) return '—';
  const head = ev.head ? `\`${String(ev.head).slice(0, 7)}\`` : '无提交';
  return `${head} · ${ev.exit === 0 ? '通过' : '失败'} · ${ev.files?.length ?? 0} 文件`;
}

function nextCell(t) {
  if (t.blockedReason) return t.blockedReason;
  switch (t.status) {
    case '待认领': return t.dispatched ? '等执行会话 claim' : '等 manager dispatch';
    case '进行中': return t.needsHuman ? '需人工验收' : '等 submit';
    case '待验收': return '等 manager 验收 / integrate';
    case '待仲裁': return t.arb ? `见 ${t.arb}` : '等仲裁';
    case '已集成': return '等 accept';
    case '已完成': return '—';
    case '阻塞': return t.blockedReason || '执行者报告阻塞';
    case '等人': return t.blockedReason || '等用户决策';
    default: return t.closeReason || '—';
  }
}

function writeBulletin(ctx, st) {
  const sections = ['待认领', '进行中', '待验收', '待仲裁', '已集成', '已完成', '关闭', '阻塞', '等人'];
  const lines = [
    '# 公告栏（BULLETIN）',
    '',
    `> 项目：${st.project} · 唯一交接渠道 · 由 \`team\` CLI 维护，勿手改`,
    `> 协议见 [PROTOCOL.md](PROTOCOL.md)；状态真相在 \`.team/local/board.json\`；生成于 ${nowIso()}`,
    '',
  ];
  for (const status of sections) {
    const rows = taskRows(st, status);
    if (!rows.length) continue;
    lines.push(`## ${status}`, '');
    lines.push('| 任务 | 认领者（会话） | 状态 | 证据 | 阻塞 / 下一步 | 更新 |');
    lines.push('|---|---|---|---|---|---|');
    for (const t of rows) {
      lines.push(`| ${cell(`${t.id} ${t.title}`)} | ${ownerLabel(t)} | ${cell(t.status)} | ${cell(evidenceCell(t))} | ${cell(nextCell(t))} | ${shortTime(t.updatedAt)} |`);
    }
    lines.push('');
  }
  if (!Object.keys(st.tasks).length) lines.push('## 暂无任务', '', '用 `team task add` 建任务，`team dispatch` 派单。', '');
  if (st.notes?.length) {
    lines.push('## 公告 / 通知', '');
    for (const n of st.notes.slice(-40)) lines.push(`- ${shortTime(n.at)} [${cell(n.by)}] ${cell(n.text)}`);
    lines.push('');
  }
  if (Object.values(st.crs).length) {
    lines.push('## 变更请求', '');
    lines.push('| CR | 标题 | 级别 | 状态 | 受影响任务 |');
    lines.push('|---|---|---|---|---|');
    for (const cr of Object.values(st.crs).sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`| ${cr.id} | ${cell(cr.title)} | ${cell(cr.mode || cr.classification || '待定')} | ${cell(cr.status)} | ${cell((cr.affected || []).join(', '))} |`);
    }
    lines.push('');
  }
  lines.push('---', '', '> 规则：只由 CLI 写；证据必须可复核；一行一任务；不删行。');
  atomicWrite(path.join(ctx.teamDir, 'BULLETIN.md'), lines.join('\n') + '\n');
}

// ---------------------------------------------------------------- 任务书

function nextTaskId(st) {
  let max = 0;
  for (const id of Object.keys(st.tasks)) {
    const m = /^T-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `T-${String(max + 1).padStart(3, '0')}`;
}

function writeTaskFile(ctx, st, task) {
  const file = path.join(ctx.teamDir, 'TASKS', `${task.id}.md`);
  const vars = {
    ID: task.id,
    TITLE: task.title,
    MODULE: task.module || '未指定',
    PRIORITY: task.priority ?? 2,
    WRITE: (task.write || []).map((g) => `  - "${g}"`).join('\n') || '  - "（未声明，禁止提交）"',
    READ: (task.read || []).map((g) => `  - "${g}"`).join('\n') || '  - "（无）"',
    DEPS: (task.deps || []).join(', ') || '（无）',
    VERIFY: task.verify || '（未设置，submit 需 --test 或 --skip-gate）',
    CONTEXT: task.context || '（待 manager 补充：背景、输入、约束）',
    ACCEPT: task.accept || '（待 manager 补充：可复核的验收标准）',
    CR: (task.crs || []).join(', ') || '（无）',
  };
  const fallback = `---\nid: ${task.id}\ntitle: ${task.title}\nmodule: ${task.module || ''}\npriority: ${task.priority ?? 2}\nstatus: ${task.status}\nwrite:\n${vars.WRITE}\nread:\n${vars.READ}\ndepends: [${vars.DEPS}]\nverify: ${task.verify || ''}\n---\n\n# ${task.id} ${task.title}\n\n## 目标\n\n${vars.CONTEXT}\n\n## 验收\n\n${vars.ACCEPT}\n\n## 执行规则\n\n- 只在写集内改；不碰 \`.team/\` 控制面。\n- 先 \`claim\`；完成后 \`submit\`；卡住 \`report --status blocked\` 并停。\n`;
  atomicWrite(file, renderTemplate('TASK.md', vars, fallback));
  return file;
}

// ---------------------------------------------------------------- init

function cmdInit(opts) {
  const ctx = resolveContext();
  const force = opts.force === true;
  const toolsOnly = opts['tools-only'] === true || opts.tools === true;

  if (fs.existsSync(ctx.teamDir) && !force && !toolsOnly) {
    throw new TeamError('ALREADY_INIT', `.team 已存在：${ctx.teamDir}`, 2, '要刷新 CLI/模板用 --tools-only；要重建用 --force（会覆盖模板）');
  }

  if (toolsOnly) {
    if (!fs.existsSync(ctx.teamDir)) throw new TeamError('NOT_INITIALIZED', `没有 .team：${ctx.teamDir}`, 2, '先正常 init');
    ensureDir(path.join(ctx.teamDir, 'tools', 'templates'));
    fs.copyFileSync(__filename, path.join(ctx.teamDir, 'tools', 'team.mjs'));
    if (fs.existsSync(TEMPLATE_ROOT)) {
      for (const f of fs.readdirSync(TEMPLATE_ROOT)) {
        const src = path.join(TEMPLATE_ROOT, f);
        if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(ctx.teamDir, 'tools', 'templates', f));
      }
    }
    const cfgTools = loadConfig(ctx);
    console.log(`已刷新 CLI/模板：${ctx.teamDir}/tools/（基线 ${cfgTools.baseBranch}，集成 ${cfgTools.integrationBranch}）`);
    return;
  }

  const head = git(['rev-parse', '--verify', 'HEAD'], ctx.controlRoot, { allowFail: true });
  if (!head) {
    throw new TeamError('EMPTY_REPO', '仓库还没有任何提交。先 git add -A && git commit -m "chore: init"，再 team init。');
  }

  const baseBranch = opts.base || git(['rev-parse', '--abbrev-ref', 'HEAD'], ctx.controlRoot);
  if (!baseBranch || baseBranch === 'HEAD') throw new TeamError('DETACHED', '当前处于 detached HEAD，无法确定基线分支；用 --base <branch> 指定。');
  const integrationBranch = opts.integration || 'team/integration';
  const project = opts.name || path.basename(ctx.controlRoot);
  const gate = opts.gate || '';
  const cfg = {
    version: 1,
    project,
    baseBranch,
    integrationBranch,
    gateCommand: gate,
    leaseTtlMs: DEFAULT_TTL,
    createdAt: nowIso(),
  };
  if (opts['worktree-root']) cfg.worktreeRoot = opts['worktree-root'];
  const linkDirs = splitList(opts.link);
  if (linkDirs.length) cfg.linkDirs = linkDirs;

  ensureDir(ctx.teamDir);
  ensureDir(path.join(ctx.teamDir, 'TASKS'));
  ensureDir(path.join(ctx.teamDir, 'CONTRACTS'));
  ensureDir(path.join(ctx.teamDir, 'DECISIONS'));
  ensureDir(path.join(ctx.teamDir, 'CHANGES'));
  ensureDir(path.join(ctx.teamDir, 'ARBITRATIONS'));
  ensureDir(path.join(ctx.teamDir, 'tools'));
  ensureDir(path.join(ctx.localDir, 'leases'));
  ensureDir(path.join(ctx.localDir, 'sessions'));
  ensureDir(path.join(ctx.localDir, 'evidence'));

  const vars = {
    PROJECT: project,
    DATE: nowIso().slice(0, 10),
    BASE_BRANCH: baseBranch,
    INTEGRATION_BRANCH: integrationBranch,
    GATE: gate || '（未设置：integrate 跳过门禁，建议 team.mjs init 时用 --gate 指定）',
  };

  const templateFiles = ['PROTOCOL.md', 'CHARTER.md', 'ARCHITECTURE.md', 'BULLETIN.md'];
  for (const name of templateFiles) {
    const target = path.join(ctx.teamDir, name);
    if (name === 'BULLETIN.md' || force || !fs.existsSync(target)) {
      atomicWrite(target, renderTemplate(name, vars, `# ${name}\n`));
    }
  }

  if (!fs.existsSync(path.join(ctx.teamDir, 'OWNERSHIP.json')) || force) {
    writeJson(path.join(ctx.teamDir, 'OWNERSHIP.json'), {
      version: 1,
      modules: {},
      protected: DEFAULT_PROTECTED,
      serial: ['.team/**'],
      note: 'modules: 模块名 -> 路径 glob；任务的 write 必须落在某个模块内，或显式 --allow-outside。protected: 只能由集成者/授权任务改。',
    });
  }

  writeJson(path.join(ctx.teamDir, 'config.json'), cfg);
  if (!fs.existsSync(path.join(ctx.teamDir, 'STATUS.md'))) {
    atomicWrite(path.join(ctx.teamDir, 'STATUS.md'), `# 项目状态\n\n- 项目：${project}\n- 基线：${baseBranch}\n- 集成：${integrationBranch}\n- 初始化：${nowIso()}\n`);
  }

  // 复制 CLI 与模板到项目内，保证无技能也能运行
  fs.copyFileSync(__filename, path.join(ctx.teamDir, 'tools', 'team.mjs'));
  ensureDir(path.join(ctx.teamDir, 'tools', 'templates'));
  if (fs.existsSync(TEMPLATE_ROOT)) {
    for (const f of fs.readdirSync(TEMPLATE_ROOT)) {
      const src = path.join(TEMPLATE_ROOT, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(ctx.teamDir, 'tools', 'templates', f));
    }
  }

  // AGENTS.md 受管块
  const agentsPath = path.join(ctx.controlRoot, 'AGENTS.md');
  const block = renderTemplate('AGENTS_BLOCK.md', {
    CLI: 'node .team/tools/team.mjs',
    PROJECT: project,
  }, '');
  if (block) {
    const existing = readText(agentsPath, '');
    const begin = '<!-- project-team:begin -->';
    const end = '<!-- project-team:end -->';
    let next;
    if (existing.includes(begin) && existing.includes(end)) {
      next = existing.replace(new RegExp(`${begin}[\\s\\S]*?${end}`), block.trim());
    } else {
      next = `${existing.trimEnd()}\n\n${block.trim()}\n`;
    }
    atomicWrite(agentsPath, next.trimStart() + '\n');
  }

  // .gitignore
  const giPath = path.join(ctx.controlRoot, '.gitignore');
  const gi = readText(giPath, '');
  if (!/^\.team\/local\/$/m.test(gi)) {
    atomicWrite(giPath, `${gi.trimEnd()}\n\n# project-team 本地状态（租约/会话/证据）\n.team/local/\n`);
  }

  // 集成分支与工作树
  if (!branchExists(ctx, integrationBranch)) {
    git(['branch', integrationBranch, baseBranch], ctx.controlRoot);
  }
  const wtRoot = worktreeRoot(ctx, cfg);
  ensureDir(wtRoot);
  const intWt = path.join(wtRoot, 'integration');
  const registered = worktreeList(ctx).map((w) => w.path);
  if (!registered.includes(normPath(intWt))) {
    if (fs.existsSync(intWt)) {
      throw new TeamError('WORKTREE_DIR_EXISTS', `集成工作树目录已存在但未注册：${intWt}`, 2, '移走该目录后重试');
    }
    git(['worktree', 'add', intWt, integrationBranch], ctx.controlRoot);
  }

  // 本地状态
  if (!fs.existsSync(statePath(ctx)) || force) {
    writeJson(statePath(ctx), {
      version: 1,
      project,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      tasks: {},
      leases: {},
      crs: {},
      arbitrations: {},
      notes: [],
    });
  }

  const st = readState(ctx);
  writeBulletin(ctx, st);
  appendEvent(ctx, { event: 'init', by: 'manager' });

  console.log(`project-team 已初始化：${ctx.teamDir}`);
  console.log(`  基线分支：${baseBranch}   集成分支：${integrationBranch}`);
  console.log(`  集成工作树：${intWt}`);
  console.log(`  门禁命令：${gate || '（未设置）'}`);
  console.log('\n下一步：');
  console.log('  1) 填 .team/CHARTER.md（需求深拆）与 .team/ARCHITECTURE.md（模块/契约/所有权）');
  console.log('  2) 在 .team/OWNERSHIP.json 里登记模块 glob');
  console.log('  3) node .team/tools/team.mjs task add --title "..." --module m-core --write "src/core/**" --verify "node --test"');
  console.log('  4) 提交 .team/ 与 AGENTS.md 后，再 team dispatch');
}

// ---------------------------------------------------------------- task

function cmdTaskAdd(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const cfg = loadConfig(ctx);
  const ownership = readJson(path.join(ctx.teamDir, 'OWNERSHIP.json'), { modules: {}, protected: DEFAULT_PROTECTED });
  const title = must(opts.title, 'title');
  const write = splitList(opts.write);
  const read = splitList(opts.read);
  const deps = splitList(opts.deps || opts.dep);
  const verify = opts.verify ? String(opts.verify) : '';
  const moduleList = splitList(opts.module);
  const module = moduleList.join(',');
  if (!write.length) throw new TeamError('NO_WRITE', '任务必须声明 --write 写集（glob，多个用逗号或分号分隔）');
  if (!verify && !opts['no-verify']) throw new TeamError('NO_VERIFY', '任务必须声明 --verify 验收命令（纯文档任务可用 --no-verify）');
  for (const m of moduleList) {
    if (!ownership.modules?.[m]) throw new TeamError('UNKNOWN_MODULE', `模块 ${m} 未在 OWNERSHIP.json 登记`, 2, '先登记模块 glob，或改用 --allow-outside');
  }
  if (moduleList.length && !opts['allow-outside']) {
    const modGlobs = moduleList.flatMap((m) => ownership.modules[m]);
    const bad = write.filter((g) => !setsOverlap([g], modGlobs));
    if (bad.length) throw new TeamError('OUTSIDE_MODULE', `写集不在模块 ${module} 内：${bad.join(', ')}`, 2, '改 glob 或加 --allow-outside');
  }
  const protectedHits = write.filter((g) => protectedRelevant(g, ownership.protected || []));
  if (protectedHits.length && !opts['allow-protected']) {
    console.log(`注意：写集可能与保护文件相交（${protectedHits.join(', ')}）。submit 会按实际改动文件拒绝；确实要改加 --allow-protected。`);
  }

  const result = mutate(ctx, (st) => {
    const id = opts.id ? String(opts.id) : nextTaskId(st);
    if (!/^T-\d{3,}$/.test(id)) throw new TeamError('BAD_ID', `任务 id 必须是 T-001 形式：${id}`);
    if (st.tasks[id]) throw new TeamError('DUP_TASK', `任务已存在：${id}`);
    for (const d of deps) if (!st.tasks[d]) throw new TeamError('NO_DEP', `依赖任务不存在：${d}`);
    const t = {
      id,
      title,
      module,
      write,
      read,
      deps,
      priority: Number(opts.priority ?? 2),
      verify,
      status: '待认领',
      context: opts.context ? String(opts.context) : '',
      accept: opts.accept ? String(opts.accept) : '',
      allowProtected: opts['allow-protected'] === true,
      crs: opts.cr ? [String(opts.cr)] : [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      evidence: [],
      rework: 0,
    };
    st.tasks[id] = t;
    writeTaskFile(ctx, st, t);
    const overlaps = Object.values(st.tasks)
      .filter((o) => o.id !== id && ACTIVE.has(o.status) && setsOverlap(o.write, t.write))
      .map((o) => o.id);
    appendEvent(ctx, { event: 'task.add', id, by: opts.by || 'manager' });
    return { id, overlaps };
  });

  console.log(`已建任务 ${result.id}：${title}`);
  if (result.overlaps.length) console.log(`注意：写集与活跃任务重叠，不能并行：${result.overlaps.join(', ')}（派单会被拒，除非 --override-overlap）`);
  console.log('下一步：git add .team && git commit -m "chore(team): add task" 后 dispatch');
}

function cmdTaskShow(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const file = path.join(ctx.teamDir, 'TASKS', `${id}.md`);
  if (!fs.existsSync(file)) throw new TeamError('NO_TASK_FILE', `任务书不存在：${file}`);
  console.log(readText(file));
}

function cmdTaskList(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const st = readState(ctx);
  const rows = Object.values(st.tasks).sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => [t.id, t.title, t.module || '—', t.status, t.sessionId ? t.sessionId.slice(-8) : '—', String(t.write.length)]);
  if (opts.json) return jsonOut(Object.values(st.tasks));
  table(['任务', '标题', '模块', '状态', '会话', '写集'], rows);
}

// ---------------------------------------------------------------- dispatch / claim

function sessionBrief(ctx, cfg, task, token) {
  const wt = task.dispatch.worktree;
  const control = ctx.controlRoot;
  return `# 执行会话简报 ${task.id}

- 工作目录（必须是这里）：\`${wt}\`
- 控制面：\`${control}/.team\`
- 任务书：\`${control}/.team/TASKS/${task.id}.md\`
- 协议：\`${control}/.team/PROTOCOL.md\`
- 公告栏：\`${control}/.team/BULLETIN.md\`
- claim token：\`${token}\`
- 分支：\`${task.dispatch.branch}\`（基于 \`${String(task.dispatch.baseSha).slice(0, 7)}\`）

## 开场顺序

> 所有 team 命令都用上面「控制面」的绝对路径；工作树里的 \`.team/tools/team.mjs\` 是基线副本，可能过期。

1. 读协议、任务书、公告栏。
2. 运行：
   \`\`\`
   node ${control}/.team/tools/team.mjs claim ${task.id} --token ${token}
   \`\`\`
3. 只在写集内改；禁止改 \`.team/\`；禁止开子会话；禁止自行扩范围。
4. 完成：
   \`\`\`
   node ${control}/.team/tools/team.mjs submit ${task.id} --token ${token} --test "${task.verify || 'true'}"
   \`\`\`
5. 卡住：\`report ${task.id} --token ${token} --status blocked --note "原因"\` 然后停，等 manager。

## 边界

- 写集：${(task.write || []).join(', ')}
- 依赖：${(task.deps || []).join(', ') || '无'}
- 验收命令：${task.verify || '（未设置）'}
`;
}

function execPrompt(ctx, task, briefPath) {
  return `你是项目执行会话，负责任务 ${task.id}（${task.title}）。
工作目录必须是 ${task.dispatch.worktree}（不要在主检出里改代码）。
第一步：读 ${ctx.controlRoot}/.team/PROTOCOL.md、${ctx.controlRoot}/.team/BULLETIN.md、${ctx.controlRoot}/.team/TASKS/${task.id}.md，以及完整简报 ${briefPath}。
然后按简报执行：claim → 只在写集内改 → submit。
所有 team 命令用简报里的控制面绝对路径，不要用工作树里的 \`.team/tools/team.mjs\`（可能是旧副本）。
不要修改 .team/ 控制面；不要开子会话；不要自行扩大范围；卡住就 report --status blocked 并停，等 manager 裁决。`;
}

function cmdDispatch(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const cfg = loadConfig(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const st0 = readState(ctx);
  const task0 = st0.tasks[id];
  if (!task0) throw new TeamError('NO_TASK', `任务不存在：${id}`);
  if (task0.status !== '待认领') throw new TeamError('BAD_STATUS', `任务 ${id} 当前状态 ${task0.status}，只有 待认领 可以 dispatch`, 2, '驳回/返工直接 claim；已完成/关闭不必再派');

  // 任务书必须已提交，保证工作树里有基线
  const rel = `.team/TASKS/${id}.md`;
  git(['ls-files', '--error-unmatch', '--', rel], ctx.controlRoot);
  if (git(['status', '--porcelain', '--', rel], ctx.controlRoot) !== '') {
    throw new TeamError('TASK_FILE_DIRTY', `任务书未提交：${rel}`, 2, '先 git add .team && git commit');
  }

  const wtRoot = worktreeRoot(ctx, cfg);
  const wt = path.join(wtRoot, id);
  if (fs.existsSync(wt)) throw new TeamError('WORKTREE_EXISTS', `工作树已存在：${wt}`, 2, `先 team clean ${id} --force`);

  const branch = `task/${id}`;
  if (branchExists(ctx, branch) && !opts.reuse) {
    throw new TeamError('BRANCH_EXISTS', `分支已存在：${branch}`, 2, '加 --reuse 复用旧分支，或 clean 后重派');
  }

  const overlaps = Object.values(st0.tasks)
    .filter((o) => o.id !== id && o.dispatched && ACTIVE.has(o.status) && setsOverlap(o.write, task0.write))
    .map((o) => o.id);
  if (overlaps.length && !opts['override-overlap']) {
    throw new TeamError('WRITE_OVERLAP', `写集与活跃任务重叠：${overlaps.join(', ')}。不能并行派单。`, 3,
      '按 依赖→优先级→认领时间 排序；确需并行加 --override-overlap --reason "..."（会留 ARB）');
  }
  if (overlaps.length && !opts.reason) {
    throw new TeamError('NEED_REASON', '--override-overlap 必须同时给 --reason');
  }

  const baseSha = git(['rev-parse', cfg.baseBranch], ctx.controlRoot);
  ensureDir(wtRoot);
  const args = branchExists(ctx, branch)
    ? ['worktree', 'add', wt, branch]
    : ['worktree', 'add', '-b', branch, wt, baseSha];
  git(args, ctx.controlRoot);
  let linked = [];
  try {
    linked = linkWorktreeDirs(ctx, cfg, wt);
  } catch (e) {
    git(['worktree', 'remove', '--force', wt], ctx.controlRoot, { allowFail: true });
    throw e;
  }

  const token = crypto.randomBytes(6).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);

  const result = mutate(ctx, (st) => {
    const t = st.tasks[id];
    t.status = '待认领';
    t.dispatched = true;
    t.tokenHash = tokenHash;
    t.dispatch = { branch, worktree: wt, baseSha, dispatchedAt: nowIso(), links: linked };
    t.updatedAt = nowIso();
    if (overlaps.length) {
      t.allowOverlap = true;
      const arb = createArbitration(ctx, st, {
        task: id,
        issue: `授权并行覆盖写集：${overlaps.join(', ')}；原因：${opts.reason}`,
        by: opts.by || 'manager',
        status: '已裁决',
        decision: '允许并行，合并串行；语义冲突由后到者 rebase/改。',
      });
      t.arb = arb.id;
      t.blockedReason = `与 ${overlaps.join(', ')} 写集重叠（ARB 授权并行）`;
    }
    const brief = sessionBrief(ctx, cfg, { ...t }, token);
    atomicWrite(path.join(ctx.localDir, 'sessions', `${id}.md`), brief);
    writeJson(path.join(ctx.localDir, 'sessions', `${id}.json`), {
      taskId: id, worktree: wt, branch, token, briefPath: path.join(ctx.localDir, 'sessions', `${id}.md`), createdAt: nowIso(),
    });
    appendEvent(ctx, { event: 'task.dispatch', id, by: opts.by || 'manager', branch, worktree: wt });
    return { briefPath: path.join(ctx.localDir, 'sessions', `${id}.md`), prompt: execPrompt(ctx, { ...t, dispatch: { worktree: wt } }, path.join(ctx.localDir, 'sessions', `${id}.md`)) };
  });

  console.log(`已派单 ${id}`);
  console.log(`  工作树：${wt}`);
  console.log(`  分支：${branch}`);
  if (linked.length) console.log(`  链接：${linked.join(', ')}`);
  console.log(`  简报：${result.briefPath}`);
  if (overlaps.length) console.log(`  ⚠ 覆盖写集并行：${overlaps.join(', ')}（已记 ARB）`);
  console.log('\n--- 可直接作为 subagent prompt ---');
  console.log(result.prompt);
  console.log('--- 结束 ---');
  console.log(`\n派完子会话后：node .team/tools/team.mjs link ${id} --session <会话id>`);
}

function cmdLink(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const session = must(opts.session, 'session');
  mutate(ctx, (st) => {
    const t = st.tasks[id];
    if (!t) throw new TeamError('NO_TASK', `任务不存在：${id}`);
    t.sessionId = session;
    t.updatedAt = nowIso();
    appendEvent(ctx, { event: 'task.link', id, session });
  });
  console.log(`已记录 ${id} → ${session}`);
}

function taskLease(st, id) {
  return Object.values(st.leases).find((l) => l.taskId === id) || null;
}

function claimCheckCwd(task, opts) {
  if (opts.manager || opts['any-cwd']) return false;
  let top;
  try { top = git(['rev-parse', '--show-toplevel'], process.cwd()); } catch { top = ''; }
  if (!top) throw new TeamError('NOT_IN_WORKTREE', '当前目录不是 git 工作树；claim 必须在任务工作树内运行', 3, 'cd 到任务工作树，或 manager 用 --manager');
  if (!samePath(top, task.dispatch.worktree)) {
    throw new TeamError('WRONG_CWD', `当前目录 ${top} 不是任务工作树 ${task.dispatch.worktree}`, 3,
      'cd 到任务工作树再 claim；防止在主检出里并行改代码');
  }
  return true;
}

function cmdClaim(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const cfg = loadConfig(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const st0 = readState(ctx);
  const task0 = st0.tasks[id];
  if (!task0) throw new TeamError('NO_TASK', `任务不存在：${id}`);
  if (!task0.dispatched) throw new TeamError('NOT_DISPATCHED', `任务 ${id} 还没 dispatch（没有工作树）`, 2, `先 team dispatch ${id}`);
  if (!['待认领', '驳回', '阻塞', '进行中'].includes(task0.status)) {
    throw new TeamError('BAD_STATUS', `任务 ${id} 当前 ${task0.status}，不能 claim`);
  }
  claimCheckCwd(task0, opts);

  let owner;
  if (opts.manager) {
    owner = `manager:${opts.by || 'manager'}`;
  } else {
    const token = must(opts.token, 'token');
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
    if (hash !== task0.tokenHash) throw new TeamError('BAD_TOKEN', 'claim token 不匹配', 3, '用简报里的 token；丢失让 manager 重发 handoff');
    owner = `tk:${hash.slice(0, 8)}`;
  }

  const ttl = Number(opts['ttl-ms'] || cfg.leaseTtlMs || DEFAULT_TTL);
  const result = mutate(ctx, (st) => {
    const t = st.tasks[id];
    const existing = taskLease(st, id);
    if (existing && existing.owner !== owner && !opts.takeover && !opts.manager) {
      throw new TeamError('LEASED', `任务 ${id} 已有租约：${existing.owner}，到期 ${shortTime(new Date(existing.expiresAt).toISOString())}`, 3,
        '等对方 release/过期，或由 manager --takeover');
    }
    // 跨任务写集冲突（被 ARB 授权并行的任务除外）
    if (!t.allowOverlap) {
      for (const [lid, lease] of Object.entries(st.leases)) {
        if (lease.taskId === id) continue;
        if (setsOverlap(lease.paths, t.write)) {
          throw new TeamError('LEASE_OVERLAP', `写集与 ${lease.taskId} 的租约重叠：${lid}`, 3,
            `先让 ${lease.taskId} release，或由 manager 仲裁后 --override`);
        }
      }
    }
    if (existing) delete st.leases[existing.id];
    const leaseId = `L-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    st.leases[leaseId] = {
      id: leaseId, taskId: id, owner, paths: t.write, createdAt: nowIso(), expiresAt: Date.now() + ttl,
      reason: opts.reason ? String(opts.reason) : 'claim',
    };
    t.status = '进行中';
    t.claim = { owner, at: nowIso(), leaseId, expiresAt: Date.now() + ttl };
    t.updatedAt = nowIso();
    t.blockedReason = '';
    appendEvent(ctx, { event: 'task.claim', id, owner, leaseId });
    return { leaseId, expiresAt: Date.now() + ttl };
  });

  console.log(`已认领 ${id}（owner ${owner}）`);
  console.log(`  租约：${result.leaseId}  到期：${shortTime(new Date(result.expiresAt).toISOString())}`);
  console.log(`  renew: team.mjs renew ${id} --token <token>`);
}

function cmdRenew(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const cfg = loadConfig(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const ttl = Number(opts['ttl-ms'] || cfg.leaseTtlMs || DEFAULT_TTL);
  const result = mutate(ctx, (st) => {
    const t = st.tasks[id];
    if (!t) throw new TeamError('NO_TASK', `任务不存在：${id}`);
    const lease = taskLease(st, id);
    if (!lease) throw new TeamError('NO_LEASE', `任务 ${id} 没有租约`, 3);
    if (!opts.manager) {
      const token = must(opts.token, 'token');
      const hash = crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
      if (hash !== t.tokenHash) throw new TeamError('BAD_TOKEN', 'token 不匹配', 3);
    }
    lease.expiresAt = Date.now() + ttl;
    t.claim.expiresAt = lease.expiresAt;
    t.updatedAt = nowIso();
    return lease.expiresAt;
  });
  console.log(`已续租 ${id} 到 ${shortTime(new Date(result).toISOString())}`);
}

function cmdRelease(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.id || opts._[0], 'id');
  mutate(ctx, (st) => {
    const t = st.tasks[id];
    if (!t) throw new TeamError('NO_TASK', `任务不存在：${id}`);
    if (!opts.manager) {
      const token = must(opts.token, 'token');
      const hash = crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
      if (hash !== t.tokenHash) throw new TeamError('BAD_TOKEN', 'token 不匹配', 3);
    }
    for (const [lid, l] of Object.entries(st.leases)) if (l.taskId === id) delete st.leases[lid];
    delete t.claim;
    t.updatedAt = nowIso();
    appendEvent(ctx, { event: 'task.release', id });
  });
  console.log(`已释放 ${id} 的租约`);
}

// ---------------------------------------------------------------- report / submit

function cmdReport(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const status = String(opts.status || 'working');
  const map = { working: '进行中', blocked: '阻塞', arbitration: '待仲裁', human: '等人', done: '待验收' };
  const target = map[status] || status;
  const note = opts.note ? String(opts.note) : '';
  mutate(ctx, (st) => {
    const t = st.tasks[id];
    if (!t) throw new TeamError('NO_TASK', `任务不存在：${id}`);
    if (!opts.manager && t.tokenHash) {
      const token = must(opts.token, 'token');
      const hash = crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
      if (hash !== t.tokenHash) throw new TeamError('BAD_TOKEN', 'token 不匹配', 3);
    }
    if (target === '阻塞' || target === '等人') {
      t.status = target;
      t.blockedReason = note || (target === '等人' ? '等用户决策' : '执行者报告阻塞');
    } else if (target === '待仲裁') {
      t.status = '待仲裁';
      const arb = createArbitration(ctx, st, { task: id, issue: note || '执行者请求仲裁', by: opts.by || 'executor' });
      t.arb = arb.id;
      t.blockedReason = `待仲裁：${arb.id}`;
    } else if (target === '进行中') {
      t.status = '进行中';
      t.blockedReason = '';
    } else if (target === '待验收') {
      t.status = '待验收';
    }
    t.updatedAt = nowIso();
    if (note) st.notes.push({ at: nowIso(), by: opts.by || 'executor', text: `${id} ${target}：${note}` });
    appendEvent(ctx, { event: 'task.report', id, status: target, note });
  });
  console.log(`已记录 ${id} → ${target}${note ? `（${note}）` : ''}`);
}

function allChangedFiles(ctx, task, cfg) {
  const wt = task.dispatch.worktree;
  // 普通情况以 dispatch 基线为准；若已 rebase/merge 到集成分支（集成是 HEAD 祖先），
  // 则以集成分支为基线，避免把集成里别人的文件算成自己的改动。
  let base = task.dispatch.baseSha;
  const intTip = git(['rev-parse', cfg.integrationBranch], wt, { allowFail: true });
  if (intTip) {
    const branchHasInt = runCapture('git', ['merge-base', '--is-ancestor', intTip, 'HEAD'], wt).status === 0;
    const baseHasInt = runCapture('git', ['merge-base', '--is-ancestor', intTip, task.dispatch.baseSha], wt).status === 0;
    if (branchHasInt && !baseHasInt) base = intTip;
  }
  const head = git(['rev-parse', 'HEAD'], wt);
  const names = git(['diff', '--name-only', base, head], wt).split('\n').map((s) => s.trim()).filter(Boolean);
  const status = git(['status', '--porcelain'], wt);
  return { head, names, status, base, dirty: status !== '' };
}

function cmdSubmit(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const cfg = loadConfig(ctx);
  const ownership = readJson(path.join(ctx.teamDir, 'OWNERSHIP.json'), { protected: DEFAULT_PROTECTED });
  const id = must(opts.id || opts._[0], 'id');
  const st0 = readState(ctx);
  const task = st0.tasks[id];
  if (!task) throw new TeamError('NO_TASK', `任务不存在：${id}`);
  if (task.status !== '进行中') throw new TeamError('BAD_STATUS', `任务 ${id} 当前 ${task.status}，只有 进行中 可以 submit`);
  if (!task.dispatch?.worktree) throw new TeamError('NO_WORKTREE', `任务 ${id} 没有工作树`);
  if (!opts.manager) {
    const token = must(opts.token, 'token');
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
    if (hash !== task.tokenHash) throw new TeamError('BAD_TOKEN', 'submit token 不匹配', 3);
    const top = git(['rev-parse', '--show-toplevel'], process.cwd(), { allowFail: true });
    if (top && !samePath(top, task.dispatch.worktree)) {
      throw new TeamError('WRONG_CWD', `submit 应在任务工作树运行：${task.dispatch.worktree}`, 3);
    }
  }
  const info = allChangedFiles(ctx, task, cfg);
  if (info.dirty) {
    throw new TeamError('DIRTY_TREE', `任务工作树有未提交改动，先提交：\n${info.status}`, 3, '工作树必须干净，submit 只认已提交的 HEAD');
  }
  if (!info.names.length && !opts['allow-empty']) {
    throw new TeamError('EMPTY_DIFF', '分支相对基线没有任何文件变化（先提交，或加 --allow-empty）', 3);
  }
  const outside = info.names.filter((f) => !matchAny(f, task.write));
  if (outside.length) {
    throw new TeamError('WRITE_VIOLATION', `以下文件不在写集内：\n  ${outside.join('\n  ')}`, 3,
      '回到写集内；确需扩写集让 manager 改任务并留 ARB，执行者不得自行扩');
  }
  const teamTouched = info.names.filter((f) => isTeamPath(f));
  if (teamTouched.length) {
    throw new TeamError('CONTROL_PLANE_WRITE', `任务分支修改了控制面：${teamTouched.join(', ')}`, 3, '撤掉 .team/ 改动，控制面只由 manager 在基线提交');
  }
  const protectedHits = info.names.filter((f) => matchAny(f, ownership.protected || []));
  if (protectedHits.length && !opts['allow-protected']) {
    throw new TeamError('PROTECTED_WRITE', `任务改了保护文件：${protectedHits.join(', ')}`, 3, '保护文件归集成者；确需改加 --allow-protected --reason 并留 ARB');
  }
  if (protectedHits.length && !opts.reason) throw new TeamError('NEED_REASON', '--allow-protected 必须给 --reason');

  const gateCmd = opts.test ? String(opts.test) : (task.verify || '');
  let gate = { status: 0, skipped: true, logFile: '' };
  if (gateCmd && !opts['skip-gate']) {
    const logFile = path.join(ctx.localDir, 'evidence', `${id}-submit-${Date.now()}.log`);
    console.log(`运行门禁：${gateCmd}`);
    gate = { ...runShellToLog(gateCmd, task.dispatch.worktree, logFile), skipped: false };
  }
  if (!gateCmd && !opts['skip-gate']) {
    throw new TeamError('NO_VERIFY', `任务 ${id} 没设置验收命令，submit 需 --test 或 --skip-gate --reason`);
  }
  if (opts['skip-gate'] && !opts.reason) {
    throw new TeamError('NEED_REASON', '--skip-gate 必须给 --reason，并写进证据');
  }
  const gateOk = gate.skipped || gate.status === 0;

  const evidence = {
    at: nowIso(),
    head: info.head,
    base: info.base,
    files: info.names,
    command: gateCmd || '(skipped)',
    exit: gate.skipped ? 0 : gate.status,
    skipped: gate.skipped,
    log: gate.logFile || '',
    needsHuman: opts['needs-human'] === true,
    by: opts.manager ? 'manager' : 'executor',
  };

  const result = mutate(ctx, (st) => {
    const t = st.tasks[id];
    if (t.status !== '进行中') throw new TeamError('BAD_STATUS', `任务状态已变：${t.status}`);
    t.evidence.push(evidence);
    t.needsHuman = evidence.needsHuman || t.needsHuman === true;
    t.updatedAt = nowIso();
    if (gateOk) {
      t.status = '待验收';
      t.blockedReason = '';
    } else {
      t.blockedReason = `门禁失败（exit ${gate.status}），见 ${path.basename(gate.logFile)}`;
    }
    if (protectedHits.length) {
      createArbitration(ctx, st, {
        task: id, issue: `授权修改保护文件：${protectedHits.join(', ')}；原因：${opts.reason}`,
        by: opts.by || 'manager', status: '已裁决', decision: '允许本次修改，集成时复核。',
      });
    }
    appendEvent(ctx, { event: 'task.submit', id, exit: evidence.exit, files: info.names.length });
    return { status: t.status };
  });

  if (!gateOk) {
    throw new TeamError('GATE_FAILED', `门禁失败（exit ${gate.status}），日志：${gate.logFile}`, 4, '修好再 submit；不要改验收命令来绕过');
  }
  console.log(`已提交验收 ${id}：${info.names.length} 文件，HEAD ${info.head.slice(0, 7)}`);
  if (evidence.needsHuman) console.log('  标记 needsHuman：accept 时必须 --human-ok');
  console.log(`下一步：manager 运行 team.mjs integrate ${id}`);
}

// ---------------------------------------------------------------- integrate / accept

function nextArbId(st) {
  let max = 0;
  for (const id of Object.keys(st.arbitrations)) {
    const m = /^ARB-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `ARB-${String(max + 1).padStart(3, '0')}`;
}

function createArbitration(ctx, st, { task, issue, by, status = '开启', decision = '' }) {
  const id = nextArbId(st);
  const file = path.join(ctx.teamDir, 'ARBITRATIONS', `${id}.md`);
  const vars = {
    ID: id,
    TASK: task || '—',
    ISSUE: issue,
    BY: by || 'manager',
    DATE: nowIso(),
    STATUS: status,
    DECISION: decision || '（未决定）',
  };
  atomicWrite(file, renderTemplate('ARBITRATION.md', vars,
    `# ${id} 仲裁记录\n\n- 任务：${task}\n- 触发：${issue}\n- 提起：${by}\n- 时间：${nowIso()}\n- 状态：${status}\n\n## 决定\n\n${decision || '（未决定）'}\n`));
  st.arbitrations[id] = { id, task, issue, by, status, decision, file: `.team/ARBITRATIONS/${id}.md`, createdAt: nowIso() };
  appendEvent(ctx, { event: 'arb.create', id, task, issue });
  return { id };
}

function ensureIntegrationWorktree(ctx, cfg) {
  const wt = integrationWorktree(ctx, cfg);
  const registered = worktreeList(ctx).some((w) => samePath(w.path, wt));
  if (!registered) {
    if (!branchExists(ctx, cfg.integrationBranch)) {
      throw new TeamError('NO_INTEGRATION_BRANCH', `集成分支不存在：${cfg.integrationBranch}`, 2, 'team init --tools-only 或手动建分支');
    }
    if (fs.existsSync(wt)) throw new TeamError('WORKTREE_DIR_EXISTS', `集成工作树目录已存在但未注册：${wt}`);
    ensureDir(path.dirname(wt));
    git(['worktree', 'add', wt, cfg.integrationBranch], ctx.controlRoot);
  }
  return wt;
}

function cmdIntegrate(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const cfg = loadConfig(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const st0 = readState(ctx);
  const t0 = st0.tasks[id];
  if (!t0) throw new TeamError('NO_TASK', `任务不存在：${id}`);
  if (t0.status !== '待验收') throw new TeamError('BAD_STATUS', `任务 ${id} 当前 ${t0.status}，只有 待验收 可以 integrate`);
  if (!t0.dispatch?.branch) throw new TeamError('NO_BRANCH', `任务 ${id} 没有分支`);

  const intWt = ensureIntegrationWorktree(ctx, cfg);
  if (!isClean(intWt)) throw new TeamError('INTEGRATION_DIRTY', `集成工作树有未提交改动：${intWt}`, 3, '先处理集成工作树，避免把别人的改动混进合并');

  const merge = runCapture('git', ['merge', '--no-commit', '--no-ff', t0.dispatch.branch], intWt);
  if (merge.status !== 0) {
    const conflicts = git(['diff', '--name-only', '--diff-filter=U'], intWt, { allowFail: true }).split('\n').filter(Boolean);
    git(['merge', '--abort'], intWt, { allowFail: true });
    const arb = mutate(ctx, (st) => {
      const t = st.tasks[id];
      t.status = '待仲裁';
      const a = createArbitration(ctx, st, {
        task: id,
        issue: `集成冲突：${conflicts.join(', ') || '未知冲突'}（已 abort，集成工作树干净）`,
        by: 'integrator',
      });
      t.arb = a.id;
      t.blockedReason = `集成冲突：${conflicts.join(', ') || '见 ARB'}`;
      t.updatedAt = nowIso();
      appendEvent(ctx, { event: 'integrate.conflict', id, conflicts });
      return a;
    });
    throw new TeamError('MERGE_CONFLICT', `合并冲突，已 abort。仲裁记录：${arb.id}`, 4,
      `读 .team/ARBITRATIONS/${arb.id}.md；裁决后让后到者 rebase 再 integrate`);
  }

  const gateCmd = opts.gate ? String(opts.gate) : (cfg.gateCommand || '');
  let gate = { status: 0, skipped: true, logFile: '' };
  if (gateCmd) {
    const logFile = path.join(ctx.localDir, 'evidence', `${id}-integrate-${Date.now()}.log`);
    console.log(`集成分支门禁：${gateCmd}`);
    gate = { ...runShellToLog(gateCmd, intWt, logFile), skipped: false };
  }
  if (!gate.skipped && gate.status !== 0) {
    git(['merge', '--abort'], intWt, { allowFail: true });
    mutate(ctx, (st) => {
      const t = st.tasks[id];
      t.status = '待验收';
      t.blockedReason = `集成门禁失败（exit ${gate.status}），见 ${path.basename(gate.logFile)}`;
      t.updatedAt = nowIso();
      appendEvent(ctx, { event: 'integrate.gatefail', id, exit: gate.status });
    });
    throw new TeamError('INTEGRATION_GATE_FAILED', `集成门禁失败（exit ${gate.status}），已 abort。日志：${gate.logFile}`, 4);
  }

  try {
    git(['commit', '-m', `merge(task): ${id} ${t0.title}`], intWt);
  } catch (e) {
    git(['merge', '--abort'], intWt, { allowFail: true });
    throw new TeamError('MERGE_COMMIT_FAILED', `合并提交失败，已尝试 abort：${e.message}`, 4);
  }
  const mergeSha = git(['rev-parse', 'HEAD'], intWt);
  mutate(ctx, (st) => {
    const t = st.tasks[id];
    t.status = '已集成';
    t.integration = { at: nowIso(), mergeSha, gateExit: gate.skipped ? 0 : gate.status, log: gate.logFile || '' };
    t.updatedAt = nowIso();
    for (const [lid, l] of Object.entries(st.leases)) if (l.taskId === id) delete st.leases[lid];
    delete t.claim;
    appendEvent(ctx, { event: 'integrate.ok', id, mergeSha });
  });
  console.log(`已集成 ${id} → ${cfg.integrationBranch} @ ${mergeSha.slice(0, 7)}${gate.skipped ? '（未跑门禁）' : ''}`);
  console.log(`下一步：team.mjs accept ${id}${t0.needsHuman ? ' --human-ok' : ''}`);
}

function cmdAccept(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const st0 = readState(ctx);
  const t0 = st0.tasks[id];
  if (!t0) throw new TeamError('NO_TASK', `任务不存在：${id}`);
  if (t0.status !== '已集成') throw new TeamError('BAD_STATUS', `任务 ${id} 当前 ${t0.status}，只有 已集成 可以 accept`);
  if (t0.needsHuman && !opts['human-ok']) {
    throw new TeamError('NEEDS_HUMAN', `任务 ${id} 标记 needsHuman；必须人工确认后加 --human-ok`, 3);
  }
  mutate(ctx, (st) => {
    const t = st.tasks[id];
    t.status = '已完成';
    t.acceptedAt = nowIso();
    t.acceptedBy = opts.by || 'manager';
    t.blockedReason = '';
    for (const [lid, l] of Object.entries(st.leases)) if (l.taskId === id) delete st.leases[lid];
    appendEvent(ctx, { event: 'task.accept', id, by: opts.by || 'manager' });
  });
  console.log(`已验收 ${id}`);
}

function cmdReject(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const reason = must(opts.reason, 'reason');
  mutate(ctx, (st) => {
    const t = st.tasks[id];
    if (!t) throw new TeamError('NO_TASK', `任务不存在：${id}`);
    if (!['待验收', '已集成'].includes(t.status)) throw new TeamError('BAD_STATUS', `任务 ${id} 当前 ${t.status}，不能驳回`);
    t.status = '进行中';
    t.rework = (t.rework || 0) + 1;
    t.blockedReason = `驳回：${reason}`;
    t.updatedAt = nowIso();
    st.notes.push({ at: nowIso(), by: opts.by || 'manager', text: `${id} 驳回：${reason}` });
    appendEvent(ctx, { event: 'task.reject', id, reason });
  });
  console.log(`已驳回 ${id}：${reason}`);
  console.log(`用 send_message 让同一个执行会话返工，或 team.mjs handoff ${id}`);
}

function cmdClose(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const reason = must(opts.reason, 'reason');
  mutate(ctx, (st) => {
    const t = st.tasks[id];
    if (!t) throw new TeamError('NO_TASK', `任务不存在：${id}`);
    t.status = '关闭';
    t.closeReason = reason;
    t.closedAt = nowIso();
    for (const [lid, l] of Object.entries(st.leases)) if (l.taskId === id) delete st.leases[lid];
    delete t.claim;
    appendEvent(ctx, { event: 'task.close', id, reason });
  });
  console.log(`已关闭 ${id}：${reason}`);
}

function cmdReopen(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const reason = must(opts.reason, 'reason');
  mutate(ctx, (st) => {
    const t = st.tasks[id];
    if (!t) throw new TeamError('NO_TASK', `任务不存在：${id}`);
    const wt = t.dispatch?.worktree;
    const hasWt = Boolean(wt && fs.existsSync(wt));
    t.status = hasWt ? '进行中' : '待认领';
    if (!hasWt) t.dispatched = false;
    t.rework = (t.rework || 0) + 1;
    t.blockedReason = `重开：${reason}`;
    t.updatedAt = nowIso();
    st.notes.push({ at: nowIso(), by: opts.by || 'manager', text: `${id} 重开：${reason}` });
    appendEvent(ctx, { event: 'task.reopen', id, reason });
    return { hasWt };
  });
  const st = readState(ctx);
  const t = st.tasks[id];
  console.log(`已重开 ${id}：${reason}`);
  if (!t.dispatch?.worktree || !fs.existsSync(t.dispatch.worktree)) {
    console.log(`工作树不在，重新派单：team.mjs dispatch ${id}`);
  } else {
    console.log(`用同一 token claim ${id}，或 send_message 让原子会话返工。`);
  }
}

function cmdClean(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const st = readState(ctx);
  const t = st.tasks[id];
  if (!t) throw new TeamError('NO_TASK', `任务不存在：${id}`);
  if (!opts.force && !['已完成', '关闭'].includes(t.status)) {
    throw new TeamError('NOT_CLOSED', `任务 ${id} 状态 ${t.status}，未完成/关闭；确要清理加 --force`, 3);
  }
  const wt = t.dispatch?.worktree;
  const cfg = loadConfig(ctx);
  if (wt && fs.existsSync(wt)) {
    unlinkWorktreeDirs(ctx, cfg, wt);
    git(['worktree', 'remove', '--force', wt], ctx.controlRoot, { allowFail: true });
    if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
  }
  fs.rmSync(path.join(ctx.localDir, 'sessions', `${id}.md`), { force: true });
  fs.rmSync(path.join(ctx.localDir, 'sessions', `${id}.json`), { force: true });
  if (opts['delete-branch'] && t.dispatch?.branch) {
    git(['branch', '-D', t.dispatch.branch], ctx.controlRoot, { allowFail: true });
  }
  console.log(`已清理 ${id} 的工作树${opts['delete-branch'] ? ' 和分支' : ''}`);
}

// ---------------------------------------------------------------- bulletin / note

function cmdBulletin(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const file = path.join(ctx.teamDir, 'BULLETIN.md');
  if (opts.json) {
    const st = readState(ctx);
    const safe = JSON.parse(JSON.stringify(st));
    for (const t of Object.values(safe.tasks)) delete t.tokenHash;
    return jsonOut({ file, tasks: safe.tasks, leases: safe.leases, notes: safe.notes });
  }
  console.log(readText(file));
}

function cmdNote(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const text = opts.text ? String(opts.text) : opts._.join(' ');
  if (!text) throw new TeamError('NO_TEXT', '缺少公告内容：--text "..."');
  mutate(ctx, (st) => {
    st.notes.push({ at: nowIso(), by: opts.by ? String(opts.by) : 'manager', text });
    appendEvent(ctx, { event: 'note', by: opts.by || 'manager', text });
  });
  console.log('已写入公告栏');
}

// ---------------------------------------------------------------- status / doctor

function cmdStatus(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const st = readState(ctx);
  const tasks = Object.values(st.tasks).sort((a, b) => a.id.localeCompare(b.id));
  if (opts.json) {
    const safe = JSON.parse(JSON.stringify(st));
    for (const t of Object.values(safe.tasks)) delete t.tokenHash;
    return jsonOut(safe);
  }
  const counts = {};
  for (const s of STATUSES) counts[s] = tasks.filter((t) => t.status === s).length;
  console.log(`项目：${st.project}   基线：${loadConfig(ctx).baseBranch}   更新时间：${shortTime(st.updatedAt)}`);
  console.log('状态：' + STATUSES.filter((s) => counts[s]).map((s) => `${s} ${counts[s]}`).join(' · '));
  console.log('');
  table(['任务', '标题', '模块', '状态', '会话', '租约', '下一步'], tasks.map((t) => {
    const lease = Object.values(st.leases).find((l) => l.taskId === t.id);
    return [t.id, t.title, t.module || '—', t.status, t.sessionId ? t.sessionId.slice(-8) : '—',
      lease ? `${lease.owner} ${shortTime(new Date(lease.expiresAt).toISOString())}` : '—', nextCell(t)];
  }));
  const overlaps = [];
  const active = tasks.filter((t) => t.dispatched && ACTIVE.has(t.status));
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      if (setsOverlap(active[i].write, active[j].write)) overlaps.push(`${active[i].id} ↔ ${active[j].id}`);
    }
  }
  if (overlaps.length) console.log(`\n⚠ 活跃任务写集重叠：${overlaps.join(', ')}（并行前需仲裁/覆盖授权）`);
  if (st.notes?.length) console.log(`\n最近公告：${st.notes[st.notes.length - 1].text}`);
}

function cmdDoctor(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const cfg = loadConfig(ctx);
  const st = readState(ctx);
  const issues = [];
  const add = (level, code, message, hint = '') => issues.push({ level, code, message, hint });

  if (!fs.existsSync(path.join(ctx.teamDir, 'PROTOCOL.md'))) add('error', 'NO_PROTOCOL', '缺少 .team/PROTOCOL.md');
  if (!fs.existsSync(path.join(ctx.teamDir, 'BULLETIN.md'))) add('error', 'NO_BULLETIN', '缺少 .team/BULLETIN.md');
  const agents = readText(path.join(ctx.controlRoot, 'AGENTS.md'), '');
  if (!agents.includes('project-team:begin')) add('warn', 'NO_AGENTS_BLOCK', 'AGENTS.md 没有 project-team 受管块', '重跑 init --tools-only 或手工补');

  const ownership = readJson(path.join(ctx.teamDir, 'OWNERSHIP.json'), { modules: {}, protected: [] });
  for (const rel of cfg.linkDirs || []) {
    if (!fs.existsSync(path.join(ctx.controlRoot, rel))) add('warn', 'LINK_TARGET_MISSING', `依赖链接目标不存在：${path.join(ctx.controlRoot, rel)}`);
  }
  for (const t of Object.values(st.tasks)) {
    const file = path.join(ctx.teamDir, 'TASKS', `${t.id}.md`);
    if (!fs.existsSync(file)) add('error', 'NO_TASK_FILE', `${t.id} 缺任务书 ${file}`);
    for (const d of t.deps || []) if (!st.tasks[d]) add('error', 'NO_DEP', `${t.id} 依赖不存在的 ${d}`);
    if (t.dispatch) {
      if (!fs.existsSync(t.dispatch.worktree)) add('error', 'NO_WORKTREE', `${t.id} 工作树不存在：${t.dispatch.worktree}`);
      else {
        const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], t.dispatch.worktree, { allowFail: true });
        if (branch && branch !== t.dispatch.branch) add('warn', 'BRANCH_DRIFT', `${t.id} 工作树分支 ${branch} ≠ ${t.dispatch.branch}`);
        if (!isClean(t.dispatch.worktree)) add('warn', 'DIRTY_WORKTREE', `${t.id} 工作树有未提交改动`);
        for (const rel of cfg.linkDirs || []) {
          const target = path.join(ctx.controlRoot, rel);
          const dest = path.join(t.dispatch.worktree, rel);
          if (!fs.existsSync(target)) continue;
          if (!fs.existsSync(dest)) add('warn', 'LINK_MISSING', `${t.id} 缺少依赖链接 ${rel}`, `重跑一次 dispatch 或手工建 junction`);
          else {
            try { if (!fs.lstatSync(dest).isSymbolicLink()) add('warn', 'LINK_NOT_LINK', `${t.id} 的 ${rel} 不是链接（可能是独立安装）`); } catch { /* ignore */ }
          }
        }
      }
    }
    const hits = (t.write || []).filter((g) => protectedRelevant(g, ownership.protected || []));
    if (hits.length && !t.allowProtected) add('warn', 'PROTECTED_IN_WRITE', `${t.id} 写集含保护文件：${hits.join(', ')}`);
    if (t.status === '进行中' && !taskLease(st, t.id)) add('warn', 'NO_LEASE', `${t.id} 进行中但没有租约（可能已过期）`);
  }

  const active = Object.values(st.tasks).filter((t) => t.dispatched && ACTIVE.has(t.status));
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      if (setsOverlap(active[i].write, active[j].write)) {
        add('warn', 'WRITE_OVERLAP', `${active[i].id} ↔ ${active[j].id} 写集重叠且都在活跃状态`);
      }
    }
  }
  for (const [lid, l] of Object.entries(st.leases)) {
    if (l.expiresAt <= Date.now()) add('warn', 'EXPIRED_LEASE', `租约过期：${lid}（${l.taskId}）`);
  }

  // 孤儿工作树
  const wtRoot = worktreeRoot(ctx, cfg);
  const known = new Set(Object.values(st.tasks).filter((t) => t.dispatch?.worktree).map((t) => normPath(t.dispatch.worktree).toLowerCase()));
  const allWt = worktreeList(ctx);
  for (const w of allWt) {
    if (!normPath(w.path).toLowerCase().startsWith(normPath(wtRoot).toLowerCase())) continue;
    if (!known.has(normPath(w.path).toLowerCase()) && !samePath(w.path, integrationWorktree(ctx, cfg))) {
      add('warn', 'ORPHAN_WORKTREE', `未登记的工作树：${w.path}`, '确认后可 git worktree remove');
    }
  }
  const intWt = integrationWorktree(ctx, cfg);
  if (!allWt.some((w) => samePath(w.path, intWt))) add('error', 'NO_INTEGRATION_WT', `集成工作树不存在：${intWt}`, 'team init --tools-only');
  else if (!isClean(intWt)) add('warn', 'INTEGRATION_DIRTY', '集成工作树有未提交改动');
  else {
    const behind = git(['rev-list', '--count', `${cfg.integrationBranch}..${cfg.baseBranch}`], intWt, { allowFail: true });
    if (behind && Number(behind) > 0) add('warn', 'INTEGRATION_BEHIND', `集成分支落后基线 ${behind} 个提交`, '在集成工作树合基线，或让 manager 同步');
  }

  // 公告栏缺行
  const bulletin = readText(path.join(ctx.teamDir, 'BULLETIN.md'));
  for (const t of Object.values(st.tasks)) if (!bulletin.includes(t.id)) add('warn', 'BULLETIN_MISSING', `公告栏缺 ${t.id}`);

  if (opts.fix) {
    mutate(ctx, (state) => {
      pruneLeases(state);
      appendEvent(ctx, { event: 'doctor.fix' });
    });
    console.log('已修复：清理过期租约、重渲染公告栏');
  }

  if (opts.json) return jsonOut({ ok: !issues.some((i) => i.level === 'error'), issues });
  if (!issues.length) {
    console.log('doctor：没有问题');
    return;
  }
  table(['级别', '代码', '问题'], issues.map((i) => [i.level, i.code, i.message]));
  for (const i of issues.filter((x) => x.hint)) console.log(`  ${i.code}: ${i.hint}`);
  if (issues.some((i) => i.level === 'error')) process.exitCode = 1;
}

// ---------------------------------------------------------------- CR

function crId(st) {
  let max = 0;
  for (const id of Object.keys(st.crs)) {
    const m = /^CR-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `CR-${String(max + 1).padStart(3, '0')}`;
}

function writeCrFile(ctx, cr) {
  const lines = [
    `# ${cr.id} ${cr.title}`, '',
    `- 状态：${cr.status}`, `- 级别：${cr.mode || cr.classification || '待定'}`, `- 提出：${cr.by || 'manager'}`, `- 时间：${cr.createdAt}`,
    '', '## 需求', '', cr.need || '（待补）', '',
    '## 触碰路径', '', (cr.touches || []).map((x) => `- \`${x}\``).join('\n') || '（未声明）', '',
    '## 影响分析', '', cr.impact || '（未分析）', '',
    '## 决定', '', cr.decision || '（未决定）', '',
  ];
  atomicWrite(path.join(ctx.teamDir, 'CHANGES', `${cr.id}.md`), lines.join('\n'));
}

function cmdCrNew(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const title = must(opts.title, 'title');
  const need = opts.need ? String(opts.need) : opts._.join(' ');
  const touches = splitList(opts.touches);
  const result = mutate(ctx, (st) => {
    const id = crId(st);
    const cr = {
      id, title, need, touches, status: '草案', mode: opts.mode || '', by: opts.by || 'manager',
      createdAt: nowIso(), affected: [],
    };
    st.crs[id] = cr;
    writeCrFile(ctx, cr);
    appendEvent(ctx, { event: 'cr.new', id });
    return { id };
  });
  console.log(`已建变更请求 ${result.id}`);
  console.log(`下一步：team.mjs cr impact ${result.id}`);
}

function computeImpact(st, cr) {
  const touches = cr.touches || [];
  const affected = new Set();
  const reasons = {};
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of Object.values(st.tasks)) {
      if (affected.has(t.id) || t.status === '关闭') continue;
      const hitGlobs = touches.length > 0 && setsOverlap(t.write, touches);
      const hitModule = String(t.module || '').split(',').filter(Boolean).some((m) => touches.includes(m));
      const hitDep = (t.deps || []).some((d) => affected.has(d));
      if (hitGlobs || hitModule || hitDep) {
        affected.add(t.id);
        reasons[t.id] = hitModule ? '模块被改' : hitDep ? '依赖受影响任务' : '写集与变更路径相交';
        changed = true;
      }
    }
  }
  return { affected: [...affected].sort(), reasons };
}

function cmdCrImpact(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const st = readState(ctx);
  const cr = st.crs[id];
  if (!cr) throw new TeamError('NO_CR', `变更请求不存在：${id}`);
  const { affected, reasons } = computeImpact(st, cr);
  const classification = affected.length === 0 ? 'additive'
    : (cr.touches || []).some((g) => (st.tasks[affected[0]]?.write || []).some((w) => globMayOverlap(w, g))) ? 'modify' : 'additive';
  const text = [
    `受影响任务（${affected.length}）：`,
    ...affected.map((a) => `- ${a}：${reasons[a]}`),
    '',
    `建议级别：${classification}`,
    classification === 'additive' ? '新增任务即可，现有任务不改。' : '只改受影响任务；其余分支/租约/状态保持不动。',
  ].join('\n');
  mutate(ctx, (state) => {
    const c = state.crs[id];
    c.affected = affected;
    c.classification = classification;
    c.impact = text;
    c.status = '待批';
    writeCrFile(ctx, c);
  });
  console.log(text);
  console.log(`\n下一步：team.mjs cr apply ${id} --mode ${classification} --tasks ${affected.join(',') || '（无）'}`);
}

function cmdCrApply(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const mode = must(opts.mode, 'mode');
  if (!['additive', 'modify', 'structural'].includes(mode)) throw new TeamError('BAD_MODE', 'mode 只能是 additive/modify/structural');
  const tasks = splitList(opts.tasks);
  if (mode === 'structural' && !opts.adr) throw new TeamError('NO_ADR', 'structural 变更必须给 --adr ADR-###');

  const result = mutate(ctx, (st) => {
    const cr = st.crs[id];
    if (!cr) throw new TeamError('NO_CR', `变更请求不存在：${id}`);
    cr.mode = mode;
    cr.status = '已应用';
    cr.appliedAt = nowIso();
    cr.decision = opts.decision ? String(opts.decision) : `${mode}：影响任务 ${tasks.join(', ') || '无'}`;
    const changed = [];
    const adrId = opts.adr ? String(opts.adr) : '';
    for (const tid of tasks) {
      const t = st.tasks[tid];
      if (!t) throw new TeamError('NO_TASK', `受影响任务不存在：${tid}`);
      t.crs = [...new Set([...(t.crs || []), id])];
      t.updatedAt = nowIso();
      if (mode === 'modify') {
        t.rework = (t.rework || 0) + 1;
        const addendum = `\n\n## 变更追加（${id}）\n\n- ${cr.need || cr.title}\n- 决定：${cr.decision}\n`;
        fs.appendFileSync(path.join(ctx.teamDir, 'TASKS', `${tid}.md`), addendum);
        if (t.status === '已完成') t.status = '待认领';
        changed.push(`${tid}:modify`);
      } else if (mode === 'structural') {
        t.status = '阻塞';
        t.blockedReason = `结构性变更 ${id}（${adrId || 'ADR 待补'}）`;
        changed.push(`${tid}:freeze`);
      }
    }
    if (mode === 'structural' && adrId) {
      const adrFile = path.join(ctx.teamDir, 'DECISIONS', `${adrId}.md`);
      if (!fs.existsSync(adrFile)) {
        atomicWrite(adrFile, `# ${adrId} ${cr.title}\n\n- 时间：${nowIso()}\n- 关联：${id}\n- 状态：已接受\n\n## 背景\n\n${cr.need || ''}\n\n## 决定\n\n${cr.decision}\n\n## 兼容层 / 回滚\n\n- 契约版本：\n- adapter：\n- 回滚点：pre-${id}\n`);
      }
    }
    writeCrFile(ctx, cr);
    st.notes.push({ at: nowIso(), by: opts.by || 'manager', text: `应用变更 ${id}（${mode}）：${changed.join(', ') || '无任务改动'}` });
    appendEvent(ctx, { event: 'cr.apply', id, mode, tasks });
    return { changed, mode };
  });
  console.log(`已应用 ${id}（${result.mode}）：${result.changed.join(', ') || '现有任务未改动'}`);
  console.log('下一步：新增任务用 task add --cr ...；受影响任务按公告栏重新派单/返工；提交任务书与 CHANGES/。');
}

function cmdArbitrate(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.task || opts.id || opts._[0], 'task');
  const issue = opts.issue ? String(opts.issue) : `任务 ${id} 冲突/争议`;
  const result = mutate(ctx, (st) => {
    const t = st.tasks[id];
    if (!t) throw new TeamError('NO_TASK', `任务不存在：${id}`);
    if (opts.decide) {
      const arbId = t.arb || createArbitration(ctx, st, { task: id, issue, by: opts.by || 'manager' }).id;
      const arb = st.arbitrations[arbId];
      arb.status = '已裁决';
      arb.decision = opts.decision ? String(opts.decision) : '按条款 5：后到者改';
      arb.decidedBy = opts.by || 'manager';
      arb.decidedAt = nowIso();
      const result = opts.result ? String(opts.result) : '进行中';
      t.status = result;
      if (result === '进行中') t.blockedReason = '';
      const file = path.join(ctx.teamDir, 'ARBITRATIONS', `${arbId}.md`);
      fs.appendFileSync(file, `\n\n## 裁决（${nowIso()}）\n\n- 决定人：${arb.decidedBy}\n- 决定：${arb.decision}\n- 任务状态：${result}\n`);
      appendEvent(ctx, { event: 'arb.decide', id: arbId, result });
      return { arbId, decided: true, result };
    }
    const a = createArbitration(ctx, st, { task: id, issue, by: opts.by || 'manager' });
    t.status = '待仲裁';
    t.arb = a.id;
    t.blockedReason = `待仲裁：${a.id}`;
    appendEvent(ctx, { event: 'arb.open', id, arb: a.id });
    return { arbId: a.id, decided: false };
  });
  if (result.decided) console.log(`已裁决 ${result.arbId} → 任务 ${id} 状态 ${result.result}`);
  else console.log(`已开启仲裁 ${result.arbId}：.team/ARBITRATIONS/${result.arbId}.md`);
}

function cmdHandoff(opts) {
  const ctx = resolveContext();
  requireInitialized(ctx);
  const id = must(opts.id || opts._[0], 'id');
  const st = readState(ctx);
  const t = st.tasks[id];
  if (!t) throw new TeamError('NO_TASK', `任务不存在：${id}`);
  const sess = readJson(path.join(ctx.localDir, 'sessions', `${id}.json`));
  if (!sess) throw new TeamError('NO_BRIEF', `任务 ${id} 没有会话简报（可能未 dispatch）`);
  console.log(`# 顶层会话交接 ${id}\n`);
  console.log(`在 DSH 里新开一个会话，工作目录选：\n  ${sess.worktree}\n`);
  console.log(`然后粘贴：\n`);
  console.log(`你是项目执行会话，负责任务 ${id}。工作目录必须是 ${sess.worktree}。`);
  console.log(`先读 ${ctx.controlRoot}/.team/PROTOCOL.md、${ctx.controlRoot}/.team/BULLETIN.md、${ctx.controlRoot}/.team/TASKS/${id}.md、${sess.briefPath}。`);
  console.log(`claim token：${sess.token}（用 team.mjs claim ${id} --token ${sess.token}；如已有租约加 --takeover）`);
  console.log(`只在写集内改；不碰 .team/；完成 submit；卡住 report。`);
  mutate(ctx, (state) => {
    state.tasks[id].handoffAt = nowIso();
    appendEvent(ctx, { event: 'task.handoff', id });
  });
  console.log(`\n已记录 handoff；manager 请在公告栏注明交接。`);
}

// ---------------------------------------------------------------- help

function printHelp() {
  console.log(`project-team CLI

用法：node .team/tools/team.mjs <命令> [参数]

初始化 / 健康
  init [--base main] [--integration team/integration] [--gate "pnpm test"] [--link "node_modules"] [--tools-only] [--force]
  doctor [--fix] [--json]
  status [--json]
  bulletin [--json]
  note --text "..." [--by manager]

任务
  task add --title "..." --module m-core --write "src/core/**" --verify "node --test"
           [--read "src/shared/**"] [--deps T-001] [--priority 2] [--allow-outside] [--allow-protected]
  task list [--json]
  task show --id T-001

派单 / 执行
  dispatch --id T-001 [--override-overlap --reason "..."] [--reuse]
  link --id T-001 --session <会话id>
  claim --id T-001 (--token <token> | --manager) [--takeover] [--ttl-ms N]
  renew --id T-001 --token <token>
  release --id T-001 --token <token>
  report --id T-001 --status working|blocked|arbitration|human --note "..."
  submit --id T-001 --token <token> [--test "cmd"] [--needs-human] [--skip-gate --reason "..."]
  handoff --id T-001

集成 / 验收
  integrate --id T-001 [--gate "cmd"]
  accept --id T-001 [--human-ok]
  reject --id T-001 --reason "..."
  reopen --id T-001 --reason "..."   # 已完成/关闭后发现问题，重新打开（工作树在则直接进行中）
  close --id T-001 --reason "..."
  clean --id T-001 [--force] [--delete-branch]

变更 / 仲裁
  cr new --title "..." --need "..." [--touches "src/core/**;src/shared/**"]
  cr impact --id CR-001
  cr apply --id CR-001 --mode additive|modify|structural --tasks T-001,T-002 [--adr ADR-001]
  arbitrate --task T-001 [--issue "..."] [--decide --decision "..." --result 进行中]

所有命令支持 --json（部分）。退出码：0 成功 / 2 用法或状态 / 3 冲突或越权 / 4 门禁或合并失败。`);
}

// ---------------------------------------------------------------- main

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') { printHelp(); return; }
  const cmd = argv[0];
  const rest = argv.slice(1);
  const opts = parseArgs(rest);
  switch (cmd) {
    case 'init': return cmdInit(opts);
    case 'doctor': return cmdDoctor(opts);
    case 'status': return cmdStatus(opts);
    case 'bulletin': return cmdBulletin(opts);
    case 'note': return cmdNote(opts);
    case 'task': {
      const sub = rest[0];
      const subOpts = parseArgs(rest.slice(1));
      if (sub === 'add') return cmdTaskAdd(subOpts);
      if (sub === 'list') return cmdTaskList(subOpts);
      if (sub === 'show') return cmdTaskShow(subOpts);
      throw new TeamError('BAD_SUB', `未知 task 子命令：${sub || '(空)'}`, 2, 'task add|list|show');
    }
    case 'dispatch': return cmdDispatch(opts);
    case 'link': return cmdLink(opts);
    case 'claim': return cmdClaim(opts);
    case 'renew': return cmdRenew(opts);
    case 'release': return cmdRelease(opts);
    case 'report': return cmdReport(opts);
    case 'submit': return cmdSubmit(opts);
    case 'integrate': return cmdIntegrate(opts);
    case 'accept': return cmdAccept(opts);
    case 'reject': return cmdReject(opts);
    case 'close': return cmdClose(opts);
    case 'reopen': return cmdReopen(opts);
    case 'clean': return cmdClean(opts);
    case 'handoff': return cmdHandoff(opts);
    case 'arbitrate': return cmdArbitrate(opts);
    case 'cr': {
      const sub = rest[0];
      const subOpts = parseArgs(rest.slice(1));
      if (sub === 'new') return cmdCrNew(subOpts);
      if (sub === 'impact') return cmdCrImpact(subOpts);
      if (sub === 'apply') return cmdCrApply(subOpts);
      throw new TeamError('BAD_SUB', `未知 cr 子命令：${sub || '(空)'}`, 2, 'cr new|impact|apply');
    }
    default:
      throw new TeamError('UNKNOWN_CMD', `未知命令：${cmd}`, 2, 'team.mjs --help');
  }
}

try {
  main();
} catch (e) {
  if (e instanceof TeamError) {
    console.error(`[team] ${e.code}: ${e.message}`);
    if (e.hint) console.error(`next: ${e.hint}`);
    process.exit(e.exit || 2);
  }
  console.error(`[team] INTERNAL: ${e.stack || e.message}`);
  process.exit(2);
}
