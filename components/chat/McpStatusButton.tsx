// components/chat/McpStatusButton.tsx
// 输入坞左下角的 MCP 状态钮（在「网页调试」右侧）：聚合色一眼看全局，点开是连接状态列表。
// 列表里能重连与禁用——SW 随时可能被回收，连接断了是常态，重连必须是随手可及的一等动作。
//
// 浮层的定位方式与「行为模式选择器」（ModeSelect）一致：**锚在整张输入卡上、左右贴边弹出**，
// 而不是锚在那颗小钮上——钮在左下角，以它为锚时浮层会顶穿侧边栏右缘被裁掉。
import { useEffect, useState } from 'react';
import { Plug, RefreshCw, Loader2, ArrowRight } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { useMcp } from '../../stores/mcp';
import { useUi } from '../../stores/ui';
import { mcpTone, MCP_STATUS_LABEL, summarizeMcp } from '../../shared/mcp';

export function McpStatusButton({ disabled }: { disabled?: boolean }) {
  const items = useMcp((s) => s.items);
  const refresh = useMcp((s) => s.refresh);
  const reconnectAll = useMcp((s) => s.reconnectAll);
  const connect = useMcp((s) => s.connect);
  const setEnabled = useMcp((s) => s.setEnabled);
  const openSettings = useUi((s) => s.openSettings);
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

  const goConfig = () => {
    setOpen(false);
    openSettings('mcp');
  };

  const sum = summarizeMcp(items);

  return (
    <div className="mcpbtn-wrap">
      <Tooltip label={sum.tip} placement="top">
        <button
          type="button"
          className={`mcpbtn mcpbtn--${sum.tone}`}
          aria-label={sum.tip}
          aria-expanded={open}
          disabled={disabled}
          onClick={toggle}
        >
          {sum.tone === 'busy' ? <Loader2 size={14} className="spin" aria-hidden /> : <Plug size={14} aria-hidden />}
        </button>
      </Tooltip>
      {open && (
        <>
          <div className="mcppop__scrim" onClick={() => setOpen(false)} />
          <div className="mcppop" role="dialog" aria-label="MCP 连接状态">
            <div className="mcppop__head">
              <span className="token">MCP 连接</span>
              <span className={`mcppop__sum mono mcppop__sum--${sum.tone}`}>{sum.label}</span>
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

            <div className="mcppop__body">
              {items.length === 0 ? (
                <div className="mcppop__empty">
                  <span className="mcppop__empty-icon"><Plug size={15} /></span>
                  <span className="mcppop__empty-text">
                    还没有 MCP 服务器。填一个 <span className="mono">http(s)</span> 地址，就能把外部工具交给 AI 调用。
                  </span>
                </div>
              ) : (
                <div className="mcppop__list">
                  {items.map((it) => (
                    <div key={it.id} className={`mcprow${it.enabled ? '' : ' mcprow--off'}`}>
                      <div className="mcprow__title">
                        <span className={`dot mcp__dot--${mcpTone(it.status)}`} aria-hidden />
                        <span className="mcprow__name">{it.name}</span>
                        <span className={`chip mcp__chip--${mcpTone(it.status)}`}>{MCP_STATUS_LABEL[it.status]}</span>
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
                            <RefreshCw size={13} className={it.status === 'connecting' ? 'spin' : undefined} />
                          </button>
                        </Tooltip>
                      </div>
                      {it.status === 'error' && it.error ? (
                        <Tooltip label={it.error}>
                          <div className="mcprow__sub mcprow__err">{it.error}</div>
                        </Tooltip>
                      ) : it.enabled ? (
                        <div className="mcprow__sub mono">{it.tools.length} 个工具</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button type="button" className="mcppop__foot" onClick={goConfig}>
              {items.length === 0 ? '去添加服务器' : '管理 MCP 服务器'}
              <ArrowRight size={13} aria-hidden />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
