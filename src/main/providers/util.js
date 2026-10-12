'use strict';
const fs = require('fs');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function num(v, d = null) { if (v === null || v === undefined || v === '' || typeof v === 'boolean') return d; const n = Number(v); return Number.isFinite(n) ? n : d; }
function pick(o, keys, d) { for (const k of keys) { if (o && o[k] !== undefined && o[k] !== null) return o[k]; } return d; }
function toEpochSec(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return toEpochSec(Number(v));
  if (typeof v === 'number') return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
  const t = Date.parse(v); return Number.isFinite(t) ? Math.round(t / 1000) : null;
}
function fmtMoney(v, cur) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sym = cur === 'USD' ? '$' : cur === 'CNY' ? '¥' : (cur ? cur + ' ' : '');
  return sym + (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2));
}
function fmtCountdown(sec) {
  if (sec === null || sec === undefined) return '';
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分`;
}
function base(provider) {
  return {
    providerId: provider.id, type: provider.type, name: provider.name, ok: false, at: Date.now(), error: null,
    kind: 'balance', currency: null, balance: null, granted: null, toppedUp: null,
    windows: [], plan: null, credits: null, models: null, announcements: null, fraction: null, source: 'api', lines: [], extra: {},
  };
}
module.exports = { readJson, num, pick, toEpochSec, fmtMoney, fmtCountdown, base };
