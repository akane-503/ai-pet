'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultConfig } = require('../src/main/config');
const { filesForRelease, scanRelease } = require('./release-files');
test('fresh installs require explicit provider and paid quip opt-in', () => {
  const config = defaultConfig();
  assert.ok(config.providers.every(p => !p.enabled && !p.apiKey && !p.accessToken));
  assert.equal(config.quips.enabled, false);
  assert.equal(config.quips.apiKey, '');
});
test('release allowlist has assets and launcher but excludes history and private state', () => {
  const root = path.resolve(__dirname, '..');
  const files = filesForRelease(root);
  assert.ok(files.includes('assets/characters/zcode.png'));
  assert.ok(files.includes('scripts/start.ps1'));
  assert.ok(files.includes('src/main/smoke-test.js'));
  assert.equal(scanRelease(root, files).credentialsFound, false);
});
test('release scan blocks real-looking tokens and local paths without echoing their values', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pet-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const token = 'sk-' + 'a'.repeat(40);
  for (const value of [token, 'C:' + '\\Users\\' + 'fixture-user\\auth.json']) {
    fs.writeFileSync(path.join(dir, 'example.txt'), value);
    assert.throws(() => scanRelease(dir, ['example.txt']), e => !e.message.includes(value));
  }
});
