// components/ui/useTruncated.ts
// 测量单行文本是否被 text-overflow 截断，供「只有截断时才挂 title tooltip」用。
// CSS 没有「是否截断」的选择器，只能量：scrollWidth > clientWidth。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** 纯判定，便于单测。留 1px 容差避让亚像素圆整。 */
export function measureTruncated(el: Pick<HTMLElement, 'scrollWidth' | 'clientWidth'>): boolean {
  return el.scrollWidth - el.clientWidth > 1;
}

/** 返回 [ref, truncated]。内容变化（deps）与容器改宽（侧边栏可拖拽）都会重量。 */
export function useTruncated<T extends HTMLElement>(deps: unknown): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [truncated, setTruncated] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (el) setTruncated(measureTruncated(el));
  }, []);

  // 布局副作用：量完立刻定 title，避免先挂后撤的一帧闪烁
  useLayoutEffect(measure, [measure, deps]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return; // jsdom 等环境无 RO：降级为只按 deps 重量
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  return [ref, truncated];
}
