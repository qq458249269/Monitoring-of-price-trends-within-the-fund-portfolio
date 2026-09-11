'use strict';

/* 构建期元数据:生成 scripts/version.json,供 build:exe 注入 APP_VERSION。
 * 用法:node scripts/gen-version.js --build <run_number> --sha <commit> [--version v0.1.1] */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const buildArg = arg('build', null);
const versionDate = new Date();
const pad = (n) => String(n).padStart(2, '0');
const dateStr = `${versionDate.getFullYear()}${pad(versionDate.getMonth() + 1)}${pad(versionDate.getDate())}`;

// 未显式传 --build 时(如 build:exe 重跑),保留当天已有构建序号,避免被 Date.now() 覆盖
let build = buildArg;
let sha = arg('sha', '').slice(0, 7) || '';
if (!build) {
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8'));
    if (String(prev.version).startsWith(`${dateStr}.`)) {
      build = prev.build;
      sha = sha || prev.sha || '';
      console.log(`build meta: 复用当天 v${prev.version} build#${prev.build}`);
    }
  } catch { /* 无历史,首次生成 */ }
}
const finalBuild = build || String(Date.now());
const version = `${dateStr}.${finalBuild}`;

const meta = {
  version,
  build: finalBuild,
  sha: sha.slice(0, 7),
  buildTime: new Date().toISOString(),
};

fs.writeFileSync(path.join(__dirname, 'version.json'), `${JSON.stringify(meta, null, 2)}\n`);
if (!build) console.log(`build meta: v${meta.version} build#${finalBuild} ${meta.sha}`);
