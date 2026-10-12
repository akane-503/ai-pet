'use strict';
// 资讯：RSS/Atom 订阅（可选），用于“模型上新/公告”提醒
const { request } = require('./http');

function parseFeed(xml) {
  const items = [];
  const grab = (block, tag) => { const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() : ''; };
  const linkOf = (block) => { const a = /<link[^>]*href="([^"]+)"/i.exec(block); if (a) return a[1]; const l = grab(block, 'link'); return l; };
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, 30)) {
    const title = grab(b, 'title');
    const id = grab(b, 'guid') || grab(b, 'id') || linkOf(b) || title;
    items.push({ id, title, link: linkOf(b), date: grab(b, 'pubDate') || grab(b, 'updated') || grab(b, 'published') });
  }
  return items;
}

async function checkFeeds(feeds, seenMap, notifyCfg) {
  const events = [];
  const seen = { ...(seenMap || {}) };
  for (const f of feeds || []) {
    if (!f || !f.url || f.enabled === false) continue;
    try {
      const r = await request(f.url, { timeoutMs: 20000, json: false });
      if (!r.ok) continue;
      const items = parseFeed(r.text);
      if (!items.length) continue;
      const prev = seen[f.url];
      const ids = items.map((i) => i.id);
      if (Array.isArray(prev)) {
        const ps = new Set(prev);
        const fresh = items.filter((i) => !ps.has(i.id)).slice(0, 3);
        for (const i of fresh) events.push({ kind: 'rss', title: `📰 ${f.name || '资讯'}`, body: i.title, link: i.link });
        seen[f.url] = Array.from(new Set([...prev, ...ids])).slice(-300);
      } else seen[f.url] = ids;
    } catch (_) { /* ignore */ }
  }
  return { events: notifyCfg.rss ? events : [], seen };
}

module.exports = { checkFeeds, parseFeed };
