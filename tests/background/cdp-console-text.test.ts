import { describe, it, expect } from 'vitest';
import { serializeRemoteObjects, MAX_CONSOLE_TEXT } from '../../background/cdp/console-text';

describe('serializeRemoteObjects', () => {
  it('字符串不加引号，多参以空格连接', () => {
    expect(serializeRemoteObjects([
      { type: 'string', value: 'hello' },
      { type: 'number', value: 42 },
      { type: 'boolean', value: true },
    ])).toBe('hello 42 true');
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
