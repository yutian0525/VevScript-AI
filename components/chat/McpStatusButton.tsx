// components/chat/McpStatusButton.tsx
// 输入坞左下角的 MCP 状态钮（在「网页调试」右侧）：聚合色一眼看全局，点开是连接状态列表。
// 列表里能重连与禁用——SW 随时可能被回收，连接断了是常态，重连必须是随手可及的一等动作。
import { useEffect, useState } from 'react';
import { Plug, RefreshCw, Loader2 } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { useMcp } from '../../stores/mcp';
import type { McpStatusItem } from '../../shared/mcp';

type Aggregate = 'empty' | 'connected' | 'connecting' | 'error' | 'idle';

function aggregate(items: McpStatusItem[]): Aggregate {
  if (items.length === 0) return 'empty';
  const live = items.filter((i) => i.enabled);
  if (live.length === 0) return 'idle';
  if (live.some((i) => i.status === 'error')) return 'error';
  if (live.some((i) => i.status === 'connecting')) return 'connecting';
  if (live.every((i) => i.status === 'connected')) return 'connected';
  return 'idle';
}

function tipFor(agg: Aggregate, items: McpStatusItem[]): string {
  const live = items.filter((i) => i.enabled);
  const tools = items.reduce((n, i) => n + (i.enabled ? i.tools.length : 0), 0);
  switch (agg) {
    case 'empty': return 'MCP：未配置服务器（到设置页添加）';
    case 'connected': return `MCP：${live.length} 台已连接 · ${tools} 个工具可用（点击查看）`;
    case 'connecting': return 'MCP：正在连接…（点击查看）';
    case 'error': return `MCP：${live.filter((i) => i.status === 'error').length} 台连接异常（点击查看并重连）`;
    default: return `MCP：${live.length} 台未连接（点击查看）`;
  }
}

export function McpStatusButton({ disabled }: { disabled?: boolean }) {
  const items = useMcp((s) => s.items);
  const refresh = useMcp((s) => s.refresh);
  const reconnectAll = useMcp((s) => s.reconnectAll);
  const connect = useMcp((s) => s.connect);
  const setEnabled = useMcp((s) => s.setEnabled);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // 挂载拉一次列表（只读，不触发连接）；状态变化靠 store 的 MCP_STATE 广播跟随。
  useEffect(() => { void refresh(); }, [refresh]);

  // 打开即拉齐：SW 若已休眠，这次请求会唤醒它并重连启用中的服务，列表不会显示一片假「未连接」。
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      setBusy(true);
      void reconnectAll().finally(() => setBusy(false));
    }
  };

  const agg = aggregate(items);
  const tip = tipFor(agg, items);

  return (
    <div className="mcpbtn-wrap">
      <Tooltip label={tip} placement="top">
        <button
          type="button"
          className={`mcpbtn mcpbtn--${agg}`}
          aria-label={tip}
          aria-expanded={open}
          disabled={disabled}
          onClick={toggle}
        >
          {agg === 'connecting' ? <Loader2 size={14} className="spin" aria-hidden /> : <Plug size={14} aria-hidden />}
        </button>
      </Tooltip>
      {open && (
        <>
          <div className="mcppop__scrim" onClick={() => setOpen(false)} />
          <div className="mcppop" role="dialog" aria-label="MCP 连接状态">
            <div className="mcppop__head">
              <span className="mcppop__title">MCP 连接</span>
              <Tooltip label="全部重连">
                <button
                  type="button"
                  className="mcp__iconbtn"
                  aria-label="全部重连"
                  disabled={busy || items.length === 0}
                  onClick={() => { setBusy(true); void reconnectAll().finally(() => setBusy(false)); }}
                >
                  <RefreshCw size={13} className={busy ? 'spin' : undefined} />
                </button>
              </Tooltip>
            </div>
            {items.length === 0 ? (
              <div className="mcppop__empty">未配置 MCP 服务器。到「设置 → MCP 服务器」添加。</div>
            ) : (
              <div className="mcppop__list">
                {items.map((it) => (
                  <div key={it.id} className="mcprow">
                    <span className={`mcp__dot mcp__dot--${it.status}`} aria-hidden />
                    <div className="mcprow__main">
                      <div className="mcprow__title">
                        <span className="mcprow__name">{it.name}</span>
                        <span className="mcprow__count mono">
                          {it.enabled ? `${it.tools.length} 工具` : '已禁用'}
                        </span>
                      </div>
                      {it.status === 'error' && it.error && (
                        <Tooltip label={it.error}>
                          <span className="mcprow__err">{it.error}</span>
                        </Tooltip>
                      )}
                    </div>
                    <div className="mcprow__actions">
                      <Tooltip label={it.enabled ? '禁用（不再下发工具）' : '启用'}>
                        <button
                          type="button"
                          className={`switch${it.enabled ? ' switch--on' : ''}`}
                          aria-label={it.enabled ? '禁用' : '启用'}
                          aria-pressed={it.enabled}
                          onClick={() => void setEnabled(it.id, !it.enabled)}
                        >
                          <span className="switch__thumb" aria-hidden />
                        </button>
                      </Tooltip>
                      <Tooltip label="重连">
                        <button
                          type="button"
                          className="mcp__iconbtn"
                          aria-label="重连"
                          disabled={!it.enabled || it.status === 'connecting'}
                          onClick={() => void connect(it.id)}
                        >
                          <RefreshCw size={13} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
