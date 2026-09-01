// observe/serialize.ts
// console 参数安全序列化（设计 §8.1）：任意参数数组 → 一行安全文本。
// 纯函数，无副作用；hook 在页面 MAIN world 调用，故不得引用扩展/模块外符号。

const MAX_LEN = 2000;

function cap(s: string): string {
  return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN)}…` : s;
}

function one(v: unknown): string {
  try {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const t = typeof v;
    if (t === 'string') return v as string;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
    if (t === 'function') return `[Function${(v as { name?: string }).name ? `: ${(v as { name: string }).name}` : ''}]`;
    if (t === 'symbol') return String(v as symbol);
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    // DOM 节点：取标签名概要（typeof Node 守卫，jsdom/页面都可能无 Node）
    if (typeof Node !== 'undefined' && v instanceof Node) {
      const el = v as { nodeName?: string; id?: string };
      return `<${(el.nodeName ?? 'node').toLowerCase()}${el.id ? `#${el.id}` : ''}>`;
    }
    return JSON.stringify(v);
  } catch {
    return '[无法序列化的对象]';
  }
}

/** 把 console.* 的参数数组序列化为一行文本（各参数以空格连接，整体截断）。 */
export function serializeConsoleArgs(args: unknown[]): string {
  return cap(args.map(one).join(' '));
}
