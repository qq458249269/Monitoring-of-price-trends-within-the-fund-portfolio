'use strict';

/* 自动更新:检查 GitHub Releases → 下载新 exe → SHA256 校验 → 自我替换(重命名策略)→ 重启。
 *
 * 替换策略(Windows 下运行中的 exe 无法删除,只能重命名):
 *   1. 现役 exe 改名 xxx.exe.old.<ts>(运行中允许)
 *   2. 新文件写到最终路径
 *   3. 重启自身(exec 新 exe / Electron app.relaunch)
 *   4. 启动时清理残留 *.old.*
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const OWNER_REPO = 'qq458249269/Monitoring-of-price-trends-within-the-fund-portfolio';
const API_LATEST = `https://api.github.com/repos/${OWNER_REPO}/releases/latest`;

/* ---------- 版本比较 ---------- */
function parseVer(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a > b 返回 1,a < b 返回 -1,相等/不可解析返回 0 */
function compareVersions(a, b) {
  const pa = parseVer(a);
  const pb = parseVer(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/* ---------- API ---------- */

/** 查询最新 release:{version, assets:[{name,url}], releaseNotes} */
async function fetchLatestRelease() {
  const res = await fetch(API_LATEST, {
    headers: {
      'User-Agent': 'fund-trend-monitor-updater',
      'Accept': 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null; // 还没有任何 release
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const j = await res.json();
  return {
    version: j.tag_name || '',
    name: j.name || '',
    releaseNotes: j.body || '',
    assets: (j.assets || []).map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    })),
  };
}

/** 在 release 资产里找给定平台应下载的 exe */
function pickAsset(rel, kind) {
  // kind: 'sea'(单文件) | 'desktop'(Electron portable)
  const prefer = kind === 'desktop' ? 'FundTrendMonitor-Portable.exe' : 'FundTrendMonitor.exe';
  const direct = rel.assets.find((a) => a.name === prefer);
  if (direct) return direct;
  return rel.assets.find((a) => a.name.endsWith('.exe')) || null;
}

/** 下载文件到临时路径(支持 http(s) 与 file:// — 后者供本地/测试使用) */
async function downloadTo(url, destFile, { onProgress } = {}) {
  if (url.startsWith('file://')) {
    const src = new URL(url).pathname.replace(/^\/([A-Za-z]:)/, '$1'); // Windows /D:/ → D:/
    fs.copyFileSync(src, destFile);
    const size = fs.statSync(destFile).size;
    if (onProgress) onProgress(size, size);
    return size;
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': 'fund-trend-monitor-updater' },
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const file = fs.createWriteStream(destFile);
  const reader = res.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      file.write(value);
      received += value.length;
      if (onProgress) onProgress(received, total);
    }
  } finally {
    file.end();
    await new Promise((resolve) => file.on('finish', resolve));
  }
  return received;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/** 从 SHA256SUMS.txt 内容中取指定文件名的期望摘要 */
function expectedDigest(sumsText, fileName) {
  for (const line of String(sumsText || '').split('\n')) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2].trim() === fileName) return m[1].toLowerCase();
  }
  return null;
}

/* ---------- 安装 ---------- */

/**
 * 应用更新:校验 → 重命名现役 exe → 落新文件 → 返回重启方式。
 * @param {object} opts
 * @param {string} opts.currentExePath 现役 exe 绝对路径
 * @param {string} opts.exeUrl 新 exe 下载地址
 * @param {string} opts.sumsUrl SHA256SUMS.txt 地址
 * @param {string} opts.assetName 资产文件名(用于摘要匹配)
 * @param {string} [opts.dataDir] 工作目录(放临时文件)
 * @returns {Promise<{ok:boolean, newVersion:string, bytes:number, backupPath:string}>}
 */
async function applyUpdate({ currentExePath, exeUrl, sumsUrl, assetName, dataDir }) {
  const workDir = dataDir || path.dirname(currentExePath);
  const tmpExe = path.join(workDir, `.update-${Date.now()}.exe`);
  const tmpSums = `${tmpExe}.sums`;

  try {
    // 1. 下载新 exe
    await downloadTo(exeUrl, tmpExe);

    // 2. SHA256 校验(有 sums 时强制,失败即放弃且不留任何残留)
    if (sumsUrl) {
      await downloadTo(sumsUrl, tmpSums);
      const expected = expectedDigest(fs.readFileSync(tmpSums, 'utf8'), assetName);
      if (!expected) throw new Error('SHA256SUMS 中找不到该资产的摘要');
      const actual = sha256(tmpExe);
      if (actual !== expected) {
        throw new Error(`SHA256 不匹配:期望 ${expected.slice(0, 12)}…,实际 ${actual.slice(0, 12)}…`);
      }
    }

    // 3. 现役 exe 重命名留档(运行中也允许 rename)
    const backupPath = `${currentExePath}.old.${Date.now()}`;
    fs.renameSync(currentExePath, backupPath);

    // 4. 新 exe 落到正式路径
    fs.copyFileSync(tmpExe, currentExePath);

    // 5. 顺带更新旁边的 SHA256SUMS.txt 记录
    try { fs.copyFileSync(tmpSums, path.join(workDir, 'SHA256SUMS.txt')); } catch { /* 可选 */ }

    return { ok: true, bytes: fs.statSync(currentExePath).size, backupPath };
  } finally {
    for (const f of [tmpExe, tmpSums]) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  }
}

/** 启动时清理历史备份 xxx.exe.old.* */
function cleanupOldVersions(exePath, keep = 1) {
  const dir = path.dirname(exePath);
  const base = path.basename(exePath);
  const olds = fs.readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.old.`))
    .map((f) => ({ f, t: Number(f.split('.old.')[1]) || 0 }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of olds.slice(keep)) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* 上次未退干净时可能仍被锁 */ }
  }
  return olds.length;
}

/** 重启到新版本:返回 spawn 的子进程(kind=electron 由调用方单独处理) */
function relaunchSea(exePath, args = []) {
  const child = spawn(exePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child;
}

module.exports = {
  OWNER_REPO,
  API_LATEST,
  parseVer,
  compareVersions,
  fetchLatestRelease,
  pickAsset,
  downloadTo,
  sha256,
  expectedDigest,
  applyUpdate,
  cleanupOldVersions,
  relaunchSea,
};
