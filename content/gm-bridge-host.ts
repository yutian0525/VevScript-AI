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

// ---- 面板直调（脚本运行时调试台，spec §3）----
// debug 命名空间 reqId：从 10 亿起，与 wrapper 的自增 reqId 不撞。
let debugReqId = 1_000_000_000;

/** token 表缺该 id、或监听器未挂时先拉一次（防 debug gmreq 早于 host 监听器挂载的竞态）。 */
async function ensureAttached(scriptId: string): Promise<boolean> {
  if (!tokens.has(scriptId) || !listenersByScript.has(scriptId)) await refreshTokens();
  if (!tokens.has(scriptId)) return false;
  attachFor(scriptId); // 幂等：已挂载则跳过
  return true;
}

/**
 * 经真实桥链路直调 GM API（面板调试用，不经 wrapper 函数体）：
 * dispatch gmreq → 宿主已有监听器做 token 校验 + 转发 GM_API_CALL → 监听 gmres 按 reqId 配对。
 * 覆盖 token 防伪 / grant 白名单 / handleGmCall / @connect 确认流 / gmres 回环。
 */
export async function debugCall(
  scriptId: string, api: string, params: unknown[], timeoutMs = 10_000,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const ready = await ensureAttached(scriptId);
  const token = tokens.get(scriptId);
  if (!ready || !token) {
    return { ok: false, error: '脚本未注入此页（查不到 token）——请切到该脚本 @match 命中的标签页后重试' };
  }
  const reqId = debugReqId++;
  return new Promise((resolve) => {
    let done = false;
    const onRes = (e: Event) => {
      const detail = (e as CustomEvent<{ reqId: number; ok: boolean; data?: unknown; error?: string }>).detail;
      if (!detail || detail.reqId !== reqId) return; // 配对：只认自己那次
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener(gmResEvent(scriptId), onRes);
      resolve({ ok: detail.ok, data: detail.data, error: detail.error });
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener(gmResEvent(scriptId), onRes);
      resolve({ ok: false, error: `直调超时（${timeoutMs}ms 无 gmres 回环）` });
    }, timeoutMs);
    window.addEventListener(gmResEvent(scriptId), onRes);
    window.dispatchEvent(new CustomEvent(gmReqEvent(scriptId), { detail: { token, reqId, api, params } }));
  });
}

/** SW 的 GM_EVENT 到达 content script 时的转发入口（entrypoints/content.ts onMessage 分支调用）。 */
export function handleGmEvent(msg: { type: 'GM_EVENT'; scriptId: string; kind: string; data: Record<string, unknown> }): void {
  window.dispatchEvent(new CustomEvent(gmEvtEvent(msg.scriptId), { detail: { kind: msg.kind, data: msg.data } }));
}
