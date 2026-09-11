'use strict';

/* 全盘异动阈值校准工具:拉新浪指数 5 分钟 K 线(近几日),把累计成交额
 * 还原成每分钟增量,统计真实分布,并用不同阈值组合回放,观察告警点位。
 *
 * 用法:node scripts/tune-market.js [zThreshold] [ratioThreshold] [minAmountYi] [warmup]
 *   默认:node scripts/tune-market.js 3 3 50 12
 */

const { fetchText } = require('../src/util');

const INDICES = ['sh000001', 'sz399001', 'sh000300', 'sz399006'];

/** 拉指数 5 分钟 K 线(新浪 json 接口):[{day,time,open,high,low,close,volume,amount}] */
async function fetch5minBars(symbol, scale = 240, count = 96) {
  // 新浪分钟线接口:scale=5 表示 5 分钟 K,ma=no 不算均线,datalen 取根数
  const url = `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=5&ma=no&datalen=${count}`;
  const text = await fetchText(url, {
    headers: { Referer: 'https://finance.sina.com.cn' },
    timeoutMs: 10000,
  });
  const m = text.match(/\((\[.*\])\)/s);
  if (!m) throw new Error(`K 线接口返回异常:${text.slice(0, 80)}`);
  const arr = JSON.parse(m[1]);
  return arr.map((b) => ({
    day: b.day, // '2026-09-11 09:35:00'
    close: Number(b.close),
    volume: Number(b.volume), // 手
    amount: Number(b.amount), // 元(5 分钟累计)
  }));
}

/** 工具:统计数列 mean/std/分位数 */
function stats(vals) {
  const n = vals.length;
  if (!n) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  const sorted = [...vals].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
  return { n, mean, std, p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: sorted[n - 1] };
}

async function main() {
  const zThreshold = Number(process.argv[2]) || 3;
  const ratioThreshold = Number(process.argv[3]) || 3;
  const minAmountYi = Number(process.argv[4]) || 50;
  const warmup = Number(process.argv[5]) || 12;

  for (const sym of INDICES) {
    console.log(`\n===== ${sym} =====`);
    let bars;
    try {
      bars = await fetch5minBars(sym);
    } catch (err) {
      console.log(`  拉取失败:${err.message}`);
      continue;
    }
    // 5 分钟 K 的 amount 本身就是该 5 分钟的成交额(新浪 K 线非累计),直接当作"每步成交额"
    const amounts = bars.map((b) => b.amount / 1e8); // 亿元
    const st = stats(amounts);
    if (!st) continue;
    console.log(`  样本 ${st.n} 根 5minK(约 ${(st.n / 48).toFixed(1)} 个交易日)`);
    console.log(`  每根成交额(亿): mean=${st.mean.toFixed(1)} std=${st.std.toFixed(1)} p50=${st.p50.toFixed(1)} p90=${st.p90.toFixed(1)} p95=${st.p95.toFixed(1)} p99=${st.p99.toFixed(1)} max=${st.max.toFixed(1)}`);

    // 回放:滑动窗口(不含当前根),模拟在线检测
    let fires = 0;
    const firedAt = [];
    for (let i = warmup; i < amounts.length; i += 1) {
      const win = amounts.slice(Math.max(0, i - 48), i); // 近 48 根(约 1 天)滑动基线
      const wst = stats(win);
      if (!wst || wst.std === 0 || wst.mean < minAmountYi) continue;
      const z = (amounts[i] - wst.mean) / wst.std;
      const prev = amounts[i - 1];
      const ratio = prev > 0 ? amounts[i] / prev : 1;
      if (Math.abs(z) >= zThreshold || ratio >= ratioThreshold) {
        fires += 1;
        firedAt.push(`${bars[i].day} amt=${amounts[i].toFixed(1)}亿 z=${z.toFixed(2)} ratio=${ratio.toFixed(2)}`);
      }
    }
    console.log(`  回放告警 ${fires} 次(z>=${zThreshold} 或 ratio>=${ratioThreshold},基线 48 根,预热 ${warmup} 根):`);
    for (const line of firedAt.slice(-8)) console.log(`    ${line}`);
  }
}

main().catch((err) => {
  console.error('tune-market failed:', err.message);
  process.exit(1);
});
