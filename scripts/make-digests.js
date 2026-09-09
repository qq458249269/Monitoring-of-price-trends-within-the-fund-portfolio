'use strict';

/* 生成 SHA256SUMS.txt(<sha256>  <文件名>),供客户端自动更新校验。
 * 用法:node scripts/make-digests.js <file1> <file2> …(默认 dist 下两个 exe) */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
let files = process.argv.slice(2);
if (!files.length) {
  files = [
    path.join(root, 'dist', 'FundTrendMonitor.exe'),
    path.join(root, 'release', 'FundTrendMonitor-Portable.exe'),
  ].filter((f) => fs.existsSync(f));
}
if (!files.length) {
  console.error('没有可生成摘要的文件');
  process.exit(1);
}

const lines = files.map((f) => {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(f));
  return `${h.digest('hex')}  ${path.basename(f)}`;
});
const out = path.join(root, 'dist', 'SHA256SUMS.txt');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
console.log(`→ ${out}`);
