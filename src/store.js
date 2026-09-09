'use strict';

/* 持久化:data/state.json(关注列表+最新估值) 与 data/history.json(分钟采样,环形) */

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, 'state.json');
    this.historyPath = path.join(dataDir, 'history.json');
    this._fh = null; // history.json 文件句柄(复用,避免每次 open)
    this._saveTimer = null;
    this._dirty = false;

    this.state = { watchlist: [], updatedAt: null };
    this.history = { funds: {} }; // code -> [samples]
    this.historyLimit = 24 * 60; // 每只基金保留 1440 个分钟采样(约 1 个交易日)
  }

  init() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    try {
      if (fs.existsSync(this.statePath)) {
        this.state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      }
    } catch (err) {
      console.warn(`[store] 读取 state.json 失败,使用默认:${err.message}`);
      this.state = { watchlist: [], updatedAt: null };
    }
    if (!Array.isArray(this.state.watchlist)) this.state.watchlist = [];

    try {
      if (fs.existsSync(this.historyPath)) {
        this.history = JSON.parse(fs.readFileSync(this.historyPath, 'utf8'));
      }
    } catch (err) {
      console.warn(`[store] 读取 history.json 失败,重建:${err.message}`);
      this.history = { funds: {} };
    }
    if (!this.history || typeof this.history !== 'object') this.history = { funds: {} };
    if (!this.history.funds || typeof this.history.funds !== 'object') this.history.funds = {};

    this._fh = fs.openSync(this.historyPath, 'w');
  }

  /* ---------- watchlist ---------- */

  getWatchlist() {
    return this.state.watchlist;
  }

  hasFund(code) {
    return this.state.watchlist.some((f) => f.code === code);
  }

  addFund({ code, name }) {
    if (this.hasFund(code)) return false;
    this.state.watchlist.push({ code, name: name || code, addedAt: Date.now() });
    this.scheduleSave();
    return true;
  }

  removeFund(code) {
    const before = this.state.watchlist.length;
    this.state.watchlist = this.state.watchlist.filter((f) => f.code !== code);
    const removed = this.state.watchlist.length < before;
    if (removed) {
      delete this.history.funds[code];
      this.flushHistory();
    }
    this.scheduleSave();
    return removed;
  }

  renameFund(code, name) {
    const fund = this.state.watchlist.find((f) => f.code === code);
    if (!fund) return false;
    fund.name = name;
    this.scheduleSave();
    return true;
  }

  updateQuote(code, fields) {
    const fund = this.state.watchlist.find((f) => f.code === code);
    if (!fund) return false;
    Object.assign(fund, fields);
    this.scheduleSave();
    return true;
  }

  /* ---------- history samples ---------- */

  appendSample(code, sample) {
    if (!this.history.funds[code]) this.history.funds[code] = [];
    const arr = this.history.funds[code];
    arr.push(sample);
    if (arr.length > this.historyLimit) arr.splice(0, arr.length - this.historyLimit);
    this._dirty = true;
  }

  getHistory(code, limit = 240) {
    const arr = this.history.funds[code];
    if (!arr) return [];
    return arr.slice(-limit);
  }

  /** history.json 只在脏时延迟落盘(避免每分钟整文件重写的 IO 放大) */
  scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flushState();
    }, 3000);
  }

  flushState() {
    if (!this._fh) return;
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.warn(`[store] 写 state.json 失败:${err.message}`);
    }
  }

  flushHistory() {
    if (!this._fh) return;
    try {
      fs.writeFileSync(this.historyPath, JSON.stringify(this.history));
      this._dirty = false;
    } catch (err) {
      console.warn(`[store] 写 history.json 失败:${err.message}`);
    }
  }

  /** 进程退出时保证持久化 */
  close() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this.flushState();
    this.flushHistory();
    if (this._fh) {
      try { fs.closeSync(this._fh); } catch { /* ignore */ }
      this._fh = null;
    }
  }
}

module.exports = { Store };
