// entrypoints/content.ts
// WXT content script：处理 background 的工具请求（设计 §6）。
// 静态注册 <all_urls> + allFrames + document_idle → 导航后浏览器自动重注入。
import type { BgToCsRequest, CsResponse, CsReadyNotification } from '../shared/messages';
import type { ToolResult } from '../shared/types';
import { buildSnapshot } from '../content/snapshot/build';
import { doClick, doFill, doFillForm, doHover, doScroll, doPressKey } from '../content/interact';
import { waitForText } from '../content/wait';

/** 纯处理逻辑（可单测）：一条 BgToCsRequest → CsResponse。 */
export async function handleCsRequest(req: BgToCsRequest): Promise<CsResponse> {
  const result = await route(req);
  return { correlationId: req.correlationId, type: req.type, result };
}

async function route(req: BgToCsRequest): Promise<ToolResult> {
  switch (req.type) {
    case 'SNAPSHOT': {
      if (!document.body) return { ok: false, error: '当前帧无 document.body（可能是非 HTML 文档），无法快照' };
      return { ok: true, data: buildSnapshot(document.body) };
    }
    case 'CLICK': return doClick(req.payload);
    case 'FILL': return doFill(req.payload);
    case 'FILL_FORM': return doFillForm(req.payload);
    case 'HOVER': return doHover(req.payload);
    case 'SCROLL': return doScroll(req.payload);
    case 'PRESS_KEY': return doPressKey(req.payload);
    case 'WAIT_TEXT': return waitForText(req.payload);
    case 'PAGE_META':
      return { ok: true, data: { url: location.href, title: document.title, readyState: document.readyState } };
    case 'EVALUATE': return { ok: false, error: 'evaluate_script 未在 Phase 2 实现' };
    case 'CONSOLE_READ': return { ok: false, error: 'console 读取未在 Phase 2 实现' };
    default: {
      const _exhaustive: never = req;
      return { ok: false, error: `未知请求：${String((_exhaustive as { type?: string }).type)}` };
    }
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: true,
  main() {
    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      const req = msg as BgToCsRequest;
      if (!req || typeof req.type !== 'string' || !('correlationId' in req)) return false;
      handleCsRequest(req)
        .then(sendResponse)
        .catch((err: unknown) => {
          sendResponse({
            correlationId: req.correlationId,
            type: req.type,
            result: { ok: false, error: err instanceof Error ? err.message : String(err) },
          });
        });
      return true; // 异步响应
    });
    // 加载完成通知（navigate 后 background 等待此信号）
    const ready: CsReadyNotification = { type: 'CS_READY', payload: { url: location.href } };
    browser.runtime.sendMessage(ready).catch(() => {});
  },
});
