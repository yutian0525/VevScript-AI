// shared/userscript-meta.ts
// Tampermonkey ==UserScript== 元数据解析/序列化（纯函数，spec §5）。
// 兼容策略（修订 2026-09-02 文本为源）：解析头 + 代码体原样执行；GM_* 不实现（grants 仅作警告徽标）；
// @include 的 pattern 形式并入 matches 按 @match 语义生效，正则/其它 glob 形式警告并忽略。

import type { ScriptRunAt, ScriptWorld, UserScript, UserScriptMeta } from './types';
import { isValidMatchPattern } from './match-pattern';

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

/** glob 语义的匹配键：与 match pattern 有损，警告并忽略（@include 已单独支持 pattern 形式） */
const UNSUPPORTED_MATCH_KEYS = new Set(['exclude', 'ant-match']);

export interface ParsedUserScript {
  fields: { name: string; matches: string[]; runAt: ScriptRunAt; world: ScriptWorld; code: string; meta: UserScriptMeta };
  warnings: string[];
}

export function parseUserScript(source: string, fallbackName?: string): ParsedUserScript {
  const lines = source.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === '// ==UserScript==');
  const endIdx = lines.findIndex((l) => l.trim() === '// ==/UserScript==');
  const defaultName = fallbackName?.replace(/\.user\.js$|\.js$/i, '').trim() || '未命名脚本';
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return {
      fields: { name: defaultName, matches: [], runAt: 'document_idle', world: 'USER_SCRIPT', code: source, meta: {} },
      warnings: ['未找到 ==UserScript== 元数据头，将使用默认设置'],
    };
  }

  const matches: string[] = [];
  const grants: string[] = [];
  const regexIncludes: string[] = [];
  const badIncludes: string[] = [];
  const badMatches: string[] = [];
  const meta: UserScriptMeta = {};
  const ignoredKeys = new Set<string>();
  let name = '';
  let runAt: ScriptRunAt = 'document_idle';
  let world: ScriptWorld = 'USER_SCRIPT';
  let badRunAt = '';
  let badWorld = '';
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
      case 'match': {
        // 修订 2026-09-02：@match 容错——合法并入（去重），非法警告并跳过（TM 更宽松，Chrome match pattern 更严；不因一条坏规则整条拒绝导入）
        if (value && isValidMatchPattern(value)) {
          if (!matches.includes(value)) matches.push(value);
        } else if (value) badMatches.push(value);
        break;
      }
      case 'include': {
        // 修订 2026-09-02：pattern 形式并入 matches（去重）；正则 /…/ 与非法 glob 警告忽略
        if (/^\/.+\/$/.test(value)) regexIncludes.push(value);
        else if (value && isValidMatchPattern(value)) {
          if (!matches.includes(value)) matches.push(value);
        } else badIncludes.push(value);
        break;
      }
      case 'world': {
        if (value === 'USER_SCRIPT' || value === 'MAIN') world = value;
        else badWorld = value;
        break;
      }
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
  if (regexIncludes.length > 0) warnings.push(`@include 正则形式不支持（${regexIncludes.join('、')}），已忽略`);
  if (badIncludes.length > 0) warnings.push(`@include 值不符合 match pattern 语法（${badIncludes.join('、')}），已忽略`);
  if (badMatches.length > 0) warnings.push(`@match 值不符合 match pattern 语法（${badMatches.join('、')}），已忽略`);
  if (badWorld) warnings.push(`@world 值「${badWorld}」不支持，已用 USER_SCRIPT`);
  const realGrants = grants.filter((g) => g !== 'none');
  if (realGrants.length > 0) {
    meta.grants = grants;
    warnings.push(`@grant 非 none：本扩展不支持 GM_* API（${realGrants.join(', ')}），脚本调用会报错`);
  }
  if (unsupportedMatch) warnings.push('不支持的匹配键 @exclude/@ant-match 已忽略，请改用 @match');
  if (ignoredKeys.size > 0) {
    warnings.push(`已忽略 ${ignoredKeys.size} 个不支持的元数据键：${[...ignoredKeys].map((k) => `@${k}`).join(' ')}`);
  }
  if (matches.length === 0) warnings.push('未找到 @match/@include 匹配规则：脚本不会在任何页面运行，请在头部补规则');

  return {
    fields: { name: name || defaultName, matches, runAt, world, code: lines.slice(endIdx + 1).join('\n'), meta },
    warnings,
  };
}

/** 反向生成带元数据头的 .user.js 文本（修订后仅用于旧记录 text 迁移与兜底，导出直接用原文）。 */
export function stringifyUserScript(script: UserScript): string {
  const meta = script.meta ?? {};
  const lines = ['// ==UserScript==', `// @name        ${script.name}`];
  if (meta.namespace) lines.push(`// @namespace   ${meta.namespace}`);
  if (meta.version) lines.push(`// @version     ${meta.version}`);
  if (meta.author) lines.push(`// @author      ${meta.author}`);
  if (meta.description) lines.push(`// @description ${meta.description}`);
  for (const m of script.matches) lines.push(`// @match       ${m}`);
  lines.push(`// @run-at      ${RUN_AT_OUT[script.runAt]}`);
  if (script.world === 'MAIN') lines.push('// @world       MAIN');
  if (meta.grants) for (const g of meta.grants) lines.push(`// @grant       ${g}`);
  if (meta.noframes) lines.push('// @noframes');
  lines.push('// ==/UserScript==', '');
  return [...lines, script.code].join('\n');
}
