'use strict';

/* 东方财富源:fund.eastmoney.com / api.fund.eastmoney.com
 * - pingzhongdata/{code}.js:概要(经理/费率/规模/持仓股/阶段收益/净值历史)
 * - f10/lsjz:历史净值
 * - fundsuggest:基金搜索
 */

const {
  fetchText, parseJsonp, extractJsString, extractJsArray,
  extractJsJson, toNumber,
} = require('../util');

const FUND_HOST = 'fund.eastmoney.com';
const API_HOST = 'api.fund.eastmoney.com';
const SEARCH_HOST = 'fundsuggest.eastmoney.com';
const F10_HOST = 'fundf10.eastmoney.com';

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function get(limiter, host, url, headers, timeoutMs = 10000) {
  const handle = await limiter.acquire(host);
  const started = Date.now();
  try {
    const text = await fetchText(url, { headers, timeoutMs, userAgent: DESKTOP_UA });
    handle.finish(true, Date.now() - started);
    return text;
  } catch (err) {
    handle.finish(false, Date.now() - started);
    throw err;
  }
}

/** 基金搜索(联想词接口) */
async function searchFunds(limiter, keyword, cfg) {
  const url = `https://${SEARCH_HOST}/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(keyword)}&_=${Date.now()}`;
  const text = await get(limiter, SEARCH_HOST, url, {
    Referer: 'https://fund.eastmoney.com/',
  });
  let data;
  try {
    data = parseJsonp(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(data && data.Datas) ? data.Datas : [];
  return rows
    .filter((r) => r && r.CODE && r.NAME)
    .slice(0, 12)
    .map((r) => {
      const base = r.FundBaseInfo || {};
      return {
        code: String(r.CODE),
        name: String(r.NAME).replace(/<[^>]+>/g, ''),
        type: base.FTYPE || r.CATEGORYDESC || '',
        company: base.JJGS || '',
        manager: base.JJJL || '',
        minBuy: toNumber(base.MINSG),
        fundSource: 'eastmoney',
      };
    });
}

/** 概要(pingzhongdata),monitor 层用 summaryCacheMs 做缓存 */
async function fetchSummary(limiter, code, cfg) {
  const url = `https://${FUND_HOST}/pingzhongdata/${code}.js?v=${Math.floor(Date.now() / 1000)}`;
  const text = await get(limiter, FUND_HOST, url, {
    Referer: `https://fund.eastmoney.com/${code}.html`,
  }, 12000);

  const name = extractJsString(text, 'fS_name');
  if (!name) throw new Error(`eastmoney pingzhongdata empty for ${code}`);

  const netWorthTrend = extractJsArray(text, 'Data_netWorthTrend') || [];
  const navHistory = (Array.isArray(netWorthTrend) ? netWorthTrend : [])
    .map((p) => ({ date: tsToDate(p.x), nav: toNumber(p.y), dayChangePct: toNumber(p.equityReturn) }))
    .filter((p) => p.nav !== null);

  const holderStructure = parseHolderStructure(extractJsJson(text, 'Data_holderStructure'));
  const assetAllocation = parseAssetAllocation(extractJsJson(text, 'Data_assetAllocation'));

  const managersRaw = extractJsJson(text, 'Data_currentFundManager');
  const managers = (Array.isArray(managersRaw) ? managersRaw : []).map((m) => ({
    name: m.name || '',
    star: toNumber(m.star),
    workTime: m.workTime || '',
    fundSize: m.fundSize || '',
  }));

  return {
    source: 'eastmoney',
    code,
    name,
    rate: extractJsString(text, 'fund_Rate'),
    sourceRate: extractJsString(text, 'fund_sourceRate'),
    minBuy: extractJsString(text, 'fund_minsg'),
    returns: {
      y1: extractJsString(text, 'syl_1n'),
      y6m: extractJsString(text, 'syl_6y'),
      y3m: extractJsString(text, 'syl_3y'),
      m1: extractJsString(text, 'syl_1y'),
    },
    stockCodes: extractJsArray(text, 'stockCodesNew') || extractJsArray(text, 'stockCodes') || [],
    bondCodes: extractJsArray(text, 'zqCodesNew') || extractJsArray(text, 'zqCodes') || [],
    managers,
    holderStructure,
    assetAllocation,
    navHistory: navHistory.slice(-(cfg.navHistoryPoints || 90)),
  };
}

/** 持有人结构:{series:[{name,data}],categories} → [{term,orgPct,individualPct}] */
function parseHolderStructure(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const categories = Array.isArray(raw.categories) ? raw.categories : [];
  const series = Array.isArray(raw.series) ? raw.series : [];
  const org = series.find((s) => /机构/.test(s.name || ''));
  const ind = series.find((s) => /个人/.test(s.name || ''));
  if (!org && !ind) return [];
  return categories.map((term, i) => ({
    term,
    orgPct: org ? toNumber((org.data || [])[i]) : null,
    individualPct: ind ? toNumber((ind.data || [])[i]) : null,
  }));
}

/** 资产配置:{series:[{name,data}],categories} → 最近一期 {date,stock,bond,cash} */
function parseAssetAllocation(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.series)) return null;
  const categories = Array.isArray(raw.categories) ? raw.categories : [];
  const pick = (re) => {
    const s = raw.series.find((x) => re.test(x.name || ''));
    const data = s && Array.isArray(s.data) ? s.data : [];
    return toNumber(data[data.length - 1]);
  };
  const out = {
    date: categories[categories.length - 1] || '',
    stock: pick(/股票/),
    bond: pick(/债券/),
    cash: pick(/现金/),
  };
  return out.stock === null && out.bond === null && out.cash === null ? null : out;
}

function tsToDate(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 历史净值(f10 lsjz),monitor 层用 navHistoryCacheMs 做缓存 */
async function fetchNavHistory(limiter, code, cfg, page = 1, pageSize = 20) {
  const url = `https://${API_HOST}/f10/lsjz?fundCode=${code}&pageIndex=${page}&pageSize=${pageSize}`;
  const text = await get(limiter, API_HOST, url, {
    Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html`,
  });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`f10 lsjz 返回非 JSON(${(text || '').slice(0, 60)})`);
  }
  const list = (json && json.Data && json.Data.LSJZList) || [];
  return {
    total: toNumber(json && json.TotalCount) || list.length,
    rows: list.map((r) => ({
      date: r.FSRQ || '',
      nav: toNumber(r.DWJZ),
      accNav: toNumber(r.LJJZ),
      dayChangePct: toNumber(r.JZZZL),
      buyStatus: r.SGZT || '',
      redeemStatus: r.SHZT || '',
      dividend: r.FHSP || '',
    })),
  };
}

module.exports = {
  FUND_HOST, API_HOST, SEARCH_HOST, F10_HOST,
  searchFunds, fetchSummary, fetchNavHistory,
  parseHolderStructure, parseAssetAllocation,
};
