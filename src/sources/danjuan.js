'use strict';

/* 蛋卷基金(danjuanfunds.com)源:富概要 + 阶段收益 + 风险等级 */

const { fetchJson, toNumber } = require('../util');

const HOST = 'danjuanfunds.com';

/** 蛋卷详情(限流抓取) */
async function fetchDetail(limiter, code, cfg) {
  const url = `https://${HOST}/djapi/fund/${code}`;
  const handle = await limiter.acquire(HOST);
  const started = Date.now();
  try {
    const json = await fetchJson(url, {
      headers: { Referer: 'https://danjuanfunds.com/' },
      timeoutMs: 9000,
    });
    handle.finish(true, Date.now() - started);
    return normalize(json && json.data, code);
  } catch (err) {
    handle.finish(false, Date.now() - started);
    throw err;
  }
}

function normalize(data, code) {
  if (!data || !data.fd_code) throw new Error(`danjuan empty for ${code}`);
  const d = data.fund_derived || {};
  return {
    source: 'danjuan',
    code,
    name: data.fd_name || '',
    fullName: data.fd_full_name || '',
    company: data.keeper_name || '',
    manager: data.manager_name || '',
    custodian: data.trup_name || '',
    foundDate: data.found_date || '',
    riskLevel: toNumber(data.risk_level),
    scale: data.totshare || '',
    nav: toNumber(d.unit_nav),
    navDate: d.end_date || '',
    dayChangePct: toNumber(d.nav_grtd),
    returns: {
      m1: pct(d.nav_grl1m),
      m3: pct(d.nav_grl3m),
      m6: pct(d.nav_grl6m),
      y1: pct(d.nav_grlty),
      y3: pct(d.nav_grl3y),
    },
  };
}

function pct(v) {
  const n = toNumber(v);
  return n === null ? null : Math.round(n * 100) / 100;
}

module.exports = { HOST, fetchDetail };
