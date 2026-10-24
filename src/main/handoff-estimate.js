'use strict';
// A workload estimate, not server progress. Calibrated only from completed local runs.
function estimate({ records = 0, digestChars = 0, compactChars = 0 } = {}, history = [], model = '') {
  const requests = compactChars > 0 ? 2 : 1;
  const work = requests * 10 + (digestChars + compactChars) / 5000 + Math.min(records, 400) / 18;
  const ratios = (Array.isArray(history) ? history : []).filter(h => h.model === model && h.work > 0 && h.seconds > 0 && Number.isFinite(h.seconds / h.work))
    .slice(-8).map(h => Math.max(0.25, Math.min(6, h.seconds / h.work))).sort((a, b) => a - b);
  const seconds = Math.max(8, Math.round(work * (ratios.length ? ratios[Math.floor(ratios.length / 2)] : 1.3)));
  return { records, digestChars, compactChars, requests, work, seconds, minSec: Math.max(5, Math.floor(seconds * 0.65)), maxSec: Math.ceil(seconds * 1.8), calibrated: ratios.length > 0 };
}
function status(plan, elapsed, phase = '整理') {
  if (!plan) return `已 ${elapsed} 秒`;
  return elapsed > plan.maxSec ? `${phase}已 ${elapsed} 秒，超过预估，仍在等待` : `${phase}已 ${elapsed} 秒，预计共 ${plan.minSec}–${plan.maxSec} 秒`;
}
module.exports = { estimate, status };
