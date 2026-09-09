'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  compareVersions, parseVer, expectedDigest, applyUpdate, cleanupOldVersions, pickAsset,
} = require('../src/updater');

test('compareVersions 语义化比较', () => {
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.0.9', '0.1.0'), -1);
  assert.equal(parseVer('bad'), null);
  assert.equal(compareVersions('bad', '1.0.0'), 0);
});

test('expectedDigest 匹配 SHA256SUMS 行', () => {
  const sums = `aaaa..  other.exe\n${'a'.repeat(64)}  FundTrendMonitor.exe\n${'b'.repeat(64)}  *FundTrendMonitor-Portable.exe`;
  assert.equal(expectedDigest(sums, 'FundTrendMonitor.exe'), 'a'.repeat(64));
  assert.equal(expectedDigest(sums, 'FundTrendMonitor-Portable.exe'), 'b'.repeat(64));
  assert.equal(expectedDigest(sums, 'nope.exe'), null);
});

test('pickAsset 按类型选择资产', () => {
  const rel = {
    assets: [
      { name: 'SHA256SUMS.txt', url: 'u3' },
      { name: 'FundTrendMonitor.exe', url: 'u1' },
      { name: 'FundTrendMonitor-Portable.exe', url: 'u2' },
    ],
  };
  assert.equal(pickAsset(rel, 'sea').name, 'FundTrendMonitor.exe');
  assert.equal(pickAsset(rel, 'desktop').name, 'FundTrendMonitor-Portable.exe');
  const rel2 = { assets: [{ name: 'whatever.exe', url: 'u' }] };
  assert.equal(pickAsset(rel2, 'sea').name, 'whatever.exe');
  assert.equal(pickAsset({ assets: [] }, 'sea'), null);
});

test('applyUpdate:下载校验重命名替换全流程', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  // 假现役 exe
  const exePath = path.join(dir, 'FundTrendMonitor.exe');
  fs.writeFileSync(exePath, 'OLD-EXE');
  // "远端"文件:本地文件 URL + 摘要
  const newExe = path.join(dir, 'new.exe');
  fs.writeFileSync(newExe, 'NEW-EXE-BODY');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(newExe)).digest('hex');
  const sums = path.join(dir, 'SHA256SUMS.txt');
  fs.writeFileSync(sums, `${digest}  FundTrendMonitor.exe\n`);

  const r = await applyUpdate({
    currentExePath: exePath,
    exeUrl: `file://${newExe.replace(/\\/g, '/')}`,
    sumsUrl: `file://${sums.replace(/\\/g, '/')}`,
    assetName: 'FundTrendMonitor.exe',
    dataDir: dir,
  });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(exePath, 'utf8'), 'NEW-EXE-BODY');
  assert.ok(fs.existsSync(r.backupPath)); // 旧版已重命名留档
  assert.equal(fs.readFileSync(r.backupPath, 'utf8'), 'OLD-EXE');
  // 摘要不匹配 → 抛错且原 exe 不动
  fs.writeFileSync(sums, `${'0'.repeat(64)}  FundTrendMonitor.exe\n`);
  await assert.rejects(() => applyUpdate({
    currentExePath: exePath,
    exeUrl: `file://${newExe.replace(/\\/g, '/')}`,
    sumsUrl: `file://${sums.replace(/\\/g, '/')}`,
    assetName: 'FundTrendMonitor.exe',
    dataDir: dir,
  }));
  assert.equal(fs.readFileSync(exePath, 'utf8'), 'NEW-EXE-BODY');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanupOldVersions 只保留最新 N 个备份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cln-'));
  const exePath = path.join(dir, 'FundTrendMonitor.exe');
  fs.writeFileSync(exePath, 'x');
  const now = Date.now();
  for (const t of [now - 3000, now - 2000, now - 1000]) {
    fs.writeFileSync(`${exePath}.old.${t}`, 'old');
  }
  const found = cleanupOldVersions(exePath, 1);
  assert.equal(found, 3);
  const remain = fs.readdirSync(dir).filter((f) => f.includes('.old.'));
  assert.equal(remain.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
