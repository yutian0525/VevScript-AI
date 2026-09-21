// components/convdebug/TurnTimeline.tsx
// Task 6 最小占位：只报轮数，Task 7 会按相同签名替换成真实时间线实现。
import type { TurnTrace } from '../../storage/traces';

export function TurnTimeline({ turns }: { turns: TurnTrace[] }) {
  return <p className="convdebug__empty">共 {turns.length} 轮（时间线待实现）</p>;
}
