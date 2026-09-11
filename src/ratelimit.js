'use strict';

/* 反爬限流:每 host 独立令牌桶 + 最小间隔 + 抖动;失败退避;健康度评分 */

const { clamp } = require('./util');

class TokenBucket {
  /**
   * @param {number} capacity 桶容量(突发上限)
   * @param {number} refillPerMinute 每分钟补充令牌数
   */
  constructor(capacity, refillPerMinute) {
    this.capacity = Math.max(1, capacity);
    this.tokens = this.capacity;
    this.refillPerMinute = Math.max(0.1, refillPerMinute);
    this.lastRefill = Date.now();
  }

  refill() {
    const now = Date.now();
    const elapsedMin = (now - this.lastRefill) / 60000;
    if (elapsedMin <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMin * this.refillPerMinute);
    this.lastRefill = now;
  }

  tryRemove() {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  msUntilToken() {
    this.refill();
    if (this.tokens >= 1) return 0;
    const need = 1 - this.tokens;
    return Math.ceil((need / this.refillPerMinute) * 60000);
  }
}

/** host 处于退避期且等待超限时抛出:调用方应切换数据源,而不是干等 */
class RateLimitBackoffError extends Error {
  constructor(host, waitMs) {
    super(`host ${host} 退避期还需 ${Math.round(waitMs / 1000)}s,超出等待上限,放弃本次请求`);
    this.name = 'RateLimitBackoffError';
    this.host = host;
    this.waitMs = waitMs;
  }
}

/** 每个 host 的限流状态:令牌桶 + 上次请求时间 + 失败退避 */
class HostState {
  constructor(opts = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 800;
    this.maxPerMinute = opts.maxPerMinute ?? 20;
    this.backoffBaseMs = opts.backoffBaseMs ?? 30000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 900000;
    this.bucket = new TokenBucket(Math.max(1, Math.ceil(this.maxPerMinute / 3)), this.maxPerMinute);
    this.lastRequestAt = 0;
    this.consecutiveFailures = 0;
    this.backoffUntil = 0;
    this.ewmaMs = null; // 响应耗时 EWMA,用于健康度
    this.totalRequests = 0;
    this.totalErrors = 0;
  }

  get backoffRemaining() {
    return Math.max(0, this.backoffUntil - Date.now());
  }

  get inBackoff() {
    return this.backoffRemaining > 0;
  }

  /** 计算下一个请求允许的时刻,返回需等待的毫秒数 */
  nextAllowedDelayMs() {
    if (this.inBackoff) return this.backoffRemaining;
    const sinceLast = Date.now() - this.lastRequestAt;
    const spacingWait = sinceLast >= this.minIntervalMs ? 0 : this.minIntervalMs - sinceLast;
    return Math.max(spacingWait, this.bucket.msUntilToken());
  }

  recordRequest() {
    this.lastRequestAt = Date.now();
    this.totalRequests += 1;
  }

  recordSuccess(latencyMs) {
    this.consecutiveFailures = 0;
    this.backoffUntil = 0;
    this.ewmaMs = this.ewmaMs === null ? latencyMs : this.ewmaMs * 0.8 + latencyMs * 0.2;
  }

  recordFailure() {
    this.totalErrors += 1;
    this.consecutiveFailures += 1;
    const exp = Math.min(this.consecutiveFailures - 1, 8);
    const wait = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** exp);
    this.backoffUntil = Date.now() + wait;
  }
}

/**
 * 每 host 限流器。
 * acquire(host): 返回 Promise,在允许的时刻 resolve(内部已做排队与退避)。
 */
class RateLimiter {
  constructor(opts = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 800;
    this.maxPerMinute = opts.maxPerMinute ?? 20;
    this.backoffBaseMs = opts.backoffBaseMs ?? 30000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 900000;
    // acquire 在退避期最多等待多久;超过抛 RateLimitBackoffError,防止死源拖垮同步循环
    this.maxBackoffWaitMs = opts.maxBackoffWaitMs ?? 5000;
    this._hosts = new Map();
    this._queues = new Map();
  }

  hostState(host) {
    let st = this._hosts.get(host);
    if (!st) {
      st = new HostState({
        minIntervalMs: this.minIntervalMs,
        maxPerMinute: this.maxPerMinute,
        backoffBaseMs: this.backoffBaseMs,
        backoffMaxMs: this.backoffMaxMs,
      });
      this._hosts.set(host, st);
    }
    return st;
  }

  async acquire(host, maxBackoffWaitMs = this.maxBackoffWaitMs) {
    const st = this.hostState(host);
    const prev = this._queues.get(host) || Promise.resolve();
    let release;
    const gate = new Promise((res) => { release = res; });
    this._queues.set(host, prev.then(() => gate));
    await prev; // 等待同 host 前面的请求完成(串行化,防并发突发)

    let waited = 0;
    try {
      for (;;) {
        const delay = st.nextAllowedDelayMs();
        if (delay <= 0) break;
        // 退避期过长:调用方应切换数据源而非干等,避免单次同步被阻塞到分钟级
        if (st.inBackoff && maxBackoffWaitMs > 0 && delay > maxBackoffWaitMs) {
          throw new RateLimitBackoffError(host, delay);
        }
        waited += delay;
        await new Promise((res) => setTimeout(res, delay));
      }
      st.recordRequest();
      return {
        host,
        waitedMs: waited,
        finish: (ok, latencyMs) => {
          if (ok) st.recordSuccess(latencyMs);
          else st.recordFailure();
          release();
        },
      };
    } catch (err) {
      release(); // 异常路径也必须放行队列,否则同 host 后续请求永久挂起
      throw err;
    }
  }

  /** 视图:给 UI 展示各 host 的健康状态 */
  snapshot() {
    const out = [];
    for (const [host, st] of this._hosts) {
      const health = st.totalRequests > 0
        ? clamp(1 - st.totalErrors / Math.max(1, st.totalRequests), 0, 1)
        : 1;
      out.push({
        host,
        health: Math.round(health * 100) / 100,
        inBackoff: st.inBackoff,
        backoffRemainingMs: st.backoffRemaining,
        totalRequests: st.totalRequests,
        totalErrors: st.totalErrors,
        avgLatencyMs: st.ewmaMs === null ? null : Math.round(st.ewmaMs),
      });
    }
    return out;
  }
}

/** 失败退避器(单对象版,供单一数据源整体退避使用) */
class Backoff {
  constructor({ baseMs = 30000, maxMs = 900000 } = {}) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.failures = 0;
    this.until = 0;
  }

  get available() {
    return Date.now() >= this.until;
  }

  get remainingMs() {
    return Math.max(0, this.until - Date.now());
  }

  fail() {
    this.failures += 1;
    const exp = Math.min(this.failures - 1, 8);
    this.until = Date.now() + Math.min(this.maxMs, this.baseMs * 2 ** exp);
  }

  succeed() {
    this.failures = 0;
    this.until = 0;
  }
}

module.exports = { TokenBucket, HostState, RateLimiter, Backoff, RateLimitBackoffError };
