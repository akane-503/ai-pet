'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dir = path.join(root, pkg.build.directories.output);
const source = path.join(dir, `AI桌宠-Setup-${pkg.version}.exe`);
const target = path.join(dir, 'setup.exe');
// Run only after a successful installer build; retain versioned installers for recovery.
const fd = fs.openSync(source, 'r');
try { const header = Buffer.alloc(2); fs.readSync(fd, header, 0, 2, 0); if (header.toString() !== 'MZ') throw new Error('Invalid Windows installer'); }
finally { fs.closeSync(fd); }
fs.copyFileSync(source, target);
const hash = crypto.createHash('sha256');
const input = fs.createReadStream(target);
input.on('data', b => hash.update(b));
input.on('error', e => { console.error(e.message); process.exitCode = 1; });
input.on('end', () => {
  const sha256 = hash.digest('hex');
  fs.writeFileSync(target + '.sha256', sha256 + '  setup.exe\n');
  console.log(JSON.stringify({ installer: target, version: pkg.version, bytes: fs.statSync(target).size, sha256 }));
});
