// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { buildSnapshot, resolveUid, resetUidMap } from '../../../content/snapshot/build';

// 反查某元素被分配的 uid（遍历 1..N）
function resolveUidByElement(el: Element): number {
  for (let i = 1; i < 10000; i++) { if (resolveUid(i) === el) return i; }
  throw new Error('uid not found');
}

describe('快照组装', () => {
  beforeEach(() => { resetUidMap(); document.body.innerHTML = ''; });

  it('可交互元素带 [uid]，纯文本节点无 uid', () => {
    document.body.innerHTML = '<button>登录</button><p>说明文字</p>';
    const { text } = buildSnapshot(document.body);
    expect(text).toMatch(/\[\d+\] button "登录"/);
    expect(text).not.toMatch(/\[\d+\] paragraph/);
  });

  it('uid 可解析回元素', () => {
    document.body.innerHTML = '<button id="b">x</button>';
    buildSnapshot(document.body);
    const btn = document.getElementById('b')!;
    const uid = resolveUidByElement(btn);
    expect(resolveUid(uid)).toBe(btn);
  });

  it('隐藏元素不出现在快照', () => {
    document.body.innerHTML = '<button style="display:none">隐藏</button><button>可见</button>';
    const { text } = buildSnapshot(document.body);
    expect(text).not.toContain('隐藏');
    expect(text).toContain('可见');
  });

  it('每 take_snapshot 重置 uid 映射', () => {
    document.body.innerHTML = '<button>a</button>';
    buildSnapshot(document.body);
    resetUidMap();
    document.body.innerHTML = '<button>b</button>';
    buildSnapshot(document.body);
    const el = resolveUid(1);
    expect(el?.textContent).not.toBe('a');
  });

  it('resolveUid 对脱离 DOM 的元素返回 null（stale）', () => {
    document.body.innerHTML = '<button>x</button>';
    buildSnapshot(document.body);
    const uid = resolveUidByElement(document.querySelector('button')!);
    document.body.innerHTML = ''; // 元素脱离
    expect(resolveUid(uid)).toBeNull();
  });

  it('嵌套结构缩进', () => {
    document.body.innerHTML = '<nav><a href="/x">链接</a></nav>';
    const { text } = buildSnapshot(document.body);
    const linkLine = text.split('\n').find((l) => l.includes('链接'))!;
    expect(linkLine.startsWith(' ')).toBe(true);
  });

  it('open shadow DOM 内的元素被收集', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button>影子按钮</button>';
    const { text } = buildSnapshot(document.body);
    expect(text).toContain('影子按钮');
  });

  it('超过节点上限时折叠', () => {
    const many = Array.from({ length: 50 }, (_, i) => `<button>b${i}</button>`).join('');
    document.body.innerHTML = `<div>${many}</div>`;
    const { text } = buildSnapshot(document.body, { maxChildrenPerLevel: 10 });
    expect(text).toMatch(/more\]/);
  });

  it('地标角色（nav）抑制 name-from-content，不显示聚合的后代文本名', () => {
    document.body.innerHTML = '<nav><a href="/a">首页</a></nav>';
    const { text } = buildSnapshot(document.body);
    const navLine = text.split('\n').find((l) => l.includes('navigation'))!;
    // nav 行不应把子链接文本"首页"当成自己的名字
    expect(navLine).not.toContain('"首页"');
  });

  it('button/link/heading 的名称正常保留', () => {
    document.body.innerHTML = '<button>提交</button><a href="/x">链接</a><h1>标题</h1>';
    const { text } = buildSnapshot(document.body);
    expect(text).toContain('button "提交"');
    expect(text).toContain('link "链接"');
    expect(text).toContain('heading "标题"');
  });

  it('maxNodes 命中时输出截断标记', () => {
    const many = Array.from({ length: 20 }, (_, i) => `<button>b${i}</button>`).join('');
    document.body.innerHTML = `<div>${many}</div>`;
    const { text } = buildSnapshot(document.body, { maxNodes: 3 });
    expect(text).toContain('截断');
  });

  it('name 中的引号被转义', () => {
    document.body.innerHTML = '<button>Say "hi"</button>';
    const { text } = buildSnapshot(document.body);
    expect(text).toContain('Say \\"hi\\"');
  });
});
