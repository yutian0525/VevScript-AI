// agent/tools/script-grep.ts
// grep_script 执行器（spec §4.5）：在脚本原文里按正则/字面量检索，返回行号 + 内容。
// 与 script-pool.ts 分文件：那边是 CRUD，这边是检索。
// 纯 storage 读取，豁免受限页预检（registry 在 RESTRICTED 检查之前分发）。

import type { ToolResult, UserScript } from '../../shared/types';
import { getScript, listScripts } from '../../storage/scripts';
import { annotateLines } from './script-pool';

export const DEFAULT_GREP_LIMIT = 50;

interface GrepArgs {
  pattern: string;
  id?: string;
  ignoreCase?: boolean;
  contextLines?: number;
  limit?: number;
}

interface GrepMatch { scriptId: string; name: string; line: number; text: string }

/** 正则优先；非法正则降级为字面量子串搜索（返回 warning 说明，不让模型的一个手滑变成硬失败）。 */
function buildMatcher(pattern: string, ignoreCase: boolean): { test: (l: string) => boolean; warning?: string } {
  const flags = ignoreCase ? 'i' : '';
  try {
    const re = new RegExp(pattern, flags);
    return { test: (l) => re.test(l) };
  } catch {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return {
      test: (l) => (ignoreCase ? l.toLowerCase() : l).includes(needle),
      warning: `pattern 不是合法正则，已降级为字面量子串搜索：${pattern}`,
    };
  }
}

export async function doGrepScript(args: GrepArgs): Promise<ToolResult> {
  try {
    if (typeof args.pattern !== 'string' || args.pattern === '') {
      return { ok: false, error: 'grep_script 需要非空 pattern' };
    }
    const limit = Math.max(1, Math.trunc(args.limit ?? DEFAULT_GREP_LIMIT));
    const ctx = Math.max(0, Math.trunc(args.contextLines ?? 0));

    let targets: UserScript[];
    if (args.id) {
      const one = await getScript(args.id);
      if (!one) return { ok: false, error: `脚本不存在：${args.id}` };
      targets = [one];
    } else {
      targets = await listScripts();
    }

    const { test, warning } = buildMatcher(args.pattern, args.ignoreCase ?? false);
    const matches: GrepMatch[] = [];
    let truncated = false;

    for (const s of targets) {
      const lines = s.text.split('\n');
      // 先收命中行号，再按 contextLines 膨胀成集合去重——避免相邻命中重复输出同一行
      const wanted = new Set<number>();
      for (let i = 0; i < lines.length; i += 1) {
        if (!test(lines[i]!)) continue;
        for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k += 1) {
          wanted.add(k);
        }
      }
      for (const idx of [...wanted].sort((a, b) => a - b)) {
        if (matches.length >= limit) { truncated = true; break; }
        matches.push({
          scriptId: s.id,
          name: s.name,
          line: idx + 1,
          text: annotateLines(lines[idx]!, idx + 1),
        });
      }
      if (truncated) break;
    }

    return { ok: true, data: { matches, truncated, ...(warning ? { warning } : {}) } };
  } catch (e) {
    return { ok: false, error: `grep_script 失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
