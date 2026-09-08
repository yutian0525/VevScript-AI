// content/query.ts
// query_page 的 CS 侧实现（spec §6.3）：按意图定向查询，替代「全量倒树再挑 uid」。
// 输出与快照同格式（带 uid），故命中行可直接交给 click/fill，也能原样搬进脚本的 $()。
// 行渲染复用 snapshot/build 的 renderElementLine（同一份 renderLine，不写第二套格式）。
import type { ToolResult } from '../shared/types';
import type { Locator } from '../shared/types';
import { queryLocator } from './locator';
import { diagnoseMiss } from './locator-diagnose';
import { ensureUid, resolveUid, renderElementLine } from './snapshot/build';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

// uid 与「最近一次快照/query_page」绑定（isConnected 防护挡不住错位指向）。
// 恒带是刻意取舍：只占 ~30 tokens，第一次就出现在 agent 眼前比省这点重要。
// 提成常量是因为「命中 0」与「命中 N」两个成功分支都要带，两处内联迟早漂移。
const UID_NOTICE = 'uid 与最近一次快照/查询绑定；页面结构变化后旧 uid 可能失效或错位，操作前若页面已变请重新查询。';

export interface QueryArgs {
  locator: Locator;
  limit?: number;
  /** 限定容器的 uid（来自快照或前一次 query_page）。 */
  within?: number;
}

export function doQuery(args: QueryArgs): ToolResult {
  if (args?.locator == null) return { ok: false, error: 'query_page 缺少 locator 参数' };

  let scope: Element | undefined;
  if (args.within != null) {
    const el = resolveUid(args.within);
    if (!el) {
      return { ok: false, error: `query_page 的 within uid ${args.within} 已失效，请重新获取 uid` };
    }
    scope = el;
  }

  let res: ReturnType<typeof queryLocator>;
  try {
    res = queryLocator(args.locator, { within: scope });
  } catch (e) {
    return { ok: false, error: `query_page 定位失败：${e instanceof Error ? e.message : String(e)}` };
  }

  if (res.elements.length === 0) {
    // 命中 0 个也要给诊断——探查阶段就把定位符调对，不带错进脚本。
    // uidNotice 恒带（uid 诊断分支也提醒了 uid 时效性，但那是「失效」口径，
    // 与本条「错位」口径互补；恒带让两个分支的返回形状一致，消费方少一层判断）。
    const diag = diagnoseMiss(args.locator, scope ?? document.body);
    return {
      ok: true,
      data: {
        matched: 0, returned: 0, lines: [], skippedFrames: res.skippedFrames,
        relaxed: diag.relaxed, nearMiss: diag.nearMiss, hint: diag.hint,
        uidNotice: UID_NOTICE,
      },
    };
  }

  const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const picked = res.elements.slice(0, limit);
  const lines = picked.map((el) => renderElementLine(el, ensureUid(el)));

  const data: Record<string, unknown> = {
    matched: res.elements.length,
    returned: picked.length,
    lines,
    skippedFrames: res.skippedFrames,
    uidNotice: UID_NOTICE,
  };
  if (res.elements.length > picked.length) {
    data.notice = `共命中 ${res.elements.length} 个，只返回前 ${picked.length} 个。加 nth 指定第几个，或用 within 收窄范围，或调大 limit（上限 ${MAX_LIMIT}）。`;
  }
  if (res.nearTier) data.nearTier = res.nearTier;
  if (res.skippedFrames > 0) {
    data.frameNotice = `${res.skippedFrames} 个跨域 iframe 无法访问，其中的元素不在结果内。`;
  }
  return { ok: true, data };
}
