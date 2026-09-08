// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { doQuery } from '../../content/query';
import { resetUidMap, resolveUid, ensureUid } from '../../content/snapshot/build';

const ok = (r: ReturnType<typeof doQuery>) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.data as {
    lines: string[]; matched: number; returned: number;
    skippedFrames: number; notice?: string; uidNotice?: string; frameNotice?: string;
    nearTier?: string; relaxed?: Record<string, number>; nearMiss?: unknown[]; hint?: string;
  };
};

const err = (r: ReturnType<typeof doQuery>): string => {
  if (r.ok) throw new Error('expected error, got ok result');
  return r.error;
};

describe('query_page', () => {
  beforeEach(() => { resetUidMap(); document.body.innerHTML = ''; });

  it('命中元素渲染为带 uid 的快照格式行', () => {
    document.body.innerHTML = '<button class="s">提交</button>';
    const d = ok(doQuery({ locator: { role: 'button', text: '提交' } }));
    expect(d.matched).toBe(1);
    expect(d.lines.length).toBe(1);
    expect(d.lines[0]).toMatch(/^\[\d+\] button "提交"$/);
  });

  it('行内的 uid 可反查回元素（能直接交给 click）', () => {
    document.body.innerHTML = '<button>确定</button>';
    const d = ok(doQuery({ locator: { text: '确定' } }));
    const uid = Number(/^\[(\d+)\]/.exec(d.lines[0]!)![1]);
    expect(resolveUid(uid)).toBe(document.querySelector('button'));
  });

  it('link 行带短 url（与快照同格式）', () => {
    document.body.innerHTML = '<a href="/a/b">链</a>';
    const d = ok(doQuery({ locator: { role: 'link' } }));
    expect(d.lines[0]).toContain('url="/a/b"');
  });

  it('输入框行带 placeholder 与状态', () => {
    document.body.innerHTML = '<input type="text" placeholder="搜索关键词" disabled>';
    const d = ok(doQuery({ locator: { role: 'textbox' } }));
    expect(d.lines[0]).toContain('"搜索关键词"');
    expect(d.lines[0]).toContain('disabled');
  });

  it('limit 默认 5、超限给 notice', () => {
    document.body.innerHTML = Array.from({ length: 9 }, (_, i) => `<button>b${i}</button>`).join('');
    const d = ok(doQuery({ locator: { role: 'button' } }));
    expect(d.matched).toBe(9);
    expect(d.returned).toBe(5);
    expect(d.notice).toContain('9');
  });

  it('limit 可指定，上限 20', () => {
    document.body.innerHTML = Array.from({ length: 30 }, (_, i) => `<button>b${i}</button>`).join('');
    expect(ok(doQuery({ locator: { role: 'button' }, limit: 25 })).returned).toBe(20);
  });

  it('命中 0 个时返回 relaxed + nearMiss + hint（不报错）', () => {
    document.body.innerHTML = '<a class="next-page">下一页 ›</a>';
    const d = ok(doQuery({ locator: { role: 'button', text: '下一页' } }));
    expect(d.matched).toBe(0);
    expect(d.relaxed!['text 包含匹配（忽略 role）']).toBe(1);
    expect(d.nearMiss!.length).toBe(1);
    expect(d.hint).toContain('下一页 ›');
  });

  it('locator 非法（空对象）返回 ok:false', () => {
    const r = doQuery({ locator: {} });
    expect(r.ok).toBe(false);
    expect(err(r)).toContain('至少需要一个条件');
  });

  it('缺 locator 参数返回 ok:false', () => {
    const r = doQuery({} as never);
    expect(r.ok).toBe(false);
    expect(err(r)).toContain('缺少 locator');
  });

  it('非法选择器返回 ok:false 并带原因', () => {
    const r = doQuery({ locator: '<<bad>>' });
    expect(r.ok).toBe(false);
    expect(err(r)).toContain('选择器非法');
  });

  it('within 用 uid 指定容器', () => {
    document.body.innerHTML = '<div id="a"><h2>A</h2></div><div id="b"><h2>B</h2></div>';
    const uid = ensureUid(document.getElementById('b')!);
    const d = ok(doQuery({ locator: 'h2', within: uid }));
    expect(d.returned).toBe(1);
    expect(d.lines[0]).toContain('"B"');
  });

  it('within 的 uid 失效时返回 ok:false', () => {
    const r = doQuery({ locator: 'h2', within: 999 });
    expect(r.ok).toBe(false);
    expect(err(r)).toContain('within');
  });

  it('跨域 iframe 计数透出 + frameNotice', () => {
    document.body.innerHTML = '<iframe id="f"></iframe><button>主</button>';
    Object.defineProperty(document.getElementById('f')!, 'contentDocument', {
      get() { throw new DOMException('blocked', 'SecurityError'); },
    });
    const d = ok(doQuery({ locator: { role: 'button' } }));
    expect(d.skippedFrames).toBe(1);
    expect(d.frameNotice).toContain('跨域');
  });

  it('命中 0 + 跨域帧时 frameNotice 也在（两分支形状对齐）', () => {
    document.body.innerHTML = '<iframe id="f"></iframe>';
    Object.defineProperty(document.getElementById('f')!, 'contentDocument', {
      get() { throw new DOMException('blocked', 'SecurityError'); },
    });
    // 查一个哪都没有的元素 → 命中 0 分支；skippedFrames 透出且 frameNotice 不缺位
    const d = ok(doQuery({ locator: { role: 'button', text: '不存在的按钮' } }));
    expect(d.matched).toBe(0);
    expect(d.skippedFrames).toBe(1);
    expect(d.frameNotice).toContain('跨域');
  });

  it('uidNotice 恒带（生命周期提示）', () => {
    document.body.innerHTML = '<button>x</button>';
    const d = ok(doQuery({ locator: { role: 'button' } }));
    expect(d.uidNotice).toContain('失效');
  });

  it('nearTier 透传', () => {
    document.body.innerHTML = '<label for="p">密码</label><input id="p" type="text">';
    const d = ok(doQuery({ locator: { role: 'textbox', near: '密码' } }));
    expect(d.nearTier).toBe('label');
  });
});
