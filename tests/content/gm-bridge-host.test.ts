// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { initBridgeHost, handleGmEvent } from '../../content/gm-bridge-host';
import { gmReqEvent, gmResEvent, gmEvtEvent } from '../../shared/gm-bridge';

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

  it('handleGmEvent：转发为 gmevt 页面事件', () => {
    const evtListener = vi.fn();
    window.addEventListener(gmEvtEvent('s1'), evtListener);
    handleGmEvent({ type: 'GM_EVENT', scriptId: 's1', kind: 'MENU_CLICK', data: { key: 'm1' } });
    expect(evtListener).toHaveBeenCalledTimes(1);
    expect((evtListener.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ kind: 'MENU_CLICK', data: { key: 'm1' } });
  });
});
