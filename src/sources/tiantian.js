'use strict';

/* 天天基金估值源(fund.eastmoney.com 基金详情接口):备用实时估值源 */

const { fetchText, parseJsonp, toNumber } = require('../util');

const HOST = 'fundgz.1234567.com.cn';

/**
 * 批量拉取基金实时估值。
 * 接口: https://fundgz.1234567.com.cn/js/{code}.js
 * 返回格式: jsonpgz({"fundcode":"...","name":"...","jzrq":"...","dwjz":"...","gsz":"...","gszzl":"...","gztime":"..."})
 *   gsz: 实时估值, gszzl: 估值涨跌%, gztime: 估值时间
 */
async function fetchQuotes(limiter, codes, cfg) {
  if (!codes.length) return new Map();
  const out = new Map();
  // 天天基金单只请求，需逐个获取
  for (const code of codes) {
    const url = `https://${HOST}/js/${code}.js?rt=${Date.now()}`;
    try {
      const handle = await limiter.acquire(HOST);
      const started = Date.now();
      try {
        const text = await fetchText(url, {
          headers: { Referer: 'https://fund.eastmoney.com/' },
          timeoutMs: 8000,
        });
        const json = parseJsonp(text);
        if (json && json.gsz !== undefined) {
          out.set(code, {
            estimate: toNumber(json.gsz),
            estimateRate: toNumber(json.gszzl),
            time: json.gztime || '',
            date: json.jzrq || '',
            prevNav: toNumber(json.dwjz),
          });
        }
        handle.finish(true, Date.now() - started);
      } catch (err) {
        handle.finish(false, Date.now() - started);
        throw err;
      }
    } catch {
      // 单只失败不影响其他基金
    }
  }
  if (!out.size && codes.length) throw new Error('tiantian: empty payload');
  return out;
}

module.exports = { HOST, fetchQuotes };
