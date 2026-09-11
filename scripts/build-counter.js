'use strict';

/* 当天构建计数器(供 gen-version.js 生成 YYYYMMDD.<当天构建次数> 版本号)。
 *
 * 计数文件存在脚本目录下(默认被 .gitignore 忽略,不入库):
 *   - 本地:scripts/.build-counter.json
 *   - CI:同上。每天首个构建写 1,当天后续构建递增。
 *     由于 runner 每次都是全新机器,本地文件在 CI 上**不跨工作流共享**;
 *     CI 的持久计数见 build.yml —— 用 Releases 列表统计当天 tag 数,
 *     取 max(本地计数, release 计数) 保证多次构建不会撞号。
 */

const fs = require('fs');
const path = require('path');

const COUNTER_FILE = path.join(__dirname, '.build-counter.json');

/** 读取本地计数文件:{ 'YYYYMMDD': n } → 当天计数,无记录返回 0 */
function readLocalCount(dateStr) {
  try {
    const j = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
    return Number(j[dateStr]) || 0;
  } catch {
    return 0;
  }
}

/** 写入本地计数文件(顺带清理 30 天前的旧记录) */
function writeLocalCount(dateStr, count) {
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
  } catch { /* 首次创建 */ }
  const cutoff = (BigInt(dateStr) - 30n).toString(); // 粗略滚动清理
  for (const k of Object.keys(j)) {
    if (k < cutoff) delete j[k];
  }
  j[dateStr] = count;
  fs.writeFileSync(COUNTER_FILE, `${JSON.stringify(j, null, 2)}\n`);
  return count;
}

/** 本地当天计数 +1 */
function bumpLocal(dateStr) {
  return writeLocalCount(dateStr, readLocalCount(dateStr) + 1);
}

module.exports = { COUNTER_FILE, readLocalCount, writeLocalCount, bumpLocal };
