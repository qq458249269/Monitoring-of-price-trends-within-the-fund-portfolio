'use strict';

/* HTTP 层:REST API + SSE 实时推送 + 静态文件(public/) */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { readAsset, existsAsset } = require('./assets');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createApiHandler({ store, registry, monitor, cfg, log = () => {}, app }) {
  const publicDir = path.join(__dirname, '..', 'public');
  const sseClients = new Set();

  monitor.onEvent((evt) => {
    const msg = `event: ${evt.type}\ndata: ${JSON.stringify(evt.payload)}\n\n`;
    for (const res of sseClients) {
      try { res.write(msg); } catch { sseClients.delete(res); }
    }
  });

  async function handleApi(req, res, pathname, query) {
    try {
      if (res.writableEnded) return;
      /* ---------- SSE ---------- */
      if (pathname === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`retry: 3000\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      /* ---------- 估值/状态 ---------- */
      if (pathname === '/api/funds' && req.method === 'GET') {
        return sendJson(res, 200, { version: (app && app.version) || null, ...monitor.snapshot() });
      }
      if (pathname === '/api/funds/sync' && req.method === 'POST') {
        const r = await monitor.syncOnce();
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (pathname === '/api/funds/closing-report' && req.method === 'POST') {
        const report = monitor.pushClosingReport();
        return sendJson(res, 200, { ok: true, report });
      }
      if (pathname === '/api/funds/closing-report' && req.method === 'GET') {
        return sendJson(res, 200, monitor.buildClosingReport());
      }
      if (pathname === '/api/funds/history' && req.method === 'GET') {
        const code = query.get('code') || '';
        const limit = Math.min(1440, Math.max(1, Number(query.get('limit')) || 240));
        if (!store.hasFund(code)) return sendJson(res, 404, { error: '未关注的基金' });
        return sendJson(res, 200, { code, samples: store.getHistory(code, limit) });
      }

      /* ---------- 关注/取消关注 ---------- */
      if (pathname === '/api/funds/add' && req.method === 'POST') {
        const body = await readBody(req);
        const code = String(body.code || '').trim();
        if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { error: '基金代码需为 6 位数字' });
        let name = String(body.name || '').trim();
        if (!name) {
          try {
            const list = await registry.search(code);
            if (list.length) name = list[0].name;
          } catch { /* 忽略,回退用代码 */ }
        }
        const added = store.addFund({ code, name: name || code });
        monitor.syncOnce().catch(() => {});
        return sendJson(res, added ? 200 : 409, added
          ? { ok: true, fund: { code, name: name || code } }
          : { error: '已在关注列表' });
      }
      if (pathname === '/api/funds/remove' && req.method === 'POST') {
        const body = await readBody(req);
        const code = String(body.code || '').trim();
        if (!code) return sendJson(res, 400, { error: '缺少 code' });
        const removed = store.removeFund(code);
        return sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: '未在关注列表' });
      }
      if (pathname === '/api/funds/rename' && req.method === 'POST') {
        const body = await readBody(req);
        const code = String(body.code || '').trim();
        const name = String(body.name || '').trim();
        if (!code || !name) return sendJson(res, 400, { error: '缺少 code/name' });
        return sendJson(res, store.renameFund(code, name) ? 200 : 404, { ok: true });
      }

      /* ---------- 搜索 ---------- */
      if (pathname === '/api/search' && req.method === 'GET') {
        const kw = (query.get('q') || '').trim();
        if (kw.length < 2) return sendJson(res, 200, { results: [] });
        const results = await registry.search(kw);
        return sendJson(res, 200, { results });
      }

      /* ---------- 概要 ---------- */
      if (pathname === '/api/funds/summary' && req.method === 'GET') {
        const code = (query.get('code') || '').trim();
        if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { error: '基金代码需为 6 位数字' });
        const summary = await registry.fetchSummary(code);
        return sendJson(res, 200, summary);
      }

      /* ---------- 历史净值 ---------- */
      if (pathname === '/api/funds/nav-history' && req.method === 'GET') {
        const code = (query.get('code') || '').trim();
        const page = Math.max(1, Number(query.get('page')) || 1);
        const size = Math.min(49, Math.max(1, Number(query.get('pageSize')) || 20));
        if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { error: '基金代码需为 6 位数字' });
        const data = await registry.fetchNavHistory(code, page, size);
        return sendJson(res, 200, data);
      }

      /* ---------- 自动更新 ---------- */
      if (pathname === '/api/update' && req.method === 'GET') {
        return sendJson(res, 200, { version: (app && app.version) || null, ...(await app.checkUpdate(false)) });
      }
      if (pathname === '/api/update/apply' && req.method === 'POST') {
        const r = await app.checkUpdate(true);
        return sendJson(res, 200, { needRestart: !!(r && r.needRestart), ...r });
      }
      if (pathname === '/api/update/restart' && req.method === 'POST') {
        sendJson(res, 200, { ok: true, restarting: true });
        setTimeout(() => { app.restartIntoUpdate().catch(() => {}); }, 300);
        return;
      }

      /* ---------- 数据源/限流状态 ---------- */
      if (pathname === '/api/sources' && req.method === 'GET') {
        return sendJson(res, 200, {
          version: (app && app.version) || null,
          sources: registry.stats(),
          limiter: cfg.rateLimit,
          lastSync: monitor.lastResult,
        });
      }

      /* ---------- 手动切换估值数据源 ---------- */
      if (pathname === '/api/sources/quote' && req.method === 'GET') {
        return sendJson(res, 200, { preferred: registry.getPreferredSource(), available: ['auto', 'sina', 'tencent', 'tiantian'] });
      }
      if (pathname === '/api/sources/quote' && req.method === 'POST') {
        const body = await readBody(req);
        const name = String(body.source || '').trim();
        const ok = registry.setPreferredSource(name);
        if (!ok) return sendJson(res, 400, { error: `无效数据源:${name}` });
        // 切换后立即同步,尽快用新源拉数据
        monitor.syncOnce().catch(() => {});
        return sendJson(res, 200, { ok: true, preferred: registry.getPreferredSource() });
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      log(`API ${pathname} 错误:${err.message}`);
      if (!res.headersSent) return sendJson(res, 502, { error: `上游或处理失败:${err.message}` });
      if (!res.writableEnded) res.end();
    }
  }

  async function handler(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(u.pathname);

    if (pathname.startsWith('/api/')) {
      return handleApi(req, res, pathname, u.searchParams);
    }

    /* ---------- 静态文件 ---------- */
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep) && file !== publicDir) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    if (!existsAsset(rel)) {
      return sendJson(res, 404, { error: 'not found' });
    }
    try {
      const data = readAsset(rel);
      if (res.headersSent) return;
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch (err) {
      log(`静态文件 ${rel} 发送失败:${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'asset error' });
      else res.end();
    }
  }

  return { handler, sseClients };
}

module.exports = { createApiHandler };
