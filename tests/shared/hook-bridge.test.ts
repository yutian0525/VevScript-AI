import { describe, it, expect } from 'vitest';
import { HOOK_MSG, RELAY_READY, type HookWindowMsg, type ConsoleEntry, type HookNetEntry } from '../../shared/hook-bridge';

describe('hook-bridge 协议', () => {
  it('导出稳定的 window 消息 tag 常量', () => {
    expect(typeof HOOK_MSG).toBe('string');
    expect(typeof RELAY_READY).toBe('string');
    expect(HOOK_MSG).not.toBe(RELAY_READY);
  });

  it('HookWindowMsg 可承载 console / network 两类', () => {
    const c: HookWindowMsg = { source: HOOK_MSG, kind: 'console', entry: { id: '1', level: 'log', text: 'hi', ts: 1 } };
    const n: HookWindowMsg = { source: HOOK_MSG, kind: 'network', entry: { loadNonce: 'ab', seq: 1, method: 'GET', url: 'https://x.com', ts: 1 } };
    expect(c.kind).toBe('console');
    expect(n.kind).toBe('network');
  });

  it('ConsoleEntry / HookNetEntry 字段可赋值', () => {
    const e: ConsoleEntry = { id: 'a', level: 'error', text: 'boom', ts: 2, url: 'https://x.com' };
    const h: HookNetEntry = { loadNonce: 'ab', seq: 2, method: 'POST', url: 'https://x.com/api', ts: 3, endTs: 4, status: 200, requestHeaders: { 'content-type': 'application/json' }, responseHeaders: {}, requestBody: '{}', responseBody: '{"ok":1}', truncated: false };
    expect(e.level).toBe('error');
    expect(h.status).toBe(200);
  });
});
