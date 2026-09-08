// background/gm-tab-store.ts
// GM_getTab/saveTab/getTabs 的 per-tab 临时存储（spec §5.1）。
// 键 gm-tab:{scriptId}:{tabId} 存 chrome.storage.session——tab/浏览器关闭随会话失效，
// 符合 GM_getTab「本 tab 临时数据」语义，不做持久化。用 browser.storage.session 裸键
// （非 WXT storage）因需按前缀枚举（getTabs）。

const PREFIX = 'gm-tab:';
const keyFor = (scriptId: string, tabId: number): string => `${PREFIX}${scriptId}:${tabId}`;

type TabData = Record<string, unknown>;

export async function getTabData(scriptId: string, tabId: number): Promise<TabData> {
  const k = keyFor(scriptId, tabId);
  const got = await browser.storage.session.get(k);
  return (got[k] as TabData) ?? {};
}

export async function saveTabData(scriptId: string, tabId: number, data: TabData): Promise<void> {
  await browser.storage.session.set({ [keyFor(scriptId, tabId)]: data });
}

/** 该脚本全部 tab 的数据：{ [tabId]: data }（对齐 TM GM_getTabs 回调形状）。 */
export async function getAllTabData(scriptId: string): Promise<Record<string, TabData>> {
  const all = await browser.storage.session.get();
  const prefix = `${PREFIX}${scriptId}:`;
  const out: Record<string, TabData> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v as TabData;
  }
  return out;
}

/** 脚本删除时清该脚本全部 tab 数据（gm-api.cleanupScriptState 调用）。 */
export async function cleanupTabData(scriptId: string): Promise<void> {
  const all = await browser.storage.session.get();
  const prefix = `${PREFIX}${scriptId}:`;
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
  if (keys.length > 0) await browser.storage.session.remove(keys);
}
