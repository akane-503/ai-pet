'use strict';
/**
 * Detect handoff files written outside the pet's own runHandoff job
 * (e.g. project-team-pm adapters/aipet/handoff.mjs --live → ~/.handoff/latest.txt).
 *
 * Boundary: announce + copy takeover + write return receipt (HANDOFF-RETURN / RETURNED.md).
 * Do NOT write engagements.json / board / ticket state — pm consumes the receipt.
 * Progress truth stays in project-team-pm (`team status --json`).
 *
 * Announce only sponsor moments, from the ai-pet-handoff marker kind:
 *   sponsor-gate — confirm a plan, or answer ask-sponsor
 *   deliverable-ready — a module deliverable can be accepted
 *   returned — the outsource slice came back (legacy kind "return" counts)
 * Heartbeats with no kind, and any other kind, stay quiet.
 * The same engage + kind is announced once.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const LATEST = path.join(os.homedir(), '.handoff', 'latest.txt');
const CACHE = path.join(os.homedir(), '.handoff', 'cache');

/**
 * @param {{ file?: string, at?: number } | null} latest
 * @param {{ lastAt: number, busy: boolean, selfWriteUntil?: number, now?: number }} state
 */
function shouldAnnounce(latest, state) {
  if (!latest || !latest.file || !latest.at) return false;
  if (state.busy) return false;
  if (latest.at <= (state.lastAt || 0)) return false;
  const now = state.now != null ? state.now : Date.now();
  if (state.selfWriteUntil && now < state.selfWriteUntil) return false;
  return true;
}

function sanitize(name) {
  return String(name || 'engage')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .slice(0, 60);
}

/** Guess sponsor repo from briefPath (`…/.team/engagements/E-xxx/BRIEF.md`). */
function repoRootFromBrief(briefPath) {
  if (!briefPath) return '';
  const abs = path.resolve(String(briefPath).replace(/\//g, path.sep));
  const parts = abs.split(path.sep);
  const idx = parts.lastIndexOf('.team');
  if (idx > 0) return parts.slice(0, idx).join(path.sep);
  return '';
}

/**
 * Read host / engageId / takeover from HANDOFF meta written by project-team-pm.
 * Falls back to blockquote `host=` then 'cursor' for legacy files.
 */
function metaFromHandoff(file) {
  const empty = { host: '', engageId: '', briefPath: '', takeover: '', kind: '', returned: false, module: '', gate: '', ask: '' };
  if (!file) return empty;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(24576);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.toString('utf8', 0, n);
      const m = /<!--\s*ai-pet-handoff:(.+?)\s*-->/.exec(head);
      if (m) {
        const j = JSON.parse(m[1]);
        return {
          host: String(j.host || '').trim(),
          engageId: String(j.engageId || '').trim(),
          briefPath: String(j.briefPath || '').trim(),
          takeover: String(j.takeover || '').trim(),
          kind: String(j.kind || '').trim(),
          returned: !!j.returned,
          module: String(j.module || j.moduleName || '').trim(),
          gate: String(j.gate || '').trim(),
          ask: String(j.ask || j.action || '').trim(),
        };
      }
      const hq = />.*\bhost=([^\s·]+)/i.exec(head);
      if (hq) return { ...empty, host: hq[1].trim() };
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    /* legacy / unreadable */
  }
  return empty;
}

/**
 * Write return receipt only (IPC + optional repo RETURNED.md).
 * Never mutates engagements.json — project-team-pm consumes the marker.
 *
 * @param {{ engageId: string, repoRoot?: string, host?: string }} opts
 * @returns {{ handoffFile: string, latestPath: string, returnedMarker: string|null, engageId: string, nextSteps: string[] }}
 */
function writeReturnReceipt({ engageId, repoRoot = '', host = '' } = {}) {
  const id = String(engageId || '').trim();
  if (!id) throw new Error('writeReturnReceipt: engageId required');
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(path.dirname(LATEST), { recursive: true });
  const sid = sanitize(id);
  const target = path.join(CACHE, `HANDOFF-RETURN-${sid}.md`);
  const next = [`team engage deliver --id ${id}`, `team engage in --id ${id}`];
  const root = repoRoot && path.isAbsolute(repoRoot) ? repoRoot : '';
  const meta = {
    host: host || '',
    engageId: id,
    kind: 'return',
    returned: true,
    source: 'ai-pet',
  };
  const body = [
    `# HANDOFF — return ${id}`,
    '',
    `<!-- ai-pet-handoff:${JSON.stringify(meta)} -->`,
    root ? `<!-- ai-pet-project:${JSON.stringify({ root })} -->` : '',
    '',
    `> ai-pet engage return · id=${id} · **已交回**`,
    '',
    '外包切片已交回（桌宠写回执）。发包方控制面将消费 `.team/engagements/<id>/RETURNED.md`，或执行：',
    '',
    '```',
    ...next,
    '```',
    '',
  ]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n');
  fs.writeFileSync(target, body, 'utf8');
  fs.appendFileSync(LATEST, `${target}${os.EOL}`, 'utf8');

  let returnedMarker = null;
  if (root) {
    const dir = path.join(root, '.team', 'engagements', sid);
    fs.mkdirSync(dir, { recursive: true });
    returnedMarker = path.join(dir, 'RETURNED.md');
    fs.writeFileSync(
      returnedMarker,
      [
        `# 已交回 · ${id}`,
        '',
        `at: ${new Date().toISOString()}`,
        'source: ai-pet',
        '',
        '下一步：',
        '',
        '```',
        ...next,
        '```',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  return {
    handoffFile: target,
    latestPath: LATEST,
    returnedMarker,
    engageId: id,
    nextSteps: next,
  };
}

/** sponsor-gate | deliverable-ready | returned, or '' when this file is not a sponsor moment. */
function sponsorKind(meta, file) {
  const kind = String(meta && meta.kind || '').trim();
  if (kind === 'returned' || kind === 'return' || (meta && meta.returned)) return 'returned';
  if (kind === 'sponsor-gate' || kind === 'deliverable-ready') return kind;
  if (!kind && /RETURN/i.test(path.basename(file || ''))) return 'returned';
  return '';
}

function moduleName(meta, goal) {
  const explicit = String((meta && meta.module) || '').trim();
  if (explicit) return explicit;
  const text = String(goal || '').replace(/\s*→\s*[A-Za-z][\w.-]*\s*$/u, '').replace(/^return\s+/i, '').trim();
  const id = meta && String(meta.engageId || '').trim();
  if (text && text !== id) return text;
  return id || '未命名模块';
}

function sponsorAction(meta, kind) {
  if (kind === 'deliverable-ready') return '请验收这份交付物';
  if (kind === 'returned') return '外包已交回';
  const gate = String(meta && meta.gate || '').trim().toLowerCase();
  if (gate === 'plan' || gate === 'confirm-plan') return '请确认计划';
  if (gate === 'ask-sponsor' || gate === 'ask') return '请回答 ask-sponsor';
  return '请确认计划，或回答 ask-sponsor';
}

/** Bubble / toast copy: module name plus what the sponsor should do. */
function sponsorPresentation(meta, goal, kind) {
  const name = moduleName(meta, goal);
  const ask = String(meta && meta.ask || '').trim();
  if (kind === 'returned') {
    const id = meta && String(meta.engageId || '').trim();
    const detail = id && name !== id ? `${name} · ${id} 已交回` : (id ? `${id} 已交回` : `${name} 已交回`);
    return { module: name, title: '外包已交回', heading: '外包已交回', detail, target: '已交回', action: '外包已交回' };
  }
  const action = sponsorAction(meta, kind);
  const line = `${name} · ${action}`;
  const detail = ask ? `${line}\n${ask}` : line;
  if (kind === 'deliverable-ready') {
    return { module: name, title: '交付物可验收', heading: line, detail, target: name, action };
  }
  return { module: name, title: '要你处理', heading: line, detail, target: name, action };
}

function viewFromLatest(latest, goalOf, opts = {}) {
  const goal = (typeof goalOf === 'function' ? goalOf(latest.file) : '') || path.basename(latest.file, '.md');
  const meta = metaFromHandoff(latest.file);
  const kind = sponsorKind(meta, latest.file);
  const isReturn = kind === 'returned';
  const presented = kind ? sponsorPresentation(meta, goal, kind) : null;
  const repoRoot = opts.repoRoot || repoRootFromBrief(meta.briefPath) || '';
  return {
    id: `ext-${latest.at}`,
    target: presented ? presented.target : '外部交接',
    heading: presented ? presented.heading : '收到交接文件',
    detail: presented ? presented.detail : (meta.host ? `${goal} · ${meta.host}` : goal),
    project: '',
    step: 4,
    steps: ['ok', 'ok', 'ok', 'ok'],
    done: true,
    cancelled: false,
    failed: false,
    manualSource: false,
    canCopy: true,
    progress: undefined,
    autoCloseMs: 20000,
    external: true,
    file: latest.file,
    host: meta.host,
    engageId: meta.engageId || '',
    returned: isReturn,
    canMarkReturned: !isReturn && !!meta.engageId,
    repoRoot,
    sponsorKind: kind,
    module: presented ? presented.module : '',
  };
}

function notificationFromLatest(latest, goalOf) {
  const goal = (typeof goalOf === 'function' ? goalOf(latest.file) : '') || path.basename(latest.file, '.md');
  const meta = metaFromHandoff(latest.file);
  const kind = sponsorKind(meta, latest.file);
  if (!kind) {
    return {
      title: '收到 AI 交接',
      body: meta.host ? `${goal} → ${meta.host}` : goal,
      file: latest.file,
      host: meta.host,
    };
  }
  const presented = sponsorPresentation(meta, goal, kind);
  const ask = String(meta.ask || '').trim();
  const body = ask && kind !== 'returned' ? `${presented.module} · ${presented.action}：${ask}` : presented.detail.split('\n')[0];
  return {
    title: presented.title,
    body,
    file: latest.file,
    host: meta.host,
    module: presented.module,
    sponsorKind: kind,
  };
}

/** Sponsor moment for this file, or '' when it should stay quiet. */
function phaseOf(meta, file) {
  return sponsorKind(meta, file);
}

/** Stable key: same engage + kind (no kind → engage/file only, and those are not announced). */
function dedupeKey(meta, file, kind) {
  const id = meta && String(meta.engageId || '').trim();
  let base = '';
  if (id) base = `engage:${id}`;
  else if (file) {
    try {
      base = `file:${path.resolve(String(file)).toLowerCase()}`;
    } catch (_) {
      base = `file:${String(file).toLowerCase()}`;
    }
  }
  if (!base) return '';
  const k = kind != null && String(kind) !== '' ? String(kind) : sponsorKind(meta, file);
  return k ? `${base}:${k}` : base;
}

/**
 * Decide how loud to announce a latest.txt bump.
 * inbox = toast + 收件箱 + 气泡，仅 sponsor-gate / deliverable-ready / returned 的第一次
 * silent = 同 engage+kind 已通知过
 * skip = 无 kind 的进度心跳，以及其它 kind
 *
 * @param {{ file?: string, at?: number } | null} latest
 * @param {Record<string, { phase: string, file: string, at?: number }>} memory
 */
function decideAnnounce(latest, memory = {}) {
  if (!latest || !latest.file) return { channel: 'skip', phase: '', key: '', reason: 'no-file' };
  const meta = metaFromHandoff(latest.file);
  const phase = sponsorKind(meta, latest.file);
  const key = dedupeKey(meta, latest.file, phase);
  if (!phase) return { channel: 'skip', phase: '', key, reason: 'no-kind' };
  const prev = key ? memory[key] : null;
  if (prev) return { channel: 'silent', phase, key, reason: 'deduped' };
  return { channel: 'inbox', phase, key, reason: phase };
}

function rememberAnnounce(memory, decision, latest) {
  const next = memory && typeof memory === 'object' ? { ...memory } : {};
  if (!decision || !decision.key || decision.channel === 'skip' || !latest || !latest.file) return next;
  next[decision.key] = { phase: decision.phase, file: latest.file, at: latest.at };
  return next;
}

/**
 * One inbox row per engageKey: merge in place (newest on top).
 * @returns {{ list: object[], notification: object, merged: boolean }}
 */
function upsertHandoffNotification(notifications, draft) {
  const list = Array.isArray(notifications) ? notifications.slice() : [];
  const key = draft && draft.engageKey ? String(draft.engageKey) : '';
  const idx = key
    ? list.findIndex((n) => n && n.kind === 'handoff-external' && n.engageKey === key)
    : -1;
  if (idx >= 0) {
    const prev = list[idx];
    const notification = {
      ...prev,
      ...draft,
      id: prev.id,
      kind: 'handoff-external',
      engageKey: key,
      ts: Date.now(),
      read: false,
    };
    list.splice(idx, 1);
    list.unshift(notification);
    return { list: list.slice(0, 300), notification, merged: true };
  }
  const notification = {
    ...draft,
    id: (draft && draft.id) || `ext-h-${Date.now()}`,
    kind: 'handoff-external',
    ts: Date.now(),
    read: false,
  };
  list.unshift(notification);
  return { list: list.slice(0, 300), notification, merged: false };
}

function inboxKeyOf(n) {
  if (!n || n.kind !== 'handoff-external') return '';
  if (n.engageKey) return String(n.engageKey);
  if (n.engageId) return `engage:${n.engageId}`;
  if (n.file) {
    try {
      return `file:${path.resolve(String(n.file)).toLowerCase()}`;
    } catch (_) {
      return `file:${String(n.file).toLowerCase()}`;
    }
  }
  return `legacy:${n.title || ''}|${n.body || ''}`;
}

/**
 * Collapse historical outsource spam; never touch non-handoff-external rows.
 * Keeps newest row per engage/file key (list is newest-first).
 * @returns {{ list: object[], removed: number, kept: number }}
 */
function pruneHandoffInbox(notifications) {
  const list = Array.isArray(notifications) ? notifications : [];
  const keep = [];
  const seen = new Set();
  let removed = 0;
  let kept = 0;
  for (const n of list) {
    if (!n || n.kind !== 'handoff-external') {
      keep.push(n);
      continue;
    }
    const key = inboxKeyOf(n);
    if (seen.has(key)) {
      removed += 1;
      continue;
    }
    seen.add(key);
    kept += 1;
    keep.push(n.engageKey ? n : { ...n, engageKey: key });
  }
  return { list: keep, removed, kept };
}

/** Tool id for takeoverPrompt — prefer HANDOFF meta host over hard-coded cursor. */
function toolForExternalHandoff(file, fallback = 'cursor') {
  const meta = metaFromHandoff(file);
  return meta.host || fallback;
}

module.exports = {
  shouldAnnounce,
  viewFromLatest,
  notificationFromLatest,
  metaFromHandoff,
  toolForExternalHandoff,
  writeReturnReceipt,
  repoRootFromBrief,
  phaseOf,
  sponsorKind,
  dedupeKey,
  decideAnnounce,
  rememberAnnounce,
  upsertHandoffNotification,
  pruneHandoffInbox,
  inboxKeyOf,
  LATEST,
  CACHE,
};
