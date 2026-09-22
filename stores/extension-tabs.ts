// stores/extension-tabs.ts
// 扩展自有页面在新标签页打开：已开则导航 + 聚焦，未开则新建。
// 复用模式来自 background/confirm-queue.ts 的 hub 标签页（开过就 tabs.update 聚焦）。

import type { PublicPath } from 'wxt/browser';

/** 打开扩展自有页面（path 形如 '/conv-debug.html'）。
 * 已存在同路径标签页时用 tabs.update 导航到目标 URL 并聚焦——既避免开一堆重复调试页，
 * 也让「已开但停在别的会话」能切过去。 */
export async function openExtensionTab(path: string, opts: { convId?: string | null } = {}): Promise<void> {
  // WXT 把 getURL 入参收窄成已知路径字面量（.wxt/types/paths.d.ts）；本函数按运行时字符串
  // 收任意扩展页路径，收窄一次过闸，运行时行为不变。
  const typedPath = path as PublicPath;
  const query = opts.convId ? `?convId=${encodeURIComponent(opts.convId)}` : '';
  const url = browser.runtime.getURL(typedPath) + query;
  const [existing] = await browser.tabs.query({ url: browser.runtime.getURL(typedPath) + '*' });
  if (existing?.id != null) {
    await browser.tabs.update(existing.id, { url, active: true });
    return;
  }
  await browser.tabs.create({ url, active: true });
}
