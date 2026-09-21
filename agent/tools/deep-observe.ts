// agent/tools/deep-observe.ts
// 深度观测（CDP）开关工具（设计 §4.1）。无参数，作用于 agent 当前标签页。
// 授权模型：直接附着，Chrome 信息条即提示与撤销入口（spec 决策 2）——不弹确认卡。
import type { ToolResult } from '../../shared/types';
import { attach, detach, getState } from '../../background/cdp/session';

export async function doEnableDeepObserve(tabId: number): Promise<ToolResult> {
  const r = await attach(tabId);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: { tabId, status: r.state.status } };
}

export async function doDisableDeepObserve(tabId: number): Promise<ToolResult> {
  await detach(tabId);
  return { ok: true, data: { tabId, status: getState(tabId).status } };
}
