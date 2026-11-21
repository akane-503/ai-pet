'use strict';

const STATUSES = Object.freeze(['pending', 'doing', 'review', 'gap', 'done']);
const LABELS = Object.freeze({
  pending: '未开始',
  doing: '进行中',
  review: '待验收',
  gap: '有缺口',
  done: '完成',
});

function oneLine(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// team status --json 用 queued|in-progress|for-review|done|canceled。
// 树上只显示 pending|doing|review|gap|done。in-progress 再带一行缺口，就是有缺口。
const FROM_TEAM = Object.freeze({
  pending: 'pending',
  queued: 'pending',
  doing: 'doing',
  'in-progress': 'doing',
  review: 'review',
  'for-review': 'review',
  gap: 'gap',
  done: 'done',
  canceled: 'canceled',
  cancelled: 'canceled',
});

function statusOf(value, gap) {
  const raw = String(value || '').trim().toLowerCase();
  const status = Object.prototype.hasOwnProperty.call(FROM_TEAM, raw) ? FROM_TEAM[raw] : 'pending';
  // 控制面把「验收出了缺口」写成 in-progress，并带一行 gap。树上这就是有缺口。
  if (raw === 'in-progress' && String(gap || '').replace(/\s+/g, ' ').trim()) return 'gap';
  return status;
}

function moduleNode(raw, index) {
  const title = oneLine(raw && (raw.title || raw.name || raw.id), 80) || `模块 ${index + 1}`;
  const gap = oneLine(raw && (raw.gap || raw.gapLine), 160);
  const status = statusOf(raw && raw.status, raw && (raw.gap || raw.gapLine));
  return {
    kind: 'module',
    id: oneLine(raw && raw.id, 80) || title,
    title,
    status,
    label: LABELS[status] || '',
    parentGoal: oneLine(raw && (raw.parentGoal || raw.goalId || raw.goal), 120),
    deliverable: oneLine(raw && (raw.deliverable || raw.deliverablePath || raw.path), 300),
    gap,
  };
}

/**
 * Root is the project goal. Modules are the nodes.
 * A parent goal that is not the project goal itself becomes one grouping layer.
 * Worker logs, tickets and reports are not read.
 *
 * @param {{ goal?: string, charter?: { goal?: string, title?: string }, name?: string, repo?: { name?: string }, modules?: object[] }} status
 */
function buildModuleTree(status) {
  const source = status && typeof status === 'object' ? status : {};
  const goal = oneLine(
    source.goal || (source.charter && (source.charter.goal || source.charter.title)) || source.name || (source.repo && source.repo.name),
    160,
  ) || '项目目标';
  const modules = (Array.isArray(source.modules) ? source.modules : [])
    .filter((item) => item && typeof item === 'object')
    .map(moduleNode)
    .filter((mod) => mod.status !== 'canceled');
  const direct = [];
  const groups = [];
  const grouped = new Map();
  for (const mod of modules) {
    const parent = mod.parentGoal && mod.parentGoal !== goal ? mod.parentGoal : '';
    if (!parent) {
      direct.push(mod);
      continue;
    }
    if (!grouped.has(parent)) {
      grouped.set(parent, []);
      groups.push(parent);
    }
    grouped.get(parent).push(mod);
  }
  const children = [
    ...direct,
    ...groups.map((title) => ({
      kind: 'goal',
      id: 'goal:' + title,
      title,
      label: '父目标',
      children: grouped.get(title),
    })),
  ];
  return {
    goal,
    modules,
    root: { kind: 'goal', id: 'project', title: goal, label: '项目目标', children },
  };
}

module.exports = { buildModuleTree, STATUSES, LABELS };
