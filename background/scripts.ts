// background/scripts.ts
// 脚本池编排层（spec §6）：CRUD（落库 + userScripts 注册同步原子完成）+ 运行态跟踪与广播。
// UI（sidepanel）与 AI 工具（agent/tools/script-pool.ts）都走本模块导出的 handler——单一数据源。
// confirmGate 拦截位：下阶段确认门控在本文件各写 handler 入口处统一拦截（pendingOps + 批准卡）。

import type { ScriptsRuntimeEntry } from '../shared/messages';
import type { UserScript } from '../shared/types';
import { listScripts } from '../storage/scripts';
import { matchUrl } from '../shared/match-pattern';

export const ENGINE_UNAVAILABLE_MSG = '脚本注入引擎不可用：请在 chrome://extensions 开启开发者模式或升级 Chrome 120+';

// ---------- 运行态跟踪（spec §6.2）----------
// 「运行中」= URL 匹配且启用的脚本（预期注入），非「实际执行成功」回执——脚本抛错仍显示运行中。
// SW 内存 map，重启丢失、下次导航/查询自重建（best-effort，与 observe-store 同哲学）。

const runtimeMap = new Map<number, ScriptsRuntimeEntry>();

export function computeRuntimeScriptIds(url: string, scripts: UserScript[]): string[] {
  if (!url) return [];
  return scripts.filter((s) => s.enabled && matchUrl(s.matches, url)).map((s) => s.id);
}

function sameEntry(a: ScriptsRuntimeEntry | undefined, b: ScriptsRuntimeEntry): boolean {
  return a != null && a.url === b.url && a.scriptIds.length === b.scriptIds.length
    && a.scriptIds.every((id, i) => id === b.scriptIds[i]);
}

function broadcastRuntime(entry: ScriptsRuntimeEntry): void {
  // 无接收方（sidepanel 未开）时 sendMessage 会 reject——fire-and-forget，吞掉即可
  void browser.runtime.sendMessage({ type: 'SCRIPTS_RUNTIME', payload: entry }).catch(() => {});
}

export async function recomputeTab(tabId: number, url: string): Promise<void> {
  const all = await listScripts();
  const entry: ScriptsRuntimeEntry = { tabId, url, scriptIds: computeRuntimeScriptIds(url, all) };
  if (sameEntry(runtimeMap.get(tabId), entry)) return;
  runtimeMap.set(tabId, entry);
  broadcastRuntime(entry);
}

export async function recomputeAllTabs(): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs
      .filter((t) => t.id != null && t.url)
      .map((t) => recomputeTab(t.id!, t.url!)),
  );
}

export function dropTab(tabId: number): void {
  runtimeMap.delete(tabId);
}

export function getRuntimeSnapshot(): ScriptsRuntimeEntry[] {
  return [...runtimeMap.values()];
}
