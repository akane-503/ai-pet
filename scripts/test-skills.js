'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const skills = require('../src/main/skills');

// 每个用例独立 home + 随包技能，避免碰到开发和测试机的真实用户目录
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-skills-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const source = path.join(dir, 'source');
  for (const name of skills.SKILLS) {
    fs.mkdirSync(path.join(source, name), { recursive: true });
    fs.writeFileSync(path.join(source, name, 'SKILL.md'), `# ${name}`);
    fs.mkdirSync(path.join(source, name, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(source, name, 'scripts', 'run.js'), `// ${name}`);
  }
  fs.mkdirSync(home, { recursive: true });
  return { dir, home, source };
}

test('list only reports tools whose directory exists, and whether the skill is deployed', (t) => {
  const { home, source } = fixture(t);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.codex'));
  let list = skills.list({ home, source });
  assert.equal(list.find(x => x.id === 'claude').present, true);
  assert.equal(list.find(x => x.id === 'claude').deployed, false);
  assert.equal(list.find(x => x.id === 'zcode').present, false);
  assert.equal(list.filter(x => x.present).length, 2);

  assert.equal(skills.deploy({ home, tools: ['claude', 'zcode'], source }).results.find(r => r.id === 'zcode').ok, false);
  list = skills.list({ home, source });
  assert.equal(list.find(x => x.id === 'claude').deployed, true);
  assert.equal(list.find(x => x.id === 'claude').upToDate, true);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'skills', 'takeover', 'scripts', 'run.js'), 'utf8'), '// takeover');
  // 本机没有的工具目录不会被创建
  assert.equal(fs.existsSync(path.join(home, '.zcode')), false);
});

test('deploy is idempotent and reports outdated copies until redeployed', (t) => {
  const { home, source } = fixture(t);
  fs.mkdirSync(path.join(home, '.codex'));
  const first = skills.deploy({ home, tools: ['codex'], source });
  assert.equal(first.ok, true);
  assert.equal(skills.deploy({ home, tools: ['codex'], source }).ok, true);

  fs.writeFileSync(path.join(source, 'takeover', 'SKILL.md'), '# takeover v2');
  assert.equal(skills.list({ home, source }).find(x => x.id === 'codex').upToDate, false);
  skills.deploy({ home, tools: ['codex'], source });
  assert.equal(skills.list({ home, source }).find(x => x.id === 'codex').upToDate, true);
  assert.equal(fs.readFileSync(path.join(home, '.codex', 'skills', 'takeover', 'SKILL.md'), 'utf8'), '# takeover v2');
});

test('remove deletes only handoff and takeover and keeps other skills', (t) => {
  const { home, source } = fixture(t);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'other'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'other', 'SKILL.md'), '# other');
  skills.deploy({ home, tools: ['claude'], source });

  const removed = skills.remove({ home, tools: ['claude'] });
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'handoff')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'skills', 'takeover')), false);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'skills', 'other', 'SKILL.md'), 'utf8'), '# other');
  assert.equal(skills.list({ home, source }).find(x => x.id === 'claude').deployed, false);
});

test('deploy refuses an incomplete bundled skill set and ignores unknown tool ids', (t) => {
  const { home, source } = fixture(t);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.rmSync(path.join(source, 'handoff'), { recursive: true, force: true });
  assert.throws(() => skills.deploy({ home, tools: ['claude'], source }), /随包技能不完整/);
  assert.equal(skills.deploy({ home, tools: ['not-a-tool'], source: fixture(t).source }).ok, false);
});

test('links owned by another manager are reported and never written through or deleted', (t) => {
  const { home, source, dir } = fixture(t);
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  const managed = path.join(dir, 'managed');
  for (const name of skills.SKILLS) {
    fs.mkdirSync(path.join(managed, name), { recursive: true });
    fs.writeFileSync(path.join(managed, name, 'SKILL.md'), `# ${name}`);
  }
  for (const name of skills.SKILLS) fs.symlinkSync(path.join(managed, name), path.join(home, '.claude', 'skills', name), 'junction');

  const listed = skills.list({ home, source }).find(x => x.id === 'claude');
  assert.equal(listed.managed, true);
  assert.equal(listed.deployed, true);

  const deployed = skills.deploy({ home, tools: ['claude'], source });
  assert.equal(deployed.ok, true);
  assert.equal(deployed.results[0].skipped, true);
  assert.equal(fs.readFileSync(path.join(managed, 'takeover', 'SKILL.md'), 'utf8'), '# takeover', '链接目标内容不被覆盖');

  const removed = skills.remove({ home, tools: ['claude'] });
  assert.equal(removed.ok, false);
  assert.match(removed.results[0].error, /Skills Manager/);
  assert.equal(fs.existsSync(path.join(managed, 'handoff', 'SKILL.md')), true, '链接目标不能被删');
  assert.equal(fs.lstatSync(path.join(home, '.claude', 'skills', 'handoff')).isSymbolicLink(), true);
});
