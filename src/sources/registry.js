'use strict';

/* 数据源注册表:估值多源轮询负载均衡 + 失败退避 + 概要缓存 */

const sina = require('./sina');
const tencent = require('./tencent');
const tencent_enhanced = require('./tencent_enhanced');
const tiantian = require('./tiantian');
const eastmoney = require('./eastmoney');
const danjuan = require('./danjuan');
const { Backoff } = require('../ratelimit');
const { toNumber } = require('../util');

/** 估值源适配为统一 {estimate, estimateRate, time, date, prevNav} 结构 */
const QUOTE_SOURCES = [
  {
    name: 'sina',
    fetch: async (limiter, codes, cfg) => {
      const raw = await sina.fetchQuotes(limiter, codes, cfg);
      const out = new Map();
      for (const [code, q] of raw) {
        out.set(code, { ...q, isNav: false });
      }
      return out;
    },
  },
  {
    name: 'tencent',
    fetch: async (limiter, codes, cfg) => {
      const raw = await tencent_enhanced.fetchQuotes(limiter, codes, cfg);
      const out = new Map();
      for (const [code, q] of raw) {
        out.set(code, { ...q });
      }
      return out;
    },
  },
  // 天天基金 fundgz.1234567.com.cn 已下线(返回 404 页),移除避免每轮尝试拉垮同步;ponytail: 接口恢复后在此加回
  // {
  //   name: 'tiantian',
  //   fetch: async (limiter, codes, cfg) => {
  //     const raw = await tiantian.fetchQuotes(limiter, codes, cfg);
  //     const out = new Map();
  //     for (const [code, q] of raw) {
  //       out.set(code, { ...q, isNav: false });
  //     }
  //     return out;
  //   },
  // },
];

class SourceRegistry {
  constructor(limiter, cfg, log = () => {}) {
    this.limiter = limiter;
    this.cfg = cfg;
    this.log = log;
    this.rr = 0; // 轮询游标(负载均衡)
    this.quoteBackoffs = new Map(); // name -> Backoff
    this.summaryBackoff = new Backoff({ baseMs: cfg.rateLimit.backoffBaseMs, maxMs: cfg.rateLimit.backoffMaxMs });
    this.danjuanBackoff = new Backoff({ baseMs: cfg.rateLimit.backoffBaseMs, maxMs: cfg.rateLimit.backoffMaxMs });
    this.summaryCache = new Map(); // code -> {at, data}
    this.navHistoryCache = new Map(); // code -> {at, data}
    // 手动指定估值源:'auto' 表示轮询负载均衡,否则为具体源名
    this.preferredSource = (cfg && cfg.quoteSource) || 'auto';
  }

  /** 设置首选估值源('auto' | 'sina' | 'tencent' | 'tiantian') */
  setPreferredSource(name) {
    const valid = ['auto', ...QUOTE_SOURCES.map((s) => s.name)];
    if (!valid.includes(name)) return false;
    this.preferredSource = name;
    return true;
  }

  /** 可用估值源列表(前端下拉框选项) */
  getAvailableSources() {
    return ['auto', ...QUOTE_SOURCES.map((s) => s.name)];
  }

  getPreferredSource() {
    return this.preferredSource;
  }

  _quoteBackoff(name) {
    let b = this.quoteBackoffs.get(name);
    if (!b) {
      b = new Backoff({ baseMs: this.cfg.rateLimit.backoffBaseMs, maxMs: this.cfg.rateLimit.backoffMaxMs });
      this.quoteBackoffs.set(name, b);
    }
    return b;
  }

  /**
   * 拉取估值:按健康度轮询顺序尝试多个源,单源失败自动切换下一个。
   * @returns {{quotes: Map, source: string, tried: string[]}}
   */
  async fetchQuotes(codes) {
    const n = QUOTE_SOURCES.length;
    // 手动指定源:优先尝试它,失败再按轮询顺序回退其余源
    const order = [];
    const manual = this.preferredSource !== 'auto'
      ? QUOTE_SOURCES.find((s) => s.name === this.preferredSource)
      : null;
    if (manual) order.push(manual);
    for (let i = 0; i < n; i += 1) {
      const src = QUOTE_SOURCES[(this.rr + i) % n];
      if (!order.includes(src)) order.push(src);
    }
    if (!manual) this.rr = (this.rr + 1) % n; // 下次从下一源开始,均匀分摊请求

    const tried = [];
    let lastErr = null;
    for (const src of order) {
      const bo = this._quoteBackoff(src.name);
      if (!bo.available) {
        tried.push(`${src.name}(退避${Math.ceil(bo.remainingMs / 1000)}s)`);
        continue;
      }
      tried.push(src.name);
      try {
        const quotes = await src.fetch(this.limiter, codes, this.cfg);
        bo.succeed();
        return { quotes, source: src.name, tried };
      } catch (err) {
        lastErr = err;
        bo.fail();
        this.log(`估值源 ${src.name} 失败:${err.message},尝试下一源`);
      }
    }
    throw new Error(`全部估值源失败(${tried.join(' → ')}):${lastErr ? lastErr.message : 'unknown'}`);
  }

  /** 概要信息:蛋卷优先,东财 pingzhongdata 兜底,双源字段合并;TTL 缓存 */
  async fetchSummary(code) {
    const cached = this.summaryCache.get(code);
    if (cached && Date.now() - cached.at < this.cfg.summaryCacheMs) return cached.data;

    let dj = null;
    if (this.danjuanBackoff.available) {
      try {
        dj = await danjuan.fetchDetail(this.limiter, code, this.cfg);
        this.danjuanBackoff.succeed();
      } catch (err) {
        this.danjuanBackoff.fail();
        this.log(`蛋卷概要 ${code} 失败:${err.message},改用东财`);
      }
    }

    let em = null;
    if (this.summaryBackoff.available) {
      try {
        em = await eastmoney.fetchSummary(this.limiter, code, this.cfg);
        this.summaryBackoff.succeed();
      } catch (err) {
        this.summaryBackoff.fail();
        this.log(`东财概要 ${code} 失败:${err.message}`);
      }
    }

    if (!dj && !em) throw new Error(`概要源全部失败:${code}`);

    const emReturns = em && em.returns ? em.returns : {};
    const merged = {
      source: dj ? 'danjuan+eastmoney' : 'eastmoney',
      code,
      name: (dj && dj.name) || (em && em.name) || '',
      fullName: (dj && dj.fullName) || '',
      company: (dj && dj.company) || '',
      manager: (dj && dj.manager) || (em && em.managers && em.managers.map((m) => m.name).join('、')) || '',
      managers: (em && em.managers) || [],
      custodian: (dj && dj.custodian) || '',
      foundDate: (dj && dj.foundDate) || '',
      riskLevel: (dj && dj.riskLevel) ?? null,
      scale: (dj && dj.scale) || '',
      rate: (em && em.rate) || '',
      minBuy: (em && em.minBuy) || (dj && dj.scale ? undefined : ''),
      returns: {
        m1: (dj && dj.returns && dj.returns.m1) ?? numOr(emReturns.m1),
        m3: (dj && dj.returns && dj.returns.m3) ?? numOr(emReturns.y3m),
        m6: (dj && dj.returns && dj.returns.m6) ?? numOr(emReturns.y6m),
        y1: (dj && dj.returns && dj.returns.y1) ?? numOr(emReturns.y1),
      },
      stockCodes: (em && em.stockCodes) || [],
      holderStructure: (em && em.holderStructure) || [],
      assetAllocation: (em && em.assetAllocation) || null,
      nav: (dj && dj.nav) ?? null,
      navDate: (dj && dj.navDate) || '',
      dayChangePct: (dj && dj.dayChangePct) ?? null,
      navHistory: (em && em.navHistory) || [],
    };

    this.summaryCache.set(code, { at: Date.now(), data: merged });
    return merged;
  }

  /** 历史净值(东财 f10),TTL 缓存 */
  async fetchNavHistory(code, page = 1, pageSize = 20) {
    const key = `${code}:${page}:${pageSize}`;
    const cached = this.navHistoryCache.get(key);
    if (cached && Date.now() - cached.at < this.cfg.navHistoryCacheMs) return cached.data;
    const data = await eastmoney.fetchNavHistory(this.limiter, code, this.cfg, page, pageSize);
    this.navHistoryCache.set(key, { at: Date.now(), data });
    return data;
  }

  /** 基金搜索(东财联想接口,含防抖由前端负责) */
  async search(keyword) {
    return eastmoney.searchFunds(this.limiter, keyword, this.cfg);
  }

  invalidateSummary(code) {
    this.summaryCache.delete(code);
  }

  /** 供 UI 展示的源健康状态 */
  stats() {
    return {
      preferredSource: this.preferredSource,
      quoteSources: QUOTE_SOURCES.map((s) => {
        const b = this._quoteBackoff(s.name);
        return {
          name: s.name,
          healthy: b.available,
          backoffRemainingMs: b.remainingMs,
          failures: b.failures,
        };
      }),
      summarySources: [
        { name: 'danjuan', healthy: this.danjuanBackoff.available, failures: this.danjuanBackoff.failures },
        { name: 'eastmoney', healthy: this.summaryBackoff.available, failures: this.summaryBackoff.failures },
      ],
      hosts: this.limiter.snapshot(),
      summaryCacheSize: this.summaryCache.size,
    };
  }
}

function numOr(v) {
  return v === undefined ? null : toNumber(v);
}

module.exports = { SourceRegistry };
