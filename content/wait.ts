// content/wait.ts
// wait_for 轮询（设计 §5 工具集）。
import type { ToolResult } from '../shared/types';
import type { BgToCsRequestMap } from '../shared/messages';

/**
 * 等页面「安静下来」：click 等交互后 DOM 常有异步反应（菜单展开 / 内容加载 / 局部渲染），
 * 立刻快照会拿到反应前的旧树。用 MutationObserver 观察 body 子树，
 * 连续 quietMs 无变更即视为稳定；封顶 maxMs 防长轮询/持续动画卡死。
 * 无变更时也至少等一个静默窗口（覆盖同步无反应但需一帧的场景）。
 */
export function waitForSettle(quietMs = 150, maxMs = 1200): Promise<void> {
  return new Promise((resolve) => {
    const target = document.body;
    if (!target || typeof MutationObserver === 'undefined') {
      setTimeout(resolve, quietMs);
      return;
    }
    let quietTimer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      obs.disconnect();
      resolve();
    };
    const obs = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, quietMs); // 每次变更重置静默计时
    });
    const hardTimer = setTimeout(done, maxMs);
    obs.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
    quietTimer = setTimeout(done, quietMs);
  });
}

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
