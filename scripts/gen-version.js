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

const build = arg('build', String(Date.now()));
const versionDate = new Date();
const pad = (n) => String(n).padStart(2, '0');
const dateStr = `${versionDate.getFullYear()}${pad(versionDate.getMonth() + 1)}${pad(versionDate.getDate())}`;
const version = `${dateStr}.${build}`;

const meta = {
  version,
  build,
  sha: (arg('sha', '') || '').slice(0, 7),
  buildTime: versionDate.toISOString(),
};

fs.writeFileSync(path.join(__dirname, 'version.json'), `${JSON.stringify(meta, null, 2)}\n`);
console.log(`build meta: v${meta.version} build#${meta.build} ${meta.sha}`);
