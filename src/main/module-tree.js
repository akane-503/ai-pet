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

function statusOf(value) {
  const status = String(value || '').trim().toLowerCase();
  return STATUSES.includes(status) ? status : 'pending';
}

function moduleNode(raw, index) {
  const title = oneLine(raw && (raw.title || raw.name || raw.id), 80) || `模块 ${index + 1}`;
  const status = statusOf(raw && raw.status);
  return {
    kind: 'module',
    id: oneLine(raw && raw.id, 80) || title,
    title,
    status,
    label: LABELS[status],
    parentGoal: oneLine(raw && (raw.parentGoal || raw.goalId || raw.goal), 120),
    deliverable: oneLine(raw && (raw.deliverable || raw.deliverablePath || raw.path), 300),
    gap: oneLine(raw && (raw.gap || raw.gapLine), 160),
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
    .map(moduleNode);
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
