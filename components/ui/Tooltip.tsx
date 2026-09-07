// components/ui/Tooltip.tsx
// 全局 hover tooltip：替换系统原生 title（原生样式丑、不可控、有延迟）。
// 用 cloneElement 把事件/ref 挂到子元素上（不加 DOM 节点、不破坏 flex 布局与 margin-left:auto），
// 气泡经 portal 挂到 body（position:fixed），越出侧边栏窄容器不被裁切。
import {
  cloneElement,
  isValidElement,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

interface Props {
  /** 提示文本。空串/undefined 或 disabled 时不渲染气泡（子元素照常渲染）。 */
  label?: ReactNode;
  /** 首选方向；空间不足时自动翻转。默认 top。 */
  placement?: TooltipPlacement;
  /** 为 true 时只渲染子元素、不挂 tooltip（如「仅文本截断时才提示」）。 */
  disabled?: boolean;
  /** hover 到显示的延迟（ms），默以 120。移出立即隐。 */
  delay?: number;
  /** 单个可接收 ref 与事件的子元素（button / span 等）。 */
  children: ReactElement;
}

/** 视口边距：气泡水平方向 clamp 的留白。 */
const MARGIN = 8;
/** anchor 与气泡之间的间隙（含箭头）。 */
const GAP = 8;

interface Pos {
  left: number;
  top: number;
  placement: TooltipPlacement;
  /** 箭头沿交叉轴相对气泡对应边缘的偏移（top/bottom → x；left/right → y），对准 anchor 中心。 */
  arrow: number;
}

/** 合并多个 ref（cloneElement 默认覆盖子元素原 ref，需手动并联）。 */
function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): (node: T | null) => void {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') ref(node);
      else (ref as { current: T | null }).current = node;
    }
  };
}

export function Tooltip({ label, placement = 'top', disabled, delay = 120, children }: Props) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const id = useId();

  const inert = disabled || label == null || label === '';

  const clearTimer = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const show = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => setOpen(true), delay);
  }, [delay]);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
    setPos(null); // 下次显示两遍测量，避免用陈旧坐标闪一帧
  }, []);

  // 定位：量 anchor + 气泡，选方向、clamp 水平、算箭头偏移。open 后气泡先隐渲染一帧供测量。
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;
    const a = anchor.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // 方向：首选 placement，空间不足翻到对侧
    const fits = {
      top: a.top - b.height - GAP >= 0,
      bottom: a.bottom + b.height + GAP <= vh,
      left: a.left - b.width - GAP >= 0,
      right: a.right + b.width + GAP <= vw,
    };
    const opposite: Record<TooltipPlacement, TooltipPlacement> = {
      top: 'bottom', bottom: 'top', left: 'right', right: 'left',
    };
    let side: TooltipPlacement = placement;
    if (!fits[placement] && fits[opposite[placement]]) side = opposite[placement];

    let left: number;
    let top: number;
    let arrow: number;
    if (side === 'top' || side === 'bottom') {
      top = side === 'top' ? a.top - b.height - GAP : a.bottom + GAP;
      const centered = a.left + a.width / 2 - b.width / 2;
      left = Math.max(MARGIN, Math.min(centered, vw - b.width - MARGIN));
      arrow = Math.max(10, Math.min(a.left + a.width / 2 - left, b.width - 10)); // 相对气泡左缘的 x
    } else {
      left = side === 'left' ? a.left - b.width - GAP : a.right + GAP;
      const centered = a.top + a.height / 2 - b.height / 2;
      top = Math.max(MARGIN, Math.min(centered, vh - b.height - MARGIN));
      arrow = Math.max(8, Math.min(a.top + a.height / 2 - top, b.height - 8)); // 相对气泡上缘的 y
    }

    setPos({ left, top, placement: side, arrow });
  }, [open, placement, label]);

  useLayoutEffect(() => () => clearTimer(), []);

  if (!isValidElement(children)) return children;
  if (inert) return children;

  // React 19：ref 作为普通 prop 存在于 props.ref；也兼容旧的顶层 .ref
  const childProps = children.props as Record<string, unknown> & {
    onMouseEnter?: (e: unknown) => void;
    onMouseLeave?: (e: unknown) => void;
    onFocus?: (e: unknown) => void;
    onBlur?: (e: unknown) => void;
    'aria-describedby'?: string;
    ref?: Ref<HTMLElement>;
  };
  const childRef = childProps.ref ?? (children as { ref?: Ref<HTMLElement> }).ref;

  const chain = (own: () => void, theirs?: (e: unknown) => void) => (e: unknown) => {
    theirs?.(e);
    own();
  };

  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: mergeRefs(anchorRef, childRef),
    onMouseEnter: chain(show, childProps.onMouseEnter),
    onMouseLeave: chain(hide, childProps.onMouseLeave),
    onFocus: chain(show, childProps.onFocus),
    onBlur: chain(hide, childProps.onBlur),
    'aria-describedby': open
      ? [childProps['aria-describedby'], id].filter(Boolean).join(' ')
      : childProps['aria-describedby'],
  });

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            className={`tt tt--${pos?.placement ?? placement}${pos ? ' tt--ready' : ''}`}
            style={{
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              ['--tt-arrow' as string]: `${pos?.arrow ?? 0}px`,
            }}
          >
            {label}
            <span className="tt__arrow" aria-hidden />
          </div>,
          document.body,
        )}
    </>
  );
}

