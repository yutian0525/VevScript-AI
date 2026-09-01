// tests/background/debug-exec.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// executeTool 与 waitForCsReady 用 mock 隔离——只验证 debug-exec 的编排（透传参数 + 计时 + 兜错）
const executeTool = vi.fn();
vi.mock('../../agent/tools/registry', () => ({ executeTool: (...a: unknown[]) => executeTool(...a) }));
vi.mock('../../background/agent-port', () => ({ waitForCsReady: vi.fn(async () => {}) }));

import { handleDebugExec } from '../../background/debug-exec';

describe('handleDebugExec', () => {
  beforeEach(() => executeTool.mockReset());

  it('透传 tabId/name/args 并回带工具结果 + ms', async () => {
    executeTool.mockResolvedValue({ ok: true, data: 'snapshot-tree' });
    const resp = await handleDebugExec({ type: 'DEBUG_EXEC_TOOL', tabId: 7, name: 'take_snapshot', args: { verbose: true } });

    expect(resp.dispatched).toBe(true);
    expect(resp.result).toEqual({ ok: true, data: 'snapshot-tree' });
    expect(typeof resp.ms).toBe('number');
    const [name, args, ctx] = executeTool.mock.calls[0]!;
    expect(name).toBe('take_snapshot');
    expect(args).toEqual({ verbose: true });
    expect(ctx).toMatchObject({ tabId: 7, sessionId: 'debug' });
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it('args 缺省时降级为空对象', async () => {
    executeTool.mockResolvedValue({ ok: true });
    await handleDebugExec({ type: 'DEBUG_EXEC_TOOL', tabId: 1, name: 'x' } as never);
    expect(executeTool.mock.calls[0]![1]).toEqual({});
  });

  it('工具返回失败原样透传（dispatched 仍为 true）', async () => {
    executeTool.mockResolvedValue({ ok: false, error: '无法操作受限页面' });
    const resp = await handleDebugExec({ type: 'DEBUG_EXEC_TOOL', tabId: 2, name: 'click', args: { uid: 3 } });
    expect(resp.dispatched).toBe(true);
    expect(resp.result).toEqual({ ok: false, error: '无法操作受限页面' });
  });

  it('executeTool 抛出时兜住为 dispatched=false + error，仍回带 ms', async () => {
    // 一次性 reject——persistent 的 throw/reject 会在 vitest v4 留下被误判为 unhandled 的残留
    executeTool.mockRejectedValueOnce(new Error('boom'));
    const resp = await handleDebugExec({ type: 'DEBUG_EXEC_TOOL', tabId: 5, name: 'click', args: { uid: 1 } });
    expect(resp.dispatched).toBe(false);
    expect(resp.error).toBe('boom');
    expect(typeof resp.ms).toBe('number');
  });
});
