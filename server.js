'use strict';

/* 入口:组装 store / limiter / registry / monitor / api,启动 HTTP 服务。
 * 双模式:
 *  - CLI:node server.js [--port 9000] [--host 0.0.0.0]
 *  - 嵌入:被 Electron 主进程 require,调用 startApp() 拿到已启动的服务
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const { Store } = require('./src/store');
const { RateLimiter } = require('./src/ratelimit');
const { SourceRegistry } = require('./src/sources/registry');
const { Monitor } = require('./src/monitor');
const { createApiHandler } = require('./src/api');
const { inSea } = require('./src/assets');
const updater = require('./src/updater');

/** 应用版本:构建时注入(APP_VERSION),源码运行读 VERSION 文件 */
function appVersion() {
  if (typeof APP_VERSION === 'string') return APP_VERSION; // esbuild define 注入
  try {
    return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

/** SEA 模式下现役 exe 路径(自我替换目标) */
function currentExePath() {
  return inSea() ? process.execPath : null;
}

/** 数据/配置根目录:优先 FUNDMON_BASEDIR(Electron 打包时指向 userData),
 *  SEA 单文件用 exe 所在目录,开发模式用项目根 */
function baseDir() {
  if (process.env.FUNDMON_BASEDIR) return process.env.FUNDMON_BASEDIR;
  return inSea() ? path.dirname(process.execPath) : __dirname;
}

function loadConfig(root) {
  const configPath = path.join(root, 'config.json');
  const defaults = {
    server: { host: '127.0.0.1', port: 8787 },
    sync: { intervalMs: 60000, jitterMs: 8000, maxFundsPerCycle: 40 },
    rateLimit: { minIntervalMs: 800, maxPerMinute: 20, backoffBaseMs: 30000, backoffMaxMs: 900000 },
    summaryCacheMs: 6 * 3600 * 1000,
    navHistoryCacheMs: 3600 * 1000,
    alertThresholds: [0.5, 1.0, 2.0, -0.5, -1.0, -2.0],
    closingReport: { enabled: true, time: '14:50', holidays: [] },
    defaults: [],
  };
  let fileCfg = {};
  try {
    if (fs.existsSync(configPath)) fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.warn(`[config] 解析 config.json 失败,使用内置默认:${err.message}`);
  }
  const cfg = {
    ...defaults,
    ...fileCfg,
    server: { ...defaults.server, ...(fileCfg.server || {}) },
    sync: { ...defaults.sync, ...(fileCfg.sync || {}) },
    rateLimit: { ...defaults.rateLimit, ...(fileCfg.rateLimit || {}) },
    closingReport: { ...defaults.closingReport, ...(fileCfg.closingReport || {}) },
  };
  if (!process.versions.electron) {
    // CLI 覆盖: --port 9000(Electron 下无意义,交给配置)
    const argv = process.argv;
    const portIdx = argv.indexOf('--port');
    if (portIdx > -1 && argv[portIdx + 1]) cfg.server.port = Number(argv[portIdx + 1]) || cfg.server.port;
    const hostIdx = argv.indexOf('--host');
    if (hostIdx > -1 && argv[hostIdx + 1]) cfg.server.host = argv[hostIdx + 1];
  }
  return cfg;
}

/** 默认日志走 stdout(打包后 Console 输出不可见,Electron 模式会注入) */
function makeDefaultLog() {
  return (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
}

/**
 * 启动应用(供 CLI 与 Electron 共用)。
 * @returns {{ server, store, registry, monitor, cfg, log, stop: () => Promise<void> }}
 */
function startApp({ log, port, host } = {}) {
  const root = baseDir();
  const cfg = loadConfig(root);
  if (port) cfg.server.port = port;
  if (host) cfg.server.host = host;
  log = log || makeDefaultLog();

  const dataDir = path.join(root, 'data');
  const store = new Store(dataDir);
  store.init();

  if (!store.getWatchlist().length && Array.isArray(cfg.defaults) && cfg.defaults.length) {
    for (const d of cfg.defaults) {
      if (d && /^\d{6}$/.test(String(d.code || ''))) store.addFund(d);
    }
    log(`已载入 ${store.getWatchlist().length} 只默认关注基金`);
  }

  const limiter = new RateLimiter(cfg.rateLimit);
  const registry = new SourceRegistry(limiter, cfg, log);
  const monitor = new Monitor({ store, registry, cfg, log });

  const app = {
    store,
    registry,
    monitor,
    cfg,
    log,
    version: appVersion(),
    url: `http://${cfg.server.host}:${cfg.server.port}`,
  };

  const { handler } = createApiHandler({ store, registry, monitor, cfg, log, app });
  const server = http.createServer(handler);
  app.server = server;
  app.stop = () => new Promise((resolve) => {
    monitor.stop();
    server.close(() => resolve());
    store.close();
  });

  /* ---------- 自动更新 ---------- */
  const exePath = currentExePath();
  if (exePath) {
    updater.cleanupOldVersions(exePath); // 启动清理 *.old.* 备份
  }

  /** 获取自我替换目标路径:SEA 用 process.execPath,Electron 用 canonical exe,其它 null */
  function getExePath() {
    if (inSea()) return exePath;
    if (app.canonicalExePath) return app.canonicalExePath;
    return null;
  }

  /** 检查更新;apply=true 时下载校验并替换,返回是否需要重启 */
  app.checkUpdate = async (apply = false) => {
    if (app._updChecking) return { ok: false, error: '正在检查更新,请稍候' };
    app._updChecking = true;
    try {
      const rel = await updater.fetchLatestRelease();
      if (!rel) return { ok: true, upToDate: true, reason: 'no release yet', version: app.version };
      const cmp = updater.compareVersions(rel.version, app.version);
      if (cmp <= 0) return { ok: true, upToDate: true, version: app.version, latest: rel.version };
      const asset = updater.pickAsset(rel, inSea() ? 'sea' : 'desktop');
      if (!asset) return { ok: false, error: `release ${rel.version} 没有 exe 资产` };
      if (!apply) return { ok: true, upToDate: false, version: app.version, latest: rel.version, asset: asset.name, notes: rel.releaseNotes };
      const target = getExePath();
      if (!target) return { ok: false, error: '当前运行方式不支持自动更新(源码模式请 git pull)' };
      log(`发现新版本 ${rel.version},开始下载 ${asset.name}…`);
      const r = await updater.applyUpdate({
        currentExePath: target,
        exeUrl: asset.url,
        sumsUrl: (rel.assets.find((a) => a.name === 'SHA256SUMS.txt') || {}).url || null,
        assetName: asset.name,
        dataDir: path.dirname(target),
      });
      log(`更新完成:${(r.bytes / 1024 / 1024).toFixed(1)} MB,旧版备份于 ${r.backupPath}`);
      return { ok: true, upToDate: false, updated: true, version: app.version, latest: rel.version, ...r, needRestart: true };
    } finally {
      app._updChecking = false;
    }
  };

  /** 重启进入新版本:SEA/Electron 直接 exec;其它返回提示 */
  app.restartIntoUpdate = async () => {
    await app.stop();
    const target = getExePath();
    if (target) {
      const child = updater.relaunchSea(target, process.argv.slice(1));
      log(`已拉起新版本进程 pid=${child.pid},当前进程退出`);
      process.exit(0);
    }
    return { ok: false, error: '当前运行方式不支持自动重启,请手动重启应用' };
  };

  // 后台定时检查(默认 6h,可关:update.enabled=false)
  const updCfg = cfg.update || { enabled: true, intervalMs: 6 * 3600 * 1000 };
  if (updCfg.enabled !== false) {
    const loop = async () => {
      if (app._updStopped) return;
      try {
        const r = await app.checkUpdate(true); // apply=true:下载替换,重启由用户确认
        if (!r.upToDate && r.updated) log(`新版本 ${r.latest} 已就绪,重启后生效(访问 /api/update 或界面按钮)`);
        else if (r.error) log(`更新检查失败:${r.error}`);
      } catch (err) {
        log(`更新检查失败:${err.message}`);
      }
      app._updTimer = setTimeout(loop, updCfg.intervalMs || 6 * 3600 * 1000);
    };
    app._updTimer = setTimeout(loop, 30000); // 启动 30s 后先查一次
  }
  app.stop = ((origStop) => async () => {
    app._updStopped = true;
    if (app._updTimer) clearTimeout(app._updTimer);
    return origStop();
  })(app.stop);

  /** 端口不可用:EADDRINUSE 被占 / EACCES 被系统排除区间保留(Windows Hyper-V/WSL) */
  const portUnavailable = (code) => code === 'EADDRINUSE' || code === 'EACCES';

  /** Windows:解析 netsh 保留端口区间一次,命中则直接跳到区间末尾之后,避免逐口空转 */
  let winExcluded = null;
  const winSkipPort = (p) => {
    if (process.platform !== 'win32') return p;
    try {
      if (winExcluded === null) {
        winExcluded = [];
        const out = require('child_process').execSync(
          'netsh interface ipv4 show excludedportrange protocol=tcp',
          { encoding: 'utf8', windowsHide: true });
        for (const m of out.matchAll(/^\s*(\d{4,5})\s+(\d{4,5})\s*$/gm)) {
          winExcluded.push([+m[1], +m[2]]);
        }
      }
      for (const [lo, hi] of winExcluded) {
        if (p >= lo && p <= hi) return hi + 1;
      }
    } catch { /* netsh 不可用则退化逐口重试 */ }
    return p;
  };

  return new Promise((resolve, reject) => {
    const MAX_TRIES = 20;
    let tries = 0;
    let started = false;
    let onStartErr = null;
    const tryListen = () => {
      onStartErr = (err) => {
        server.removeListener('error', onStartErr);
        if (portUnavailable(err.code) && !started && tries < MAX_TRIES) {
          tries += 1;
          const next = winSkipPort(cfg.server.port + 1);
          log(`端口 ${cfg.server.port} 不可用(${err.code}),改用 ${next}`);
          cfg.server.port = next;
          tryListen();
        } else {
          reject(err);
        }
      };
      server.once('error', onStartErr);
      server.listen(cfg.server.port, cfg.server.host, () => {
        server.removeListener('error', onStartErr);
        started = true;
        app.url = `http://${cfg.server.host}:${cfg.server.port}`;
        monitor.start();
        log(`基金趋势监测服务 ${app.url} · v${app.version}`);
        resolve(app);
      });
    };
    tryListen();
    // 成功启动后端口失效(自我更新替换 exe 时旧进程未退干净)→ 顺延重听
    server.on('error', (err) => {
      if (started && portUnavailable(err.code) && process.env.FUNDMON_PORT_RETRY !== '1') {
        process.env.FUNDMON_PORT_RETRY = '1';
        cfg.server.port = winSkipPort(cfg.server.port + 1);
        log(`端口被占/被保留,改用 ${cfg.server.port}`);
        server.listen(cfg.server.port, cfg.server.host);
      }
    });
  });
}

module.exports = { startApp, loadConfig, baseDir };

/* CLI 直接运行时(node server.js)自动启动 */
if (require.main === module) {
  const app = startApp();
  app.catch((err) => {
    console.error('启动失败:', err.message);
    process.exit(1);
  });
  const shutdown = async () => {
    const a = await app;
    console.log('正在退出,落盘数据…');
    await a.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
