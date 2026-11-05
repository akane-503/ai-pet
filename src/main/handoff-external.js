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
  LATEST,
  CACHE,
};
