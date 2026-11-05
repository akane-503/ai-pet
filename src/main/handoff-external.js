'use strict';
/**
 * Detect handoff files written outside the pet's own runHandoff job
 * (e.g. project-team-pm adapters/aipet/handoff.mjs --live → ~/.handoff/latest.txt).
 *
 * Boundary: announce + copy takeover + write return receipt (HANDOFF-RETURN / RETURNED.md).
 * Do NOT write engagements.json / board / ticket state — pm consumes the receipt.
 * Progress truth stays in project-team-pm (`team status --json`).
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
  const empty = { host: '', engageId: '', briefPath: '', takeover: '', kind: '', returned: false };
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

function viewFromLatest(latest, goalOf, opts = {}) {
  const goal = (typeof goalOf === 'function' ? goalOf(latest.file) : '') || path.basename(latest.file, '.md');
  const meta = metaFromHandoff(latest.file);
  const isReturn = meta.returned || meta.kind === 'return' || /RETURN/i.test(path.basename(latest.file || ''));
  const repoRoot = opts.repoRoot || repoRootFromBrief(meta.briefPath) || '';
  return {
    id: `ext-${latest.at}`,
    target: isReturn ? '已交回' : '外部交接',
    heading: isReturn ? '外包已交回' : '收到交接文件',
    detail: meta.host ? `${goal} · ${meta.host}` : goal,
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
  };
}

function notificationFromLatest(latest, goalOf) {
  const goal = (typeof goalOf === 'function' ? goalOf(latest.file) : '') || path.basename(latest.file, '.md');
  const meta = metaFromHandoff(latest.file);
  const isReturn = meta.returned || meta.kind === 'return' || /RETURN/i.test(path.basename(latest.file || ''));
  return {
    title: isReturn ? '外包已交回' : '收到 AI 交接',
    body: meta.host ? `${goal} → ${meta.host}` : goal,
    file: latest.file,
    host: meta.host,
  };
}

function isReturnMeta(meta, file) {
  return !!(meta && (meta.returned || meta.kind === 'return')) || /RETURN/i.test(path.basename(file || ''));
}

/** Lifecycle phase for throttle: out (派出/需你处理) vs returned (交回). */
function phaseOf(meta, file) {
  return isReturnMeta(meta, file) ? 'returned' : 'out';
}

/** Stable key for same engage / same HANDOFF — used to merge inbox rows. */
function dedupeKey(meta, file) {
  const id = meta && String(meta.engageId || '').trim();
  if (id) return `engage:${id}`;
  if (file) {
    try {
      return `file:${path.resolve(String(file)).toLowerCase()}`;
    } catch (_) {
      return `file:${String(file).toLowerCase()}`;
    }
  }
  return '';
}

/**
 * Decide how loud to announce a latest.txt bump.
 * inbox = toast + 收件箱（派出 / 交回 / 状态变化）
 * bubble = 只刷新桌宠气泡（同 phase 换文件）
 * silent = 仅记 memory / lastJob（同文件刷屏）
 *
 * @param {{ file?: string, at?: number } | null} latest
 * @param {Record<string, { phase: string, file: string, at?: number }>} memory
 */
function decideAnnounce(latest, memory = {}) {
  if (!latest || !latest.file) return { channel: 'skip', phase: '', key: '', reason: 'no-file' };
  const meta = metaFromHandoff(latest.file);
  const key = dedupeKey(meta, latest.file);
  const phase = phaseOf(meta, latest.file);
  const prev = key ? memory[key] : null;
  if (!prev) {
    return {
      channel: 'inbox',
      phase,
      key,
      reason: phase === 'returned' ? 'returned' : 'dispatched',
    };
  }
  if (prev.phase !== phase) {
    return { channel: 'inbox', phase, key, reason: 'state-change' };
  }
  let sameFile = false;
  try {
    sameFile = path.resolve(String(prev.file || '')) === path.resolve(String(latest.file));
  } catch (_) {
    sameFile = String(prev.file || '') === String(latest.file);
  }
  if (sameFile) return { channel: 'silent', phase, key, reason: 'same-file-refresh' };
  return { channel: 'bubble', phase, key, reason: 'same-phase-rewrite' };
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
  dedupeKey,
  decideAnnounce,
  rememberAnnounce,
  upsertHandoffNotification,
  pruneHandoffInbox,
  inboxKeyOf,
  LATEST,
  CACHE,
};
