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

  it('有非 generic 命中时丢弃 generic 容器（div 包 button）', () => {
    document.body.innerHTML = '<div><button>删除</button></div>';
    const r = queryLocator({ text: '删除' });
    expect(r.elements.length).toBe(1);
    expect(r.elements[0]!.tagName).toBe('BUTTON');
  });

  it('有非 generic 命中时丢弃 generic 后代（button 包 span）', () => {
    document.body.innerHTML = '<button><span>删除</span></button>';
    const r = queryLocator({ text: '删除' });
    expect(r.elements.length).toBe(1);
    expect(r.elements[0]!.tagName).toBe('BUTTON');
  });

  it('全 generic 命中时规则不触发（纯文本嵌套容器全保留）', () => {
    document.body.innerHTML = '<div><section><p>正文</p></section></div>';
    const r = queryLocator({ text: '正文' });
    expect(r.elements.length).toBe(3);
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
    // 字符串值经 JSON.stringify 包裹——text 常含引号，直接内插会自嵌套不可读
    expect(describeLocator({ role: 'button', text: '登录' })).toBe('{ role:"button", text:"登录" }');
    expect(describeLocator({ text: '删', nth: 2 })).toBe('{ text:"删", nth:2 }');
  });

  it('describeLocator 的 text 含引号时不自嵌套', () => {
    expect(describeLocator({ text: 'he said "hi"' })).toBe('{ text:"he said \\"hi\\"" }');
  });
});

describe('locator 的 near 三级判定', () => {
  beforeEach(() => { resetUidMap(); document.body.innerHTML = ''; });

  it('第一级：label[for] 显式关联', () => {
    document.body.innerHTML = `
      <label for="pw">密码</label><input id="pw" type="text">
      <label for="un">用户名</label><input id="un" type="text">`;
    const r = queryLocator({ role: 'textbox', near: '密码' });
    expect(r.elements.length).toBe(1);
    expect(r.elements[0]!.id).toBe('pw');
    expect(r.nearTier).toBe('label');
  });

  it('第一级：包裹式 label', () => {
    document.body.innerHTML = '<label>邮箱<input id="em" type="text"></label>';
    const r = queryLocator({ role: 'textbox', near: '邮箱' });
    expect(r.elements[0]!.id).toBe('em');
    expect(r.nearTier).toBe('label');
  });

  it('第一级：aria-labelledby 反向关联', () => {
    document.body.innerHTML = `
      <span id="lbl">验证码</span><input id="code" type="text" aria-labelledby="lbl">`;
    const r = queryLocator({ role: 'textbox', near: '验证码' });
    expect(r.elements[0]!.id).toBe('code');
    expect(r.nearTier).toBe('label');
  });

  it('第二级：无显式关联时按 DOM 邻近（同容器内优先）', () => {
    document.body.innerHTML = `
      <div class="row"><span>手机号</span><input id="phone" type="text"></div>
      <div class="row"><span>地址</span><input id="addr" type="text"></div>`;
    const r = queryLocator({ role: 'textbox', near: '手机号' });
    expect(r.elements[0]!.id).toBe('phone');
    expect(r.nearTier).toBe('dom');
  });

  it('第二级：逐层向上扩大搜索，取最近祖先层命中的', () => {
    document.body.innerHTML = `
      <section>
        <div><span>金额</span></div>
        <div><input id="amount" type="text"></div>
      </section>
      <input id="far" type="text">`;
    const r = queryLocator({ role: 'textbox', near: '金额' });
    expect(r.elements[0]!.id).toBe('amount');
  });

  it('near 文本不存在时返回空', () => {
    document.body.innerHTML = '<input type="text">';
    expect(queryLocator({ role: 'textbox', near: '不存在的标签' }).elements).toEqual([]);
  });

  it('near 命中但无满足其余条件的元素时返回空', () => {
    document.body.innerHTML = '<span>标签</span>';
    expect(queryLocator({ role: 'textbox', near: '标签' }).elements).toEqual([]);
  });

  it('锚点取最深层（避免 body 这类含全部文本的祖先当锚点）', () => {
    document.body.innerHTML = `
      <div><div><span>目标标签</span><input id="deep" type="text"></div></div>
      <input id="shallow" type="text">`;
    const r = queryLocator({ role: 'textbox', near: '目标标签' });
    // length 断言必须：只查 elements[0] 的话，祖先锚点把搜索圈放大到 body
    // （deep/shallow 全命中）时 [0] 仍是 deep，缺陷会漏网。
    expect(r.elements.length).toBe(1);
    expect(r.elements[0]!.id).toBe('deep');
  });

  it('near 与 nth 组合：在 near 结果上取第 n 个', () => {
    document.body.innerHTML = `
      <div><span>组</span><input id="i0" type="text"><input id="i1" type="text"></div>`;
    const r = queryLocator({ role: 'textbox', near: '组', nth: 1 });
    expect(r.elements[0]!.id).toBe('i1');
  });

  it('near 与 text 组合：两个条件都要满足', () => {
    document.body.innerHTML = `
      <div><span>操作区</span><button>保存</button><button>取消</button></div>`;
    const r = queryLocator({ near: '操作区', text: '取消' });
    expect(r.elements.length).toBe(1);
    expect(r.elements[0]!.textContent).toBe('取消');
  });
});
