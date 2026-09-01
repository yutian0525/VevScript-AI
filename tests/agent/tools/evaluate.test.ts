import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doEvaluate } from '../../../agent/tools/evaluate';

describe('evaluate_script', () => {
  beforeEach(() => fakeBrowser.reset());

  it('返回包裹器求值结果', async () => {
    fakeBrowser.scripting.executeScript = vi.fn().mockResolvedValue([
      { result: { __ok: true, __value: 42 } },
    ]) as never;
    const r = await doEvaluate(1, { function: '() => 42' });
    expect(r.ok).toBe(true);
    expect((r as { data: { result: unknown } }).data.result).toBe(42);
  });

  it('world 参数映射到 MAIN/ISOLATED', async () => {
    const exec = vi.fn().mockResolvedValue([{ result: { __ok: true, __value: 'x' } }]);
    fakeBrowser.scripting.executeScript = exec as never;
    await doEvaluate(1, { function: '() => "x"', world: 'isolated' });
    expect(exec.mock.calls[0]![0].world).toBe('ISOLATED');
    await doEvaluate(1, { function: '() => "x"' });
    expect(exec.mock.calls[1]![0].world).toBe('MAIN');
  });

  it('页面内抛异常 → 失败', async () => {
    fakeBrowser.scripting.executeScript = vi.fn().mockResolvedValue([
      { result: { __ok: false, __error: 'ReferenceError: foo is not defined' } },
    ]) as never;
    const r = await doEvaluate(1, { function: '() => foo' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('ReferenceError');
  });

  it('结果不可序列化 → 失败并提示', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    fakeBrowser.scripting.executeScript = vi.fn().mockResolvedValue([
      { result: { __ok: true, __value: circular } },
    ]) as never;
    const r = await doEvaluate(1, { function: '() => window' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('序列化');
  });

  it('超时返回失败', async () => {
    fakeBrowser.scripting.executeScript = vi.fn().mockImplementation(
      () => new Promise((res) => setTimeout(() => res([{ result: { __ok: true, __value: 1 } }]), 200)),
    ) as never;
    const r = await doEvaluate(1, { function: '() => 1', timeoutMs: 50 });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('超时');
  });

  it('executeScript 本身抛错（如受限页）→ 失败', async () => {
    fakeBrowser.scripting.executeScript = vi.fn().mockRejectedValue(new Error('Cannot access contents')) as never;
    const r = await doEvaluate(1, { function: '() => 1' });
    expect(r.ok).toBe(false);
  });
});
