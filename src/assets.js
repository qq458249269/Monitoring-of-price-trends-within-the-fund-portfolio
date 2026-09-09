'use strict';

/* 静态资源解析:SEA 打包后从 exe 内嵌资源读取;开发模式从 public/ 磁盘读取 */

let seaApi = null;
try {
  seaApi = require('node:sea');
} catch {
  seaApi = null; // 旧版本 Node 无 node:sea
}

function inSea() {
  try {
    return !!(seaApi && seaApi.isSea && seaApi.isSea());
  } catch {
    return false;
  }
}

const EMBEDDED = new Set(['index.html', 'app.js', 'style.css']);

/**
 * 读取静态资源。
 * @param {string} name 相对 public/ 的文件名(已由 api 层归一化)
 * @returns {Buffer}
 */
function readAsset(name) {
  if (inSea() && EMBEDDED.has(name)) {
    // Node 24 的 getRawAsset 返回 ArrayBuffer(而非文档所写 Buffer),
    // res.end(ArrayBuffer) 会抛错,统一转 Buffer
    return Buffer.from(seaApi.getRawAsset(name));
  }
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'public', name);
  return fs.readFileSync(file);
}

function existsAsset(name) {
  if (inSea() && EMBEDDED.has(name)) return true;
  const fs = require('fs');
  const path = require('path');
  return fs.existsSync(path.join(__dirname, '..', 'public', name));
}

module.exports = { readAsset, existsAsset, inSea, EMBEDDED };
