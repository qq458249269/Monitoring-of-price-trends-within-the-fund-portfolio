'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Monitor, computeTrend, linearSlope } = require('../src/monitor');

test('linearSlope 线性序列斜率', () => {
  assert.ok(Math.abs(linearSlope([1, 2, 3, 4]) - 1) < 1e-9);
  assert.ok(Math.abs(linearSlope([4, 3, 2, 1]) + 1) < 1e-9);
  assert.equal(linearSlope([5]), 0);
});

test('computeTrend 上升/下降/持平', () => {
  const up = computeTrend(
    [1.0, 1.01, 1.02, 1.03].map((e, i) => ({ t: i, e })), 'X', 1,
  );
  assert.equal(up.direction, 'up');
  assert.ok(up.changePct > 0);

  const down = computeTrend(
    [2.0, 1.99, 1.97].map((e, i) => ({ t: i, e })), 'X', 1,
  );
  assert.equal(down.direction, 'down');

  const flat = computeTrend([{ t: 0, e: 1.5 }], 'X', 1);
  assert.equal(flat.direction, 'flat');
  assert.equal(flat.n, 1);
});

test('Monitor 提醒去重(同阈值 30 分钟内不重复)', () => {
  const events = [];
  const cfg = { alertThresholds: [1.0], sync: { intervalMs: 60000, jitterMs: 0 }, summaryCacheMs: 0, navHistoryCacheMs: 0, rateLimit: {} };
  const m = new Monitor({
    cfg,
    store: { getWatchlist: () => [], getHistory: () => [], updateQuote: () => {}, appendSample: () => {} },
    registry: { fetchQuotes: async () => ({ quotes: new Map(), source: 't', tried: [] }), stats: () => ({}) },
    log: () => {},
  });
  m.onEvent((e) => events.push(e));

  const fund = { code: '000001', name: '测试', estimateRate: 0.5 };
  const q = { estimate: 1.01, estimateRate: 1.2, time: '', date: '', prevNav: 1.0, isNav: false };
  m.checkAlert(fund, q, 0.5, {});
  m.checkAlert(fund, q, 0.6, {});
  assert.equal(events.filter((e) => e.type === 'alert').length, 1);
});

test('Monitor 跨越阈值才提醒', () => {
  const events = [];
  const cfg = { alertThresholds: [1.0], sync: { intervalMs: 60000, jitterMs: 0 }, summaryCacheMs: 0, navHistoryCacheMs: 0, rateLimit: {} };
  const m = new Monitor({
    cfg,
    store: { getWatchlist: () => [], getHistory: () => [], updateQuote: () => {}, appendSample: () => {} },
    registry: { fetchQuotes: async () => ({ quotes: new Map(), source: 't', tried: [] }), stats: () => ({}) },
    log: () => {},
  });
  m.onEvent((e) => events.push(e));
  const fund = { code: '000001', name: '测试', estimateRate: 0.5 };
  m.checkAlert(fund, { estimate: 1.0, estimateRate: 0.9, prevNav: 1 }, 0.5, {});
  assert.equal(events.length, 0); // 未到阈值
  m.checkAlert(fund, { estimate: 1.05, estimateRate: 1.4, prevNav: 1 }, 0.9, {});
  assert.equal(events.length, 1); // 跨越 1.0
});

test('下跌只触发负阈值,且方向文案正确', () => {
  const events = [];
  const cfg = { alertThresholds: [0.5, -0.5], sync: { intervalMs: 60000, jitterMs: 0 }, summaryCacheMs: 0, navHistoryCacheMs: 0, rateLimit: {} };
  const m = new Monitor({
    cfg,
    store: { getWatchlist: () => [], getHistory: () => [], updateQuote: () => {}, appendSample: () => {} },
    registry: { fetchQuotes: async () => ({ quotes: new Map(), source: 't', tried: [] }), stats: () => ({}) },
    log: () => {},
  });
  m.onEvent((e) => events.push(e));
  const fund = { code: '000001', name: '测试' };
  // 首次同步即 -1.42%:只应命中 -0.5,不应报 +0.5
  m.checkAlert(fund, { estimate: 0.55, estimateRate: -1.42, prevNav: 0.56 }, null, {});
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.threshold, -0.5);
  assert.match(events[0].payload.message, /跌破 -0\.5%/);
  // 同阈值 30 分钟内去重
  m.checkAlert(fund, { estimate: 0.54, estimateRate: -1.5, prevNav: 0.56 }, -1.42, {});
  assert.equal(events.length, 1);
});

test('syncOnce:注册表失败时抛错且不崩溃', async () => {
  const cfg = { sync: { intervalMs: 60000, jitterMs: 0, maxFundsPerCycle: 40 }, alertThresholds: [], rateLimit: {} };
  const m = new Monitor({
    cfg,
    store: { getWatchlist: () => [{ code: '000001', name: 'x' }], getHistory: () => [], updateQuote: () => {}, appendSample: () => {} },
    registry: { fetchQuotes: async () => { throw new Error('boom'); }, stats: () => ({}) },
    log: () => {},
  });
  await assert.rejects(() => m.syncOnce());
  assert.equal(m.syncing, false); // finally 恢复
});
