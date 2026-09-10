// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { diagnoseMiss, diagnoseAmbiguous, briefElement } from '../../content/locator-diagnose';
import { resetUidMap } from '../../content/snapshot/build';

describe('定位失败诊断', () => {
  beforeEach(() => { resetUidMap(); document.body.innerHTML = ''; });

  it('briefElement 给 tag/class/text，text 截 40 字符', () => {
    document.body.innerHTML = `<a class="next-page">${'长'.repeat(60)}</a>`;
    const b = briefElement(document.querySelector('a')!);
    expect(b.tag).toBe('a');
    expect(b.class).toBe('next-page');
    expect(b.text.length).toBeLessThanOrEqual(41);
  });

  it('briefElement 无 class 时不带该字段', () => {
    document.body.innerHTML = '<button>x</button>';
    expect(briefElement(document.querySelector('button')!).class).toBeUndefined();
  });

  it('relaxed 三档都给出计数（含 0，"全是 0" 本身是信息）', () => {
    document.body.innerHTML = '<button>其它</button>';
    const d = diagnoseMiss({ role: 'button', text: '下一页' }, document.body);
    expect(d.relaxed).toEqual({
      'text 精确匹配（忽略 role）': 0,
      'text 包含匹配（忽略 role）': 0,
      'role=button 全部': 1,
    });
  });

  it('典型场景：文本含额外字符且 role 不符 → 包含匹配命中 + nearMiss 给出候选', () => {
    document.body.innerHTML = '<a class="next-page">下一页 ›</a><button>上一页</button>';
    const d = diagnoseMiss({ role: 'button', text: '下一页' }, document.body);
    expect(d.relaxed!['text 包含匹配（忽略 role）']).toBe(1);
    expect(d.nearMiss).toEqual([{ tag: 'a', class: 'next-page', text: '下一页 ›' }]);
    expect(d.hint).toContain('下一页 ›');
    expect(d.hint).toContain('a');
  });

  it('nearMiss 上限 3 条，按文本长度差排序（最像的在前）', () => {
    document.body.innerHTML = `
      <div>删除记录并清空回收站</div><div>删除记录</div>
      <div>删除</div><div>删除全部内容项</div>`;
    const d = diagnoseMiss({ role: 'button', text: '删除' }, document.body);
    expect(d.nearMiss!.length).toBe(3);
    expect(d.nearMiss![0]!.text).toBe('删除');
  });

  it('role 不存在于页面时 hint 提示换 role', () => {
    document.body.innerHTML = '<div>内容</div>';
    const d = diagnoseMiss({ role: 'slider', text: '内容' }, document.body);
    expect(d.relaxed!['role=slider 全部']).toBe(0);
    expect(d.hint).toContain('slider');
  });

  it('只有 text 无 role 时 relaxed 只给两档', () => {
    document.body.innerHTML = '<button>x</button>';
    const d = diagnoseMiss({ text: '找不到' }, document.body);
    expect(Object.keys(d.relaxed!)).toEqual([
      'text 精确匹配（忽略 role）', 'text 包含匹配（忽略 role）',
    ]);
  });

  it('CSS 选择器失败时给 tag 部分的计数与语义 locator 建议', () => {
    document.body.innerHTML = '<button class="other">x</button>';
    const d = diagnoseMiss('button.submit', document.body);
    expect(d.relaxed!['button 全部']).toBe(1);
    expect(d.hint).toContain('语义');
  });

  it('near 失败时 hint 指出锚点文本是否存在', () => {
    document.body.innerHTML = '<input type="text">';
    const d = diagnoseMiss({ role: 'textbox', near: '密码' }, document.body);
    expect(d.hint).toContain('密码');
    expect(d.hint).toContain('未找到');
  });

  it('near 锚点在同源 iframe 内时不算「锚点不存在」（存在性检查跨帧）', () => {
    // relaxed 计数与真实 near 匹配都跨帧（collectRoots），锚点存在性检查若只查
    // 主帧 textContent，会把「锚点在帧内」误判成「锚点不存在」，hint 指去滚动。
    document.body.innerHTML = '<iframe id="f"></iframe>';
    const f = document.getElementById('f') as HTMLIFrameElement;
    f.contentDocument!.body.innerHTML = '<label for="p">密码</label>';
    // 主帧没有满足 role=textbox 的元素（帧内也没 input），near 真实 miss，
    // 但锚点「密码」在帧内存在 → hint 必须落「锚点在但附近没目标」分支。
    const d = diagnoseMiss({ role: 'textbox', near: '密码' }, document.body);
    expect(d.hint).toContain('附近没有');
  });

  it('exact 命中但 role 不符时落 role 交叉分支（不产出「exact 未命中」假话）', () => {
    // exact 分流若无「exact 档计数为 0」守卫，text 全等、role 卡住的场景会
    // 落 exact 分支说「exact 精确匹配未命中」——与 relaxed 计数（exact=1）自相矛盾。
    document.body.innerHTML = '<a href="#">删除记录</a>';
    const d = diagnoseMiss({ role: 'button', text: '删除记录', exact: true }, document.body);
    expect(d.relaxed!['text 精确匹配（忽略 role）']).toBe(1);
    expect(d.hint).toContain('不是 button');
    expect(d.hint).not.toContain('exact 精确匹配未命中');
  });

  it('near 锚点存在但目标不存在时 hint 区分这两种情况', () => {
    document.body.innerHTML = '<span>密码</span>';
    const d = diagnoseMiss({ role: 'textbox', near: '密码' }, document.body);
    expect(d.hint).toContain('附近没有');
  });

  it('uid 失效的 hint 引导重新获取', () => {
    const d = diagnoseMiss(999, document.body);
    expect(d.matched).toBe(0);
    expect(d.hint).toContain('999');
    expect(d.hint).toContain('重新');
  });

  it('diagnoseAmbiguous 列候选（上限 5）并建议 nth/within', () => {
    document.body.innerHTML = Array.from({ length: 7 }, (_, i) =>
      `<button class="del">删除${i}</button>`).join('');
    const els = Array.from(document.querySelectorAll('button'));
    const d = diagnoseAmbiguous({ role: 'button', text: '删除' }, els);
    expect(d.matched).toBe(7);
    expect(d.ambiguous!.length).toBe(5);
    expect(d.hint).toContain('nth');
    expect(d.hint).toContain('within');
  });
});
