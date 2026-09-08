// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { queryLocator, describeLocator } from '../../content/locator';
import { buildSnapshot, resetUidMap, resolveUid } from '../../content/snapshot/build';

describe('locator 基础匹配', () => {
  beforeEach(() => { resetUidMap(); document.body.innerHTML = ''; });

  it('字符串 = CSS 选择器', () => {
    document.body.innerHTML = '<button class="a">一</button><button class="b">二</button>';
    const r = queryLocator('button.b');
    expect(r.elements.length).toBe(1);
    expect(r.elements[0]!.textContent).toBe('二');
  });

  it('CSS 选择器非法时抛出可读错误', () => {
    expect(() => queryLocator('<<bad>>')).toThrow(/选择器非法/);
  });

  it('数字 = uid，经 resolveUid 反查', () => {
    document.body.innerHTML = '<button id="b">目标</button>';
    buildSnapshot(document.body);
    const el = document.getElementById('b')!;
    let uid = 0;
    for (let i = 1; i < 200; i++) if (resolveUid(i) === el) { uid = i; break; }
    const r = queryLocator(uid);
    expect(r.elements).toEqual([el]);
  });

  it('uid 失效（元素脱离 DOM）返回空数组', () => {
    document.body.innerHTML = '<button>x</button>';
    buildSnapshot(document.body);
    // uid 1 是快照根（body 本身），需找 button 的真实 uid 才能表达「元素脱离」意图
    const el = document.querySelector('button')!;
    let uid = 0;
    for (let i = 1; i < 200; i++) if (resolveUid(i) === el) { uid = i; break; }
    document.body.innerHTML = '';
    expect(queryLocator(uid).elements).toEqual([]);
  });

  it('role 过滤（口径与快照一致，复用 computeRole）', () => {
    document.body.innerHTML = '<a href="/x">链</a><button>钮</button>';
    const r = queryLocator({ role: 'button' });
    expect(r.elements.length).toBe(1);
    expect(r.elements[0]!.tagName).toBe('BUTTON');
  });

  it('text 默认包含匹配', () => {
    document.body.innerHTML = '<button>提交表单</button>';
    expect(queryLocator({ text: '提交' }).elements.length).toBe(1);
  });

  it('exact:true 转精确匹配', () => {
    document.body.innerHTML = '<button>提交表单</button>';
    expect(queryLocator({ text: '提交', exact: true }).elements.length).toBe(0);
    expect(queryLocator({ text: '提交表单', exact: true }).elements.length).toBe(1);
  });

  it('text 匹配前折叠空白', () => {
    document.body.innerHTML = '<button>  下一\n  页  </button>';
    expect(queryLocator({ text: '下一 页', exact: true }).elements.length).toBe(1);
  });

  it('role + text 联合过滤', () => {
    document.body.innerHTML = '<a href="/x">删除</a><button>删除</button>';
    const r = queryLocator({ role: 'button', text: '删除' });
    expect(r.elements.length).toBe(1);
    expect(r.elements[0]!.tagName).toBe('BUTTON');
  });

  it('无 name 的元素按自身可见文本匹配（generic 不进 NAME_FROM_CONTENT）', () => {
    document.body.innerHTML = '<div>纯文本容器</div>';
    expect(queryLocator({ text: '纯文本容器' }).elements.length).toBe(1);
  });

  it('nth 取第 n 个（0-based）', () => {
    document.body.innerHTML = '<button>删</button><button>删</button><button>删</button>';
    const r = queryLocator({ text: '删', nth: 2 });
    expect(r.elements.length).toBe(1);
    expect(r.nthApplied).toBe(true);
  });

  it('nth 越界返回空', () => {
    document.body.innerHTML = '<button>删</button>';
    expect(queryLocator({ text: '删', nth: 5 }).elements).toEqual([]);
  });

  it('隐藏元素不匹配（与快照口径一致）', () => {
    document.body.innerHTML = '<button style="display:none">隐</button><button>显</button>';
    const r = queryLocator({ role: 'button' });
    expect(r.elements.length).toBe(1);
    expect(r.elements[0]!.textContent).toBe('显');
  });

  it('within 限定搜索范围', () => {
    document.body.innerHTML = '<div id="a"><h2>标题A</h2></div><div id="b"><h2>标题B</h2></div>';
    const scope = document.getElementById('b')!;
    const r = queryLocator('h2', { within: scope });
    expect(r.elements.length).toBe(1);
    expect(r.elements[0]!.textContent).toBe('标题B');
  });

  it('空语义 locator（无任何条件）抛错，不返回全页元素', () => {
    document.body.innerHTML = '<button>x</button>';
    expect(() => queryLocator({})).toThrow(/至少需要一个条件/);
  });

  it('describeLocator 生成可读描述（进 trace 与错误文案）', () => {
    expect(describeLocator('button.b')).toBe('选择器 "button.b"');
    expect(describeLocator(46)).toBe('uid 46');
    expect(describeLocator({ role: 'button', text: '登录' })).toBe('{ role:"button", text:"登录" }');
    expect(describeLocator({ text: '删', nth: 2 })).toBe('{ text:"删", nth:2 }');
  });
});
