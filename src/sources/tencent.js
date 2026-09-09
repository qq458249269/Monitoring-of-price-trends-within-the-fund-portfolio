'use strict';

/* 腾讯行情源(qt.gtimg.cn jj 前缀):备用净值源。GBK 编码。 */

const { fetchText, toNumber } = require('../util');

const HOST = 'qt.gtimg.cn';

/**
 * 批量拉取基金最新确认净值(非实时估值,用于净值校验/兜底)。
 * v_jj161725="161725~名称~0.0000~0.0000~~0.5617~2.2778~-0.4607~2026-09-08~"
 * 字段: 1名称 5单位净值 6累计净值 7日涨跌% 8净值日期
 */
async function fetchNavs(limiter, codes, cfg) {
  if (!codes.length) return new Map();
  const url = `https://${HOST}/q=${codes.map((c) => `jj${c}`).join(',')}`;
  const handle = await limiter.acquire(HOST);
  const started = Date.now();
  try {
    const text = await fetchText(url, { timeoutMs: 8000 });
    const out = new Map();
    const re = /v_jj(\d{6})="([^"]*)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const p = m[2].split('~');
      const nav = toNumber(p[5]);
      const navDate = p[8] || '';
      const name = p[1] || '';
      if (nav === null && !navDate) continue;
      out.set(m[1], { nav, accNav: toNumber(p[6]), dayChangePct: toNumber(p[7]), navDate, name });
    }
    if (!out.size && codes.length) throw new Error('tencent: empty payload');
    handle.finish(true, Date.now() - started);
    return out;
  } catch (err) {
    handle.finish(false, Date.now() - started);
    throw err;
  }
}

module.exports = { HOST, fetchNavs };
