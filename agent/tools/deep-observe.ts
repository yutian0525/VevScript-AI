// agent/tools/deep-observe.ts
// 深度观测（CDP）开关工具（设计 §4.1）：单工具带 enabled 布尔，形状对齐 toggle_script。
// 授权模型：直接附着，Chrome 信息条即提示与撤销入口（spec 决策 2）——不弹确认卡。
import type { ToolResult } from '../../shared/types';
import { attach, detach, getState } from '../../background/cdp/session';

export async function doToggleDeepObserve(tabId: number, enabled: boolean): Promise<ToolResult> {
  if (!enabled) {
    await detach(tabId);
    return { ok: true, data: { tabId, status: getState(tabId).status } };
  }
  const r = await attach(tabId);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: { tabId, status: r.state.status } };
}
