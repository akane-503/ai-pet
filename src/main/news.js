'use strict';
const { request } = require('./http');
const PRESETS = [
  { name: 'Codex 正式版', url: 'https://github.com/openai/codex/releases.atom', type: 'release' },
  { name: 'Claude Code 正式版', url: 'https://github.com/anthropics/claude-code/releases.atom', type: 'release' },
  { name: 'Gemini CLI 正式版', url: 'https://github.com/google-gemini/gemini-cli/releases.atom', type: 'release' },
  { name: 'Tibo · OpenAI（X 第三方转录）', url: 'https://x.noodl3.net/thsottiaux/rss', type: 'tibo' },
];
function decode(s) {
  return String(s).replace(/&(?:amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (m, d, h) => {
    if (d || h) { const n = parseInt(d || h, h ? 16 : 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[m.toLowerCase()] || m;
  });
}
const safeLink = s => { try { const u = new URL(decode(s)); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : ''; } catch (_) { return ''; } };
function parseFeed(xml) {
  const grab = (block, tag) => {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
    return m ? decode(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')).trim() : '';
  };
  const linkOf = block => {
    const links = block.match(/<link\b[^>]*>/gi) || [];
    for (const l of links) {
      if (/\brel=['"](?:self|enclosure)['"]/i.test(l)) continue;
      const m = /\bhref=['"]([^'"]+)['"]/i.exec(l); if (m) return safeLink(m[1]);
    }
    return safeLink(grab(block, 'link'));
  };
  return (String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || String(xml).match(/<entry\b[\s\S]*?<\/entry>/gi) || []).slice(0, 60).map(b => ({
    id: grab(b, 'guid') || grab(b, 'id') || linkOf(b) || grab(b, 'title'), title: grab(b, 'title'), link: linkOf(b),
    date: grab(b, 'pubDate') || grab(b, 'published') || grab(b, 'updated'),
  })).filter(i => i.id && i.title);
}
function feedsFor(cfg = {}) {
  const feeds = [...(cfg.toolNews ? PRESETS : []), ...(cfg.rss ? cfg.rssFeeds || [] : [])];
  return [...new Map(feeds.filter(f => f && f.enabled !== false && safeLink(f.url)).map(f => [f.url, f])).values()];
}
function cleanPost(s) { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > 280 ? t.slice(0, 280) + '…' : t; }
function eventFor(item, feed, now) {
  if (feed.type) {
    const date = Date.parse(item.date);
    if (!Number.isFinite(date) || now - date > 48 * 3600e3 || date > now + 5 * 60000) return null;
  }
  if (feed.type === 'release' && /(?:^|[\W_])(?:alpha|beta|rc\d*|preview|nightly|canary|dev)(?:$|[\W_])/i.test(item.title)) return null;
  let kind = 'rss', title = `📰 ${feed.name || '资讯'}`, link = item.link;
  if (feed.type === 'release') { kind = 'tool-update'; title = `🆕 ${feed.name}发布`; }
  if (feed.type === 'tibo') {
    // Only link back to this author's actual post. No forecasting or account-quota changes.
    const text = String(item.title || '');
    // 转录源会把「R to @thsottiaux」这类转推/回复也收进来：要么和原帖重复要么是玩梗，没有独立信息量
    if (/^\s*(?:qt|rt)?\s*r?\s*to\s+@/i.test(text) || /^\s*(?:rt|qt)\s*[:@]/i.test(text)) return null;
    const post = /^https:\/\/(?:x\.noodl3\.net|x\.com|twitter\.com)\/thsottiaux\/status\/(\d+)/i.exec(link);
    if (!post) return null;
    link = 'https://x.com/thsottiaux/status/' + post[1];
    // 分诊：帖子说了什么，标题就说什么；额度类附上自己账号的对照（main 落通知前补 accountHint）
    const quotaWord = /\b(?:usage|limits?|rate)\b|\b(?:credits?|tokens?)\b|重置|额度/i;
    const bump = /\b(?:doubl\w*|trippl\w*|increas\w*|rais\w*|boost\w*|bonus|extra|gift\w*|grant\w*|sent|add\w*|more)\b/i.test(text) && quotaWord.test(text);
    const reset = /\breset\w*\b|重置/i.test(text);
    const outage = /\b(?:outage|degrad\w*|incident\w*|overloaded|rate[ -]?limited)\b/i.test(text);
    const model = /\b(?:model\w*|codex|chatgpt|gpt[ -]?\d|terra|sol|astra|luna|launch\w*|releas\w*)\b|模型|发布/i.test(text);
    if (!bump && !reset && !outage && !model && !quotaWord.test(text)) return null;
    kind = 'quota-news';
    let accountHint = 'codex';
    if (bump) title = '🎁 Tibo：可能加量 / 送额度（待账户确认）';
    else if (reset) title = '⏰ Tibo：预告重置（待账户确认）';
    else if (outage) title = '⚠️ Tibo：故障 / 限速动态';
    else if (model && !quotaWord.test(text)) { kind = 'model-news'; title = '🆕 Tibo：模型 / 工具动态'; accountHint = null; }
    else title = '📣 Tibo 动态（待账户确认）';
    return { kind, eventKey: `news:${feed.url}:${item.id}`, title, body: `${cleanPost(text)}\nX 第三方转录；原帖说明不代表你的额度已重置。`, link, accountHint };
  }
  return { kind, eventKey: `news:${feed.url}:${item.id}`, title, body: `${item.title.slice(0, 220)}${feed.type === 'tibo' ? '\nX 第三方转录；原帖说明不代表你的额度已重置。' : ''}`, link };
}

// 额度类 Tibo 动态推送时，附上自己账号的当前状态：预告归预告，账号归账号，别让人以为帖子=自己额度变了
function accountStatusLine(snapshots, providers, hint) {
  const p = (providers || []).find((x) => x && x.enabled && x.type === hint);
  if (!p) return '';
  const s = snapshots && snapshots[p.id];
  if (!s || !s.ok) return `你的 ${p.name}：暂时读不到额度数据，稍后自动重试再对照`;
  const fmtLeft = (sec) => { const v = Math.max(0, sec); const d = Math.floor(v / 86400), h = Math.floor((v % 86400) / 3600), m = Math.floor((v % 3600) / 60); return d ? `${d}天${h}h` : h ? `${h}h${m}m` : `${m}m`; };
  const parts = (s.windows || []).map((w) => `${w.label}已用 ${Math.round(w.usedPercent)}%` + (w.resetsAt ? `（${fmtLeft(w.resetsAt - Date.now() / 1000)}后重置）` : ''));
  if (s.balance !== null && s.balance !== undefined) parts.push(`余额 ${s.balance}`);
  const prefix = s.stale ? `你的 ${p.name}（刚刷新失败，旧值）：` : `你的 ${p.name}：`;
  return parts.length ? prefix + parts.join(' · ') + '（以你的接口为准）' : `${p.name} 已启用，暂无额度窗口（以你的接口为准）`;
}
async function checkFeeds(feeds, seenMap, notifyCfg = {}, { fetch = request, now = Date.now() } = {}) {
  const events = [], seen = { ...(seenMap || {}) }, status = {};
  await Promise.all((feeds || []).filter(f => f && f.enabled !== false && safeLink(f.url)).slice(0, 20).map(async f => {
    const s = { name: f.name || '资讯', at: now, ok: false };
    status[f.url] = s;
    try {
      const r = await fetch(f.url, { timeoutMs: 12000, json: false });
      if (!r.ok) throw Error('HTTP ' + r.status);
      const items = parseFeed(r.text);
      if (!items.length) throw Error('没有可读的 RSS / Atom 条目');
      s.ok = true; s.latest = items[0].date; s.count = items.length;
      const latest = Date.parse(s.latest); s.stale = Number.isFinite(latest) && now - latest > 7 * 86400e3;
      const prev = seen[f.url];
      if (Array.isArray(prev)) {
        const old = new Set(prev), fresh = items.filter(i => !old.has(i.id)).map(i => eventFor(i, f, now)).filter(Boolean).slice(0, 3);
        if (f.type ? notifyCfg.toolNews : notifyCfg.rss) events.push(...fresh);
      }
      seen[f.url] = [...new Set([...items.map(i => i.id), ...(prev || [])])].slice(0, 500);
    } catch (e) { s.error = e.name === 'AbortError' ? '连接超时' : e.message; }
  }));
  return { events, seen, status };
}
module.exports = { checkFeeds, parseFeed, feedsFor, eventFor, accountStatusLine, PRESETS };
