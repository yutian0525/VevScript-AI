import { describe, it, expect } from 'vitest';
import { serializeConsoleArgs } from '../../observe/serialize';

describe('serializeConsoleArgs', () => {
  it('标量拼接', () => {
    expect(serializeConsoleArgs(['hello', 42, true])).toBe('hello 42 true');
  });

  it('null / undefined', () => {
    expect(serializeConsoleArgs([null, undefined])).toBe('null undefined');
  });

  it('纯对象 JSON 化', () => {
    expect(serializeConsoleArgs([{ a: 1 }])).toContain('"a":1');
  });

  it('循环引用不抛，降级标注', () => {
    const o: Record<string, unknown> = {}; o.self = o;
    const out = serializeConsoleArgs([o]);
    expect(typeof out).toBe('string');
    expect(out).toContain('[无法序列化');
  });

  it('函数标注为 [Function]', () => {
    expect(serializeConsoleArgs([function foo() {}])).toContain('[Function');
  });

  it('Error 取 name+message', () => {
    expect(serializeConsoleArgs([new TypeError('bad')])).toContain('TypeError: bad');
  });

  it('超长字符串截断加省略号', () => {
    const out = serializeConsoleArgs(['x'.repeat(5000)]);
    expect(out.length).toBeLessThanOrEqual(2100);
    expect(out.endsWith('…')).toBe(true);
  });

  it('取值抛异常的恶意对象不外抛，降级标注', () => {
    // getPrototypeOf 陷阱使 instanceof Error 抛出（原本未被 try/catch 覆盖）
    const evil = new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } });
    expect(() => serializeConsoleArgs([evil])).not.toThrow();
    expect(serializeConsoleArgs([evil])).toContain('[无法序列化');
  });

  it('get 陷阱抛出的 Proxy 不外抛，降级标注', () => {
    const evil = new Proxy({}, { get() { throw new Error('trap'); }, has() { throw new Error('trap'); } });
    expect(() => serializeConsoleArgs([evil])).not.toThrow();
    expect(serializeConsoleArgs([evil])).toContain('[无法序列化');
  });
});
