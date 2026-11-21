'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { buildModuleTree } = require('../src/main/module-tree');
const { readModuleProgress } = require('../src/main/module-status');

test('module tree is the project goal, then modules, with one gap line', () => {
  const long = '缺口'.repeat(90);
  const tree = buildModuleTree({
    charter: { goal: '做出桌宠' },
    modules: [
      { id: 'a', title: '气泡', status: 'pending', deliverable: 'src/renderer/pet.html', gap: long, log: 'do not copy' },
      { id: 'b', title: '安装', status: 'review', parentGoal: '做出桌宠', deliverable: 'E:/06_Software/ai-pet' },
      { id: 'c', title: '图', status: 'gap', parentGoal: '看清进度', gap: '还在画日志\n第二行' },
    ],
    org: [{ summary: 'worker wrote a long report' }],
  });
  assert.equal(tree.root.title, '做出桌宠');
  assert.equal(tree.root.children.filter((item) => item.kind === 'module').length, 2);
  assert.equal(tree.root.children[0].label, '未开始');
  assert.equal(tree.root.children[0].gap.length, 160);
  assert.equal(tree.root.children.at(-1).title, '看清进度');
  assert.equal(tree.root.children.at(-1).children[0].gap, '还在画日志 第二行');
  const text = JSON.stringify(tree);
  assert.ok(!text.includes('do not copy'));
  assert.ok(!text.includes('long report'));
});

test('module tree reads team status words as pending, doing, review, gap, and done', () => {
  const tree = buildModuleTree({
    charter: { goal: '看见模块' },
    modules: [
      { id: 'q', title: '排队', status: 'queued', deliverable: 'docs/a.md' },
      { id: 'w', title: '在做', status: 'in-progress', deliverable: 'src/w.js' },
      { id: 'g', title: '缺口', status: 'in-progress', deliverable: 'src/g.js', gap: '差一行' },
      { id: 'r', title: '待看', status: 'for-review', deliverable: 'src/r.js' },
      { id: 'd', title: '好了', status: 'done', deliverable: 'src/d.js' },
      { id: 'x', title: '取消', status: 'canceled', deliverable: 'src/x.js' },
    ],
  });
  assert.equal(tree.root.title, '看见模块');
  assert.deepEqual(tree.root.children.map((item) => item.status), ['pending', 'doing', 'gap', 'review', 'done']);
  assert.deepEqual(tree.root.children.map((item) => item.label), ['未开始', '进行中', '有缺口', '待验收', '完成']);
  assert.equal(tree.root.children[2].gap, '差一行');
  assert.equal(tree.root.children[2].deliverable, 'src/g.js');
  assert.equal(JSON.stringify(tree).includes('取消'), false);
});

test('module progress keeps modules and drops worker reports', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-modtree-'));
  const root = path.join(folder, 'pet');
  fs.mkdirSync(path.join(root, '.team'), { recursive: true });
  const view = await readModuleProgress(root, {
    run: async (cwd) => ({
      schemaVersion: 1,
      repo: { name: 'pet', root: cwd },
      charter: { goal: '看见进度' },
      modules: [{ id: 'handoff', title: '转接', status: 'doing', deliverable: 'src/main/handoff.js', gap: '缺验收' }],
      org: [{ id: 'worker-1', summary: 'Implement the whole panel and paste the log' }],
      personQueue: [{ summary: 'Confirm a plan in a long note' }],
    }),
  });
  assert.equal(view.goal, '看见进度');
  assert.equal(view.modules[0].label, '进行中');
  assert.equal(view.moduleTree.children[0].deliverable, 'src/main/handoff.js');
  const text = JSON.stringify(view);
  assert.ok(!text.includes('worker-1'));
  assert.ok(!text.includes('Implement'));
  assert.ok(!text.includes('Confirm'));
  fs.rmSync(folder, { recursive: true, force: true });
  await assert.rejects(readModuleProgress('relative', { run() { return {}; } }), /完整目录路径/);
});
