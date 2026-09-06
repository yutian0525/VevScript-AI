// components/confirm/confirm-reducer.ts
// hub 页「事件 → 状态」纯函数（可测）：CONFIRM_PENDING 幂等追加，CONFIRM_RESOLVED 移除。
import type { ConfirmRequest, ConfirmPendingEvent, ConfirmResolvedEvent } from '../../shared/confirm';

type ConfirmEvent = ConfirmPendingEvent | ConfirmResolvedEvent;

export function applyConfirmEvent(state: ConfirmRequest[], event: ConfirmEvent): ConfirmRequest[] {
  if (event.type === 'CONFIRM_PENDING') {
    if (state.some((c) => c.confirmId === event.confirm.confirmId)) return state;
    return [...state, event.confirm];
  }
  if (event.type === 'CONFIRM_RESOLVED') {
    return state.filter((c) => c.confirmId !== event.confirmId);
  }
  return state;
}
