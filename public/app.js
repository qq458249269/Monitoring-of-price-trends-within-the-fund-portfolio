'use strict';

/* 前端逻辑:列表渲染、SSE 实时更新、迷你走势图、搜索/关注、概要抽屉 */

/* ---------- 工具 ---------- */
const $ = (sel) => document.querySelector(sel);

function cls(rate) {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return 'flat';
  if (rate > 0) return 'up';    // 红涨
  if (rate < 0) return 'down';  // 绿跌
  return 'flat';
}

function fmtRate(rate) {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '--';
  const s = rate > 0 ? '+' : '';
  return `${s}${rate.toFixed(2)}%`;
}

function fmtNum(v, digits = 4) {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  return Number(v).toFixed(digits);
}

function fmtTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------- 状态 ---------- */
const funds = new Map(); // code -> fund view (含 history)
let lastMeta = null;
let selectedCode = null;

/* ---------- 迷你走势图 ---------- */
function sparkline(history, colorUp, width = 260, height = 54) {
  const pts = (history || []).filter((p) => typeof p.e === 'number' && p.e !== null);
  if (pts.length < 2) return `<svg viewBox="0 0 ${width} ${height}"><text x="50%" y="55%" fill="#556" font-size="10" text-anchor="middle">等待采样…</text></svg>`;
  const vals = pts.map((p) => p.e);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = (max - min) * 0.15 || Math.abs(max) * 0.001 || 0.001;
  const lo = min - pad;
  const hi = max + pad;
  const x = (i) => (i / (pts.length - 1)) * (width - 4) + 2;
  const y = (v) => height - 4 - ((v - lo) / (hi - lo)) * (height - 8);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.e).toFixed(1)}`).join(' ');
  const area = `M2,${height} L${line.replace(/ /g, ' L')} L${width - 2},${height} Z`;
  const up = vals[vals.length - 1] >= vals[0];
  const color = up ? colorUp : 'var(--down)';
  const baseY = y(vals[0]);
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <defs><linearGradient id="g${up ? 'u' : 'd'}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <line x1="2" y1="${baseY.toFixed(1)}" x2="${width - 2}" y2="${baseY.toFixed(1)}" stroke="#3a4756" stroke-dasharray="3 3" stroke-width="1"/>
    <path d="${area}" fill="url(#g${up ? 'u' : 'd'})"/>
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6"/>
  </svg>`;
}

/* ---------- 列表渲染 ---------- */
function fundCardHtml(f) {
  const rate = f.estimateRate;
  const c = cls(rate);
  const trendLabel = { up: '↗ 上行', down: '↘ 下行', flat: '→ 持平' }[trendDir(f)] || '';
  const tag = f.isNav ? '<span class="fc-tag">净值</span>' : '<span class="fc-tag">估值</span>';
  return `
    <div class="fc-head">
      <div>
        <span class="fc-name">${esc(f.name)}</span><span class="fc-code">${esc(f.code)}</span>${tag}
      </div>
      <div class="fc-right">
        <span class="fc-estimate ${c}">${fmtNum(f.estimate)}</span>
        <span class="fc-rate ${c}">${fmtRate(rate)}</span>
      </div>
    </div>
    <div class="fc-body">
      <div class="fc-chart">${sparkline(f.history)}</div>
      <div class="fc-meta">
        <div>昨净 <b>${fmtNum(f.prevNav)}</b></div>
        <div>时间 <b>${esc(f.quoteTime || '--')}</b></div>
        <div>源 <b>${esc(f.source || '--')}</b></div>
      </div>
    </div>
    <div class="fc-foot">
      <span class="fc-trend">日内 ${trendLabel} · 采样 ${f.history ? f.history.length : 0} 点 · 更新 ${fmtTime(f.updatedAt)}</span>
      <span class="fc-actions">
        <button class="mini-btn" data-act="detail" data-code="${f.code}">概要</button>
        <button class="mini-btn" data-act="rename" data-code="${f.code}">改名</button>
        <button class="mini-btn danger" data-act="remove" data-code="${f.code}">取关</button>
      </span>
    </div>`;
}

function trendDir(f) {
  const h = (f.history || []).filter((p) => typeof p.e === 'number');
  if (h.length < 2) return 'flat';
  const d = h[h.length - 1].e - h[0].e;
  if (d > 0.0001) return 'up';
  if (d < -0.0001) return 'down';
  return 'flat';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function renderList() {
  const list = [...funds.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const container = $('#fundList');
  $('#emptyState').classList.toggle('hidden', list.length > 0);
  container.innerHTML = list.map((f) => `
    <div class="fund-card ${f.code === selectedCode ? 'selected' : ''}" data-code="${f.code}">
      ${fundCardHtml(f)}
    </div>`).join('');
}

/* 局部更新:仅刷新数字与图,减少闪烁 */
function updateCard(f) {
  const card = document.querySelector(`.fund-card[data-code="${f.code}"]`);
  if (!card) { renderList(); return; }
  card.innerHTML = fundCardHtml(f);
}

/* ---------- 数据加载 ---------- */
async function loadFunds() {
  try {
    const snap = await api('/api/funds');
    lastMeta = snap.lastResult;
    for (const f of snap.funds || []) funds.set(f.code, f);
    renderList();
    renderSyncStatus(snap.updatedAt, snap.sources);
  } catch (err) {
    toast(`加载失败:${err.message}`);
  }
}

function renderSyncStatus(updatedAt, sources) {
  const parts = [];
  if (updatedAt) parts.push(`同步 ${fmtTime(updatedAt)}`);
  if (lastMeta && lastMeta.source) parts.push(`源 ${lastMeta.source}`);
  $('#syncStatus').textContent = parts.join(' · ') || '未同步';
  if (sources) renderSourceStats(sources);
}

function renderSourceStats(sources) {
  const bits = [];
  for (const s of sources.quoteSources || []) {
    bits.push(`${s.name} ${s.healthy ? '●' : '⛔'}${s.failures ? `(${s.failures}败)` : ''}`);
  }
  for (const h of sources.hosts || []) {
    bits.push(`${h.host} ${Math.round((h.health || 0) * 100)}%${h.inBackoff ? '(退避)' : ''}`);
  }
  $('#srcStats').textContent = bits.join('  ·  ');
}

/* ---------- SSE ---------- */
function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('tick', (e) => {
    try {
      const payload = JSON.parse(e.data);
      for (const f of payload.quotes || []) {
        funds.set(f.code, { ...(funds.get(f.code) || {}), ...f });
        updateCard(funds.get(f.code));
      }
      if (payload.meta) {
        lastMeta = { ...lastMeta, ...payload.meta };
        const t = payload.meta.at || Date.now();
        $('#syncStatus').textContent = `同步 ${fmtTime(t)} · 源 ${(payload.meta.source || '-')}`;
      }
    } catch { /* 忽略坏帧 */ }
  });
  es.addEventListener('alert', (e) => {
    try {
      const a = JSON.parse(e.data);
      pushEvent(`${a.message}`, true);
      toast(`⚠ ${a.message}`, 4000);
    } catch { /* ignore */ }
  });
  es.addEventListener('closing-report', (e) => {
    try {
      const r = JSON.parse(e.data);
      renderClosingReport(r);
    } catch { /* ignore */ }
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

function pushEvent(text, isAlert) {
  const feed = $('#eventFeed');
  const div = document.createElement('div');
  div.className = `evt${isAlert ? ' alert' : ''}`;
  div.textContent = `${isAlert ? '⚠ ' : ''}${text}`;
  feed.prepend(div);
  while (feed.children.length > 8) feed.removeChild(feed.lastChild);
  setTimeout(() => div.remove(), 60000);
}

/* ---------- 搜索 ---------- */
let searchTimer = null;
function bindSearch() {
  const input = $('#searchInput');
  const box = $('#searchResults');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const kw = input.value.trim();
    if (kw.length < 2) { box.classList.add('hidden'); return; }
    searchTimer = setTimeout(async () => {
      try {
        const { results } = await api(`/api/search?q=${encodeURIComponent(kw)}`);
        box.innerHTML = results.length
          ? results.map((r) => `
            <div class="sr-item" data-code="${esc(r.code)}" data-name="${esc(r.name)}">
              <div>
                <div>${esc(r.name)} <span class="code">${esc(r.code)}</span></div>
                <div class="meta">${esc([r.type, r.company, r.manager].filter(Boolean).join(' · '))}</div>
              </div>
              <button class="mini-btn">+关注</button>
            </div>`).join('')
          : '<div class="sr-empty">无匹配基金</div>';
        box.classList.remove('hidden');
      } catch (err) {
        box.innerHTML = `<div class="sr-empty">搜索失败:${esc(err.message)}</div>`;
        box.classList.remove('hidden');
      }
    }, 300);
  });
  box.addEventListener('click', async (e) => {
    const item = e.target.closest('.sr-item');
    if (!item) return;
    const code = item.dataset.code;
    const name = item.dataset.name;
    try {
      await api('/api/funds/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name }),
      });
      toast(`已关注 ${name}(${code})`);
      box.classList.add('hidden');
      input.value = '';
      await loadFunds();
      monitorPollRefresh();
    } catch (err) {
      toast(err.message);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) box.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      input.focus();
    }
  });
}

/* 新添加后轮询一次拉取估值 */
function monitorPollRefresh() {
  setTimeout(loadFunds, 2500);
}

/* ---------- 列表操作 ---------- */
function bindListActions() {
  $('#fundList').addEventListener('click', async (e) => {
    const btn = e.target.closest('.mini-btn');
    const card = e.target.closest('.fund-card');
    if (!card) return;
    const code = card.dataset.code;
    if (btn) {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'remove') {
        try {
          await api('/api/funds/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
          });
          funds.delete(code);
          renderList();
          toast('已取消关注');
        } catch (err) { toast(err.message); }
      } else if (act === 'rename') {
        const f = funds.get(code);
        const name = prompt('修改显示名称:', f ? f.name : '');
        if (name && name.trim()) {
          try {
            await api('/api/funds/rename', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code, name: name.trim() }),
            });
            await loadFunds();
          } catch (err) { toast(err.message); }
        }
      } else if (act === 'detail') {
        openDrawer(code);
      }
      return;
    }
    selectedCode = code;
    openDrawer(code);
  });
}

/* ---------- 概要抽屉 ---------- */
const RISK = { 1: '低', 2: '中低', 3: '中', 4: '中高', 5: '高' };

async function openDrawer(code) {
  const f = funds.get(code) || {};
  $('#drawerMask').classList.remove('hidden');
  $('#drawer').classList.remove('hidden');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#dTitle').textContent = f.name || code;
  $('#dSub').textContent = `${code}${f.estimate !== undefined && f.estimate !== null ? ` · 估值 ${fmtNum(f.estimate)} (${fmtRate(f.estimateRate)})` : ''}`;
  const body = $('#dBody');
  body.innerHTML = '<div class="loading">加载概要…</div>';

  try {
    const [summary, navHist] = await Promise.all([
      api(`/api/funds/summary?code=${code}`),
      api(`/api/funds/nav-history?code=${code}&pageSize=15`).catch(() => null),
    ]);
    renderSummary(body, summary, navHist);
  } catch (err) {
    body.innerHTML = `<div class="loading">概要加载失败:${esc(err.message)}</div>`;
  }
}

function renderSummary(el, s, navHist) {
  const rets = s.returns || {};
  const retCell = (k, v) => `
    <div class="ret-cell">
      <div class="k">${k}</div>
      <div class="v ${cls(v)}">${fmtRate(v)}</div>
    </div>`;
  const kv = (k, v) => `
    <div class="kv"><div class="k">${k}</div><div class="v">${v ?? '--'}</div></div>`;

  const managers = (s.managers || []).map((m) => `
    <div class="kv" style="grid-column: span 2;">
      <div class="k">基金经理</div>
      <div class="v">${esc(m.name)}${m.star ? ` ★${m.star}` : ''}
        <span style="color:var(--muted);font-weight:400;font-size:11px">${esc(m.workTime || '')} ${esc(m.fundSize || '')}</span>
      </div>
    </div>`).join('');

  let holderHtml = '';
  if (s.holderStructure && s.holderStructure.length) {
    const latest = s.holderStructure[s.holderStructure.length - 1];
    if (latest && latest.orgPct !== null) {
      holderHtml = `
        <div class="sec-title">持有人结构(${esc(latest.term || '')})</div>
        <div class="holder-bar">
          <div class="holder-org" style="width:${latest.orgPct}%"></div>
          <div class="holder-ind" style="width:${latest.individualPct || 0}%"></div>
        </div>
        <div style="font-size:11px;color:var(--muted)">机构 ${latest.orgPct}% · 个人 ${latest.individualPct ?? '--'}%</div>`;
    }
  }

  let allocHtml = '';
  if (s.assetAllocation) {
    const a = s.assetAllocation;
    allocHtml = `<div class="sec-title">资产配置(${esc(a.date || '')})</div>
      <div style="font-size:12px">股票 <b>${a.stock ?? '--'}%</b> · 债券 <b>${a.bond ?? '--'}%</b> · 现金 <b>${a.cash ?? '--'}%</b></div>`;
  }

  let navRows = '';
  if (navHist && navHist.rows && navHist.rows.length) {
    navRows = `
      <div class="sec-title">历史净值</div>
      <table class="nav-table">
        <tr><th>日期</th><th>单位净值</th><th>累计</th><th>日涨跌</th></tr>
        ${navHist.rows.map((r) => `
          <tr>
            <td>${esc(r.date)}</td>
            <td>${fmtNum(r.nav)}</td>
            <td>${fmtNum(r.accNav)}</td>
            <td class="${cls(r.dayChangePct)}">${fmtRate(r.dayChangePct)}</td>
          </tr>`).join('')}
      </table>`;
  }

  el.innerHTML = `
    <div class="kv-grid">
      ${kv('基金公司', esc(s.company))}
      ${kv('托管行', esc(s.custodian))}
      ${kv('成立日期', esc(s.foundDate))}
      ${kv('风险等级', RISK[s.riskLevel] || '--')}
      ${kv('规模', esc(s.scale))}
      ${kv('费率', esc(s.rate) ? `${esc(s.rate)}(原 ${esc(s.sourceRate || '--')})` : '--')}
      ${kv('起购金额', s.minBuy ? `${esc(s.minBuy)} 元` : '--')}
      ${kv('最新净值', s.nav !== null && s.nav !== undefined ? `${fmtNum(s.nav)} (${esc(s.navDate)})` : '--')}
      ${managers}
    </div>
    <div class="sec-title">阶段收益</div>
    <div class="returns-grid">
      ${retCell('近1月', rets.m1)}
      ${retCell('近3月', rets.m3)}
      ${retCell('近6月', rets.m6)}
      ${retCell('近1年', rets.y1)}
    </div>
    ${holderHtml}
    ${allocHtml}
    ${s.stockCodes && s.stockCodes.length ? `<div class="sec-title">重仓股票</div><div style="font-size:12px;color:var(--muted)">${s.stockCodes.slice(0, 15).map(esc).join(' · ')}</div>` : ''}
    ${navRows}
    <div style="margin-top:14px;font-size:11px;color:var(--muted)">来源:${esc(s.source)} · 缓存 6 小时</div>`;
}

function bindDrawer() {
  const close = () => {
    $('#drawer').classList.add('hidden');
    $('#drawerMask').classList.add('hidden');
    $('#drawer').setAttribute('aria-hidden', 'true');
    selectedCode = null;
    renderList();
  };
  $('#dClose').addEventListener('click', close);
  $('#drawerMask').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

/* ---------- 收盘预估报告 ---------- */
function renderClosingReport(r) {
  const items = (r.items || []).filter((x) => x.estimateRate !== null && x.estimateRate !== undefined);
  const sorted = [...items].sort((a, b) => b.estimateRate - a.estimateRate);
  const lines = sorted.slice(0, 5).map((x) =>
    `    ${x.name}(${x.code}) ${fmtRate(x.estimateRate)}`).join('\n');
  const more = items.length > 5 ? `\n    … 共 ${items.length} 只` : '';
  const summary = `📊 ${r.time} 收盘预估:均 ${fmtRate(r.avgRate)} · 涨${items.filter((x) => x.estimateRate > 0).length}/跌${items.filter((x) => x.estimateRate < 0).length}`;
  pushEvent(`${summary}\n${lines}${more}`, true);
  toast(summary, 6000);
  // 控制台输出完整报告便于复制
  console.log(`[收盘预估 ${r.time}]`, r);
}

async function manualClosingReport() {
  try {
    const { report } = await api('/api/funds/closing-report', { method: 'POST' });
    renderClosingReport(report);
  } catch (err) {
    toast(`收盘预估失败:${err.message}`);
  }
}

function bindClosingReportBtn() {
  $('#reportBtn').addEventListener('click', manualClosingReport);
}

/* ---------- 自动更新 ---------- */
function bindUpdateBtn() {
  $('#updateBtn').addEventListener('click', async () => {
    const btn = $('#updateBtn');
    btn.disabled = true;
    btn.textContent = '⏳ 检查中…';
    try {
      const r = await api('/api/update/apply', { method: 'POST' });
      if (r.upToDate) {
        toast(`已是最新版本 ${r.version}`);
      } else if (r.error) {
        toast(`更新失败:${r.error}`);
      } else if (r.needRestart) {
        toast(`新版本 ${r.latest} 已就绪,正在重启…`, 6000);
        setTimeout(async () => {
          try { await api('/api/update/restart', { method: 'POST' }); } catch { /* 进程退出导致的中断属预期 */ }
        }, 1200);
      } else {
        toast(`结果:${JSON.stringify(r).slice(0, 80)}`);
      }
    } catch (err) {
      toast(`更新检查失败:${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '⬆ 更新';
    }
  });
}

/* ---------- 手动同步 ---------- */
function bindSyncBtn() {
  $('#syncBtn').addEventListener('click', async () => {
    const btn = $('#syncBtn');
    btn.disabled = true;
    try {
      await api('/api/funds/sync', { method: 'POST' });
      pushEvent('手动同步完成');
      await loadFunds();
    } catch (err) {
      toast(`同步失败:${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------- 启动 ---------- */
function refreshSourcesLoop() {
  const loop = async () => {
    try {
      const { sources } = await api('/api/sources');
      renderSourceStats(sources);
    } catch { /* ignore */ }
    setTimeout(loop, 60000);
  };
  loop();
}

bindSearch();
bindListActions();
bindDrawer();
bindSyncBtn();
bindClosingReportBtn();
bindUpdateBtn();
connectStream();
loadFunds();
refreshSourcesLoop();
