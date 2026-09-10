'use strict';

/* 监测器:每分钟(±抖动)同步估值 → 采样 → 趋势计算 → 阈值提醒 → SSE 推送 */

const { jitter, msUntilBeijing, beijingTimeStr } = require('./util');

/** 检测估值序列中的异常波动点(大额资金异动信号,Z-score)**/
function detectAnomalies(samples, threshold = 2) {
  const vals = samples.filter((s) => typeof s.e === 'number' && s.e !== null);
  if (vals.length < 8) return [];
  const mean = vals.reduce((a, b) => a + b.e, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((a, v) => a + (v.e - mean) ** 2, 0) / vals.length);
  if (std === 0) return [];
  const out = [];
  for (let i = 0; i < vals.length; i += 1) {
    const z = (vals[i].e - mean) / std;
    if (Math.abs(z) >= threshold) {
      out.push({
        at: vals[i].t,
        value: vals[i].e,
        zScore: Math.round(z * 100) / 100,
        direction: z > 0 ? 'up' : 'down',
        magnitude: Math.abs(z),
      });
    }
  }
  return out;
}

/** 最小二乘斜率(x=采样序号, y=估值),返回“每采样步”变化量 */
function linearSlope(ys) {
  const n = ys.length;
  if (n < 2) return 0;
  const sx = ((n - 1) * n) / 2;
  const sxx = ((n - 1) * n * (2 * n - 1)) / 6;
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxy = ys.reduce((a, y, i) => a + i * y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

function computeTrend(samples, code, now) {
  const pts = samples.filter((s) => typeof s.e === 'number' && s.e !== null);
  if (pts.length < 2) {
    return { code, n: pts.length, direction: 'flat', changePct: 0, slope: 0, first: null, last: null, high: null, low: null, at: now };
  }
  const vals = pts.map((p) => p.e);
  const first = vals[0];
  const last = vals[vals.length - 1];
  const high = Math.max(...vals);
  const low = Math.min(...vals);
  const slope = linearSlope(vals);
  const changePct = first !== 0 ? ((last - first) / first) * 100 : 0;
  let direction = 'flat';
  if (changePct > 0.05 || slope > 0) direction = 'up';
  else if (changePct < -0.05 || slope < 0) direction = 'down';
  return {
    code,
    n: pts.length,
    direction,
    changePct: Math.round(changePct * 100) / 100,
    slope: Math.round(slope * 1e6) / 1e6,
    first,
    last,
    high,
    low,
    at: now,
  };
}

class Monitor {
  constructor({ store, registry, cfg, log = () => {} }) {
    this.store = store;
    this.registry = registry;
    this.cfg = cfg;
    this.log = log;
    this.timer = null;
    this.stopped = false;
    this.syncing = false;
    this.lastSyncAt = null;
    this.lastResult = null;
    this.alertThresholds = cfg.alertThresholds || [];
    this._listeners = new Set();
    this._alerted = new Map(); // code -> {key, at} 同一提醒 30 分钟内不重复
    this.closingReport = cfg.closingReport || { enabled: true, time: '14:50' };
    this._reportTimer = null;
    this._lastReportDay = null; // 北京时间 YYYY-MM-DD,防重复推送
  }

  start() {
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      const delay = jitter(this.cfg.sync.intervalMs + this.cfg.sync.jitterMs);
      this.timer = setTimeout(async () => {
        if (this.stopped) return;
        try {
          await this.syncOnce();
        } catch (err) {
          this.log(`同步异常:${err.message}`);
        }
        tick();
      }, delay);
    };
    // 启动即先同步一次
    setTimeout(() => {
      this.syncOnce().catch((err) => this.log(`首次同步异常:${err.message}`));
    }, 500);
    tick();
    if (this.closingReport.enabled !== false) this.scheduleClosingReport();
    this.log(`监测已启动:每 ${Math.round(this.cfg.sync.intervalMs / 1000)}s ±抖动 同步一次` +
      (this.closingReport.enabled !== false ? `,收盘预估推送 ${this.closingReport.time}(北京时间)` : ''));
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this._reportTimer) clearTimeout(this._reportTimer);
  }

  onEvent(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit(type, payload) {
    const evt = { type, payload, at: Date.now() };
    for (const fn of this._listeners) {
      try { fn(evt); } catch { /* listener 异常不影响主流程 */ }
    }
  }

  /** 单次同步:分批拉估值 → 更新状态/采样/趋势 → 提醒 → 推送 */
  async syncOnce() {
    if (this.syncing) return { skipped: true };
    this.syncing = true;
    const started = Date.now();
    try {
      const watch = this.store.getWatchlist();
      const codes = watch.map((f) => f.code).slice(0, this.cfg.sync.maxFundsPerCycle);
      if (!codes.length) {
        this.lastSyncAt = Date.now();
        this.lastResult = { ok: true, updated: 0, at: this.lastSyncAt };
        return this.lastResult;
      }

      const { quotes, source, tried } = await this.registry.fetchQuotes(codes);
      const now = Date.now();
      let updated = 0;
      const trends = [];

      for (const fund of watch) {
        const q = quotes.get(fund.code);
        if (!q) continue;
        const prevRate = fund.estimateRate;
        const fields = {
          estimate: q.estimate,
          estimateRate: q.estimateRate,
          prevNav: q.prevNav ?? null,
          quoteTime: q.time || '',
          quoteDate: q.date || '',
          isNav: !!q.isNav,
          source,
          updatedAt: now,
        };
        this.store.updateQuote(fund.code, fields);
        this.store.appendSample(fund.code, {
          t: now,
          e: q.estimate,
          r: q.estimateRate,
        });
        updated += 1;

        const trend = computeTrend(this.store.getHistory(fund.code, 60), fund.code, now);
        trends.push(trend);
        this.checkAlert(fund, q, prevRate, trend);
        this.checkAnomaly(fund);
      }

      this.lastSyncAt = now;
      this.lastResult = { ok: true, updated, source, tried, durationMs: Date.now() - started, at: now };
      this.emit('tick', {
        quotes: watch.filter((f) => quotes.has(f.code)).map((f) => this.quoteView(f)),
        trends,
        meta: { source, tried, durationMs: this.lastResult.durationMs },
      });
      return this.lastResult;
    } finally {
      this.syncing = false;
    }
  }

  /** 估值涨跌幅跨越阈值时提醒(取幅度最大命中;同方向同阈值 30 分钟内去重) */
  checkAlert(fund, quote, prevRate, trend) {
    const rate = quote.estimateRate;
    if (rate === null || rate === undefined) return;
    let hit = null;
    for (const th of this.alertThresholds) {
      let crossed;
      if (prevRate === null || prevRate === undefined) {
        // 首次同步:按涨跌方向匹配同号阈值,避免下跌报“+0.5%”
        crossed = rate >= 0 ? (th > 0 && rate >= th) : (th < 0 && rate <= th);
      } else {
        crossed = (prevRate < th && rate >= th) || (prevRate > th && rate <= th);
      }
      if (crossed && (hit === null || Math.abs(th) > Math.abs(hit))) hit = th;
    }
    if (hit === null) return;
    const key = `${fund.code}:${hit > 0 ? '+' : ''}${hit}`;
    const last = this._alerted.get(fund.code);
    if (last && last.key === key && Date.now() - last.at < 30 * 60 * 1000) return;
    this._alerted.set(fund.code, { key, at: Date.now() });
    this.emit('alert', {
      code: fund.code,
      name: fund.name,
      threshold: hit,
      estimateRate: rate,
      estimate: quote.estimate,
      direction: rate >= 0 ? 'up' : 'down',
      message: `${fund.name}(${fund.code}) 估值 ${rate >= 0 ? '+' : ''}${rate}% ${rate >= 0 ? '涨' : '跌'}破 ${hit > 0 ? '+' : ''}${hit}% 阈值`,
    });
  }

  /** 大额资金异动检测:基于分钟级采样 Z-score 异常值,自动推送事件 */
  checkAnomaly(fund) {
    const history = this.store.getHistory(fund.code, 30);
    const anomalies = detectAnomalies(history, 2.5);
    if (!anomalies.length) return;
    const latest = anomalies[anomalies.length - 1];
    const last = this._alerted.get(fund.code);
    const key = `${fund.code}:anomaly:${latest.direction}`;
    if (last && last.key === key && Date.now() - last.at < 15 * 60 * 1000) return;
    this._alerted.set(fund.code, { key, at: Date.now() });
    this.emit('alert', {
      code: fund.code,
      name: fund.name,
      threshold: null,
      estimateRate: fund.estimateRate,
      estimate: fund.estimate,
      direction: latest.direction,
      zScore: latest.zScore,
      magnitude: latest.magnitude,
      at: latest.at,
      message: `${fund.name}(${fund.code}) ⚡ 估值${latest.direction === 'up' ? '突增' : '急跌'} ${latest.zScore > 0 ? '+' : ''}${latest.zScore}σ(幅度 ${latest.magnitude.toFixed(1)}σ)`,
      type: 'anomaly',
    });
  }

  /**
   * 收盘预估报告:尾盘(默认 14:50 北京时间)推送关注基金的预估当日涨跌。
   * 数据取最近一次同步的估值/涨跌幅,并给出日内趋势。
   */
  buildClosingReport() {
    const watch = this.store.getWatchlist();
    const items = watch.map((f) => {
      const history = this.store.getHistory(f.code, 60);
      const trend = computeTrend(history, f.code, Date.now());
      return {
        code: f.code,
        name: f.name,
        estimate: f.estimate ?? null,
        estimateRate: f.estimateRate ?? null,
        quoteTime: f.quoteTime || '',
        isNav: !!f.isNav,
        trend: trend.direction,
        dayHigh: trend.high,
        dayLow: trend.low,
      };
    });
    const valid = items.filter((x) => x.estimateRate !== null && x.estimateRate !== undefined);
    return {
      at: Date.now(),
      time: beijingTimeStr(new Date()),
      total: items.length,
      valid: valid.length,
      avgRate: valid.length
        ? Math.round((valid.reduce((a, x) => a + x.estimateRate, 0) / valid.length) * 100) / 100
        : null,
      items,
    };
  }

  /** 推送收盘预估(SSE + 事件流) */
  pushClosingReport() {
    const report = this.buildClosingReport();
    const up = report.items.filter((x) => (x.estimateRate || 0) > 0).length;
    const down = report.items.filter((x) => (x.estimateRate || 0) < 0).length;
    const flat = report.valid - up - down;
    this.emit('closing-report', report);
    this.log(`收盘预估已推送:关注 ${report.total} 只,预估涨 ${up} / 跌 ${down} / 平 ${flat},平均 ${report.avgRate === null ? '--' : report.avgRate + '%'}`);
    return report;
  }

  /** 调度:每个交易日北京时间 closingReport.time(默认 14:50)推送一次 */
  scheduleClosingReport() {
    if (this.stopped) return;
    const [h, m] = String(this.closingReport.time || '14:50').split(':').map(Number);
    const holidays = this.closingReport.holidays || [];
    const delay = msUntilBeijing(h, m, new Date(), holidays);
    this._reportTimer = setTimeout(async () => {
      if (this.stopped) return;
      try {
        // 推送前先强制同步一次,保证预估用的是最新估值
        await this.syncOnce();
      } catch (err) {
        this.log(`收盘预估前同步失败:${err.message}`);
      }
      this.pushClosingReport();
      // 排下一天(已含周末/节假日跳过)
      this.scheduleClosingReport();
    }, delay);
    const at = new Date(Date.now() + delay);
    this.log(`收盘预估已排程:北京时间 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}(约 ${Math.round(delay / 60000)} 分钟后,${beijingTimeStr(at)})`);
  }

  /** 单只基金对前端的完整视图 */
  quoteView(fund) {
    const history = this.store.getHistory(fund.code, 240);
    return {
      code: fund.code,
      name: fund.name,
      estimate: fund.estimate ?? null,
      estimateRate: fund.estimateRate ?? null,
      prevNav: fund.prevNav ?? null,
      quoteTime: fund.quoteTime || '',
      isNav: !!fund.isNav,
      source: fund.source || '',
      updatedAt: fund.updatedAt || null,
      history: history.map((s) => ({ t: s.t, e: s.e, r: s.r })),
    };
  }

  snapshot() {
    const watch = this.store.getWatchlist();
    return {
      updatedAt: this.lastSyncAt,
      lastResult: this.lastResult,
      funds: watch.map((f) => this.quoteView(f)),
      sources: this.registry.stats(),
      closingReport: { enabled: this.closingReport.enabled !== false, time: this.closingReport.time || '14:50' },
    };
  }
}

module.exports = { Monitor, computeTrend, linearSlope };
