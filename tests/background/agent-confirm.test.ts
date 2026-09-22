// tests/background/agent-confirm.test.ts
// 后台确认槽：登记/决策/超时/中断 + attach 回放（spec §7）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  registerToolConfirm, resolveToolConfirm, discardToolConfirm,
  __resetToolConfirms, buildAttachEvents,
} from '../../background/agent-port';
import { emptyTail } from '../../background/agent-tail';

const ENTRY = { callId: 'call-1', name: 'evaluate_script', args: '{"function":"1+1"}' };

beforeEach(() => {
  fakeBrowser.reset();
  __resetToolConfirms();
});
afterEach(() => vi.useRealTimers());

describe('registerToolConfirm', () => {
  it('决策回传 resolve 并清槽', async () => {
    const ac = new AbortController();
    const p = registerToolConfirm('cv1', ENTRY, ac.signal);
    resolveToolConfirm('cv1', 'call-1', 'allow-session');
    await expect(p).resolves.toBe('allow-session');
  });

  it('callId 不匹配不 resolve（防陈旧确认串轮）', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = registerToolConfirm('cv2', ENTRY, ac.signal);
    resolveToolConfirm('cv2', 'other-call', 'allow');
    vi.advanceTimersByTime(120_000);
    await expect(p).resolves.toBe('timeout'); // 只能等超时兜底
  });

  it('120s 超时 resolve timeout', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = registerToolConfirm('cv3', ENTRY, ac.signal);
    vi.advanceTimersByTime(120_000);
    await expect(p).resolves.toBe('timeout');
  });

  it('abort resolve deny（停止键/loop 退出路径）', async () => {
    const ac = new AbortController();
    const p = registerToolConfirm('cv4', ENTRY, ac.signal);
    ac.abort();
    await expect(p).resolves.toBe('deny');
  });

  it('discardToolConfirm 兜底清理（loop finally）', async () => {
    const ac = new AbortController();
    const p = registerToolConfirm('cv5', ENTRY, ac.signal);
    discardToolConfirm('cv5');
    await expect(p).resolves.toBe('deny');
    discardToolConfirm('cv5'); // 幂等
  });
});

describe('buildAttachEvents 回放待确认状态', () => {
  it('running 且有 pending：事件序列末尾追加 tool-confirm', async () => {
    const ac = new AbortController();
    const p = registerToolConfirm('cv6', ENTRY, ac.signal);
    const events = await buildAttachEvents('cv6', true, emptyTail());
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: 'tool-confirm', callId: 'call-1', name: 'evaluate_script' });
    expect((last as { until?: number }).until).toBeGreaterThan(0);
    resolveToolConfirm('cv6', 'call-1', 'deny');
    await p;
  });

  it('无 pending：事件里没有 tool-confirm', async () => {
    const events = await buildAttachEvents('cv7', true, emptyTail());
    expect(events.some((e) => e.type === 'tool-confirm')).toBe(false);
  });
});
