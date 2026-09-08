// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { click, type as typeInto, hover, press } from '../../../content/helpers/events';
import { StepError } from '../../../content/helpers/step-error';

/** 记录元素上派发的事件类型序列。 */
function recordEvents(el: Element, types: string[]): string[] {
  const seen: string[] = [];
  for (const t of types) el.addEventListener(t, () => seen.push(t));
  return seen;
}

const ALL = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'focus'];

/** 非 0 rect 的 DOMRect 桩（jsdom 恒返 0，遮挡检测分支需要真实几何才会走进去）。 */
const RECT = { left: 10, top: 10, width: 80, height: 30, right: 90, bottom: 40, x: 10, y: 10, toJSON: () => ({}) } as DOMRect;

/** 捕获 click 的失败结果并收窄成 StepError（jsdom 下 click 正常路径返回 undefined，
 *  catch 捕获的可能是任意 unknown——统一断言成 StepError 方便后续访问 kind/detail）。 */
function catchStepError(p: Promise<void>): Promise<StepError> {
  return p.then(() => { throw new Error('expected click to reject with StepError, but it resolved'); },
    (e: unknown) => e as StepError);
}

/** elementFromPoint 在 jsdom 不存在，遮挡检测的 try/catch 退化为「恒 null 跳过」。
 *  要进 blocked / 命中后代 / force / pointer-events 各分支必须先造一个可 spy 的桩。 */
function stubElementFromPoint(): ReturnType<typeof vi.fn> {
  const stub = vi.fn(() => null);
  Object.defineProperty(document, 'elementFromPoint', { value: stub, configurable: true });
  return stub;
}

describe('click 事件序列', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // jsdom 没有该 API；上一用例塞进 document 的桩要清掉，恢复「不存在」原貌
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it('派发完整序列且顺序正确（含现有实现缺失的 pointerup；focus 事件在序列之前）', async () => {
    document.body.innerHTML = '<button>x</button>';
    const btn = document.querySelector('button')!;
    const seen = recordEvents(btn, ALL);
    await click(btn);
    // focus 派发在 mousedown 之前（真实浏览器行为），单独用 focus spy 用例覆盖，这里只断言鼠标序列
    expect(seen.filter((t) => t !== 'focus')).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    expect(seen).toContain('focus');
  });

  it('点击前调用 focus（现有实现缺失，导致依赖 focus 的组件不响应）', async () => {
    document.body.innerHTML = '<button>x</button>';
    const btn = document.querySelector('button')!;
    const spy = vi.spyOn(btn, 'focus');
    await click(btn);
    expect(spy).toHaveBeenCalled();
  });

  it('事件冒泡到祖先（框架事件委托依赖此）', async () => {
    document.body.innerHTML = '<div id="root"><span id="inner">x</span></div>';
    const seen: string[] = [];
    document.getElementById('root')!.addEventListener('click', () => seen.push('delegated'));
    await click(document.getElementById('inner')!);
    expect(seen).toEqual(['delegated']);
  });

  it('事件带 view 与 detail（部分框架读取）', async () => {
    document.body.innerHTML = '<button>x</button>';
    const btn = document.querySelector('button')!;
    let ev: MouseEvent | undefined;
    btn.addEventListener('click', (e) => { ev = e as MouseEvent; });
    await click(btn);
    expect(ev!.detail).toBe(1);
    expect(ev!.view).toBe(window);
    expect(ev!.bubbles).toBe(true);
    expect(ev!.cancelable).toBe(true);
  });

  it('事件坐标用真实 rect 中心（rect 非 0 时）', async () => {
    document.body.innerHTML = '<button>x</button>';
    const btn = document.querySelector('button')!;
    let ev: MouseEvent | undefined;
    btn.addEventListener('click', (e) => { ev = e as MouseEvent; });
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue(RECT);
    await click(btn);
    expect(ev!.clientX).toBe(50);   // left 10 + width 80 / 2
    expect(ev!.clientY).toBe(25);   // top 10 + height 30 / 2
  });

  it('dbl 选项追加 dblclick（detail=2）', async () => {
    document.body.innerHTML = '<button>x</button>';
    const btn = document.querySelector('button')!;
    let detail = 0;
    btn.addEventListener('dblclick', (e) => { detail = (e as MouseEvent).detail; });
    const seen = recordEvents(btn, ALL);
    await click(btn, { dbl: true });
    expect(seen).toContain('dblclick');
    expect(detail).toBe(2);
  });

  it('disabled 元素抛 state 类 StepError（而非静默无效点击）', async () => {
    document.body.innerHTML = '<button disabled>x</button>';
    const btn = document.querySelector('button')!;
    const err = await catchStepError(click(btn));
    expect(err).toBeInstanceOf(StepError);
    expect(err.kind).toBe('state');
    expect(err.message).toContain('disabled');
  });

  it('aria-disabled 同样拦截', async () => {
    document.body.innerHTML = '<div role="button" aria-disabled="true">x</div>';
    const err = await catchStepError(click(document.querySelector('[role=button]')!));
    expect(err.kind).toBe('state');
    expect(err.message).toContain('aria-disabled');
  });

  it('遮挡检测：elementFromPoint 返回不相关元素时抛 blocked 并带遮挡物信息', async () => {
    document.body.innerHTML = '<button>目标</button><div class="cookie-banner">提示条</div>';
    const btn = document.querySelector('button')!;
    const banner = document.querySelector('.cookie-banner')!;
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue(RECT);
    stubElementFromPoint().mockReturnValue(banner as HTMLElement);
    const err = await catchStepError(click(btn));
    expect(err).toBeInstanceOf(StepError);
    expect(err.kind).toBe('blocked');
    expect(err.detail.blockedBy).toMatchObject({ tag: 'div', class: 'cookie-banner' });
    expect(err.detail.hint).toContain('force');
  });

  it('遮挡物是目标的后代时不算遮挡（点在自己的子元素上是正常的）', async () => {
    document.body.innerHTML = '<button><span id="s">文字</span></button>';
    const btn = document.querySelector('button')!;
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue(RECT);
    stubElementFromPoint().mockReturnValue(document.getElementById('s') as HTMLElement);
    await expect(click(btn)).resolves.toBeUndefined();
  });

  it('force:true 跳过遮挡检测', async () => {
    document.body.innerHTML = '<button>x</button><div class="mask">遮</div>';
    const btn = document.querySelector('button')!;
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue(RECT);
    const stub = stubElementFromPoint().mockReturnValue(document.querySelector('.mask') as HTMLElement);
    await expect(click(btn, { force: true })).resolves.toBeUndefined();
    expect(stub).not.toHaveBeenCalled();   // force 是跳过调用，不是命中后放行
  });

  it('rect 全 0（jsdom / 0 尺寸元素）时跳过遮挡检测，不误报', async () => {
    document.body.innerHTML = '<button>x</button>';
    await expect(click(document.querySelector('button')!)).resolves.toBeUndefined();
  });

  it('pointer-events:none 的遮挡物不算遮挡（不拦事件）', async () => {
    document.body.innerHTML = '<button>x</button><div class="deco" style="pointer-events:none">装饰</div>';
    const btn = document.querySelector('button')!;
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue(RECT);
    stubElementFromPoint().mockReturnValue(document.querySelector('.deco') as HTMLElement);
    await expect(click(btn)).resolves.toBeUndefined();
  });

  it('elementFromPoint 不可用（jsdom 原貌：不存在）时不阻断点击', async () => {
    document.body.innerHTML = '<button>x</button>';
    const btn = document.querySelector('button')!;
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue(RECT);
    // 不造桩——document.elementFromPoint 为 undefined，取值即抛 TypeError，走 try/catch 跳过分支
    await expect(click(btn)).resolves.toBeUndefined();
  });

  it('elementFromPoint 返回 null（无命中）时不误报遮挡', async () => {
    document.body.innerHTML = '<button>x</button>';
    const btn = document.querySelector('button')!;
    vi.spyOn(btn, 'getBoundingClientRect').mockReturnValue(RECT);
    stubElementFromPoint().mockReturnValue(null);
    await expect(click(btn)).resolves.toBeUndefined();
  });

  it('scrollIntoView 在点击前被调用（真实浏览器里把元素滚进视野）', async () => {
    document.body.innerHTML = '<button>x</button>';
    const btn = document.querySelector('button')!;
    const spy = vi.fn();
    (btn as HTMLElement).scrollIntoView = spy;
    await click(btn);
    expect(spy).toHaveBeenCalledWith({ block: 'center' });
  });
});

describe('type 四路分派', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('input：逐字符发 keydown/keyup，最后 change', async () => {
    document.body.innerHTML = '<input type="text">';
    const el = document.querySelector('input')!;
    const seq: string[] = [];
    for (const t of ['keydown', 'keypress', 'input', 'keyup', 'change']) {
      el.addEventListener(t, () => seq.push(t));
    }
    await typeInto(el, 'ab');
    expect(el.value).toBe('ab');
    expect(seq.filter((s) => s === 'keydown').length).toBe(2);
    expect(seq.filter((s) => s === 'input').length).toBe(2);
    expect(seq[seq.length - 1]).toBe('change');
  });

  it('input：keydown 事件带正确的 key（搜索联想框读它）', async () => {
    document.body.innerHTML = '<input type="text">';
    const el = document.querySelector('input')!;
    const keys: string[] = [];
    el.addEventListener('keydown', (e) => keys.push((e as KeyboardEvent).key));
    await typeInto(el, 'hi');
    expect(keys).toEqual(['h', 'i']);
  });

  it('input：大写字符的 keydown 带 shiftKey=true（真实浏览器 shift+a 的产物）', async () => {
    document.body.innerHTML = '<input type="text">';
    const el = document.querySelector('input')!;
    const shifts: boolean[] = [];
    el.addEventListener('keydown', (e) => shifts.push((e as KeyboardEvent).shiftKey));
    await typeInto(el, 'aA');
    expect(shifts).toEqual([false, true]);
  });

  it('number input 的非数字值抛 state（原生 setter 静默清洗成空，不报则 agent 误以为成功）', async () => {
    document.body.innerHTML = '<input type="number">';
    const err = await catchStepError(typeInto(document.querySelector('input')!, 'abc'));
    expect(err.kind).toBe('state');
    expect(err.message).toContain('清洗');
  });

  it('number input 的合法数字正常写入', async () => {
    document.body.innerHTML = '<input type="number">';
    const el = document.querySelector('input')!;
    await typeInto(el, '-5');
    expect(el.value).toBe('-5');
  });

  it('contenteditable="false" 不可输入（显式关闭编辑，误判会静默覆盖富文本岛内容）', async () => {
    document.body.innerHTML = '<div contenteditable="false">锁死文本</div>';
    const err = await catchStepError(typeInto(document.querySelector('div')!, 'AI写入'));
    expect(err.kind).toBe('state');
  });

  it('contenteditable 裸属性（空值）仍可输入', async () => {
    document.body.innerHTML = '<div contenteditable>可编辑</div>';
    const el = document.querySelector('div')!;
    await typeInto(el, 'ok');
    expect(el.textContent).toBe('ok');
  });

  it('input：填入前清空既有值', async () => {
    document.body.innerHTML = '<input type="text" value="旧值">';
    const el = document.querySelector('input')!;
    await typeInto(el, '新');
    expect(el.value).toBe('新');
  });

  it('input：instant 快路径只发一次 input，无 keydown', async () => {
    document.body.innerHTML = '<input type="text">';
    const el = document.querySelector('input')!;
    let inputs = 0, keydowns = 0;
    el.addEventListener('input', () => { inputs += 1; });
    el.addEventListener('keydown', () => { keydowns += 1; });
    await typeInto(el, '很长的一段文本', { instant: true });
    expect(el.value).toBe('很长的一段文本');
    expect(inputs).toBe(1);
    expect(keydowns).toBe(0);
  });

  it('input：不派发 blur（可能触发提交/校验，交给 agent 显式 press）', async () => {
    document.body.innerHTML = '<input type="text"><input id="other">';
    const el = document.querySelector('input')!;
    (el as HTMLElement).focus();   // 真实流程焦点通常已在目标上（先点击聚焦再输入）
    let blurred = false;
    el.addEventListener('blur', () => { blurred = true; });
    document.getElementById('other')!.addEventListener('blur', () => { blurred = true; });
    await typeInto(el, 'x');
    // helper 自身不派发任何 blur：序列结尾不调 blur()，重复 focus 已聚焦元素也不产生 blur
    expect(blurred).toBe(false);
  });

  it('textarea 同样支持', async () => {
    document.body.innerHTML = '<textarea></textarea>';
    const el = document.querySelector('textarea')!;
    await typeInto(el, '多行');
    expect(el.value).toBe('多行');
  });

  it('select：按 value 匹配 option', async () => {
    document.body.innerHTML = '<select><option value="a">甲</option><option value="b">乙</option></select>';
    const el = document.querySelector('select')!;
    const seq: string[] = [];
    for (const t of ['input', 'change']) el.addEventListener(t, () => seq.push(t));
    await typeInto(el, 'b');
    expect(el.value).toBe('b');
    expect(seq).toEqual(['input', 'change']);
  });

  it('select：value 无匹配时按 option 文本匹配', async () => {
    document.body.innerHTML = '<select><option value="a">甲</option><option value="b">乙</option></select>';
    const el = document.querySelector('select')!;
    await typeInto(el, '乙');
    expect(el.value).toBe('b');
  });

  it('select：都无匹配时抛 state 并列出可选项', async () => {
    document.body.innerHTML = '<select><option value="a">甲</option></select>';
    const err = await catchStepError(typeInto(document.querySelector('select')!, '丙'));
    expect(err.kind).toBe('state');
    expect(err.message).toContain('甲');
  });

  it('contenteditable：写入 textContent 并发 input', async () => {
    document.body.innerHTML = '<div contenteditable="true"></div>';
    const el = document.querySelector('div')!;
    let inputs = 0;
    el.addEventListener('input', () => { inputs += 1; });
    await typeInto(el, '富文本');
    expect(el.textContent).toBe('富文本');
    expect(inputs).toBeGreaterThan(0);
  });

  it('不可输入元素抛 state 并说明原因', async () => {
    document.body.innerHTML = '<div id="plain">普通 div</div>';
    const err = await catchStepError(typeInto(document.getElementById('plain')!, 'x'));
    expect(err.kind).toBe('state');
    expect(err.message).toContain('不支持输入');
    expect(err.detail.hint).toContain('query_page');
  });

  it('disabled 输入框抛 state', async () => {
    document.body.innerHTML = '<input type="text" disabled>';
    const err = await catchStepError(typeInto(document.querySelector('input')!, 'x'));
    expect(err.kind).toBe('state');
  });

  it('readonly 输入框抛 state（区别于 disabled）', async () => {
    document.body.innerHTML = '<input type="text" readonly>';
    const err = await catchStepError(typeInto(document.querySelector('input')!, 'x'));
    expect(err.kind).toBe('state');
    expect(err.message).toContain('readonly');
  });
});

describe('hover', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('派发 pointerover/mouseover/mousemove/mouseenter', async () => {
    document.body.innerHTML = '<div id="m">菜单</div>';
    const el = document.getElementById('m')!;
    const seen: string[] = [];
    for (const t of ['pointerover', 'mouseover', 'mousemove', 'mouseenter']) {
      el.addEventListener(t, () => seen.push(t));
    }
    await hover(el);
    expect(seen).toEqual(['pointerover', 'mouseover', 'mousemove', 'mouseenter']);
  });

  it('mouseover 冒泡、mouseenter 不冒泡（符合 DOM 规范）', async () => {
    document.body.innerHTML = '<div id="p"><div id="c">x</div></div>';
    const parent = document.getElementById('p')!;
    const seen: string[] = [];
    parent.addEventListener('mouseover', () => seen.push('over'));
    parent.addEventListener('mouseenter', () => seen.push('enter'));
    await hover(document.getElementById('c')!);
    expect(seen).toEqual(['over']);
  });
});

describe('press', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('字符串形式发 keydown/keypress/keyup 到 activeElement', async () => {
    document.body.innerHTML = '<input type="text">';
    const el = document.querySelector('input')!;
    (el as HTMLElement).focus();
    const seen: string[] = [];
    for (const t of ['keydown', 'keypress', 'keyup']) el.addEventListener(t, () => seen.push(t));
    await press('Enter');
    expect(seen).toEqual(['keydown', 'keypress', 'keyup']);
  });

  it('非字符键不发 keypress（Escape/Tab 等与真实浏览器一致）', async () => {
    document.body.innerHTML = '<input type="text">';
    const el = document.querySelector('input')!;
    (el as HTMLElement).focus();
    const seen: string[] = [];
    for (const t of ['keydown', 'keypress', 'keyup']) el.addEventListener(t, () => seen.push(t));
    await press('Escape');
    expect(seen).toEqual(['keydown', 'keyup']);
  });

  it('对象形式带修饰键', async () => {
    document.body.innerHTML = '<input type="text">';
    const el = document.querySelector('input')!;
    (el as HTMLElement).focus();
    let ev: KeyboardEvent | undefined;
    el.addEventListener('keydown', (e) => { ev = e as KeyboardEvent; });
    await press({ key: 'a', ctrl: true, shift: true });
    expect(ev!.key).toBe('a');
    expect(ev!.ctrlKey).toBe(true);
    expect(ev!.shiftKey).toBe(true);
  });

  it('无 activeElement 时退回 body，不抛错', async () => {
    document.body.innerHTML = '';
    await expect(press('Enter')).resolves.toBeUndefined();
  });

  it('press 的 events 冒泡（监听在祖先上也能收到）', async () => {
    document.body.innerHTML = '<div id="wrap"><input type="text"></div>';
    const el = document.querySelector('input')!;
    (el as HTMLElement).focus();
    const seen: string[] = [];
    document.getElementById('wrap')!.addEventListener('keydown', () => seen.push('delegated'));
    await press('a');
    expect(seen).toEqual(['delegated']);
  });
});
