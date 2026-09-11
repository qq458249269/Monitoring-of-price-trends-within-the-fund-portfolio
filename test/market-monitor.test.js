'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MarketMonitor, detectIncrementAnomaly } = require('../src/market-monitor');
const market = require('../src/sources/market');

/* ---------- detectIncrementAnomaly(累计额差分后的分钟增量检测) ---------- */

test('detectIncrementAnomaly:绝对额低于下限不告警(过滤日常波动)', () => {
  // 基线每分钟 20 亿,当前 40 亿(环比 2×,z 不够),且低于 100 亿下限
  const r = detectIncrementAnomaly(
    [200000, 200000, 200000, 200000, 200000], 400000,
    { zThreshold: 3.0, ratioThreshold: 3.2, minAmountYi: 100 },
  );
  assert.equal(r, null);
});

test('detectIncrementAnomaly:巨量脉冲触发(z 与 ratio 双高)', () => {
  // 基线 20 亿/分钟,当前 200 亿
  const r = detectIncrementAnomaly(
    [200000, 180000, 220000, 210000, 190000], 2000000,
    { zThreshold: 3.0, ratioThreshold: 3.2, minAmountYi: 100 },
  );
  assert.ok(r);
  assert.equal(r.kind, 'surge');
  assert.ok(r.zScore > 3);
  assert.ok(r.ratio > 3.2);
});

test('detectIncrementAnomaly:零方差基线 z=Infinity 但环比不足仍可触发', () => {
  const r = detectIncrementAnomaly([100000, 100000, 100000], 500000,
    { zThreshold: 3.0, ratioThreshold: 3.2, minAmountYi: 10 });
  assert.ok(r);
  assert.equal(r.zScore, Infinity);
  assert.equal(r.ratio, 5);
});

test('detectIncrementAnomaly:空基线返回 null', () => {
  assert.equal(detectIncrementAnomaly([], 5000000, { zThreshold: 3, ratioThreshold: 3.2, minAmountYi: 100 }), null);
});

/* ---------- MarketMonitor:累计额差分管道 ---------- */

/** 构造一个可注入 fake fetch 的 monitor */
function makeMonitor() {
  const m = new MarketMonitor({ cfg: { market: { indices: ['sh000001'] } }, log: () => {} });
  const events = [];
  m.onEvent((e) => events.push(e));
  m._limiter = { acquire: async () => ({ finish() {} }) };
  const feed = (cum) => {
    const orig = global.fetch;
    global.fetch = async () => ({
      ok: true,
      headers: new Map([['content-type', 'text/plain; charset=utf-8']]),
      text: async () => `var hq_str_s_sh000001="上证指数,3934.1,-0.2,-0.01,0,${cum}";`,
    });
    return () => { global.fetch = orig; };
  };
  return { m, events, feed };
}

test('MarketMonitor:累计额差分 + 预热期不出告警', async () => {
  const { m, events, feed } = makeMonitor();
  let cum = 100000;
  for (let i = 0; i < 9; i += 1) {
    cum += 200000; // 每分钟 20 亿
    const restore = feed(cum);
    await m.syncOnce();
    restore();
  }
  assert.equal(events.length, 0); // 预热期 + 温和增量:无告警
  assert.equal(m._history.get('sh000001').length, 9);
  const incs = m._history.get('sh000001').map((s) => s._inc).filter((v) => v !== undefined);
  assert.equal(incs.length, 8); // 首样本无增量
  assert.ok(incs.every((v) => v === 200000));
});

test('MarketMonitor:跨日累计额重置不产生负增量/误报', async () => {
  const { m, events, feed } = makeMonitor();
  let cum = 100000;
  for (let i = 0; i < 9; i += 1) {
    cum += 200000;
    const restore = feed(cum);
    await m.syncOnce();
    restore();
  }
  cum = 50000; // 模拟跨日:累计额骤降
  let restore = feed(cum);
  await m.syncOnce();
  restore();
  assert.equal(events.length, 0);
  cum += 400000; // 温和上涨 2 倍
  restore = feed(cum);
  await m.syncOnce();
  restore();
  assert.equal(events.length, 0); // 低于下限不告警
});

test('MarketMonitor:盘中脉冲告警一次,30 分钟内去重', async () => {
  const { m, events, feed } = makeMonitor();
  m._isTradingTime = () => true;
  let cum = 100000;
  for (let i = 0; i < 9; i += 1) {
    cum += 200000;
    const restore = feed(cum);
    await m.syncOnce();
    restore();
  }
  cum += 2000000; // 单分钟 200 亿脉冲
  let restore = feed(cum);
  await m.syncOnce();
  restore();
  assert.equal(events.length, 1);
  const p = events[0].payload;
  assert.equal(p.type, 'market-anomaly');
  assert.equal(p.amountYi, 200);
  assert.ok(p.zScore >= 3 || p.ratio >= 3.2);
  // 再来一根温和增量:去重期内不应重复告警
  cum += 200000;
  restore = feed(cum);
  await m.syncOnce();
  restore();
  assert.equal(events.length, 1);
});

/* ---------- market.fetchIndices 解析新浪 s_ 格式 ---------- */

test('market.fetchIndices 解析新浪 s_ 格式(万元累计额)', async () => {
  const payload = 'var hq_str_s_sh000001="上证指数,3094.668,-128.073,-3.97,436653,5458126";\n'
    + 'var hq_str_s_sz399001="深证成指,9876.54,123.45,1.26,555555,6666666";\n';
  const fake = {
    ok: true,
    headers: new Map([['content-type', 'text/plain']]),
    text: async () => payload,
    arrayBuffer: async () => new TextEncoder().encode(payload).buffer,
  };
  const origFetch = global.fetch;
  global.fetch = async () => fake;
  try {
    const limiter = { acquire: async () => ({ finish: () => {} }) };
    const out = await market.fetchIndices(limiter, ['sh000001', 'sz399001'], {});
    assert.equal(out.size, 2);
    const sh = out.get('sh000001');
    assert.equal(sh.price, 3094.668);
    assert.equal(sh.changePct, -3.97);
    assert.equal(sh.amount, 5458126); // 万元(当日累计)
    assert.ok(sh.name.length > 0);
  } finally {
    global.fetch = origFetch;
  }
});

/* ---------- MarketMonitor 快照/事件管道 ---------- */

test('MarketMonitor:事件管道、去重表与快照结构', () => {
  const now = Date.now();
  const arr = Array.from({ length: 11 }, (_, i) => ({ t: now - (11 - i) * 60000, price: 3000, changePct: 0.1, amountCum: 1000 + i * 100, _inc: 100 }));
  const m = new MarketMonitor({ cfg: { market: { indices: ['sh000001'] } }, log: () => {} });
  const events = [];
  m.onEvent((e) => events.push(e));
  m._history = new Map([['sh000001', arr]]);
  m.emit('alert', { type: 'market-anomaly', message: 'x' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'alert');
  m._alerted.set('sh000001', { kind: 'surge', at: now });
  assert.equal(m._alerted.get('sh000001').kind, 'surge');
  m._latest.set('sh000001', { name: '上证指数', price: 3000, changePct: 1.2, amount: 4000, updatedAt: now });
  const snap = m.snapshot();
  assert.equal(snap.indices.length, 1);
  assert.equal(snap.indices[0].name, '上证指数');
  assert.ok(Array.isArray(snap.indices[0].history));
  assert.equal(snap.indices[0].history[0].a, 0.01); // _inc=100万 → 0.01 亿
  const off = m.onEvent(() => {});
  off();
  m.emit('alert', { type: 'market-anomaly', message: 'y' });
  assert.equal(events.length, 2);
});
