// content/wait.ts
// wait_for 轮询（设计 §5 工具集）。
import type { ToolResult } from '../shared/types';
import type { BgToCsRequestMap } from '../shared/messages';

export function waitForText(p: BgToCsRequestMap['WAIT_TEXT']): Promise<ToolResult> {
  const timeout = p.timeoutMs ?? 10_000;
  const start = Date.now();
  const hit = () => {
    const text = document.body?.innerText ?? document.body?.textContent ?? '';
    return p.texts.find((t) => text.includes(t));
  };
  return new Promise((resolve) => {
    const found = hit();
    if (found) { resolve({ ok: true, data: { matched: found } }); return; }
    const timer = setInterval(() => {
      const m = hit();
      if (m) { clearInterval(timer); resolve({ ok: true, data: { matched: m } }); return; }
      if (Date.now() - start >= timeout) {
        clearInterval(timer);
        resolve({ ok: false, error: `wait_for 超时（${timeout}ms）：未出现 ${p.texts.join(' / ')}` });
      }
    }, 200);
  });
}
