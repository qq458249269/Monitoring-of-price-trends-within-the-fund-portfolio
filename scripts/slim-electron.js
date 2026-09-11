'use strict';

/* 精简 Electron 打包产物(electron-builder afterPack 钩子):
 * 1. 删除 55 种语言包,只留 zh-CN / en-US(省 ~40 MB 未压缩)
 * 2. 删除非必需大文件:SwiftShader/Vulkan 软渲染、D3D 编译器、
 *    LICENSES.chromium.html(应用窗口不用 GPU 加速 fallback 也能跑;
 *    若用户机器极端缺 GPU 驱动,窗口仍可用 ANGLE/D3D11 默认路径)
 * 3. 删除开源许可文本(发布页单独附 LICENSE,不影响运行)
 *
 * 预期:win-unpacked 从 ~260 MB 降到 ~210 MB,portable exe 相应缩小。
 */

const fs = require('fs');
const path = require('path');

/** 需要保留的语言包(应用 UI 只有中文/英文) */
const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);

/** resources 根目录下直接删除的文件/目录(按名字精确匹配) */
const REMOVE_NAMES = new Set([
  'vk_swiftshader.dll', // Vulkan 软件渲染 fallback(~5.3 MB)
  'vk_swiftshader_icd.json',
  'vulkan-1.dll', // Vulkan loader(~0.9 MB)
  'd3dcompiler_47.dll', // HLSL 编译器,ANGLE WebGL 用(~4.7 MB)
  'LICENSES.chromium.html', // ~8.8 MB 纯文本
  'LICENSE.electron.txt',
]);

function removeRecursive(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = async function slimElectron(context) {
  const dir = context.appOutDir;
  const removed = { bytes: 0, files: 0 };

  const rm = (p, size) => {
    if (removeRecursive(p)) {
      removed.files += 1;
      removed.bytes += size || 0;
    }
  };

  // 1. 语言包:只留 KEEP_LOCALES
  const localesDir = path.join(dir, 'locales');
  if (fs.existsSync(localesDir)) {
    for (const f of fs.readdirSync(localesDir)) {
      if (!KEEP_LOCALES.has(f)) {
        rm(path.join(localesDir, f), fs.statSync(path.join(localesDir, f)).size);
      }
    }
  }

  // 2. 非必需大文件
  for (const name of REMOVE_NAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) rm(p, fs.statSync(p).size);
  }

  const mb = (removed.bytes / 1024 / 1024).toFixed(1);
  console.log(`[slim-electron] removed ${removed.files} files, saved ~${mb} MB (unpacked) from ${dir}`);
};
