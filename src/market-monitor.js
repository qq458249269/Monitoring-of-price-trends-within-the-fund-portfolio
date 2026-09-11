'use strict';

/* 全盘异动监测:跟踪主要指数成交额,检测大资金活跃度异常。
 *
 * 数据:新浪 s_ 指数行情(点位 + 成交额),随主同步循环每分钟采样。
 *      注意:接口返回的是**当日累计成交额**(万元),随时间单调递增;
 *      检测前先差分还原为"每分钟增量"。
 * 检测:每分钟成交增量相对"近 5 分钟滑动基线"的 Z-score + 环比倍数,
 *      且增量绝对值需超过 minAmountYi(亿元)过滤日常波动。
 *      阈值经 scripts/tune-market.js 用 5 分钟 K 线回放校准:
 *      z=2.5/ratio=2 时两天回放仅开盘首根触发;开盘脉冲属正常放量,
 *      因此阈值上调为 z≥3.0、ratio≥3.2、增量≥100 亿,只抓真正的盘中脉冲。
 */

const market = require('./sources/market');
const { isTradingTime } = require('./util');
const { RateLimiter } = require('./ratelimit');

const HISTORY_LIMIT = 240; // 每指数保留 240 个分钟采样(约 1 个交易日)
const BASELINE_WINDOW = 5; // 滑动基线:近 5 个增量样本(分钟)
const WARMUP_SAMPLES = 8; // 开盘预热:累计不足 8 个样本不出告警(避开开盘脉冲)

class MarketMonitor {
  constructor({ cfg, log = () => {} }) {
    this.cfg = cfg;
    this.log = log;
    this.indices = (cfg.market && cfg.market.indices) || market.DEFAULT_INDICES;
    this.timer = null;
    this.stopped = false;
    this._listeners = new Set();
    this._history = new Map(); // code -> [{t, price, changePct, amountCum}]  amountCum=当日累计额(万元)
    this._lastCum = new Map(); // code -> 上一采样当日累计额(万元)
    this._alerted = new Map(); // code -> {kind, at}
    this._latest = new Map(); // code -> 最新行情
    this.lastSyncAt = null;
    const mcfg = cfg.market || {};
    this.opts = {
      zThreshold: 3.0,
      ratioThreshold: 3.2,
      minAmountYi: 100, // 单分钟增量≥100 亿才算大资金级别
      ...mcfg.anomaly,
    };
  }

  start() {
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      const interval = (this.cfg.market && this.cfg.market.intervalMs) || 60000;
      this.timer = setTimeout(async () => {
        if (this.stopped) return;
        try {
          await this.syncOnce();
        } catch (err) {
          this.log(`全盘同步异常:${err.message}`);
        }
        tick();
      }, interval);
    };
    setTimeout(() => this.syncOnce().catch((err) => this.log(`全盘首次同步异常:${err.message}`)), 1500);
    tick();
    this.log(`全盘监测已启动:指数 ${this.indices.join(' / ')},增量异动 z≥${this.opts.zThreshold}/环比≥${this.opts.ratioThreshold}/≥${this.opts.minAmountYi}亿`);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  onEvent(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit(type, payload) {
    const evt = { type, payload, at: Date.now() };
    for (const fn of this._listeners) {
      try { fn(evt); } catch { /* ignore */ }
    }
  }

  /** 把当日累计额差分为每分钟增量;跨日/首样本返回 null */
  diffIncrement(code, amountCumWan) {
    const last = this._lastCum.get(code);
    this._lastCum.set(code, amountCumWan);
    if (last === undefined || amountCumWan < last) return null; // 首样本或跨日重置
    return amountCumWan - last; // 万元
  }

  /** 单次同步:拉指数 → 累计额差分 → 异动检测 → 推送 */
  async syncOnce() {
    // 独立限流器:新浪指数与基金估值共用同一 host,单独小配额避免抢占主源配额
    if (!this._limiter) {
      this._limiter = new RateLimiter({
        minIntervalMs: 1500,
        maxPerMinute: 10,
        backoffBaseMs: 30000,
        backoffMaxMs: 600000,
      });
    }
    const quotes = await market.fetchIndices(this._limiter, this.indices, this.cfg);
    const now = Date.now();
    this.lastSyncAt = now;
    for (const [code, q] of quotes) {
      this._latest.set(code, { ...q, updatedAt: now });
      if (!this._history.has(code)) this._history.set(code, []);
      const arr = this._history.get(code);
      arr.push({ t: now, price: q.price, changePct: q.changePct, amountCum: q.amount });
      if (arr.length > HISTORY_LIMIT) arr.splice(0, arr.length - HISTORY_LIMIT);

      const incrementWan = this.diffIncrement(code, q.amount);
      arr[arr.length - 1]._inc = incrementWan === null ? undefined : incrementWan; // 供下轮做基线
      if (incrementWan === null || incrementWan <= 0) continue; // 首样本/跨日/零成交
      if (arr.length < WARMUP_SAMPLES + 1) continue; // 预热期(含开盘脉冲过滤)

      // 收盘后不做异动提示
      const trading = isTradingTime(new Date(), (this.cfg.closingReport && this.cfg.closingReport.holidays) || []);
      if (!trading) continue;

      const increments = arr.slice(-(BASELINE_WINDOW + 1), -1).map((s) => s._inc);
      // 基线取此前 BASELINE_WINDOW 个增量;首轮样本 _inc=undefined,过滤掉
      const valid = increments.filter((v) => typeof v === 'number' && v > 0);
      const anomaly = detectIncrementAnomaly(valid, incrementWan, this.opts);

      if (!anomaly) continue;
      const key = anomaly.kind;
      const last = this._alerted.get(code);
      if (last && last.kind === key && now - last.at < 30 * 60 * 1000) continue; // 30 分钟去重
      this._alerted.set(code, { kind: key, at: now });

      const dir = q.changePct >= 0 ? 'up' : 'down';
      const dirText = dir === 'up' ? '放量上攻' : '放量下杀';
      const amountYi = (incrementWan / 10000).toFixed(0); // 万元→亿
      this.emit('alert', {
        code,
        name: q.name,
        type: 'market-anomaly',
        scope: 'market',
        direction: dir,
        amount: incrementWan,
        amountYi: Number(amountYi),
        zScore: anomaly.zScore,
        ratio: anomaly.ratio,
        message: `【全盘】${q.name} 单分钟成交 ${amountYi} 亿 ⚡${dirText}(环比 ${anomaly.ratio}×,Z=${anomaly.zScore},基线均值 ${(anomaly.mean / 10000).toFixed(0)} 亿)`,
      });
    }
    return { ok: true, updated: quotes.size, at: now };
  }

  /** 快照:供 API/前端 */
  snapshot() {
    return {
      updatedAt: this.lastSyncAt,
      indices: this.indices.map((c) => {
        const q = this._latest.get(c);
        const arr = this._history.get(c) || [];
        return {
          code: c,
          ...(q || { name: c, price: null, changePct: null, amount: null }),
          // history 返回分钟增量(亿,两位小数);缺失样本为 null
          history: arr.slice(-120).map((s) => ({
            t: s.t,
            p: s.price,
            r: s.changePct,
            a: s._inc === undefined ? null : Math.round(s._inc / 100) / 100,
          })),
        };
      }),
    };
  }
}

/** 分钟增量异动检测:Z-score(近 BASELINE_WINDOW 根)+ 环比 + 绝对额下限 */
function detectIncrementAnomaly(baselineIncrements, currentIncrementWan, { zThreshold, ratioThreshold, minAmountYi } = {}) {
  if (currentIncrementWan < minAmountYi * 10000) return null; // 绝对额过滤(万元)
  if (!baselineIncrements.length) return null;
  const mean = baselineIncrements.reduce((a, b) => a + b, 0) / baselineIncrements.length;
  if (mean <= 0) return null;
  const std = Math.sqrt(
    baselineIncrements.reduce((a, v) => a + (v - mean) ** 2, 0) / baselineIncrements.length,
  );
  const z = std > 0 ? (currentIncrementWan - mean) / std : Infinity;
  const ratio = currentIncrementWan / mean;
  if (z < zThreshold && ratio < ratioThreshold) return null;
  return {
    amount: currentIncrementWan,
    mean,
    zScore: Math.round(z * 100) / 100,
    ratio: Math.round(ratio * 100) / 100,
    kind: 'surge',
  };
}

module.exports = { MarketMonitor, detectIncrementAnomaly, BASELINE_WINDOW, WARMUP_SAMPLES };
