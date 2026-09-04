// scripts/build-manual.mjs
// gmt-manual-* 人工测试脚本族拼接：_panel-core.js + <module>.user.js.src → gmt-manual-<module>.user.js
// 零依赖（node:fs）；幂等（重复运行产物一致）。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'fixtures/userscripts/manual');
const core = readFileSync(join(srcDir, '_panel-core.js'), 'utf8');

// 扫描 <module>.user.js.src（排除 _panel-core.js）
const modules = readdirSync(srcDir)
  .filter((f) => f.endsWith('.user.js.src'))
  .map((f) => f.replace(/\.user\.js\.src$/, ''))
  .sort();

for (const mod of modules) {
  const src = readFileSync(join(srcDir, `${mod}.user.js.src`), 'utf8');
  // 源文件 = 元头 + 正文（卡片定义体）。元头结束标记后拆两段。
  const END = '// ==/UserScript==';
  const endIdx = src.indexOf(END);
  if (endIdx === -1) throw new Error(`${mod}.user.js.src 缺少 ==/UserScript== 结束标记`);
  const header = src.slice(0, endIdx + END.length);
  const body = src.slice(endIdx + END.length).trim();
  const out = `${header}\n\n(function () {\n'use strict';\n${core}\n${body}\n})();\n`;
  const outFile = join(srcDir, `gmt-manual-${mod}.user.js`);
  writeFileSync(outFile, out);
  console.log(`built gmt-manual-${mod}.user.js (${out.length} bytes)`);
}
console.log(`done: ${modules.length} modules`);
