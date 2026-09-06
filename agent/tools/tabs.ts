// agent/tools/tabs.ts
// 标签页管理工具（设计 §2、§6）。执行器只做 chrome.tabs 调用 + 组织 ToolResult；
// targetTab 的变更由 agent loop 读取 data.targetTab 后维护（设计 §4）。
import type { ToolResult } from '../../shared/types';

export async function doListPages(targetTab: number): Promise<ToolResult> {
  try {
    const tabs = await browser.tabs.query({});
    const pages = tabs
      .filter((t) => t.id != null)
      .map((t) => ({
        tabId: t.id!,
        url: t.url ?? '',
        title: t.title ?? '',
        active: t.active ?? false,
        isTarget: t.id === targetTab,
      }));
    return { ok: true, data: { pages } };
  } catch (err) {
    return { ok: false, error: `list_pages 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function doNewPage(
  args: { url: string; background?: boolean },
  waitForReady?: (tabId: number) => Promise<void>,
): Promise<ToolResult> {
  if (!args.url) return { ok: false, error: 'new_page 缺少 url 参数' };
  try {
    const tab = await browser.tabs.create({ url: args.url, active: !args.background });
    if (tab.id == null) return { ok: false, error: 'new_page 创建后未返回 tabId' };
    await waitForReady?.(tab.id);
    return { ok: true, data: { targetTab: tab.id, url: tab.url ?? args.url } };
  } catch (err) {
    return { ok: false, error: `new_page 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function doClosePage(args: { tabId: number }): Promise<ToolResult> {
  if (args.tabId == null) return { ok: false, error: 'close_page 缺少 tabId 参数' };
  try {
    await browser.tabs.remove(args.tabId);
    return { ok: true, data: { closed: args.tabId } };
  } catch (err) {
    return { ok: false, error: `close_page 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function doSelectPage(args: { tabId: number }): Promise<ToolResult> {
  if (args.tabId == null) return { ok: false, error: 'select_page 缺少 tabId 参数' };
  try {
    const tab = await browser.tabs.update(args.tabId, { active: true });
    return { ok: true, data: { targetTab: args.tabId, url: tab?.url ?? '' } };
  } catch (err) {
    return { ok: false, error: `select_page 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
