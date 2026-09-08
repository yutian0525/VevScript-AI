// content/helpers/events.ts
// 事件序列实现（spec §3.3/§3.4）。这里是修「点了没反应」的核心：
// 现有 interact.ts 缺 pointerup、不 focus、坐标恒 0、无遮挡检测，四项在此一次修对。
// 原则 2：框架保证正确，而非每次靠模型写对。
import { StepError, disabledReason } from './step-error';

export interface ClickOpts {
  /** 追加 dblclick。 */
  dbl?: boolean;
  /** 跳过遮挡检测（目标被半透明装饰层覆盖但实际可点时用）。 */
  force?: boolean;
}

export interface TypeOpts {
  /** 跳过逐字符键盘事件，直接设值 + 一次 input/change。长文本用。 */
  instant?: boolean;
}

export interface PressMods { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }
export type PressArg = string | ({ key: string } & PressMods);

/** 等一帧让布局稳定。rAF 不可用（jsdom 部分配置）时退回微延时。 */
function raf(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** 元素简要信息（进错误诊断）。class 截 60：Tailwind 类名可 300+ 字符，
 *  不截会放大失败诊断的 token 开销（text 有 40 上限，class 同理要有）。 */
export function briefOf(el: Element): Record<string, unknown> {
  const raw = el.getAttribute('class')?.trim();
  const cls = raw && raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const brief: Record<string, unknown> = { tag: el.tagName.toLowerCase(), text };
  if (cls) brief.class = cls;
  return brief;
}

/** 把页面的 window 塞进已构造事件的 view 字段。不能走构造器 init.view：vitest jsdom 环境
 *  把全局 window 换成了 Node global（populateGlobal 把 window/self 指到 global），它过不了
 *  jsdom 构造器的 isWindow 校验（「member view is not of type Window」）；而真实事件对象上的
 *  view 属性 configurable，构造后 defineProperty 回填即可。回填失败也不阻断——view 只是
 *  部分框架读取的附加信息，缺失时为 null 不影响派发。 */
function withView<T extends UIEvent>(el: Element, ev: T): T {
  try {
    const view = el.ownerDocument.defaultView;
    if (view && ev.view !== view) Object.defineProperty(ev, 'view', { value: view, configurable: true });
  } catch {
    // 极端环境（view 不可配置）下保持原样
  }
  return ev;
}

/** 派发 pointer 事件。PointerEvent 不可用（jsdom / 老浏览器）时退回 MouseEvent，
 *  事件 type 不变故监听方照样收到——不因构造器缺失丢掉整个序列。 */
function firePointer(el: Element, type: string, init: MouseEventInit): void {
  const ev = typeof PointerEvent === 'function'
    ? new PointerEvent(type, { ...init, pointerId: 1, isPrimary: true, pointerType: 'mouse' })
    : new MouseEvent(type, init);
  el.dispatchEvent(withView(el, ev));
}

/** 命中点上的元素是否构成真实遮挡。pointer-events:none 的装饰层不拦事件，不算遮挡。 */
function isRealBlocker(target: Element, hit: Element): boolean {
  if (hit === target) return false;
  if (target.contains(hit) || hit.contains(target)) return false;
  const style = hit.ownerDocument.defaultView?.getComputedStyle(hit);
  if (style?.pointerEvents === 'none') return false;
  return true;
}

export async function click(el: Element, opts: ClickOpts = {}): Promise<void> {
  const why = disabledReason(el);
  if (why) {
    throw new StepError('state', `元素不可点击：<${el.tagName.toLowerCase()}> 带 ${why}`, {
      element: briefOf(el),
      hint: '该元素当前被禁用。先满足其启用条件（如填完必填项、勾选同意条款），或改点其它元素。',
    });
  }

  // scrollIntoView 包 try/catch：jsdom 30 原型上无此方法（可选链够用），但未来版本
  // 可能学 scrollBy「定义了但调时抛 Not implemented」——可选链兜不住抛错，会炸掉整个 click。
  try {
    (el as HTMLElement).scrollIntoView?.({ block: 'center' });
  } catch {
    // 滚动失败不阻断点击（遮挡检测自有兜底）
  }
  await raf();

  const r = el.getBoundingClientRect();
  const hasRect = r.width > 0 || r.height > 0;
  const x = hasRect ? r.left + r.width / 2 : 0;
  const y = hasRect ? r.top + r.height / 2 : 0;

  // 遮挡检测只在有真实几何信息时进行。rect 全 0（jsdom / 0 尺寸包装元素）无从判断，
  // 此时误报比漏报更坏——会把本可点的元素判死。
  if (!opts.force && hasRect) {
    let hit: Element | null = null;
    try {
      hit = el.ownerDocument.elementFromPoint(x, y);
    } catch {
      hit = null;   // jsdom 未实现该 API：跳过检测，不阻断
    }
    if (hit && isRealBlocker(el, hit)) {
      const cls = (s: string | null) => (s ? ` class="${s}"` : '');
      throw new StepError(
        'blocked',
        `点击被遮挡：目标 <${el.tagName.toLowerCase()}${cls(el.getAttribute('class'))}> 被 <${hit.tagName.toLowerCase()}${cls(hit.getAttribute('class'))}> 覆盖`,
        {
          element: { ...briefOf(el), rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } },
          blockedBy: briefOf(hit),
          hint: '先处理遮挡物（找它上面的关闭/同意按钮点掉），或滚动使目标离开遮挡区域后重试。确认遮挡层实际不拦点击时可传 { force: true }。',
        },
      );
    }
  }

  (el as HTMLElement).focus?.();

  const init: MouseEventInit = {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
    view: undefined, detail: 1,
  };
  firePointer(el, 'pointerdown', init);
  el.dispatchEvent(withView(el, new MouseEvent('mousedown', init)));
  firePointer(el, 'pointerup', init);
  el.dispatchEvent(withView(el, new MouseEvent('mouseup', init)));
  el.dispatchEvent(withView(el, new MouseEvent('click', init)));
  if (opts.dbl) el.dispatchEvent(withView(el, new MouseEvent('dblclick', { ...init, detail: 2 })));
}

/** 用原生 value setter 绕过 React 等框架的值劫持（沿用 interact.ts 既有做法）。
 *  框架在元素实例上 defineProperty 劫持 value 时，走原型 setter 才能让框架的
 *  valueTracker 追踪到「值确实变了」，后续 input 事件才不会被认为是重复值而丢掉。 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else (el as { value: string }).value = value;
}

/** 键盘事件 init（ctrl/shift/alt/meta 对齐 PressMods）。 */
function keyInit(key: string, mods: PressMods = {}): KeyboardEventInit {
  return {
    key, bubbles: true, cancelable: true,
    ctrlKey: Boolean(mods.ctrl), shiftKey: Boolean(mods.shift),
    altKey: Boolean(mods.alt), metaKey: Boolean(mods.meta),
  };
}

/** select 的 option 列表进错误诊断。「"显示文本"(value=xxx)」形式，最多 10 个防 token 放大。 */
function optionSummary(sel: HTMLSelectElement): string {
  return Array.from(sel.options)
    .slice(0, 10)
    .map((o) => `"${(o.textContent ?? '').trim()}"(value=${o.value})`)
    .join('、');
}

export async function type(el: Element, value: string, opts: TypeOpts = {}): Promise<void> {
  const why = disabledReason(el);
  if (why) {
    throw new StepError('state', `输入控件被禁用：<${el.tagName.toLowerCase()}> 带 ${why}`, {
      element: briefOf(el),
      hint: '输入控件被禁用。先满足启用条件（如勾选同意条款、填完必填项），或改用其它可编辑的输入途径。',
    });
  }

  // —— select ——
  if (el instanceof HTMLSelectElement) {
    const sel = el;
    const byValue = Array.from(sel.options).find((o) => o.value === value);
    const byText = byValue
      ? undefined
      : Array.from(sel.options).find((o) => (o.textContent ?? '').trim() === value.trim());
    const opt = byValue ?? byText;
    if (!opt) {
      throw new StepError('state', `select 无匹配选项："${value}"。可选项：${optionSummary(sel)}`, {
        element: briefOf(sel),
        hint: '选项由 JS 动态加载时先 waitFor 等它填充再选；或改用列表上的搜索/自定义入口。',
      });
    }
    (sel as HTMLElement).focus?.();
    setNativeValue(sel, opt.value);
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  // —— contenteditable ——（jsdom 的 HTMLElement 原型没有 isContentEditable getter，
  // 探针确认恒 undefined，故退回 contenteditable 属性判断；注意裸属性 contenteditable=""
  // 也算可编辑，但属性不存在（null）不算——「元素有该属性」必须显式排除 null）
  const editable = el instanceof HTMLElement
    && (el.isContentEditable || el.hasAttribute('contenteditable'));
  if (editable) {
    const host = el as HTMLElement;
    host.focus?.();
    const set = (text: string): void => {
      host.textContent = text;
      host.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    };
    if (opts.instant) {
      set(value);
      return;
    }
    host.textContent = '';
    let acc = '';
    for (const ch of value) {
      host.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }));
      acc += ch;
      set(acc);
    }
    return;
  }

  // —— input / textarea ——
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const input = el;
    // readonly 单独拦截而非静默失败：值写不进去，agent 会误以为成功
    if (input.readOnly) {
      throw new StepError('state', `<${input.tagName.toLowerCase()}> 是 readonly（只读），不能手动输入`, {
        element: briefOf(input),
        hint: 'readonly 输入框通常由页面逻辑填充（如点按钮回填、选日期回填），找触发它的控件点一下，或用 evaluate_script 确认交互路径。',
      });
    }
    input.focus?.();

    if (opts.instant) {
      setNativeValue(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    setNativeValue(input, '');
    let acc = '';
    for (const ch of value) {
      input.dispatchEvent(new KeyboardEvent('keydown', keyInit(ch)));
      input.dispatchEvent(new KeyboardEvent('keypress', keyInit(ch)));
      acc += ch;
      setNativeValue(input, acc);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', keyInit(ch)));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // 刻意不 blur：blur 可能触发提交或校验逻辑，是否「离开」该由 agent 显式 press('Tab') 决定
    return;
  }

  // —— 其余元素 ——
  throw new StepError('state', `元素不支持输入：<${el.tagName.toLowerCase()}> 不是输入框/文本域/下拉框/contenteditable`, {
    element: briefOf(el),
    hint: '用 query_page 确认目标：真正的输入框 role 是 textbox 或 combobox。有些站点的「输入框」外观由 div 模拟，实际输入框是其内部的 input——试 { role: "textbox", near: "该标签文字" }。',
  });
}

export async function hover(el: Element): Promise<void> {
  try {
    (el as HTMLElement).scrollIntoView?.({ block: 'center' });
  } catch {
    // 滚动失败不阻断悬停（与 click 同款兜底）
  }
  await raf();

  const r = el.getBoundingClientRect();
  const hasRect = r.width > 0 || r.height > 0;
  const init: MouseEventInit = {
    bubbles: true, cancelable: true,
    clientX: hasRect ? r.left + r.width / 2 : 0,
    clientY: hasRect ? r.top + r.height / 2 : 0,
    view: undefined, detail: 0,
  };
  firePointer(el, 'pointerover', init);
  el.dispatchEvent(withView(el, new MouseEvent('mouseover', init)));
  // mousemove：不少悬停菜单要等它才展开，不能省
  el.dispatchEvent(withView(el, new MouseEvent('mousemove', init)));
  // mouseenter/mouseleave 规范上不冒泡（真实浏览器也不冒泡），bubbles: false 对齐
  el.dispatchEvent(withView(el, new MouseEvent('mouseenter', { ...init, bubbles: false })));
}

export async function press(arg: PressArg, mods: PressMods = {}): Promise<void> {
  const spec: PressMods & { key: string } = typeof arg === 'string'
    ? { key: arg, ...mods }
    : { ...mods, ...arg };
  const target = (document.activeElement ?? document.body) as Element | null;
  if (!target) return;   // 极端情况（document 无 body）下无事可做

  target.dispatchEvent(new KeyboardEvent('keydown', keyInit(spec.key, spec)));
  // keypress 只对可打印字符发：Enter 等有专用 key 且真实浏览器对它产生 keypress
  //（旧式 UI 依赖 Enter 的 keypress 提交表单），Escape/Tab/方向键则不产生 keypress。
  // 判定取「单字符或 Enter」——中文字符 length 为 1 也会发，保守多发比漏发安全，见自审探针 4。
  if (spec.key.length === 1 || spec.key === 'Enter') {
    target.dispatchEvent(new KeyboardEvent('keypress', keyInit(spec.key, spec)));
  }
  target.dispatchEvent(new KeyboardEvent('keyup', keyInit(spec.key, spec)));
}
