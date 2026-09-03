// components/popup/PopupApp.tsx
// 扩展图标 popup（spec §3）：上区导航（开侧边栏/脚本管理直达）+ 下区当前页运行中脚本。
// 点脚本 = 触发菜单命令（单条直触/多条展开/零条禁用观感），触发后浮窗关闭。
import { useEffect, useState } from 'react';
import { storage } from 'wxt/utils/storage';
import { PanelLeft, ScrollText, SquarePen } from 'lucide-react';
import { openScriptTab, sendScriptsRequest } from '../../stores/scripts';
import type { GmMenuEntry, GmErrorItem, GmConfirmItem } from '../../stores/scripts';
import type { ScriptsRuntimeEntry } from '../../shared/messages';

interface RunRow {
  scriptId: string;
  name: string;
  commands: Array<{ key: string; name: string }>;
}

/** 当前活动标签：currentWindow 取不到时退化到 lastFocusedWindow（对齐 stores/scripts refresh 惯例）。 */
async function activeTab(): Promise<{ id?: number } | undefined> {
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

export function PopupApp() {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null); // 多命令展开中的 scriptId

  // 冷读：当前 tab 运行条目 + 菜单快照（短命页面不订阅广播）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tab = await activeTab();
        const tabId = tab?.id;
        const rtResp = await sendScriptsRequest<{ ok: boolean; data?: { entry: ScriptsRuntimeEntry | null }; error?: string }>({
          type: 'SCRIPTS_GET_RUNTIME_FOR_TAB', tabId: tabId ?? -1,
        });
        const gmResp = await sendScriptsRequest<{ ok: boolean; data?: { menus: GmMenuEntry[]; errors: Record<string, GmErrorItem[]>; confirms: GmConfirmItem[] }; error?: string }>({
          type: 'SCRIPTS_GET_GM_STATE',
        });
        const listResp = await sendScriptsRequest<{ ok: boolean; data?: { scripts: Array<{ id: string; name: string }> }; error?: string }>({
          type: 'SCRIPTS_LIST',
        });
        if (cancelled) return;
        const entry = rtResp.data?.entry ?? null;
        const names = new Map((listResp.data?.scripts ?? []).map((s) => [s.id, s.name]));
        const menus = gmResp.data?.menus ?? [];
        const runRows: RunRow[] = (entry?.scriptIds ?? []).map((scriptId) => ({
          scriptId,
          name: names.get(scriptId) ?? scriptId,
          commands: menus.find((m) => m.scriptId === scriptId)?.commands ?? [],
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

  function onRowClick(row: RunRow): void {
    const only = row.commands[0];
    if (!only) return; // 零命令：禁用观感，点击无操作
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
        <div className="popup__runhead">
          <span className={`scripts-run__dot${rows.length > 0 ? '' : ' scripts-run__dot--off'}`} aria-hidden />
          <span className="mono">RUNNING · {rows.length}</span>
        </div>
        {!loaded ? (
          <div className="popup__empty">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="popup__empty">无脚本在此页运行</div>
        ) : (
          rows.map((row) => (
            <div key={row.scriptId} className="popup__runwrap">
              <div
                className="popup__runrow"
                role="button"
                tabIndex={0}
                aria-disabled={row.commands.length === 0}
                title={row.commands.length === 0 ? '无菜单命令' : row.commands.length === 1 ? `执行：${row.commands[0]?.name ?? ''}` : '展开命令列表'}
                onClick={() => onRowClick(row)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); } }}
              >
                <span className="popup__runname">{row.name}</span>
                <button
                  type="button"
                  className="popup__editbtn"
                  aria-label={`编辑 ${row.name}`}
                  title="编辑脚本"
                  onClick={(e) => { e.stopPropagation(); openScriptTab(row.scriptId); }}
                >
                  <SquarePen size={13} aria-hidden />
                </button>
              </div>
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
