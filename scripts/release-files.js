'use strict';
const fs = require('node:fs');
const path = require('node:path');
const FILES = ['package.json', 'package-lock.json', '.npmrc', '.gitignore', 'start.cmd', 'README.md', 'THIRD_PARTY_NOTICES.md',
  'scripts/start.ps1', 'scripts/pack.js', 'scripts/release-files.js', 'scripts/install-shortcuts.ps1',
  'scripts/test-behavior.js', 'scripts/test-data.js', 'scripts/test-release.js', 'scripts/test-geometry.js'];
function filesForRelease(root) {
  const files = [...FILES];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relative + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Release cannot contain symlinks: ' + name);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  walk('src'); walk('assets');
  return files.sort();
}
function scanRelease(root, files) {
  const issues = [];
  const secrets = /(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}|eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{15,})/;
  const localPath = /[A-Z]:[\\/](?:Users|01_Projects)[\\/](?!Public\b|Default\b)[^\s"'<>]+/i;
  for (const file of files) {
    if (/(^|\/)(?:node_modules|dist|crawl|gen|work|outputs)(\/|$)|(^|\/)(?:config|state|auth|\.credentials)\.json|\.log$/i.test(file)) issues.push({ file, reason: 'private or generated file' });
    const data = fs.readFileSync(path.join(root, file)).toString('utf8');
    if (secrets.test(data)) issues.push({ file, reason: 'possible credential (redacted)' });
    if (localPath.test(data)) issues.push({ file, reason: 'machine-specific absolute path (redacted)' });
  }
  if (issues.length) throw new Error('Release scan failed: ' + JSON.stringify(issues));
  return { files: files.length, credentialsFound: false, privatePathsFound: false };
}
module.exports = { filesForRelease, scanRelease };
