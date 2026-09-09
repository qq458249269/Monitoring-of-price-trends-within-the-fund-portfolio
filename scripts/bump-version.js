'use strict';

/* CI 用:patch 版本号自动递增(VERSION + package.json 同步)。
 * 本地运行只打印;GitHub Actions 运行时写入 GITHUB_OUTPUT 供后续步骤引用。 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const versionPath = path.join(root, 'VERSION');
const pkgPath = path.join(root, 'package.json');

const cur = fs.readFileSync(versionPath, 'utf8').trim();
const m = cur.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!m) {
  console.error(`VERSION 格式非法:${cur}`);
  process.exit(1);
}
const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;

fs.writeFileSync(versionPath, `${next}\n`);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = next;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=v${next}\n`);
}
console.log(`bumped: ${cur} → ${next}`);
