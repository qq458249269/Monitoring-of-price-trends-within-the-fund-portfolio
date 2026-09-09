'use strict';

/* 自动更新集成(Electron 桌面版):
 * - 首次运行:把自身复制到 %APPDATA%/FundTrendMonitor/FundTrendMonitor.exe 规范路径
 *   (之后所有更新都替换这个副本,原下载文件不动)
 * - 启动时清理 *.old.* 备份
 * - 定时检查 GitHub release → 下载+SHA256 → 替换规范路径 exe → app.relaunch()
 */

const fs = require('fs');
const path = require('path');
const updater = require('../src/updater');

/** 规范安装路径:%APPDATA%/FundTrendMonitor/FundTrendMonitor.exe */
function canonicalExePath(userDataDir) {
  return path.join(userDataDir, 'FundTrendMonitor.exe');
}

/**
 * 确保规范副本存在:portable exe 首次运行时把自身复制过去(重命名式安装)。
 * 返回实际应运行的 exe 路径(规范副本优先)。
 */
function ensureCanonicalCopy(app) {
  const running = process.execPath;
  const userData = app.getPath('userData');
  const canonical = canonicalExePath(userData);

  // 已经在跑规范副本
  if (path.resolve(running) === path.resolve(canonical)) {
    updater.cleanupOldVersions(canonical);
    return { exePath: canonical, copied: false };
  }

  // portable 临时目录(win-unpacked / _MEI 之类)→ 复制自身到规范路径
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  const needCopy = !fs.existsSync(canonical)
    || fs.statSync(running).size !== fs.statSync(canonical).size;
  if (needCopy) {
    const backup = `${canonical}.old.${Date.now()}`;
    if (fs.existsSync(canonical)) {
      try { fs.renameSync(canonical, backup); } catch { /* 可能正被占用 */ }
    }
    fs.copyFileSync(running, canonical);
  }
  updater.cleanupOldVersions(canonical);
  return { exePath: canonical, copied: true };
}

/** 定时检查更新;发现新版本时下载校验并替换规范 exe,返回是否已就绪待重启 */
async function checkAndInstall(app, { exePath, log }) {
  const rel = await updater.fetchLatestRelease();
  if (!rel) return { upToDate: true, reason: 'no release yet' };
  const current = app.getVersion();
  if (updater.compareVersions(rel.version, current) <= 0) {
    return { upToDate: true, version: current, latest: rel.version };
  }
  const asset = updater.pickAsset(rel, 'desktop');
  if (!asset) return { upToDate: false, error: `release ${rel.version} 没有 exe 资产` };

  log(`发现新版本 ${rel.version},下载 ${asset.name}…`);
  const r = await updater.applyUpdate({
    currentExePath: exePath,
    exeUrl: asset.url,
    sumsUrl: (rel.assets.find((a) => a.name === 'SHA256SUMS.txt') || {}).url || null,
    assetName: asset.name,
    dataDir: app.getPath('userData'),
  });
  log(`更新完成:${(r.bytes / 1024 / 1024).toFixed(1)} MB → ${exePath}`);
  return { upToDate: false, updated: true, latest: rel.version, needRestart: true };
}

module.exports = { canonicalExePath, ensureCanonicalCopy, checkAndInstall };
