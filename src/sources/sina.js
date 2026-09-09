'use strict';

/* 新浪基金估值源(fu_ 前缀):主源,支持批量。GBK 编码。 */

const { fetchText, toNumber } = require('../util');

const HOST = 'hq.sinajs.cn';

/**
 * 批量拉取基金估值。
 * @param {string[]} codes 6 位基金代码
 * @returns {Promise<Map<string, {estimate:number,estimateRate:number,time:string,date:string,prevNav:number|null}>>}
 */
async function fetchQuotes(limiter, codes, cfg) {
  if (!codes.length) return new Map();
  const list = codes.map((c) => `fu_${c}`).join(',');
  const url = `https://${HOST}/list=${list}`;
  const handle = await limiter.acquire(HOST);
  const started = Date.now();
  try {
    const text = await fetchText(url, {
      headers: { Referer: 'https://finance.sina.com.cn' },
      timeoutMs: 8000,
    });
    const out = new Map();
    const re = /hq_str_fu_(\d{6})="([^"]*)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const code = m[1];
      const parts = m[2].split(',');
      // 新浪 fu_ 字段: 0名称 1时间(HH:MM:SS) 2当前估值 3昨收净值 4累计净值 5? 6估值涨跌 7日期 8昨收净值2 9估算涨跌%
      const estimate = toNumber(parts[2]);
      const date = parts[7] || '';
      const time = parts[1] || '';
      const estimateRate = toNumber(parts[9]);
      const prevNav = toNumber(parts[8]) ?? toNumber(parts[3]);
      if (estimate === null && estimateRate === null) continue;
      out.set(code, {
        estimate,
        estimateRate,
        time: date && time ? `${date} ${time}` : time || date,
        date,
        prevNav,
      });
    }
    if (!out.size && codes.length) throw new Error('sina: empty payload');
    handle.finish(true, Date.now() - started);
    return out;
  } catch (err) {
    handle.finish(false, Date.now() - started);
    throw err;
  }
}

module.exports = { HOST, fetchQuotes };
