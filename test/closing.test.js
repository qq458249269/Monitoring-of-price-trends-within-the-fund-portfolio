'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { msUntilBeijing, beijingParts, beijingTimeStr } = require('../src/util');
const { Monitor } = require('../src/monitor');

test('beijingParts:时区安全分解(UTC 02:00 = 北京 10:00)', () => {
  // 2026-09-09T02:00:00Z = 北京时间 10:00
  const p = beijingParts(new Date('2026-09-09T02:00:00Z'));
  assert.equal(p.hour, 10);
  assert.equal(p.minute, 0);
  assert.equal(p.ymd, '2026-09-09');
  assert.equal(p.dow, 3); // 周三
});

test('msUntilBeijing:今天未到 → 今天;已过 → 明天(跳过周末)', () => {
  // 周三(2026-09-09)北京 10:00 → 14:50 还有 290 分钟
  const wed10 = new Date('2026-09-09T02:00:00Z');
  assert.equal(msUntilBeijing(14, 50, wed10), 290 * 60000);
  // 周三北京 15:00 已过 → 周四 14:50
  const wed15 = new Date('2026-09-09T07:00:00Z');
  assert.equal(msUntilBeijing(14, 50, wed15), (23 * 60 + 50) * 60000);
  // 周五 15:00 已过 → 跳过周末到周一 14:50(3 天差 10 分钟)
  const fri15 = new Date('2026-09-11T07:00:00Z');
  assert.equal(msUntilBeijing(14, 50, fri15), (3 * 1440 - 10) * 60000);
});

test('beijingTimeStr', () => {
  assert.equal(beijingTimeStr(new Date('2026-09-09T02:34:00Z')), '10:34');
});

function buildMonitor() {
  const funds = [
    { code: '000001', name: '涨基', estimate: 1.5, estimateRate: 2.1, quoteTime: '14:49:00', isNav: false },
    { code: '000002', name: '跌基', estimate: 0.8, estimateRate: -1.2, quoteTime: '14:49:00', isNav: false },
    { code: '000003', name: '无数据', estimate: null, estimateRate: null, quoteTime: '', isNav: false },
  ];
  const history = {
    '000001': [{ t: 1, e: 1.45 }, { t: 2, e: 1.48 }, { t: 3, e: 1.5 }],
    '000002': [{ t: 1, e: 0.85 }, { t: 2, e: 0.82 }, { t: 3, e: 0.8 }],
  };
  const monitor = new Monitor({
    cfg: {
      sync: { intervalMs: 60000, jitterMs: 0 },
      alertThresholds: [],
      closingReport: { enabled: true, time: '14:50', holidays: [] },
      rateLimit: {},
    },
    store: {
      getWatchlist: () => funds,
      getHistory: (code) => history[code] || [],
      updateQuote: () => {},
      appendSample: () => {},
    },
    registry: { stats: () => ({}), fetchQuotes: async () => ({ quotes: new Map(), source: 't', tried: [] }) },
    log: () => {},
  });
  return monitor;
}

test('buildClosingReport:汇总与逐只预估', () => {
  const m = buildMonitor();
  const r = m.buildClosingReport();
  assert.equal(r.total, 3);
  assert.equal(r.valid, 2);
  assert.ok(Math.abs(r.avgRate - 0.45) < 1e-9); // (2.1 + -1.2) / 2
  const up = r.items.find((x) => x.code === '000001');
  assert.equal(up.trend, 'up');
  assert.equal(up.dayHigh, 1.5);
  const down = r.items.find((x) => x.code === '000002');
  assert.equal(down.trend, 'down');
  assert.equal(down.dayLow, 0.8);
});

test('pushClosingReport:发出 closing-report 事件', () => {
  const m = buildMonitor();
  const events = [];
  m.onEvent((e) => events.push(e));
  const r = m.pushClosingReport();
  assert.equal(r.valid, 2);
  const evt = events.find((e) => e.type === 'closing-report');
  assert.ok(evt, '应有 closing-report 事件');
  assert.equal(evt.payload.items.length, 3);
});
