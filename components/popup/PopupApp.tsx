// components/popup/PopupApp.tsx
// 扩展图标 popup（spec §3）：上区导航（开侧边栏/脚本管理直达）+ 下区当前页运行中脚本。
// 点脚本 = 触发菜单命令（单条直触/多条展开/零条禁用观感），触发后浮窗关闭。
import { useEffect, useState } from 'react';
import { storage } from 'wxt/utils/storage';
import { PanelLeft, ScrollText, SquarePen } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { openScriptTab, sendScriptsRequest } from '../../stores/scripts';
import type { GmMenuEntry, GmErrorItem } from '../../stores/scripts';
import type { ScriptsRuntimeEntry } from '../../shared/messages';
import { matchUrl } from '../../shared/match-pattern';

interface RunRow {
  scriptId: string;
  name: string;
  commands: Array<{ key: string; name: string }>;
}

/** 当前活动标签：currentWindow 取不到时退化到 lastFocusedWindow（对齐 stores/scripts refresh 惯例）。 */
async function activeTab(): Promise<{ id?: number; url?: string } | undefined> {
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

export function PopupApp() {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null); // 多命令展开中的 scriptId
  // 启停开关状态：冷读页不订阅广播，本地 optimistic 覆盖（undefined = 未动过，用默认开）
  const [enabledIds, setEnabledIds] = useState<Map<string, boolean>>(new Map());

  // 冷读：当前 tab 运行条目 + 菜单快照（短命页面不订阅广播）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tab = await activeTab();
        const tabId = tab?.id;
        const url = tab?.url ?? '';
        const rtResp = await sendScriptsRequest<{ ok: boolean; data?: { entry: ScriptsRuntimeEntry | null }; error?: string }>({
          type: 'SCRIPTS_GET_RUNTIME_FOR_TAB', tabId: tabId ?? -1,
        });
        const gmResp = await sendScriptsRequest<{ ok: boolean; data?: { menus: GmMenuEntry[]; errors: Record<string, GmErrorItem[]> }; error?: string }>({
          type: 'SCRIPTS_GET_GM_STATE',
        });
        const listResp = await sendScriptsRequest<{ ok: boolean; data?: { scripts: Array<{ id: string; name: string; enabled: boolean; matches?: string[] }> }; error?: string }>({
          type: 'SCRIPTS_LIST',
        });
        if (cancelled) return;
        const entry = rtResp.data?.entry ?? null;
        const listed = listResp.data?.scripts ?? [];
        setEnabledIds(new Map(listed.map((s) => [s.id, s.enabled])));
        const menus = gmResp.data?.menus ?? [];
        // 行集合 = 已注入（运行中）∪ 匹配当前页 URL 的脚本（含被禁用的——供一键启用）
        const injected = new Set(entry?.scriptIds ?? []);
        const runRows: RunRow[] = listed
          .filter((s) => injected.has(s.id) || matchUrl(s.matches ?? [], url))
          .map((s) => ({
            scriptId: s.id,
            name: s.name,
            commands: menus.find((m) => m.scriptId === s.id)?.commands ?? [],
          }));
        setRows(runRows);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function openSidepanel(): Promise<void> {
    const tab = await activeTab();
    if (tab?.id != null) await browser.sidePanel.open({ tabId: tab.id });
  }

  async function gotoScripts(): Promise<void> {
    // 双通道保时序：storage.session 待航标记（侧边栏挂载消费）+ 实时广播（侧边栏已开时立即切换）
    await storage.setItem('session:ui:pendingView', 'scripts');
    await browser.runtime.sendMessage({ type: 'UI_NAV', view: 'scripts' }).catch(() => {});
    await openSidepanel();
  }

  async function invoke(scriptId: string, key: string): Promise<void> {
    await sendScriptsRequest({ type: 'SCRIPTS_MENU_INVOKE', scriptId, key });
    window.close(); // 触发后浮窗关闭（用户决策 B）
  }

  async function setEnabled(scriptId: string, enabled: boolean): Promise<void> {
    // 冷读页不维护 summaries，启停结果下次打开 popup 自然刷新
    await sendScriptsRequest({ type: 'SCRIPTS_SET_ENABLED', id: scriptId, enabled }).catch(() => {});
  }

  function onRowClick(row: RunRow): void {
    const only = row.commands[0];
    if (!only) return; // 零命令：点击行本体无操作（可正常 hover 进详情编辑）
    if (row.commands.length === 1) void invoke(row.scriptId, only.key);
    else setExpanded(expanded === row.scriptId ? null : row.scriptId);
  }

  return (
    <div className="popup">
      <div className="popup__nav">
        <button className="popup__navbtn" onClick={() => void openSidepanel()}>
          <PanelLeft size={15} aria-hidden /> 打开侧边栏
        </button>
        <button className="popup__navbtn" onClick={() => void gotoScripts()}>
          <ScrollText size={15} aria-hidden /> 脚本管理
        </button>
      </div>
      <div className="popup__run">
        {!loaded ? (
          <div className="popup__empty popup__empty--center">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="popup__empty popup__empty--center">无脚本在此页运行</div>
        ) : (
          rows.map((row) => (
            <div key={row.scriptId} className="popup__runwrap">
              <Tooltip label={row.commands.length === 0 ? '无菜单命令' : row.commands.length === 1 ? `执行：${row.commands[0]?.name ?? ''}` : '展开命令列表'}>
                <div
                  className="popup__runrow"
                  role="button"
                  tabIndex={0}
                  onClick={() => onRowClick(row)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); } }}
                >
                  <span className="popup__runname">{row.name}</span>
                  <Tooltip label="编辑脚本">
                    <button
                      type="button"
                      className="popup__editbtn"
                      aria-label={`编辑 ${row.name}`}
                      onClick={(e) => { e.stopPropagation(); openScriptTab(row.scriptId); }}
                    >
                      <SquarePen size={13} aria-hidden />
                    </button>
                  </Tooltip>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabledIds.get(row.scriptId) ?? true}
                    aria-label={`${enabledIds.get(row.scriptId) ?? true ? '禁用' : '启用'} ${row.name}`}
                    className={`switch${enabledIds.get(row.scriptId) ?? true ? ' switch--on' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = !(enabledIds.get(row.scriptId) ?? true);
                      setEnabledIds((prev) => new Map(prev).set(row.scriptId, next));
                      void setEnabled(row.scriptId, next);
                    }}
                  >
                    <span className="switch__thumb" aria-hidden />
                  </button>
                </div>
              </Tooltip>
              {expanded === row.scriptId && row.commands.length > 1 && (
                <div className="popup__cmdlist">
                  {row.commands.map((c) => (
                    <button
                      key={c.key}
                      className="popup__cmdbtn"
                      onClick={() => void invoke(row.scriptId, c.key)}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
