import { describe, it, expect } from 'vitest';
import type { HookConsoleNotification, HookNetworkNotification } from '../../shared/messages';

describe('Phase 3b 通知协议', () => {
  it('HOOK_CONSOLE 承载 console 条目', () => {
    const m: HookConsoleNotification = { type: 'HOOK_CONSOLE', payload: { entries: [{ id: '0:1', level: 'log', text: 'a', ts: 1 }] } };
    expect(m.type).toBe('HOOK_CONSOLE');
    expect(m.payload.entries[0]!.level).toBe('log');
  });

  it('HOOK_NETWORK 承载 hook 网络条目', () => {
    const m: HookNetworkNotification = { type: 'HOOK_NETWORK', payload: { entries: [{ loadNonce: 'n1', seq: 1, method: 'GET', url: 'https://x.com', ts: 1 }] } };
    expect(m.type).toBe('HOOK_NETWORK');
    expect(m.payload.entries[0]!.method).toBe('GET');
  });
});
