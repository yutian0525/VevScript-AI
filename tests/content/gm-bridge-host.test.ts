// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { initBridgeHost, handleGmEvent } from '../../content/gm-bridge-host';
import { gmReqEvent, gmResEvent, gmEvtEvent, gmHelloEvent, gmHostEvent } from '../../shared/gm-bridge';

describe('gm-bridge-host', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('initBridgeHost：拉 token 表 + 挂 gmreq 监听 + 转发 GM_API_CALL 到 runtime，回 gmres', async () => {
    // fake-browser 契约：sendResponse + return true
    browser.runtime.onMessage.addListener((msg: { type: string }, _sender, sendResponse) => {
      if (msg.type === 'GM_BRIDGE_TOKENS') {
        sendResponse({ ok: true, data: { entries: [{ scriptId: 's1', token: 'tok' }] } });
        return true;
      }
      if (msg.type === 'GM_API_CALL') {
        expect(msg).toMatchObject({ scriptId: 's1', api: 'SetValue', params: ['k', 1] });
        sendResponse({ ok: true, data: null });
        return true;
      }
      sendResponse({ ok: false, error: 'unexpected' });
      return true;
    });

    const dispose = initBridgeHost();
    await new Promise((r) => setTimeout(r, 10)); // 等 token 拉取

    const resListener = vi.fn();
    window.addEventListener(gmResEvent('s1'), resListener);
    window.dispatchEvent(new CustomEvent(gmReqEvent('s1'), {
      detail: { token: 'tok', reqId: 7, api: 'SetValue', params: ['k', 1] },
    }));
    await new Promise((r) => setTimeout(r, 10));
    expect(resListener).toHaveBeenCalledTimes(1);
    expect((resListener.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ reqId: 7, ok: true });
    dispose();
  });

  it('错误 token 的请求被丢弃（不转发、不响应）', async () => {
    browser.runtime.onMessage.addListener((msg: { type: string }, _sender, sendResponse) => {
      if (msg.type === 'GM_BRIDGE_TOKENS') { sendResponse({ ok: true, data: { entries: [{ scriptId: 's1', token: 'tok' }] } }); return true; }
      sendResponse({ ok: true }); return true;
    });
    const dispose = initBridgeHost();
    await new Promise((r) => setTimeout(r, 10));

    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage');
    const resListener = vi.fn();
    window.addEventListener(gmResEvent('s1'), resListener);
    window.dispatchEvent(new CustomEvent(gmReqEvent('s1'), {
      detail: { token: 'WRONG', reqId: 8, api: 'SetValue', params: [] },
    }));
    await new Promise((r) => setTimeout(r, 10));
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'GM_API_CALL' }));
    expect(resListener).not.toHaveBeenCalled();
    dispose();
  });

  it('握手反向时序：宿主先就绪，wrapper 后到的 gmhello 触发宿主重发 gmhost', async () => {
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'GM_BRIDGE_TOKENS') { sendResponse({ ok: true, data: { entries: [{ scriptId: 's1', token: 'tok' }] } }); return true; }
      sendResponse({ ok: true }); return true;
    });
    const dispose = initBridgeHost();
    await new Promise((r) => setTimeout(r, 10)); // attachFor 已跑（发了首个 gmhost，此刻无 wrapper 接）

    // 模拟晚注入的 wrapper：挂 gmhost 监听后 dispatch gmhello
    const hostReadySpy = vi.fn();
    window.addEventListener(gmHostEvent('s1'), hostReadySpy);
    window.dispatchEvent(new CustomEvent(gmHelloEvent('s1')));
    expect(hostReadySpy).toHaveBeenCalledTimes(1); // 宿主收到 gmhello 同步重发 gmhost
    window.removeEventListener(gmHostEvent('s1'), hostReadySpy);
    dispose();
  });

  it('握手正向时序端到端：wrapper 先注入（gmreq 入 backlog）→ 宿主就绪冲刷 → gmreq 到达 SW', async () => {
    const apiCalls: Array<Record<string, unknown>> = [];
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'GM_BRIDGE_TOKENS') { sendResponse({ ok: true, data: { entries: [{ scriptId: 's-race', token: 'rtok' }] } }); return true; }
      if (msg.type === 'GM_API_CALL') { apiCalls.push(msg as Record<string, unknown>); sendResponse({ ok: true, data: null }); return true; }
      sendResponse({ ok: false, error: 'x' }); return true;
    });

    // 迷你 wrapper 客户端（模拟 preamble 握手：宿主未就绪时 gmreq 入 backlog，收 gmhost 冲刷）
    let hostReady = false;
    let backlog: Array<Record<string, unknown>> = [];
    const send = (detail: Record<string, unknown>): void => { window.dispatchEvent(new CustomEvent(gmReqEvent('s-race'), { detail })); };
    const onHost = (): void => {
      hostReady = true;
      const pend = backlog; backlog = [];
      for (const d of pend) send(d);
    };
    window.addEventListener(gmHostEvent('s-race'), onHost);
    window.dispatchEvent(new CustomEvent(gmHelloEvent('s-race'))); // wrapper 问询（宿主未 init，无人接）
    // 用户代码同步调 API：宿主未就绪 → 入 backlog（这正是真实脚本 @run-at document-end 的现场）
    const detail = { token: 'rtok', reqId: 1, api: 'XmlHttpRequest', params: [{ url: 'https://x.test/a' }] };
    if (hostReady) send(detail); else backlog.push(detail);
    expect(apiCalls).toHaveLength(0); // 尚未到达 SW（宿主未就绪）

    // 宿主就绪（document_idle + 拉 token）：attachFor 发 gmhost → 迷你 wrapper 冲刷 → gmreq 被接住
    const dispose = initBridgeHost();
    await new Promise((r) => setTimeout(r, 10));
    expect(hostReady).toBe(true);
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]).toMatchObject({ type: 'GM_API_CALL', scriptId: 's-race', api: 'XmlHttpRequest' });

    window.removeEventListener(gmHostEvent('s-race'), onHost);
    dispose();
  });

  it('handleGmEvent：转发为 gmevt 页面事件', () => {
    const evtListener = vi.fn();
    window.addEventListener(gmEvtEvent('s1'), evtListener);
    handleGmEvent({ type: 'GM_EVENT', scriptId: 's1', kind: 'MENU_CLICK', data: { key: 'm1' } });
    expect(evtListener).toHaveBeenCalledTimes(1);
    expect((evtListener.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ kind: 'MENU_CLICK', data: { key: 'm1' } });
  });

  it('debugCall：拉 token + 真实链路调 GM_API_CALL，回 data', async () => {
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'GM_BRIDGE_TOKENS') { sendResponse({ ok: true, data: { entries: [{ scriptId: 's1', token: 'tok' }] } }); return true; }
      if (msg.type === 'GM_API_CALL') { sendResponse({ ok: true, data: { got: (msg as unknown as { params: unknown[] }).params } }); return true; }
      sendResponse({ ok: false, error: 'x' }); return true;
    });
    const { debugCall } = await import('../../content/gm-bridge-host');
    const r = await debugCall('s1', 'GetValue', ['k'], 500);
    expect(r).toMatchObject({ ok: true, data: { got: ['k'] } });
  });

  it('debugCall：token 拉不到时报错（脚本未注入此页）', async () => {
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'GM_BRIDGE_TOKENS') { sendResponse({ ok: true, data: { entries: [] } }); return true; }
      sendResponse({ ok: true }); return true;
    });
    const { debugCall } = await import('../../content/gm-bridge-host');
    const r = await debugCall('sX', 'GetValue', ['k'], 500);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/未注入|token/);
  });

  it('debugCall：无 gmres 时超时', async () => {
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'GM_BRIDGE_TOKENS') { sendResponse({ ok: true, data: { entries: [{ scriptId: 's1', token: 'tok' }] } }); return true; }
      // GM_API_CALL 永不响应（模拟宿主转发后 SW 卡住）
      return true;
    });
    const { debugCall } = await import('../../content/gm-bridge-host');
    const r = await debugCall('s1', 'SetValue', ['k', 1], 30);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超时/);
  });
});
