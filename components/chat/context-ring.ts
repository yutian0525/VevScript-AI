// components/chat/context-ring.ts
// 环形上下文几何工具：独立小圆环（ContextRing）的 gauge 与占比映射共用。
// 半径配 22px 小环（viewBox 22，center 11）。dashOffset 只依赖周长比例，与具体像素无关。

export const RING_RADIUS = 9;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 已填充比例 → stroke-dashoffset（0=全空=周长，1=全满=0）。 */
export function dashOffset(ratio: number): number {
  return RING_CIRCUMFERENCE * (1 - ratio);
}
