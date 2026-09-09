'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/store');
const { RateLimiter } = require('../src/ratelimit');
const { SourceRegistry } = require('../src/sources/registry');
const { Monitor } = require('../src/monitor');
const { createApiHandler } = require('../src/api');

/* 用临时目录 + fake registry,不触外网 */
function buildApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fundmon-'));
  const cfg = {
    server: { host: '127.0.0.1', port: 0 },
    sync: { intervalMs: 3600000, jitterMs: 0, maxFundsPerCycle: 40 },
    rateLimit: { minIntervalMs: 1, maxPerMinute: 1000, backoffBaseMs: 10, backoffMaxMs: 50 },
    summaryCacheMs: 1000,
    navHistoryCacheMs: 1000,
    alertThresholds: [1],
    defaults: [],
    navHistoryPoints: 90,
  };
  const store = new Store(dataDir);
  store.init();
  const limiter = new RateLimiter(cfg.rateLimit);
  const fakeRegistry = {
    fetchQuotes: async (codes) => ({
      quotes: new Map(codes.map((c) => [c, { estimate: 1.234, estimateRate: 2.5, time: '10:30:00', date: '2026-09-09', prevNav: 1.2, isNav: false }])),
      source: 'fake',
      tried: ['fake'],
    }),
    fetchSummary: async (code) => ({ code, name: `基金${code}`, returns: { m1: 1.2 }, managers: [{ name: '张三', star: 5 }] }),
    fetchNavHistory: async (code) => ({ total: 1, rows: [{ date: '2026-09-08', nav: 1.2, accNav: 2.2, dayChangePct: 0.5 }] }),
    search: async (kw) => [{ code: '000001', name: `假基金(${kw})`, type: '混合型', company: '测试', manager: '张三' }],
    stats: () => ({ quoteSources: [], summarySources: [], hosts: [] }),
  };
  const monitor = new Monitor({ store, registry: fakeRegistry, cfg, log: () => {} });
  const { handler } = createApiHandler({ store, registry: fakeRegistry, monitor, cfg, log: () => {} });
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        store,
        monitor,
        close: () => new Promise((res) => server.close(res)),
        cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
      });
    });
  });
}

async function req(port, method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('API 端到端:添加 → 快照 → 搜索 → 概要 → 历史 → 删除', async (t) => {
  const app = await buildApp();
  t.after(() => app.close().then(app.cleanup));

  // 添加非法代码
  let r = await req(app.port, 'POST', '/api/funds/add', { code: 'abc' });
  assert.equal(r.status, 400);

  // 正常添加(fake registry 立即出估值)
  r = await req(app.port, 'POST', '/api/funds/add', { code: '161725', name: '白酒' });
  assert.equal(r.status, 200);
  assert.equal(r.data.fund.name, '白酒');

  // 重复添加 409
  r = await req(app.port, 'POST', '/api/funds/add', { code: '161725' });
  assert.equal(r.status, 409);

  // 快照含估值与历史采样
  r = await req(app.port, 'GET', '/api/funds');
  assert.equal(r.status, 200);
  assert.equal(r.data.funds.length, 1);
  assert.equal(r.data.funds[0].estimate, 1.234);
  assert.ok(r.data.funds[0].history.length >= 1);

  // 搜索
  r = await req(app.port, 'GET', '/api/search?q=白酒');
  assert.equal(r.status, 200);
  assert.equal(r.data.results[0].code, '000001');

  // 概要
  r = await req(app.port, 'GET', '/api/funds/summary?code=161725');
  assert.equal(r.status, 200);
  assert.equal(r.data.name, '基金161725');

  // 历史净值
  r = await req(app.port, 'GET', '/api/funds/nav-history?code=161725');
  assert.equal(r.status, 200);
  assert.equal(r.data.rows[0].nav, 1.2);

  // 采样历史
  r = await req(app.port, 'GET', '/api/funds/history?code=161725');
  assert.equal(r.status, 200);
  assert.ok(r.data.samples.length >= 1);

  // 未关注基金的历史 → 404
  r = await req(app.port, 'GET', '/api/funds/history?code=999999');
  assert.equal(r.status, 404);

  // 改名
  r = await req(app.port, 'POST', '/api/funds/rename', { code: '161725', name: '酱香' });
  assert.equal(r.status, 200);
  r = await req(app.port, 'GET', '/api/funds');
  assert.equal(r.data.funds[0].name, '酱香');

  // 删除
  r = await req(app.port, 'POST', '/api/funds/remove', { code: '161725' });
  assert.equal(r.status, 200);
  r = await req(app.port, 'POST', '/api/funds/remove', { code: '161725' });
  assert.equal(r.status, 404);

  // sources
  r = await req(app.port, 'GET', '/api/sources');
  assert.equal(r.status, 200);
  assert.ok('quoteSources' in r.data.sources);
});

test('静态文件与路径穿越防护', async (t) => {
  const app = await buildApp();
  t.after(() => app.close().then(app.cleanup));

  let res = await fetch(`http://127.0.0.1:${app.port}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /基金估值趋势监测/);

  // fetch 会规范化 /../,用原始 socket 发未规范化路径验证服务端行为
  // WHATWG URL 把 /../ 与 /%2e%2e/ 都规范化掉 → 404
  assert.equal(await rawGet(app.port, '/../config.json'), 404);
  assert.equal(await rawGet(app.port, '/%2e%2e/config.json'), 404);
  // %2f 在 URL 解析中保留,handler 解码后命中 public/ 前缀检查 → 403
  assert.equal(await rawGet(app.port, '/..%2fconfig.json'), 403);
  // Windows 反斜杠穿越(%5c)同样绝不能读到文件
  const bs = await rawGet(app.port, '/..%5cconfig.json');
  assert.ok(bs === 403 || bs === 404, `backslash traversal 应被拦截,实际 ${bs}`);

  // 规范化后的 /config.json 不在 public/ 下 → 404
  res = await fetch(`http://127.0.0.1:${app.port}/config.json`);
  assert.equal(res.status, 404);
});

function rawGet(port, reqPath) {
  const net = require('net');
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${reqPath} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString(); });
    sock.on('end', () => {
      const m = buf.match(/^HTTP\/1\.[01] (\d+)/);
      resolve(m ? Number(m[1]) : 0);
    });
    sock.on('error', () => resolve(0));
  });
}

test('Store 持久化往返', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fundstore-'));
  const s1 = new Store(dataDir);
  s1.init();
  s1.addFund({ code: '000001', name: 'A' });
  s1.appendSample('000001', { t: 1, e: 1.1, r: 0.1 });
  s1.close();

  const s2 = new Store(dataDir);
  s2.init();
  assert.equal(s2.getWatchlist().length, 1);
  assert.equal(s2.getWatchlist()[0].name, 'A');
  assert.equal(s2.getHistory('000001')[0].e, 1.1);
  assert.equal(s2.removeFund('000001'), true);
  s2.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('RateLimiter 最小间隔生效', async () => {
  const rl = new RateLimiter({ minIntervalMs: 60, maxPerMinute: 1000, backoffBaseMs: 10, backoffMaxMs: 20 });
  const t0 = Date.now();
  const h1 = await rl.acquire('h');
  h1.finish(true, 1);
  const h2 = await rl.acquire('h');
  h2.finish(true, 1);
  assert.ok(Date.now() - t0 >= 55, `两次请求间隔应 ≥55ms,实际 ${Date.now() - t0}ms`);
});
