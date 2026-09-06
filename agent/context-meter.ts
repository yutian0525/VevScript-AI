// 上下文占比与颜色档位（设计 §3.2 / §4.2）。环形指示器与 loop 自动压缩共用阈值。

/** 自动压缩触发阈值：占比达到此值时 loop 在下一轮前触发一次摘要。 */
export const COMPACT_THRESHOLD = 0.8;

/** 危险档阈值：占比达到此值时进入 danger 档位。 */
export const DANGER_THRESHOLD = 0.95;

export type MeterZone = 'normal' | 'warn' | 'danger';

/** 已用 token 占窗口比例，裁剪到 [0,1]。used 未知或 window 非法时返回 0。 */
export function meterRatio(used: number | undefined, window: number): number {
  if (used == null || window <= 0) return 0;
  const r = used / window;
  if (r < 0) return 0;
  if (r > 1) return 1;
  return r;
}

/** 占比 → 颜色档位：<80% normal / [80%,95%) warn / >=95% danger。 */
export function meterZone(ratio: number): MeterZone {
  if (ratio >= DANGER_THRESHOLD) return 'danger';
  if (ratio >= COMPACT_THRESHOLD) return 'warn';
  return 'normal';
}
