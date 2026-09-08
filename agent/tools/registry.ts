// agent/tools/registry.ts
// 工具 schema 注册 + executor 分发（设计 §4）。
import type { ToolResult } from '../../shared/types';
import type { ToolSchema } from '../provider/types';
import { createRequest, type BgToCsRequestMap } from '../../shared/messages';
import { TOOL_SCHEMAS } from './schemas';
import { ASK_MODE_TOOLS, filterSchemasForMemory, memoryToolDenial, type AgentMode, type MemoryCap } from '../mode';
import { doListPages, doNewPage, doClosePage, doSelectPage } from './tabs';
import { doScreenshot } from './screenshot';
import { doEvaluate } from './evaluate';
import { doRunPageScript } from './page-script';
import { doHttpRequest } from './http';
import { doListConsoleMessages, doListNetworkRequests, doGetNetworkRequest } from './observe';
import {
  doListScripts, doGetScript, doCreateScript, doUpdateScript, doDeleteScript, doToggleScript,
} from './script-pool';
import { doGrepScript } from './script-grep';
import { doLoadSkill } from './skills-tool';
import { doMemoryList, doMemoryWrite, doMemoryDelete } from './memory';
import type { ScriptPatch } from '../../shared/messages';

export interface ToolCtx {
  tabId: number;
  sessionId: string;
  signal: AbortSignal;
  /** navigate 后等待 content script 就绪；由 background 注入（默认空实现方便测试）。 */
  waitForReady?: (tabId: number) => Promise<void>;
  /** 行为模式守卫：ask 模式拒执行只读白名单外的工具（默认 'agent' 不设限）。 */
  mode?: AgentMode;
  /** 记忆档位守卫：off 拒全部记忆工具、read 拒写（默认 'full' 不设限）。 */
  memory?: MemoryCap;
}

/** 全量 schema（调试台/默认用）。ask 模式清单见 agent/mode.ts。
 *  memory 缺省 'full'：调试台等既有调用点不受记忆开关影响。 */
export function getToolSchemas(mode: AgentMode = 'agent', memory: MemoryCap = 'full'): ToolSchema[] {
  const byMode = mode === 'agent' ? TOOL_SCHEMAS : TOOL_SCHEMAS.filter((s) => ASK_MODE_TOOLS.has(s.function.name));
  return filterSchemasForMemory(byMode, memory);
}

const RESTRICTED = /^(chrome|edge|about|chrome-extension|moz-extension|devtools):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;

// 工具名 → content script 请求类型（未列出的走 chrome API 分支）
const CS_TOOL_MAP: Record<string, keyof BgToCsRequestMap> = {
  take_snapshot: 'SNAPSHOT',
  query_page: 'QUERY',
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
  // ---- 模式守卫（ask）：白名单外一律拒。工具清单已按模式下发，这里是防幻觉调用的硬闸 ----
  if (ctx.mode === 'ask' && !ASK_MODE_TOOLS.has(name)) {
    return { ok: false, error: `当前为 ask（只读）模式，工具 ${name} 不可用；如需执行该操作请切换到 agent 模式` };
  }
  // ---- 记忆档位守卫：工具清单已按档位下发，这里兜底拦幻觉调用 ----
  const memDenial = memoryToolDenial(name, ctx.memory ?? 'full');
  if (memDenial) return { ok: false, error: memDenial };
  // ---- 豁免受限页预检的工具（不碰当前页内容 / background 独立发起）----
  // navigate_page 走 tabs API，可跨受限页工作（如从 chrome://newtab 导航到普通页）。
  if (name === 'navigate_page') {
    return navigate(ctx, args as { type: string; url?: string });
  }
  // http_request 由 background 独立 fetch，与当前页 URL 无关；透传 ctx.signal 以便 loop abort 中断挂起请求。
  if (name === 'http_request') {
    return doHttpRequest(
      args as { url: string; method?: string; headers?: Record<string, string>; body?: string },
      ctx.signal,
    );
  }
  // tabs 管理类工具不操作页面内容，无需受限页预检。
  if (name === 'list_pages') return doListPages(ctx.tabId);
  if (name === 'new_page') return doNewPage(args as { url: string; background?: boolean }, ctx.waitForReady);
  if (name === 'close_page') return doClosePage(args as { tabId: number });
  if (name === 'select_page') return doSelectPage(args as { tabId: number });

  // 观测类工具读 SW 缓冲、不碰活页面，与 list_pages 同属豁免（受限页返回空比报错更有用）。
  if (name === 'list_console_messages') return doListConsoleMessages(ctx.tabId, args as { level?: string; limit?: number });
  if (name === 'list_network_requests') return doListNetworkRequests(ctx.tabId, args as { method?: string; urlContains?: string; status?: number; limit?: number });
  if (name === 'get_network_request') return doGetNetworkRequest(ctx.tabId, args as { requestId: string });

  // 脚本池六工具：纯 storage/注册操作，不碰页面内容，豁免受限页预检（spec §8）。
  if (name === 'list_scripts') return doListScripts(args as { enabled?: boolean; urlContains?: string });
  if (name === 'get_script') return doGetScript(args as { id: string; offset?: number; limit?: number });
  if (name === 'grep_script') {
    return doGrepScript(args as { pattern: string; id?: string; ignoreCase?: boolean; contextLines?: number; limit?: number });
  }
  if (name === 'create_script') return doCreateScript(args as { source?: string; text?: string; url?: string; enabled?: boolean });
  if (name === 'update_script') return doUpdateScript(args as { id: string; patch: ScriptPatch });
  if (name === 'delete_script') return doDeleteScript(args as { id: string });
  if (name === 'toggle_script') return doToggleScript(args as { id: string; enabled: boolean });

  // load_skill：纯 storage 读取，不碰页面，豁免受限页预检（spec §2.4）。
  if (name === 'load_skill') return doLoadSkill((args as { command: string }).command);

  // 记忆三工具：纯 storage 读写，不碰页面，豁免受限页预检（spec §3.4）。
  if (name === 'memory_list') return doMemoryList(args as { scope?: string; limit?: number });
  if (name === 'memory_write') {
    return doMemoryWrite(args as { content?: string; matches?: string[]; id?: string });
  }
  if (name === 'memory_delete') return doMemoryDelete(args as { id: string });

  // ---- 以下工具操作当前目标页，需受限页预检 ----
  const tab = await browser.tabs.get(ctx.tabId).catch(() => undefined);
  const url = tab?.url ?? '';
  if (RESTRICTED.test(url)) {
    return { ok: false, error: `无法操作受限页面（${url}）` };
  }

  // chrome API 类工具（操作当前页但不经 content script）。
  if (name === 'take_screenshot') {
    return doScreenshot(ctx.tabId, args as { format?: 'jpeg' | 'png'; quality?: number });
  }
  if (name === 'evaluate_script') {
    return doEvaluate(
      ctx.tabId,
      args as { function: string; args?: unknown[]; world?: 'main' | 'isolated'; timeoutMs?: number },
    );
  }
  // run_page_script 与 evaluate_script 同级：SW 直接 scripting.executeScript 注入运行时，
  // 不经 CS 消息通道，但同样操作当前页 → 保留在上面的受限页预检之后。
  if (name === 'run_page_script') {
    return doRunPageScript(
      ctx.tabId,
      args as { script: string; world?: 'isolated' | 'main'; timeoutMs?: number; screenshot?: 'never' | 'on-failure' | 'always' },
    );
  }

  const csType = CS_TOOL_MAP[name];
  if (!csType) return { ok: false, error: `未知工具：${name}` };

  // 透传 args（形状由 schema 保证）；模型不传参时 args 即 {}，SNAPSHOT 的 detail/region 可正常透传
  const payload = args as BgToCsRequestMap[typeof csType];
  const req = createRequest(csType, payload);
  try {
    // 定向主帧 frameId:0，避免 allFrames 广播抢答
    const resp = await browser.tabs.sendMessage(ctx.tabId, req, { frameId: 0 }) as { result?: ToolResult } | undefined;
    if (!resp?.result) return { ok: false, error: 'content script 无响应（页面可能未加载完成）' };
    return resp.result;
  } catch (err) {
    // "Receiving end does not exist"：页面在扩展重载前就已打开，未被自动注入 content script。
    // 动态注入 content.js 兜底后重试一次（设计 §4.4 静态注册 + 动态注入兜底）。
    const injected = await injectContentScript(ctx.tabId);
    if (!injected) {
      return { ok: false, error: `发送到页面失败：${err instanceof Error ? err.message : String(err)}（该页可能不允许注入）` };
    }
    try {
      const retry = await browser.tabs.sendMessage(ctx.tabId, req, { frameId: 0 }) as { result?: ToolResult } | undefined;
      if (!retry?.result) return { ok: false, error: 'content script 无响应（注入后仍无应答）' };
      return retry.result;
    } catch (err2) {
      return { ok: false, error: `发送到页面失败（注入后重试仍失败）：${err2 instanceof Error ? err2.message : String(err2)}` };
    }
  }
}

/** 向目标标签页主帧动态注入 content script（老页面未自动注入时的兜底）。成功返回 true。 */
async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['/content-scripts/content.js'],
    });
    return true;
  } catch (e) {
    console.warn('[registry] 动态注入 content script 失败', e);
    return false;
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
