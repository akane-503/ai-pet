'use strict';
/**
 * Detect handoff files written outside the pet's own runHandoff job
 * (e.g. project-team-pm adapters/aipet/handoff.mjs --live → ~/.handoff/latest.txt).
 */
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

function viewFromLatest(latest, goalOf) {
  const goal = (typeof goalOf === 'function' ? goalOf(latest.file) : '') || path.basename(latest.file, '.md');
  return {
    id: `ext-${latest.at}`,
    target: '外部交接',
    heading: '收到交接文件',
    detail: goal,
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
  };
}

function notificationFromLatest(latest, goalOf) {
  const goal = (typeof goalOf === 'function' ? goalOf(latest.file) : '') || path.basename(latest.file, '.md');
  return {
    title: '收到 AI 交接',
    body: goal,
    file: latest.file,
  };
}

module.exports = { shouldAnnounce, viewFromLatest, notificationFromLatest };
