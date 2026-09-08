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

/** 等一帧让布局稳定。rAF 不可用（jsdom 部分配置）时退回微延时。 */
function raf(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** 元素简要信息（进错误诊断）。 */
export function briefOf(el: Element): Record<string, unknown> {
  const cls = el.getAttribute('class')?.trim();
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

  (el as HTMLElement).scrollIntoView?.({ block: 'center' });
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
