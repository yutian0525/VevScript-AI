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

  it('可交互元素带 [uid]；文本产出带 uid 的 StaticText', () => {
    document.body.innerHTML = '<button>登录</button><p>说明文字</p>';
    const { text } = buildSnapshot(document.body);
    expect(text).toMatch(/\[\d+\] button "登录"/);
    expect(text).toMatch(/\[\d+\] StaticText "说明文字"/);
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

  it('文本内容产出 StaticText 行并带 uid', () => {
    document.body.innerHTML = '<div>供应商准入排查</div>';
    const { text } = buildSnapshot(document.body);
    expect(text).toMatch(/\[\d+\] StaticText "供应商准入排查"/);
  });

  it('StaticText 的 uid 解析回父元素', () => {
    document.body.innerHTML = '<div id="card">使用模板</div>';
    buildSnapshot(document.body);
    const card = document.getElementById('card')!;
    let uid = 0;
    for (let i = 1; i < 10000; i++) { if (resolveUid(i) === card) { uid = i; break; } }
    expect(resolveUid(uid)).toBe(card);
  });

  it('根输出 RootWebArea，含标题', () => {
    document.title = '启信慧眼';
    document.body.innerHTML = '<button>x</button>';
    const { text } = buildSnapshot(document.body);
    expect(text.split('\n')[0]).toMatch(/RootWebArea "启信慧眼"/);
  });

  it('纯布局 generic 折叠，子节点上提（无空 generic 行）', () => {
    document.body.innerHTML = '<div><div><button>深层按钮</button></div></div>';
    const { text } = buildSnapshot(document.body);
    expect(text).not.toMatch(/^\s*generic\s*$/m);
    expect(text).toContain('button "深层按钮"');
  });

  it('generic 有 description 时保留成行', () => {
    document.body.innerHTML = '<div role="group" aria-describedby="h">菜单</div><span id="h">帮助</span>';
    const { text } = buildSnapshot(document.body);
    expect(text).toMatch(/description="帮助"/);
  });

  it('link 输出 url', () => {
    document.body.innerHTML = '<a href="/home">首页</a>';
    const { text } = buildSnapshot(document.body);
    expect(text).toMatch(/link "首页".*url="[^"]*\/home"/);
  });

  it('maxNodes 截断标记含「未显示」，且不超额产出', () => {
    const many = Array.from({ length: 20 }, (_, i) => `<button>b${i}</button>`).join('');
    document.body.innerHTML = `<div>${many}</div>`;
    const { text } = buildSnapshot(document.body, { maxNodes: 3 });
    expect(text).toContain('未显示');
    // maxNodes=3：RootWebArea + 外层 div + 第一个 button 用尽预算；产出的 [uid] 行数应 <= 3
    const uidLines = text.split('\n').filter((l) => /\[\d+\]/.test(l)).length;
    expect(uidLines).toBeLessThanOrEqual(3);
  });

  it('StaticText 折叠内部换行，保持单行', () => {
    document.body.innerHTML = '<div>第一行\n\n第二行  多空格</div>';
    const { text } = buildSnapshot(document.body);
    const line = text.split('\n').find((l) => l.includes('StaticText'))!;
    expect(line).toContain('第一行 第二行 多空格');
    // 该 StaticText 只占一个物理行
    expect(text.split('\n').filter((l) => l.includes('第二行')).length).toBe(1);
  });

  it('页面文本内的伪造行不破坏格式（引号/换行被转义折叠）', () => {
    document.body.innerHTML = '<div>foo"\n[999] button "假的"</div>';
    const { text } = buildSnapshot(document.body);
    // 不应出现未转义的独立伪造行
    expect(text).not.toMatch(/^\[999\] button "假的"/m);
  });

  it('StaticText 与父节点 name 相同时不重复输出（去重）', () => {
    document.body.innerHTML = '<a href="/x">链接文字</a>';
    const { text } = buildSnapshot(document.body);
    expect(text).toContain('link "链接文字"');
    // 同一段文字不该再出一行 StaticText
    expect(text).not.toContain('StaticText "链接文字"');
  });

  it('StaticText 与父 name 不同时保留', () => {
    document.body.innerHTML = '<div aria-label="标签">正文内容</div>';
    const { text } = buildSnapshot(document.body);
    expect(text).toContain('StaticText "正文内容"');
  });

  it('父 name 被截断（100 字符）时，文本是其前缀也算重复', () => {
    const long = 'x'.repeat(150);
    document.body.innerHTML = `<button>${long}</button>`;
    const { text } = buildSnapshot(document.body);
    expect(text).not.toContain('StaticText');
  });

  it('多段文本只去重与 name 相同的那段', () => {
    document.body.innerHTML = '<button aria-label="标签">标签<span>其他</span></button>';
    const { text } = buildSnapshot(document.body);
    expect(text).not.toContain('StaticText "标签"');
    expect(text).toContain('StaticText "其他"');
  });
});
