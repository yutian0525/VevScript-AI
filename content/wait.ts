// content/wait.ts
// wait_for 工具的 CS 侧适配（spec §6.4）。四种条件互斥；等待逻辑复用 helpers/wait.ts 的
// waitFor（不写第二套轮询）。texts 形式保留向后兼容——它是本工具的原有语义。
import type { ToolResult } from '../shared/types';
import type { BgToCsRequestMap } from '../shared/messages';
import { waitFor } from './helpers/wait';
import { StepError } from './helpers/step-error';
import { resolveUid } from './snapshot/build';

export async function waitForText(p: BgToCsRequestMap['WAIT_TEXT']): Promise<ToolResult> {
  const given = [
    p.texts?.length ? 'texts' : null,
    p.appear != null ? 'appear' : null,
    p.gone != null ? 'gone' : null,
    p.idle != null ? 'idle' : null,
  ].filter(Boolean) as string[];

  // 0 个条件 = 无条件死等到超时，直接拒绝比让 agent 干等 10s 有用。
  if (given.length === 0) {
    return { ok: false, error: 'wait_for 至少需要一个条件：texts / appear / gone / idle' };
  }
  // 多个条件同传不静默取优先：静默取舍会让 agent 以为两个条件都被等待了。
  if (given.length > 1) {
    return { ok: false, error: `wait_for 只能传一个条件，收到 ${given.join(' + ')}。分成多次调用` };
  }

  const timeout = p.timeoutMs ?? 10_000;

  try {
    // texts：任一命中即成功。逐个 await 会串行等待，故合成一个谓词一次交给 waitFor。
    // 谓词形式的超时报错会说「自定义谓词未满足」，agent 没写过谓词会被误导去查谓词
    // 逻辑——texts 分支自己 catch timeout 换成讲文本的专属文案（审查意见 2）。
    if (p.texts?.length) {
      const wanted = p.texts;
      let matched = '';
      try {
        await waitFor(() => {
          const body = document.body?.innerText ?? document.body?.textContent ?? '';
          const hit = wanted.find((t) => body.includes(t));
          if (hit) { matched = hit; return true; }
          return false;
        }, { timeout });
      } catch (e) {
        if (e instanceof StepError && e.kind === 'timeout') {
          return { ok: false, error: `wait_for 超时（${timeout}ms）：文本「${wanted.join(' / ')}」均未出现。` };
        }
        throw e;
      }
      return { ok: true, data: { matched } };
    }

    // appear 传 uid 的前置检查：uid 是某次快照的分配，页面一变就与真实元素错位；
    // 失效 uid 等 locator 轮询只可能死等到超时（reviewed 意见 3）——立即报「已失效」。
    if (p.appear != null) {
      if (typeof p.appear === 'number' && !resolveUid(p.appear)) {
        return { ok: false, error: `wait_for 失败：uid ${p.appear} 已失效，请重新 take_snapshot 或 query_page 获取当前 uid` };
      }
      const r = await waitFor(p.appear, { timeout });
      return { ok: true, data: { waited: r.waited } };
    }
    if (p.gone != null) {
      const r = await waitFor({ gone: p.gone }, { timeout });
      return { ok: true, data: { waited: r.waited } };
    }
    const r = await waitFor({ idle: p.idle! }, { timeout });
    return { ok: true, data: { waited: r.waited } };
  } catch (e) {
    // StepError 的 detail.hint 是可执行的修复建议，拼进 error 一起回给 agent
    //（SW 侧只透传 ToolResult，不认识 StepError——hint 必须在这里就地并入）。
    if (e instanceof StepError) {
      const hint = e.detail.hint;
      return { ok: false, error: hint ? `${e.message}\n${hint}` : e.message };
    }
    return { ok: false, error: `wait_for 失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
