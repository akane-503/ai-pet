'use strict';
(function (root) {
  // 启动入口自动判断：用户填的是网址、AppID、路径还是命令——别让人对着五种「方式」硬选。
  // 判据从宽：只有明确像路径/网址才换类，裸词一律当 CLI（PATH 可解析，menuAvailable 也会按 PATH 找）。
  function judgeKind(value) {
    const v = String(value || '').trim();
    if (!v) return null;
    if (/^https?:\/\//i.test(v)) return 'url';
    if (/!App$/i.test(v)) return 'store';
    if (/[\\/]/.test(v)) return 'app';
    return 'cli';
  }
  // `wsl -l -q` 的输出可能是 UTF-16（字符间夹 \0），统一剥掉再按行拆
  function parseWslList(text) {
    return String(text || '').replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  const launch = { judgeKind, parseWslList };
  if (typeof module === 'object' && module.exports) module.exports = launch;
  else root.LaunchFind = launch;
})(typeof globalThis === 'object' ? globalThis : this);
