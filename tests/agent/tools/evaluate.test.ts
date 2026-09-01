import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doEvaluate, pageRunner } from '../../../agent/tools/evaluate';

// pageRunner 的错误归一化：页面里 reject/throw 的常常不是 Error（DOM error Event、
// DOMException 等），旧实现 String(e) 得 "[object Event]" 丢光线索。这些用例锁死改进。
describe('pageRunner 错误归一化', () => {
  const errOf = async (code: string): Promise<string> => {
    const r = await pageRunner(code, []);
    if (r.__ok) throw new Error('expected __ok=false');
    return r.__error;
  };

  it('Error → name: message', async () => {
    expect(await errOf('() => { throw new TypeError("boom") }')).toBe('TypeError: boom');
  });

  it('DOM error Event（图片加载失败那类）→ 提取事件类型与目标资源，不再是 [object Event]', async () => {
    const code = `() => {
      const ev = new Event('error');
      Object.defineProperty(ev, 'target', { value: { tagName: 'IMG', src: 'https://x.com/a.png' } });
      throw ev;
    }`;
    const msg = await errOf(code);
    expect(msg).not.toContain('[object Event]');
    expect(msg).toContain('error 事件');
    expect(msg).toContain('img');
    expect(msg).toContain('https://x.com/a.png');
  });

  it('event-like 普通对象（无 Event 实例但有 type+target）也被识别', async () => {
    const code = `() => { throw { type: 'error', target: { tagName: 'SCRIPT', src: 'https://cdn/x.js' } }; }`;
    const msg = await errOf(code);
    expect(msg).toContain('error 事件');
    expect(msg).toContain('script');
    expect(msg).toContain('https://cdn/x.js');
  });

  it('DOMException → DOMException(name): message', async () => {
    const code = `() => { throw new DOMException('tainted canvas', 'SecurityError'); }`;
    const msg = await errOf(code);
    expect(msg).toContain('DOMException(SecurityError)');
    expect(msg).toContain('tainted canvas');
  });

  it('普通对象有 message 字段 → 取 message', async () => {
    expect(await errOf('() => { throw { message: "自定义失败" } }')).toBe('自定义失败');
  });

  it('普通对象无 message → JSON 序列化', async () => {
    expect(await errOf('() => { throw { code: 42 } }')).toBe('{"code":42}');
  });

  it('reject 一个 error Event（Promise 路径）同样被归一化', async () => {
    const code = `() => Promise.reject(Object.assign(new Event('error'), {}))`;
    const msg = await errOf(code);
    expect(msg).toContain('error 事件');
  });

  it('超长错误串截断到 500 字符', async () => {
    const code = '() => { throw new Error("x".repeat(2000)) }';
    const msg = await errOf(code);
    expect(msg.length).toBeLessThanOrEqual(520); // 500 + "TypeError: " 前缀余量 + 省略号
    expect(msg.endsWith('…')).toBe(true);
  });

  it('正常返回值仍走 __ok=true', async () => {
    const r = await pageRunner('() => 1 + 1', []);
    expect(r).toEqual({ __ok: true, __value: 2 });
  });
});

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
