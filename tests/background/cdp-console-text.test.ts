import { describe, it, expect } from 'vitest';
import {
  serializeRemoteObjects, formatStackTrace, MAX_CONSOLE_TEXT, MAX_CONSOLE_STACK,
} from '../../background/cdp/console-text';

describe('formatStackTrace', () => {
  it('每帧一行「函数名 @ url:行:列」', () => {
    expect(formatStackTrace({
      callFrames: [{ functionName: 'fn', url: 'https://x.com/a.js', lineNumber: 1, columnNumber: 2 }],
    })).toBe('fn @ https://x.com/a.js:1:2');
  });

  it('截到 10 帧（深层递归不炸条目）', () => {
    const callFrames = Array.from({ length: 50 }, (_, i) => ({
      functionName: `f${i}`, url: 'https://x.com/a.js', lineNumber: i, columnNumber: 0,
    }));
    const lines = formatStackTrace({ callFrames })!.split('\n');
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe('f0 @ https://x.com/a.js:0:0');
    expect(lines[9]).toBe('f9 @ https://x.com/a.js:9:0');
  });

  it('无 callFrames / 空数组 → undefined（调用方据此不写 stack 键）', () => {
    expect(formatStackTrace(undefined)).toBeUndefined();
    expect(formatStackTrace({})).toBeUndefined();
    expect(formatStackTrace({ callFrames: [] })).toBeUndefined();
  });

  it('超长堆栈截断到 MAX_CONSOLE_STACK 并加省略号', () => {
    const callFrames = Array.from({ length: 10 }, () => ({
      functionName: 'f', url: `https://x.com/${'p'.repeat(300)}.js`, lineNumber: 1, columnNumber: 1,
    }));
    const out = formatStackTrace({ callFrames })!;
    expect(out).toHaveLength(MAX_CONSOLE_STACK + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('serializeRemoteObjects', () => {
  it('字符串不加引号，多参以空格连接', () => {
    expect(serializeRemoteObjects([
      { type: 'string', value: 'hello' },
      { type: 'number', value: 42 },
      { type: 'boolean', value: true },
    ])).toBe('hello 42 true');
  });

  it('Infinity / NaN / -0 走 unserializableValue：回退 description，不渲染成 undefined', () => {
    // CDP 把这三个放进 unserializableValue，value 缺席，description 才是正确文本
    expect(serializeRemoteObjects([{ type: 'number', description: 'Infinity' }])).toBe('Infinity');
    expect(serializeRemoteObjects([{ type: 'number', description: 'NaN' }])).toBe('NaN');
    expect(serializeRemoteObjects([{ type: 'number', description: '-0' }])).toBe('-0');
    // 常规数字仍走 value（0 / false 不能被 ?? 误判为缺席）
    expect(serializeRemoteObjects([{ type: 'number', value: 0, description: '0' }])).toBe('0');
    expect(serializeRemoteObjects([{ type: 'boolean', value: false }])).toBe('false');
  });

  it('null / undefined / bigint', () => {
    expect(serializeRemoteObjects([
      { type: 'object', subtype: 'null', value: null },
      { type: 'undefined' },
      { type: 'bigint', description: '10n' },
    ])).toBe('null undefined 10n');
  });

  it('对象优先用 description', () => {
    expect(serializeRemoteObjects([{ type: 'object', description: 'Object { a: 1 }' }]))
      .toBe('Object { a: 1 }');
  });

  it('无 description 时用 preview 拼浅层摘要，最多 5 项 + 溢出省略号', () => {
    const preview = {
      type: 'object',
      properties: [
        { name: 'a', type: 'number', value: '1' },
        { name: 'b', type: 'string', value: 'x' },
        { name: 'c', type: 'number', value: '3' },
        { name: 'd', type: 'number', value: '4' },
        { name: 'e', type: 'number', value: '5' },
        { name: 'f', type: 'number', value: '6' },
      ],
      overflow: true,
    };
    expect(serializeRemoteObjects([{ type: 'object', preview }])).toBe('{a: 1, b: x, c: 3, d: 4, e: 5, …}');
  });

  it('既无 description 也无 preview 的对象退回占位', () => {
    expect(serializeRemoteObjects([{ type: 'object' }])).toBe('[object]');
  });

  it('Error 用 description（含堆栈首行）', () => {
    expect(serializeRemoteObjects([
      { type: 'object', subtype: 'error', description: 'Error: boom\n    at <anonymous>:1:1' },
    ])).toBe('Error: boom\n    at <anonymous>:1:1');
  });

  it('函数用 description', () => {
    expect(serializeRemoteObjects([{ type: 'function', description: 'ƒ foo()' }])).toBe('ƒ foo()');
  });

  it('超长文本截断到 MAX_CONSOLE_TEXT 并加省略号', () => {
    const long = 'x'.repeat(MAX_CONSOLE_TEXT + 100);
    const out = serializeRemoteObjects([{ type: 'string', value: long }]);
    expect(out).toHaveLength(MAX_CONSOLE_TEXT + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('空参数返回空串', () => {
    expect(serializeRemoteObjects([])).toBe('');
  });
});
