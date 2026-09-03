// content/gm-bridge-host.ts
// ISOLATED 侧桥宿主（spec §6）：向 SW 拉 token 表（按当前 URL），监听 gmreq:<id> 页面事件，
// 校验 token 后转发 GM_API_CALL；SW 下行 GM_EVENT 转发为 gmevt:<id> 页面事件。
// wrapper（USER_SCRIPT/MAIN 世界）派发的 CustomEvent 在 ISOLATED 世界可见——共享同一 DOM。

import { gmReqEvent, gmResEvent, gmEvtEvent, type GmBridgeRequest } from '../shared/gm-bridge';

let tokens = new Map<string, string>();
let listenersByScript = new Map<string, (e: Event) => void>();

function attachFor(scriptId: string): void {
  if (listenersByScript.has(scriptId)) return;
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<GmBridgeRequest>).detail;
    if (!detail || typeof detail.api !== 'string') return;
    if (tokens.get(scriptId) !== detail.token) return; // 防伪造（spec §6）
    void browser.runtime.sendMessage({
      type: 'GM_API_CALL', scriptId, api: detail.api, reqId: detail.reqId, params: detail.params,
    }).then((resp) => {
      window.dispatchEvent(new CustomEvent(gmResEvent(scriptId), {
        detail: { reqId: detail.reqId, ...(resp as { ok: boolean; data?: unknown; error?: string }) },
      }));
    }).catch((err) => {
      window.dispatchEvent(new CustomEvent(gmResEvent(scriptId), {
        detail: { reqId: detail.reqId, ok: false, error: String(err) },
      }));
    });
  };
  window.addEventListener(gmReqEvent(scriptId), listener);
  listenersByScript.set(scriptId, listener);
}

async function refreshTokens(): Promise<void> {
  try {
    const resp = await browser.runtime.sendMessage({ type: 'GM_BRIDGE_TOKENS', url: location.href }) as
      { ok: boolean; data?: { entries: Array<{ scriptId: string; token: string }> } } | undefined;
    if (resp?.ok && resp.data) {
      tokens = new Map(resp.data.entries.map((e) => [e.scriptId, e.token]));
      for (const id of tokens.keys()) attachFor(id);
    }
  } catch {
    // SW 未就绪——保持现有表，下次导航自愈
  }
}

export function initBridgeHost(): () => void {
  void refreshTokens();
  return () => {
    for (const [id, fn] of listenersByScript) window.removeEventListener(gmReqEvent(id), fn);
    listenersByScript = new Map();
  };
}

/** SW 的 GM_EVENT 到达 content script 时的转发入口（entrypoints/content.ts onMessage 分支调用）。 */
export function handleGmEvent(msg: { type: 'GM_EVENT'; scriptId: string; kind: string; data: Record<string, unknown> }): void {
  window.dispatchEvent(new CustomEvent(gmEvtEvent(msg.scriptId), { detail: { kind: msg.kind, data: msg.data } }));
}
