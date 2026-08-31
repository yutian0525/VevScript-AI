// agent/tools/registry.ts
// 工具 schema 注册 + executor 分发（设计 §4）。
import type { ToolResult } from '../../shared/types';
import type { ToolSchema } from '../provider/types';
import { createRequest, type BgToCsRequestMap } from '../../shared/messages';
import { TOOL_SCHEMAS } from './schemas';

export interface ToolCtx {
  tabId: number;
  sessionId: string;
  signal: AbortSignal;
  /** navigate 后等待 content script 就绪；由 background 注入（默认空实现方便测试）。 */
  waitForReady?: (tabId: number) => Promise<void>;
}

export function getToolSchemas(): ToolSchema[] {
  return TOOL_SCHEMAS;
}

const RESTRICTED = /^(chrome|edge|about|chrome-extension|moz-extension|devtools):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;

// 工具名 → content script 请求类型（未列出的走 chrome API 分支）
const CS_TOOL_MAP: Record<string, keyof BgToCsRequestMap> = {
  take_snapshot: 'SNAPSHOT',
  click: 'CLICK',
  fill: 'FILL',
  fill_form: 'FILL_FORM',
  hover: 'HOVER',
  scroll: 'SCROLL',
  press_key: 'PRESS_KEY',
  wait_for: 'WAIT_TEXT',
};

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolResult> {
  // navigate_page 走 tabs API，可跨受限页工作（如从 chrome://newtab 导航到普通页），
  // 故豁免当前页受限预检。
  if (name === 'navigate_page') {
    return navigate(ctx, args as { type: string; url?: string });
  }

  const tab = await browser.tabs.get(ctx.tabId).catch(() => undefined);
  const url = tab?.url ?? '';
  if (RESTRICTED.test(url)) {
    return { ok: false, error: `无法操作受限页面（${url}）` };
  }

  const csType = CS_TOOL_MAP[name];
  if (!csType) return { ok: false, error: `未知工具：${name}` };

  // 透传 args（形状由 schema 保证）；模型不传参时 args 即 {}，SNAPSHOT 的 verbose 可正常透传
  const payload = args as BgToCsRequestMap[typeof csType];
  const req = createRequest(csType, payload);
  try {
    // 定向主帧 frameId:0，避免 allFrames 广播抢答
    const resp = await browser.tabs.sendMessage(ctx.tabId, req, { frameId: 0 }) as { result?: ToolResult } | undefined;
    if (!resp?.result) return { ok: false, error: 'content script 无响应（页面可能未加载完成）' };
    return resp.result;
  } catch (err) {
    return { ok: false, error: `发送到页面失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

async function navigate(ctx: ToolCtx, args: { type: string; url?: string }): Promise<ToolResult> {
  try {
    switch (args.type) {
      case 'url':
        if (!args.url) return { ok: false, error: 'navigate url 缺少 url 参数' };
        await browser.tabs.update(ctx.tabId, { url: args.url });
        break;
      case 'reload': await browser.tabs.reload(ctx.tabId); break;
      case 'back': await browser.tabs.goBack(ctx.tabId); break;
      case 'forward': await browser.tabs.goForward(ctx.tabId); break;
      default: return { ok: false, error: `未知导航类型：${args.type}` };
    }
    await ctx.waitForReady?.(ctx.tabId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `导航失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
