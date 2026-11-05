'use strict';
// 解密 Cursor 写入 state.vscdb 的 cursor-safe-storage:v1:…（Electron safeStorage / Chromium OSCrypt）
// Windows：Local State 里 os_crypt.encrypted_key（DPAPI）→ AES-256-GCM（v10）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PREFIX_V1 = 'cursor-safe-storage:v1:';
const PREFIX_ANY = 'cursor-safe-storage:';
const DPAPI_PREFIX = 'DPAPI';
const WIN_VERSION = 'v10';
const WIN_KEY_LEN = 32;
const WIN_NONCE_LEN = 12;
const WIN_TAG_LEN = 16;

/** @type {Map<string, Buffer>} */
const keyCache = new Map();

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX_ANY);
}

function looksJwt(value) {
  if (typeof value !== 'string' || !value) return false;
  const parts = value.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function localStatePathFromDb(dbPath) {
  // …/Cursor/User/globalStorage/state.vscdb → …/Cursor/Local State
  return path.join(path.dirname(path.dirname(path.dirname(path.resolve(dbPath)))), 'Local State');
}

function windowsUnprotectBuffer(blob) {
  const b64 = Buffer.from(blob).toString('base64');
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    `$bytes=[Convert]::FromBase64String('${b64}')`,
    '$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($dec)',
  ].join(';');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (r.error) throw new Error('调用 DPAPI 失败：' + r.error.message);
  if (r.status !== 0) {
    const err = String(r.stderr || r.stdout || '').trim() || ('exit ' + r.status);
    throw new Error('DPAPI 解保护失败：' + err.slice(0, 200));
  }
  const out = String(r.stdout || '').replace(/\r?\n/g, '').trim();
  if (!out) throw new Error('DPAPI 解保护返回空');
  return Buffer.from(out, 'base64');
}

function loadWindowsOsCryptKey(localStatePath) {
  const resolved = path.resolve(localStatePath);
  if (keyCache.has(resolved)) return keyCache.get(resolved);
  if (!fs.existsSync(resolved)) {
    throw new Error('找不到 Cursor Local State（' + resolved + '）；请先打开一次 Cursor');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (e) {
    throw new Error('Cursor Local State 不是合法 JSON：' + e.message);
  }
  const encKeyB64 = parsed && parsed.os_crypt && parsed.os_crypt.encrypted_key;
  if (!encKeyB64 || typeof encKeyB64 !== 'string') {
    throw new Error('Cursor Local State 缺少 os_crypt.encrypted_key');
  }
  const encKey = Buffer.from(encKeyB64, 'base64');
  const prefix = encKey.subarray(0, DPAPI_PREFIX.length).toString('latin1');
  if (prefix !== DPAPI_PREFIX) {
    throw new Error(
      'Cursor OSCrypt 密钥前缀是「' + prefix + '」（期望 DPAPI）；可能启用了 App-Bound Encryption，桌宠暂无法解密'
    );
  }
  const key = windowsUnprotectBuffer(encKey.subarray(DPAPI_PREFIX.length));
  if (key.length !== WIN_KEY_LEN) {
    throw new Error('DPAPI 解出的 OSCrypt 密钥长度异常（' + key.length + '，期望 ' + WIN_KEY_LEN + '）');
  }
  keyCache.set(resolved, key);
  return key;
}

function windowsAesGcmEncrypt(plaintext, key32) {
  const nonce = crypto.randomBytes(WIN_NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key32, nonce);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(WIN_VERSION, 'latin1'), nonce, ciphertext, tag]);
}

function windowsAesGcmDecrypt(blob, key32) {
  if (!Buffer.isBuffer(blob) || blob.length < WIN_VERSION.length + WIN_NONCE_LEN + WIN_TAG_LEN) {
    throw new Error('safeStorage 密文太短');
  }
  const ver = blob.subarray(0, WIN_VERSION.length).toString('latin1');
  if (ver !== WIN_VERSION) {
    throw new Error('safeStorage 信封版本是「' + ver + '」（仅支持 v10）');
  }
  const nonce = blob.subarray(WIN_VERSION.length, WIN_VERSION.length + WIN_NONCE_LEN);
  const tag = blob.subarray(blob.length - WIN_TAG_LEN);
  const ciphertext = blob.subarray(WIN_VERSION.length + WIN_NONCE_LEN, blob.length - WIN_TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key32, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error('AES-GCM 解密失败（密钥或密文不匹配）：' + e.message);
  }
}

function encodeCursorSafeStorageV1(plaintext, key32) {
  return PREFIX_V1 + windowsAesGcmEncrypt(plaintext, key32).toString('base64');
}

/**
 * 把 state.vscdb 里的 accessToken 解析成可用的 JWT。
 * @param {string} raw
 * @param {{ dbPath?: string, localStatePath?: string, key?: Buffer }} [opts]
 *   `key` 仅供测试注入，跳过 DPAPI。
 */
function resolveAccessToken(raw, opts = {}) {
  if (!raw) return { ok: false, error: 'Cursor 未登录' };
  if (!isEncrypted(raw)) {
    if (looksJwt(raw)) return { ok: true, token: raw, encrypted: false };
    return { ok: false, error: 'Cursor 登录 token 格式不认识（非 JWT，也非 cursor-safe-storage）' };
  }
  if (!raw.startsWith(PREFIX_V1)) {
    const head = raw.slice(0, Math.min(32, raw.indexOf(':', PREFIX_ANY.length) + 1 || 32));
    return { ok: false, error: 'Cursor 加密 token 版本不支持（' + head + '…）；请升级桌宠或改用手动 Cookie' };
  }
  let blob;
  try {
    blob = Buffer.from(raw.slice(PREFIX_V1.length), 'base64');
  } catch (e) {
    return { ok: false, error: 'Cursor 加密 token 不是合法 base64：' + e.message };
  }
  if (process.platform !== 'win32' && !opts.key) {
    return {
      ok: false,
      error:
        '本机 Cursor token 已加密（cursor-safe-storage），当前平台暂不支持自动解密；请在设置里填 WorkosCursorSessionToken Cookie',
    };
  }
  try {
    const key = opts.key || loadWindowsOsCryptKey(opts.localStatePath || localStatePathFromDb(opts.dbPath || ''));
    const token = windowsAesGcmDecrypt(blob, key);
    if (!looksJwt(token)) {
      return { ok: false, error: '解密成功但结果不是 JWT（可能解错密钥）；请改用手动 Cookie' };
    }
    return { ok: true, token, encrypted: true };
  } catch (e) {
    return { ok: false, error: '解密 Cursor 登录 token 失败：' + e.message };
  }
}

function resetKeyCacheForTests() {
  keyCache.clear();
}

module.exports = {
  PREFIX_V1,
  isEncrypted,
  looksJwt,
  localStatePathFromDb,
  loadWindowsOsCryptKey,
  windowsAesGcmEncrypt,
  windowsAesGcmDecrypt,
  encodeCursorSafeStorageV1,
  resolveAccessToken,
  resetKeyCacheForTests,
};
