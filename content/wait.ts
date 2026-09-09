// content/wait.ts
// wait_for 工具的 CS 侧适配（spec §6.4）。四种条件互斥；等待逻辑复用 helpers/wait.ts 的
// waitFor（不写第二套轮询）。texts 形式保留向后兼容——它是本工具的原有语义。
import type { ToolResult } from '../shared/types';
import type { BgToCsRequestMap } from '../shared/messages';
import { waitFor } from './helpers/wait';
import { StepError } from './helpers/step-error';

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
    return { ok: false, error: `wait_for 只能传一个条件，收到 ${given.join(' + ')}。分成多次调用，或改用 run_page_script 在脚本里连续 waitFor` };
  }

  const timeout = p.timeoutMs ?? 10_000;

  try {
    // texts：任一命中即成功。逐个 await 会串行等待，故合成一个谓词一次交给 waitFor。
    if (p.texts?.length) {
      const wanted = p.texts;
      let matched = '';
      await waitFor(() => {
        const body = document.body?.innerText ?? document.body?.textContent ?? '';
        const hit = wanted.find((t) => body.includes(t));
        if (hit) { matched = hit; return true; }
        return false;
      }, { timeout });
      return { ok: true, data: { matched } };
    }

    if (p.appear != null) {
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
