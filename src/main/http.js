'use strict';
// 统一的 HTTP 请求：优先用 Electron net（走 Chromium 网络栈、系统代理），失败/不可用时退回 Node fetch
const { net } = require('electron');

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, json = true, useNode = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const f = (!useNode && net && net.fetch) ? net.fetch.bind(net) : fetch;
    const res = await f(url, { method, headers, body, signal: ctrl.signal, redirect: 'follow' });
    const text = await res.text();
    let data = null;
    if (json) { try { data = JSON.parse(text); } catch (_) { data = null; } }
    return { ok: res.ok, status: res.status, text, data, headers: res.headers };
  } finally { clearTimeout(timer); }
}

// 带一次重试（网络错误 / 5xx）
async function requestRetry(url, opts = {}) {
  try {
    const r = await request(url, opts);
    if (r.status >= 500) throw new Error('HTTP ' + r.status);
    return r;
  } catch (e) {
    await new Promise((r) => setTimeout(r, 600));
    return request(url, opts);
  }
}

module.exports = { request, requestRetry };
