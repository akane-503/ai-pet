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
  let networkFailure = false;
  try {
    let r;
    try { r = await request(url, opts); } catch (e) { networkFailure = true; throw e; }
    if (r.status >= 500) throw new Error('HTTP ' + r.status);
    return r;
  } catch (e) {
    await new Promise((r) => setTimeout(r, 600));
    // Chromium 网络栈/系统代理失败时，安全的只读查询尝试 Node 网络栈。
    // POST 等请求不自动换栈重放，避免重复提交或重复计费。
    const safe = /^(GET|HEAD)$/i.test(opts.method || 'GET');
    return request(url, networkFailure && safe && !opts.useNode ? { ...opts, useNode: true } : opts);
  }
}

module.exports = { request, requestRetry };
