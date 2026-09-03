// components/chat/follow.ts
// 「跟随底部」的判定逻辑（纯函数，便于单测）。
//
// 为什么不能只看「当前是否贴底」：程序化滚动（点「回到底部」的 smooth 下落、流式的瞬时贴底）
// 途中每一帧都会触发 scroll 事件，而中间帧当然没贴底 —— 只看位置就会把刚打开的跟随立刻关掉，
// 流式时更甚（下落那几百毫秒里内容还在长，落点是旧的底，最后一帧留下 atBottom=false）。
//
// 改为看方向：关跟随只由「用户向上滚」触发，向下滚一律不关。于是
//   · smooth 下落全程是向下事件 → 跟随保持开着，落点短了也无妨（下一次内容变化会瞬时贴底补上）
//   · 用户上滚 → 立刻关，悬浮钮浮出
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 距底多少像素内算「贴底」：留余量，避让亚像素/圆整误差。 */
export const AT_BOTTOM_SLACK = 32;

/** 认定「用户向上滚」的最小位移：滤掉平滑动画的亚像素回摆与橡皮筋抖动。 */
const UP_EPSILON = 1;

export function isAtBottom(m: ScrollMetrics, slack = AT_BOTTOM_SLACK): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= slack;
}

/** 依据上一次位置算出下一个跟随态。向上滚 → 关；贴底 → 开；其余（向下但未到底）→ 不动。 */
export function nextFollow(prevTop: number, m: ScrollMetrics, follow: boolean): boolean {
  if (prevTop - m.scrollTop > UP_EPSILON) return false;
  if (isAtBottom(m)) return true;
  return follow;
}
