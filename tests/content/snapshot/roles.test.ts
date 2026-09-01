// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { computeRole, computeName, computeStates, computeDescription, computeExtras } from '../../../content/snapshot/roles';

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

describe('role 计算', () => {
  it('显式 role 优先', () => {
    expect(computeRole(el('<div role="button">x</div>'))).toBe('button');
  });
  it('button → button', () => expect(computeRole(el('<button>x</button>'))).toBe('button'));
  it('a[href] → link', () => expect(computeRole(el('<a href="/x">x</a>'))).toBe('link'));
  it('a 无 href → generic', () => expect(computeRole(el('<a>x</a>'))).toBe('generic'));
  it('input[type=text] → textbox', () => expect(computeRole(el('<input type="text">'))).toBe('textbox'));
  it('input[type=checkbox] → checkbox', () => expect(computeRole(el('<input type="checkbox">'))).toBe('checkbox'));
  it('select → combobox', () => expect(computeRole(el('<select></select>'))).toBe('combobox'));
  it('textarea → textbox', () => expect(computeRole(el('<textarea></textarea>'))).toBe('textbox'));
  it('div → generic', () => expect(computeRole(el('<div>x</div>'))).toBe('generic'));
  it('h1 → heading', () => expect(computeRole(el('<h1>x</h1>'))).toBe('heading'));
});

describe('name 计算', () => {
  it('aria-label 最高优先', () => {
    expect(computeName(el('<button aria-label="关闭">x</button>'))).toBe('关闭');
  });
  it('placeholder 次之', () => {
    expect(computeName(el('<input placeholder="邮箱">'))).toBe('邮箱');
  });
  it('alt（img）', () => expect(computeName(el('<img alt="头像">'))).toBe('头像'));
  it('name-from-content 角色的文本兜底并截断', () => {
    const long = 'x'.repeat(200);
    expect(computeName(el(`<button>${long}</button>`)).length).toBeLessThanOrEqual(100);
  });
  it('无名返回空串', () => expect(computeName(el('<div></div>'))).toBe(''));
  it('label[for] 关联优先于 placeholder', () => {
    const d = document.createElement('div');
    d.innerHTML = '<label for="em">邮箱地址</label><input id="em" placeholder="ph">';
    document.body.appendChild(d);
    const input = d.querySelector('input')!;
    expect(computeName(input)).toBe('邮箱地址');
    d.remove();
  });
  it('包裹式 label 关联', () => {
    const d = document.createElement('div');
    d.innerHTML = '<label>用户名<input></label>';
    document.body.appendChild(d);
    const input = d.querySelector('input')!;
    expect(computeName(input)).toContain('用户名');
    d.remove();
  });
  it('generic（div）不从内容取名，返回空', () => {
    expect(computeName(el('<div>一些说明文字</div>'))).toBe('');
  });
  it('name-from-content 角色只取可见后代文本，忽略隐藏子树', () => {
    const d = document.createElement('div');
    d.innerHTML = '<a href="/m">营销<div style="display:none">潜客挖掘 AI营销 全维搜索</div></a>';
    document.body.appendChild(d);
    const link = d.querySelector('a')!;
    expect(computeName(link)).toBe('营销');
    d.remove();
  });
});

describe('states 计算', () => {
  it('disabled', () => expect(computeStates(el('<button disabled>x</button>'))).toContain('disabled'));
  it('checked', () => {
    const c = el('<input type="checkbox">') as HTMLInputElement;
    c.checked = true;
    expect(computeStates(c)).toContain('checked');
  });
  it('aria-expanded', () => expect(computeStates(el('<button aria-expanded="true">x</button>'))).toContain('expanded'));
});

describe('description 计算', () => {
  it('聚合隐藏子菜单文本', () => {
    const d = document.createElement('div');
    d.innerHTML = '<a href="/m">营销<div style="display:none">潜客挖掘 AI营销 全维搜索</div></a>';
    document.body.appendChild(d);
    const link = d.querySelector('a')!;
    expect(computeDescription(link)).toBe('潜客挖掘 AI营销 全维搜索');
    d.remove();
  });
  it('无隐藏内容时返回空，不含可见文本', () => {
    const d = document.createElement('div');
    d.innerHTML = '<a href="/m">营销<span>可见副标题</span></a>';
    document.body.appendChild(d);
    expect(computeDescription(d.querySelector('a')!)).toBe('');
    d.remove();
  });
  it('aria-describedby 优先', () => {
    const d = document.createElement('div');
    d.innerHTML = '<span id="d">帮助说明</span><button aria-describedby="d">保存</button>';
    document.body.appendChild(d);
    expect(computeDescription(d.querySelector('button')!)).toBe('帮助说明');
    d.remove();
  });
  it('collectHiddenText/description 受 200 字预算裁剪', () => {
    const d = document.createElement('div');
    d.innerHTML = '<a href="/x">锚<span style="display:none">' + 'x'.repeat(5000) + '</span></a>';
    document.body.appendChild(d);
    expect(computeDescription(d.querySelector('a')!).length).toBeLessThanOrEqual(200);
    d.remove();
  });
  it('aria-description 作为 description 来源', () => {
    expect(computeDescription(el('<button aria-description="额外说明">x</button>'))).toBe('额外说明');
  });
  it('generic 的隐藏后代文本不聚合为 description（已排除 generic）', () => {
    const d = document.createElement('div');
    d.innerHTML = '<div><span style="display:none">隐藏噪声</span></div>';
    document.body.appendChild(d);
    expect(computeDescription(d.firstElementChild!)).toBe('');
    d.remove();
  });
  it('collectHiddenText 不泄漏 script/style 源码', () => {
    const d = document.createElement('div');
    d.innerHTML = '<a href="/x">链接<style>.a{color:red}</style><script>var x=1</script></a>';
    document.body.appendChild(d);
    const desc = computeDescription(d.querySelector('a')!);
    expect(desc).not.toContain('color:red');
    expect(desc).not.toContain('var x');
    d.remove();
  });
});

describe('extras 计算', () => {
  it('link 输出绝对 url', () => {
    const a = el('<a href="/home">首页</a>');
    expect(computeExtras(a).url).toContain('/home');
    expect(computeExtras(a).url!.startsWith('http')).toBe(true);
  });
  it('aria-haspopup', () => {
    expect(computeExtras(el('<div role="combobox" aria-haspopup="listbox"></div>')).haspopup).toBe('listbox');
  });
  it('aria-haspopup="false" 被忽略', () => {
    expect(computeExtras(el('<div role="combobox" aria-haspopup="false"></div>')).haspopup).toBeUndefined();
  });
  it('input autocomplete', () => {
    expect(computeExtras(el('<input aria-autocomplete="list">')).autocomplete).toBe('list');
  });
  it('无相关属性时字段为 undefined', () => {
    const e = computeExtras(el('<button>x</button>'));
    expect(e.url).toBeUndefined();
    expect(e.haspopup).toBeUndefined();
  });
});

describe('states 补充', () => {
  it('tab 角色带 selectable', () => {
    expect(computeStates(el('<div role="tab">模板</div>'))).toContain('selectable');
  });
  it('原生 option selected', () => {
    const d = document.createElement('div');
    d.innerHTML = '<select><option selected>A</option></select>';
    expect(computeStates(d.querySelector('option')!)).toContain('selected');
  });
  it('原生 option 角色为 option 且带 selectable', () => {
    expect(computeRole(el('<option>A</option>'))).toBe('option');
    const d = document.createElement('div');
    d.innerHTML = '<select><option>A</option></select>';
    expect(computeStates(d.querySelector('option')!)).toContain('selectable');
  });
});
