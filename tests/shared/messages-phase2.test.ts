import { describe, it, expect } from 'vitest';
import { createRequest, type CsReadyNotification, type PortMsgFromPanel, type PortMsgToPanel } from '../../shared/messages';

describe('Phase 2 协议扩展', () => {
  it('FILL_FORM 请求可构造', () => {
    const req = createRequest('FILL_FORM', { elements: [{ uid: 1, value: 'a' }] });
    expect(req.type).toBe('FILL_FORM');
    expect(req.payload.elements[0]!.value).toBe('a');
  });

  it('CLICK 请求可构造（uid + 可选 dblClick）', () => {
    const req = createRequest('CLICK', { uid: 2, dblClick: true });
    expect(req.type).toBe('CLICK');
    expect(req.payload.uid).toBe(2);
    expect(req.payload.dblClick).toBe(true);
  });

  it('CS_READY 通知类型可赋值', () => {
    const n: CsReadyNotification = { type: 'CS_READY', payload: { url: 'https://x.com' } };
    expect(n.type).toBe('CS_READY');
  });

  it('Port 消息类型可赋值（双向）', () => {
    const fromPanel: PortMsgFromPanel = { type: 'agent:start', convId: 'c1', tabId: 1, userMessage: 'hi' };
    const toPanel: PortMsgToPanel = { type: 'text-delta', text: 'x' };
    expect(fromPanel.type).toBe('agent:start');
    expect(toPanel.type).toBe('text-delta');
  });

  it('WAIT_TEXT 请求仍可构造（Phase 1 已有，回归）', () => {
    const req = createRequest('WAIT_TEXT', { texts: ['done'], timeoutMs: 5000 });
    expect(req.type).toBe('WAIT_TEXT');
  });
});
