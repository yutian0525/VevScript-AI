// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { isHidden } from '../../../content/snapshot/visibility';

function mount(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

describe('隐藏过滤', () => {
  it('display:none → 隐藏', () => expect(isHidden(mount('<div style="display:none">x</div>'))).toBe(true));
  it('visibility:hidden → 隐藏', () => expect(isHidden(mount('<div style="visibility:hidden">x</div>'))).toBe(true));
  it('aria-hidden=true → 隐藏', () => expect(isHidden(mount('<div aria-hidden="true">x</div>'))).toBe(true));
  it('hidden 属性 → 隐藏', () => expect(isHidden(mount('<div hidden>x</div>'))).toBe(true));
  it('普通可见元素 → 不隐藏', () => expect(isHidden(mount('<div>x</div>'))).toBe(false));
  it('script/style 标签 → 隐藏', () => {
    expect(isHidden(mount('<script>1</script>'))).toBe(true);
    expect(isHidden(mount('<style>a{}</style>'))).toBe(true);
  });
});
