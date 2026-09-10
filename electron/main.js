'use strict';

/* Electron 主进程:原生窗口客户端
 * - 内嵌 startApp() 的监测服务(同引擎,无浏览器依赖)
 * - 原生窗口 + 任务栏图标
 */

const { app, BrowserWindow, Notification, shell, dialog } = require('electron');
const path = require('path');
const { ensureCanonicalCopy, checkAndInstall, canonicalExePath } = require('./updater');

let win = null;
let appHandle = null; // { url, stop, monitor, log, ... }
let updateState = { checking: false, last: null, ready: false };

/** 系统原生通知(窗口最小化也能看到) */
function notify(title, body, urgent = false) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: !urgent });
  n.on('click', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  n.show();
}

function logLine(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(ts, ...args);
}

/* ---------- 自动更新调度 ---------- */
function scheduleUpdateLoop(canonicalExe) {
  const check = async () => {
    if (updateState.checking) return;
    updateState.checking = true;
    try {
      const r = await checkAndInstall(app, { exePath: canonicalExe, log: logLine });
      updateState.last = { at: Date.now(), ...r };
      if (r.updated && r.needRestart) {
        updateState.ready = true;
        notify('更新已就绪', `新版本 ${r.latest} 已下载,重启应用即生效`, true);
      }
    } catch (err) {
      updateState.last = { at: Date.now(), error: err.message };
      logLine(`更新检查失败:${err.message}`);
    } finally {
      updateState.checking = false;
    }
    setTimeout(check, 6 * 3600 * 1000); // 6h 一查
  };
  setTimeout(check, 20000); // 启动 20s 后首查
}

async function bootServer() {
  // 运行时自我安装:portable 首跑复制到规范路径,之后更新替换该副本
  const canonical = ensureCanonicalCopy(app);
  process.env.FUNDMON_BASEDIR = app.getPath('userData');
  logLine(`运行副本:${canonical.exePath}${canonical.copied ? '(新复制)' : ''}`);

  // 打包后 asar 只读:配置首跑导出到 userData
  const fs = require('fs');
  const cfgInAsar = path.join(__dirname, '..', 'config.json');
  const cfgTarget = path.join(app.getPath('userData'), 'config.json');
  if (!fs.existsSync(cfgTarget) && fs.existsSync(cfgInAsar)) {
    fs.copyFileSync(cfgInAsar, cfgTarget);
  }

  const { startApp } = require(path.join(__dirname, '..', 'server.js'));
  appHandle = await startApp({ log: logLine });

  // 服务器事件 → 原生通知
  const { monitor } = appHandle;
  monitor.onEvent((evt) => {
    if (evt.type === 'alert') {
      const icon = evt.payload.type === 'anomaly' ? '⚡' : '⚠';
      notify(`${icon} ${evt.payload.type === 'anomaly' ? '异动' : '估值提醒'}`, evt.payload.message, true);
    } else if (evt.type === 'closing-report') {
      const items = (evt.payload.items || []).filter((x) => x.estimateRate !== null && x.estimateRate !== undefined);
      const up = items.filter((x) => x.estimateRate > 0).length;
      const down = items.filter((x) => x.estimateRate < 0).length;
      const top = [...items].sort((a, b) => b.estimateRate - a.estimateRate);
      const head = top.slice(0, 3).map((x) => `${x.name} ${x.estimateRate > 0 ? '+' : ''}${x.estimateRate}%`).join('\n');
      notify(
        `${evt.payload.time} 收盘预估 · 均 ${evt.payload.avgRate === null ? '--' : evt.payload.avgRate + '%'}(涨${up}/跌${down})`,
        head || '暂无有效估值',
      );
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    title: '基金估值趋势监测',
    backgroundColor: '#0f1419',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 主进程日志转发到窗口控制台(便于排查)
  win.webContents.on('did-finish-load', () => {
    logLine(`窗口已加载:${appHandle ? appHandle.url : '?'}`);
  });

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const target = appHandle ? appHandle.url : 'about:blank';
  win.loadURL(target).catch((err) => {
    dialog.showErrorBox('加载失败', `无法加载 ${target}\n\n${err.message}`);
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  try {
    await bootServer();
  } catch (err) {
    dialog.showErrorBox('服务启动失败', err.message);
    app.quit();
    return;
  }
  createWindow();
  scheduleUpdateLoop(canonicalExePath(app.getPath('userData')));

  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('before-quit', async () => {
  if (appHandle) {
    try { await appHandle.stop(); } catch { /* ignore */ }
    appHandle = null;
  }
});
