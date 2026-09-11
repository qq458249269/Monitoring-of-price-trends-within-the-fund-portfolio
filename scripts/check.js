#!/usr/bin/env node
// 零依赖静态检查。本仓库为原生 JS(Electron),无 TypeScript/React,故:
//   lint      = 全部源码语法校验(node --check)
//   typecheck = 语法校验 + 测试套件(动态语言的事实类型门禁)
const { spawnSync } = require('node:child_process');
const { readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

const mode = process.argv[2] || 'lint';
const roots = ['public', 'electron', 'scripts', 'test', 'server.js'];

function collect(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, acc);
    else if (p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const files = [];
for (const r of roots) {
  if (r.endsWith('.js')) files.push(r);
  else collect(r, files);
}
files.sort();

let failed = false;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { failed = true; console.error(r.stderr || r.stdout); }
}
if (failed) {
  console.error(`✗ ${mode}: ${files.length} 个 JS 文件存在语法错误`);
  process.exit(1);
}
console.log(`✓ ${mode}: ${files.length} 个 JS 文件语法通过`);

if (mode === 'typecheck') {
  const t = spawnSync(process.execPath, ['--test'], { stdio: 'inherit' });
  process.exit(t.status ?? 1);
}