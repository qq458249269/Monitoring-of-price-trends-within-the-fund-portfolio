'use strict';

/* 全盘行情源(新浪指数 s_ 前缀):指数点位 + 成交额,用于全盘异动监测。
 *
 * 新浪 s_ 精简格式:
 *   var hq_str_s_sh000001="上证指数,3094.668,-128.073,-3.97,436653,5458126";
 *   字段: 0名称 1当前点位 2涨跌额 3涨跌幅% 4成交量(手) 5成交额(万元)
 *
 * 常用指数代码:
 *   sh000001 上证指数  sz399001 深证成指  sh000300 沪深300
 *   sh000905 中证500   sz399006 创业板指  sh000016 上证50
 */

const { fetchText, toNumber } = require('../util');

const HOST = 'hq.sinajs.cn';

/** 默认监测的指数(A 股主要宽基) */
const DEFAULT_INDICES = ['sh000001', 'sz399001', 'sh000300', 'sz399006'];

/**
 * 批量拉取指数行情。
 * @param {string[]} codes 如 ['sh000001','sz399001'](内部自动加 s_ 前缀取精简格式)
 * @returns {Promise<Map<string, {name,price,change,changePct,volume,amount}>>}
 *   amount 单位:万元;volume 单位:手
 */
async function fetchIndices(limiter, codes, cfg) {
  if (!codes.length) return new Map();
  // 每个代码都必须带 s_ 前缀,否则返回全量格式(变量名 hq_str_sh000001,字段 30+)
  const url = `https://${HOST}/list=${codes.map((c) => `s_${c}`).join(',')}`;
  const handle = await limiter.acquire(HOST);
  const started = Date.now();
  try {
    const text = await fetchText(url, {
      headers: { Referer: 'https://finance.sina.com.cn' },
      timeoutMs: 8000,
    });
    const out = new Map();
    const re = /hq_str_s_(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const code = m[1];
      const p = m[2].split(',');
      if (p.length < 6) continue;
      const name = p[0] || code;
      const price = toNumber(p[1]);
      const changePct = toNumber(p[3]);
      const amount = toNumber(p[5]); // 万元
      if (price === null || amount === null) continue;
      out.set(code, {
        name,
        price,
        change: toNumber(p[2]),
        changePct,
        volume: toNumber(p[4]), // 手
        amount, // 万元
      });
    }
    if (!out.size && codes.length) throw new Error('sina market: empty payload');
    handle.finish(true, Date.now() - started);
    return out;
  } catch (err) {
    handle.finish(false, Date.now() - started);
    throw err;
  }
}

module.exports = { HOST, DEFAULT_INDICES, fetchIndices };
