'use strict';

/* 腾讯行情源增强版(qt.gtimg.cn):sz 前缀获取场内基金(LOF/ETF)当天实时估值。
 *
 * sz 前缀: 场内基金(LOF/ETF)实时行情
 *   v_sz161725="51~白酒基金LOF~161725~0.533~0.542~0.541~...~20260911161436~-0.009~-1.66~..."
 *   字段: 3当前价 4昨收 30时间戳 31涨跌额 32涨跌幅%
 *
 * jj 前缀(已禁用): 确认净值,日期是昨天的,不满足"只显示当天"要求
 */

const { fetchText, toNumber } = require('../util');

const HOST = 'qt.gtimg.cn';

/** 判断时间戳字符串是否是今天 */
function isToday(timeField) {
  if (!timeField || timeField.length < 8) return false;
  const year = timeField.slice(0, 4);
  const month = timeField.slice(4, 6);
  const day = timeField.slice(6, 8);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${year}-${month}-${day}` === today;
}

/**
 * 批量拉取场内基金当天实时估值。
 * 只用 sz 前缀,仅返回时间戳是今天的基金(场外基金不支持)。
 * @returns {Promise<Map<string, {estimate, estimateRate, time, date, prevNav}>>}
 */
async function fetchQuotes(limiter, codes, cfg) {
  if (!codes.length) return new Map();
  const out = new Map();

  const szCodes = codes.map((c) => `sz${c}`).join(',');
  const szUrl = `https://${HOST}/q=${szCodes}`;
  const handle = await limiter.acquire(HOST);
  const started = Date.now();
  try {
    const szText = await fetchText(szUrl, { timeoutMs: 8000 });
    const re = /v_sz(\d{6})="([^"]*)"/g;
    let m;
    while ((m = re.exec(szText)) !== null) {
      const code = m[1];
      const p = m[2].split('~');
      const estimate = toNumber(p[3]);
      const prevNav = toNumber(p[4]);
      const timeField = p[30] || '';
      const estimateRate = toNumber(p[32]);
      if (estimate === null) continue;
      if (!isToday(timeField)) continue; // 只要当天数据
      const date = timeField.length >= 8 ? `${timeField.slice(0, 4)}-${timeField.slice(4, 6)}-${timeField.slice(6, 8)}` : '';
      const time = timeField.length >= 14 ? `${timeField.slice(8, 10)}:${timeField.slice(10, 12)}:${timeField.slice(12, 14)}` : '';
      out.set(code, { estimate, estimateRate, time, date, prevNav, isNav: false });
    }
    if (!out.size && codes.length) throw new Error('tencent: no today data');
    handle.finish(true, Date.now() - started);
    return out;
  } catch (err) {
    handle.finish(false, Date.now() - started);
    throw err;
  }
}

module.exports = { HOST, fetchQuotes };
