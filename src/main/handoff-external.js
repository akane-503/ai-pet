'use strict';
/**
 * Detect handoff files written outside the pet's own runHandoff job
 * (e.g. project-team-pm adapters/aipet/handoff.mjs --live → ~/.handoff/latest.txt).
 *
 * Boundary: announce + copy takeover only. Do NOT write .team / board / engage state.
 * Progress truth stays in project-team-pm (`team status --json`).
 */
const fs = require('fs');
const path = require('path');

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

function viewFromLatest(latest, goalOf) {
  const goal = (typeof goalOf === 'function' ? goalOf(latest.file) : '') || path.basename(latest.file, '.md');
  const meta = metaFromHandoff(latest.file);
  const isReturn = meta.returned || meta.kind === 'return' || /RETURN/i.test(path.basename(latest.file || ''));
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
};
