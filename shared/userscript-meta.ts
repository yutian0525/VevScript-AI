// shared/userscript-meta.ts
// Tampermonkey ==UserScript== 元数据解析/序列化（纯函数，spec §5）。
// 兼容策略：解析头 + 代码体原样执行；GM_* 不实现（grants 仅作警告徽标）；@include 等 glob 匹配键警告并忽略。

import type { ScriptRunAt, UserScript, UserScriptMeta } from './types';

const RUN_AT_IN: Record<string, ScriptRunAt> = {
  'document-start': 'document_start',
  'document-end': 'document_end',
  'document-idle': 'document_idle',
};

const RUN_AT_OUT: Record<ScriptRunAt, string> = {
  document_start: 'document-start',
  document_end: 'document-end',
  document_idle: 'document-idle',
};

/** glob 语义的匹配键：与 @match 有损，宁缺毋滥（spec §2 非目标） */
const UNSUPPORTED_MATCH_KEYS = new Set(['include', 'exclude', 'ant-match']);

export interface ParsedUserScript {
  fields: { name: string; matches: string[]; runAt: ScriptRunAt; code: string; meta: UserScriptMeta };
  warnings: string[];
}

export function parseUserScript(source: string, fallbackName?: string): ParsedUserScript {
  const lines = source.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === '// ==UserScript==');
  const endIdx = lines.findIndex((l) => l.trim() === '// ==/UserScript==');
  const defaultName = fallbackName?.replace(/\.user\.js$|\.js$/i, '').trim() || '未命名脚本';
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return {
      fields: { name: defaultName, matches: [], runAt: 'document_idle', code: source, meta: {} },
      warnings: ['未找到 ==UserScript== 元数据头，将使用默认设置'],
    };
  }

  const matches: string[] = [];
  const grants: string[] = [];
  const meta: UserScriptMeta = {};
  const ignoredKeys = new Set<string>();
  let name = '';
  let runAt: ScriptRunAt = 'document_idle';
  let badRunAt = '';
  let unsupportedMatch = false;

  for (const line of lines.slice(startIdx + 1, endIdx)) {
    const m = /^\s*\/\/\s*@(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    // noUncheckedIndexedAccess 下捕获组类型为 string | undefined；正则命中时组 1/2 必存在，?? 仅为编译兜底，运行时行为不变
    const key = m[1] ?? '';
    const value = (m[2] ?? '').trim();
    switch (key) {
      case 'name': name = value; break;
      case 'namespace': meta.namespace = value; break;
      case 'version': meta.version = value; break;
      case 'author': meta.author = value; break;
      case 'description': meta.description = value; break;
      case 'match': matches.push(value); break;
      case 'run-at': {
        const mapped = RUN_AT_IN[value];
        if (mapped) runAt = mapped;
        else badRunAt = value;
        break;
      }
      case 'grant': grants.push(value); break;
      case 'noframes': meta.noframes = true; break;
      default:
        if (UNSUPPORTED_MATCH_KEYS.has(key)) unsupportedMatch = true;
        else ignoredKeys.add(key);
    }
  }

  // 警告按固定顺序组装（测试依赖此顺序的稳定性）
  const warnings: string[] = [];
  if (badRunAt) warnings.push(`@run-at 值「${badRunAt}」不支持，已用 document-idle`);
  const realGrants = grants.filter((g) => g !== 'none');
  if (realGrants.length > 0) {
    meta.grants = grants;
    warnings.push(`@grant 非 none：本扩展不支持 GM_* API（${realGrants.join(', ')}），脚本调用会报错`);
  }
  if (unsupportedMatch) warnings.push('不支持的匹配键 @include/@exclude 已忽略，请改用 @match');
  if (ignoredKeys.size > 0) {
    warnings.push(`已忽略 ${ignoredKeys.size} 个不支持的元数据键：${[...ignoredKeys].map((k) => `@${k}`).join(' ')}`);
  }
  if (matches.length === 0) warnings.push('未找到 @match：脚本不会在任何页面运行，请在详情页补匹配规则');

  return {
    fields: { name: name || defaultName, matches, runAt, code: lines.slice(endIdx + 1).join('\n'), meta },
    warnings,
  };
}

/** 反向生成带元数据头的 .user.js 文本（导出下载用）。 */
export function stringifyUserScript(script: UserScript): string {
  const meta = script.meta ?? {};
  const lines = ['// ==UserScript==', `// @name        ${script.name}`];
  if (meta.namespace) lines.push(`// @namespace   ${meta.namespace}`);
  if (meta.version) lines.push(`// @version     ${meta.version}`);
  if (meta.author) lines.push(`// @author      ${meta.author}`);
  if (meta.description) lines.push(`// @description ${meta.description}`);
  for (const m of script.matches) lines.push(`// @match       ${m}`);
  lines.push(`// @run-at      ${RUN_AT_OUT[script.runAt]}`);
  if (meta.grants) for (const g of meta.grants) lines.push(`// @grant       ${g}`);
  if (meta.noframes) lines.push('// @noframes');
  lines.push('// ==/UserScript==', '');
  return [...lines, script.code].join('\n');
}
