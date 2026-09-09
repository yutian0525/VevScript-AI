// background/gm-urlchange.ts
// window.onurlchange 支持（spec §5.4）：SW 监听 webNavigation 的 SPA 导航事件（pushState/
// replaceState = onHistoryStateUpdated；hash = onReferenceFragmentUpdated），仅主帧，
// 找出 @grant window.onurlchange 且 match 命中的启用脚本，经 dispatch 下行 URL_CHANGE。

import { listScripts } from '../storage/scripts';
import { matchUrl } from '../shared/match-pattern';

/** 该 URL 下应收到 urlchange 的脚本 id：启用 + match 命中 + @grant window.onurlchange。 */
export async function scriptsForUrlChange(url: string): Promise<string[]> {
  if (!url) return [];
  const all = await listScripts();
  return all
    .filter((s) => s.enabled && matchUrl(s.matches, url) && (s.meta?.grants ?? []).includes('window.onurlchange'))
    .map((s) => s.id);
}

export type UrlChangeDispatch = (tabId: number, scriptId: string, url: string) => void;

interface NavDetails { tabId: number; frameId: number; url: string }
interface NavEvent { addListener(cb: (d: NavDetails) => void): void }
interface WebNav { onHistoryStateUpdated?: NavEvent; onReferenceFragmentUpdated?: NavEvent }

/** 注册 webNavigation 监听（幂等由调用方保证：initGmApi 只调一次）。无 webNavigation 时静默。 */
export function initUrlChange(dispatch: UrlChangeDispatch): void {
  const wn = (browser as unknown as { webNavigation?: WebNav }).webNavigation;
  if (!wn) return;
  const handler = async (d: NavDetails): Promise<void> => {
    if (d.frameId !== 0) return; // 仅主帧
    const ids = await scriptsForUrlChange(d.url);
    for (const id of ids) dispatch(d.tabId, id, d.url);
  };
  wn.onHistoryStateUpdated?.addListener((d) => void handler(d));
  wn.onReferenceFragmentUpdated?.addListener((d) => void handler(d));
}
