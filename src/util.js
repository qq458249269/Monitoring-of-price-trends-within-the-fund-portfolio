'use strict';

/* 通用工具:HTTP 抓取(GBK 解码)、JSONP、字段抽取、调度辅助 */

const BROWSER_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
];

let uaIndex = Math.floor(Math.random() * BROWSER_UAS.length);
function nextUserAgent() {
  uaIndex = (uaIndex + 1) % BROWSER_UAS.length;
  return BROWSER_UAS[uaIndex];
}

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

function withTimeout(ms) {
  if (ms > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

/** 抓取文本,自动按响应 charset 解码(默认 utf-8,支持 gbk/gb2312) */
async function fetchText(url, opts = {}) {
  const { headers = {}, timeoutMs = 10000 } = opts;
  const res = await fetch(url, {
    headers: {
      'User-Agent': opts.userAgent || nextUserAgent(),
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
      ...headers,
    },
    signal: withTimeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) throw new HttpError(res.status, url);
  const type = res.headers.get('content-type') || '';
  let charset = (type.match(/charset=([\w-]+)/i) || [])[1];
  if (!charset) {
    const buf = await res.arrayBuffer();
    let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    const m = text.match(/<meta[^>]+charset=["']?([\w-]+)/i);
    if (m) charset = m[1];
    else return text;
    if (/^utf-?8$/i.test(charset)) return text;
    text = new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(buf);
    return text;
  }
  if (/^utf-?8$/i.test(charset)) return res.text();
  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, opts);
  return JSON.parse(text);
}

/** 解析 JSONP: cb({...}) / xxx(...) → 对象;纯 JSON(含括号字符串值)原样 JSON.parse */
function parseJsonp(text) {
  const s = String(text).trim();
  // 仅当开头形如回调名(标识符/点号)后紧跟 "(" 时才按 JSONP 解包,
  // 避免误伤值里含 "(" 的纯 JSON,如 {"NAME":"xx(LOF)C"}
  const m = s.match(/^[\w$.]+\s*\(/);
  if (m && !s.startsWith('{') && !s.startsWith('[')) {
    const inner = s.slice(m[0].length, s.lastIndexOf(')')).trim();
    if (!inner || inner === ';') throw new Error('JSONP empty payload');
    return JSON.parse(inner);
  }
  return JSON.parse(s);
}

/** 从 JS 文本中提取 `var name = <value>;` 的值 */
function extractJsVar(text, name) {
  const re = new RegExp(`var\\s+${name}\\s*=\\s*([\\s\\S]*?);`, 'm');
  const m = text.match(re);
  return m ? m[1].trim() : undefined;
}

function extractJsString(text, name) {
  const raw = extractJsVar(text, name);
  if (raw === undefined) return undefined;
  const m = raw.match(/^["'](.*)["']$/s);
  return m ? m[1] : undefined;
}

function extractJsArray(text, name) {
  const raw = extractJsVar(text, name);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    const inner = raw.replace(/,\s*$/, '');
    try {
      return JSON.parse(`[${inner}]`);
    } catch {
      return undefined;
    }
  }
}

function extractJsJson(text, name) {
  const raw = extractJsVar(text, name);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function toNumber(v) {
  if (v === null || v === undefined || v === '' || v === '--' || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 确定性随机:用于测试注入 */
function randInt(min, max, rng = Math.random) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function jitter(base, rng = Math.random) {
  return Math.max(0, Math.round(base * (0.5 + rng())));
}

/** 中国市场开闭市判断。now: Date;holidays: 'YYYY-MM-DD' 数组 */
function isTradingTime(now, holidays = []) {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const pad = (x) => String(x).padStart(2, '0');
  const ymd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (holidays.includes(ymd)) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const open1 = 9 * 60 + 30;
  const close1 = 11 * 60 + 30;
  const open2 = 13 * 60;
  const close2 = 15 * 60;
  return (minutes >= open1 && minutes <= close1) || (minutes >= open2 && minutes <= close2);
}

/** 北京时间分解(时区安全):{ymd, hour, minute, dow} */
function beijingParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dow: dowMap[parts.weekday] ?? new Date(date).getDay(),
  };
}

/** 距下一个北京时间 hour:minute 的毫秒数(自动跳过周末;holidays 为 'YYYY-MM-DD' 数组) */
function msUntilBeijing(hour, minute, now = new Date(), holidays = []) {
  const bj = beijingParts(now);
  const minutesNow = bj.hour * 60 + bj.minute;
  const target = hour * 60 + minute;
  let daysAhead = minutesNow >= target ? 1 : 0;
  const blocked = (p) => p.dow === 0 || p.dow === 6 || holidays.includes(p.ymd);
  for (;;) {
    const cand = beijingParts(new Date(now.getTime() + daysAhead * 86400000));
    if (!blocked(cand)) break;
    daysAhead += 1;
  }
  const deltaMin = daysAhead * 1440 + (target - minutesNow);
  return Math.max(0, deltaMin * 60000);
}

/** 北京时间 'HH:MM' 字符串 */
function beijingTimeStr(date = new Date()) {
  const p = beijingParts(date);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

module.exports = {
  BROWSER_UAS,
  HttpError,
  nextUserAgent,
  fetchText,
  fetchJson,
  parseJsonp,
  extractJsVar,
  extractJsString,
  extractJsArray,
  extractJsJson,
  toNumber,
  round2,
  clamp,
  sleep,
  randInt,
  jitter,
  isTradingTime,
  beijingParts,
  msUntilBeijing,
  beijingTimeStr,
};
