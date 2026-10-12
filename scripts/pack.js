'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { filesForRelease, scanRelease } = require('./release-files');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
const dist = path.join(root, 'dist');
const stage = path.join(dist, `ai-pet-v${version}`);
const zip = stage + '-source.zip';
fs.mkdirSync(dist, { recursive: true });
if (path.dirname(stage) !== dist || !path.basename(stage).startsWith('ai-pet-v')) throw new Error('Unsafe staging path');
if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true });
if (fs.existsSync(zip)) fs.unlinkSync(zip);
const files = filesForRelease(root);
const scan = scanRelease(root, files);
for (const file of files) {
  const target = path.join(stage, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}
const manifest = files.map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(stage, file))).digest('hex') }));
fs.writeFileSync(path.join(stage, 'RELEASE_MANIFEST.json'), JSON.stringify({ version, scan, files: manifest }, null, 2) + '\n');
execFileSync('powershell.exe', ['-NoProfile', '-Command', "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:AIPET_STAGE, $env:AIPET_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $true)"], {
  windowsHide: true, stdio: 'inherit', env: { ...process.env, AIPET_STAGE: stage, AIPET_ZIP: zip }
});
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
fs.writeFileSync(zip + '.sha256', `${sha256}  ${path.basename(zip)}\n`);
console.log(JSON.stringify({ zip: path.basename(zip), bytes: fs.statSync(zip).size, sha256, scan }, null, 2));
