'use strict';

/* 打包 Windows 单文件 exe(Node SEA 方案):
 * 1. esbuild 把 server.js 及依赖打成单文件 CJS bundle(src/assets.js 运行时自动切换内嵌/磁盘资源)
 * 2. node --experimental-sea-config 生成 blob(按 sea-config.json 内嵌 public/ 静态资源)
 * 3. 复制当前 node.exe → dist/FundTrendMonitor.exe
 * 4. postject 注入 blob
 *
 * 运行:npm run build:exe  (联网下载 esbuild/postject,产物免 Node 环境直接双击运行)
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const target = path.join(dist, 'FundTrendMonitor.exe');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败(exit ${r.status})`);
}

/** 直接调用 esbuild 原生二进制(避免 Windows shell 吞引号) */
function esbuildBin() {
  const p1 = path.join(root, 'node_modules', '@esbuild', `win32-x64`, 'esbuild.exe');
  if (process.platform === 'win32' && fs.existsSync(p1)) return p1;
  return path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');
}

function ensureTools() {
  const need = [];
  if (!fs.existsSync(path.join(root, 'node_modules', 'esbuild'))) need.push('esbuild@0.24.0');
  if (!fs.existsSync(path.join(root, 'node_modules', 'postject'))) need.push('postject@1.0.0-alpha.6');
  if (need.length) {
    console.log(`[1/5] 安装打包工具 ${need.join(', ')} …`);
    // npm 在 Windows 是 npm.cmd,必须经 shell 调起
    const r = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', ...need], {
      stdio: 'inherit', cwd: root, shell: true,
    });
    if (r.status !== 0) throw new Error(`npm install 打包工具失败(exit ${r.status})`);
  } else {
    console.log('[1/5] 打包工具已就绪');
  }
}

function main() {
  fs.mkdirSync(dist, { recursive: true });

  ensureTools();

  console.log('[2/5] esbuild 打包 → dist/bundle.cjs…');
  // 注入构建元数据(APP_VERSION / BUILD_META),源码运行时回退读 VERSION 文件
  run('node', [path.join(root, 'scripts', 'gen-version.js')]);
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'version.json'), 'utf8'));
  run(esbuildBin(), [
    'server.js',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node18',
    '--outfile=dist/bundle.cjs',
    `--define:APP_VERSION=${JSON.stringify(meta.version)}`,
  ], { shell: false });

  console.log('[3/5] 生成 SEA blob(内嵌 index.html/app.js/style.css)…');
  run('node', ['--experimental-sea-config', 'sea-config.json']);

  console.log('[4/5] 复制 node.exe → dist/FundTrendMonitor.exe…');
  fs.copyFileSync(process.execPath, target);

  console.log('[5/5] postject 注入 blob…');
  run('node', [
    path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
    target,
    'NODE_SEA_BLOB',
    path.join(dist, 'sea-prep.blob'),
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ]);

  const mb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`\n完成:dist/FundTrendMonitor.exe (${mb} MB)`);

  // 便捷:把 config.json 复制到 exe 同目录(已有则不覆盖)
  const cfgTarget = path.join(dist, 'config.json');
  if (fs.existsSync(path.join(root, 'config.json')) && !fs.existsSync(cfgTarget)) {
    fs.copyFileSync(path.join(root, 'config.json'), cfgTarget);
    console.log('已复制 config.json → dist/(可编辑后重启生效)');
  }

  console.log('说明:');
  console.log('  - 双击运行或命令行运行,默认 http://127.0.0.1:8787');
  console.log('  - data/ 目录生成在 exe 同目录,用于持久化关注列表与采样');
}

main();
