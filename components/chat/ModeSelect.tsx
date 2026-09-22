// components/chat/ModeSelect.tsx
// 行为模式 + 确认策略双组浮层（spec §8.3）：自绘浮层（不用原生 <select>，样式不可控）。
// 触发钮 = 模式图标（Eye/Bot）+ 权限状态文案（ask→只读；agent→档位名）+ 底色 chip，无箭头。
// Esc/点外关闭；键盘 ↑↓ + Enter 扁平跨五项（行为模式 2 + 确认策略 3）。
import { useEffect, useRef, useState } from 'react';
import { Check, Eye, Bot } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import type { AgentMode } from '../../agent/mode';
import type { ConfirmLevel } from '../../agent/permission';
import { getSettings, saveSettings } from '../../storage/settings';
import { useChat } from '../../stores/chat';
import { useConversations } from '../../stores/conversations';

const MODE_OPTIONS: Array<{ value: AgentMode; label: string; desc: string }> = [
  { value: 'agent', label: 'Agent', desc: '完整能力：可点击、填写、导航、执行脚本、管理脚本池' },
  { value: 'ask', label: 'Ask', desc: '只读问答：仅查看页面、截图、读控制台/网络/脚本，不做任何修改' },
];

const LEVEL_OPTIONS: Array<{ value: ConfirmLevel; label: string; desc: string }> = [
  { value: 'all', label: '全部询问', desc: '每个写入/执行类操作都先问你（只读动作除外）' },
  { value: 'sensitive', label: '仅敏感', desc: '只有高危操作（任意 JS、跨域请求、导航、脚本/技能池写入）需要确认' },
  { value: 'auto', label: '自动放行', desc: '全部放行不询问；可随时回此浮窗改回' },
];

type Row =
  | { kind: 'mode'; value: AgentMode }
  | { kind: 'level'; value: ConfirmLevel; disabled: boolean };

export function ModeSelect({ disabled }: { disabled?: boolean }) {
  const mode = useChat((s) => s.mode);
  const setMode = useConversations((s) => s.setMode);
  const [level, setLevel] = useState<ConfirmLevel>('sensitive');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // 挂载读已存档位；改档直写 settings（运行中 loop 每发工具现读，权威永远在 storage）
  useEffect(() => {
    let alive = true;
    void getSettings().then((s) => { if (alive) setLevel(s.agent.confirmLevel); });
    return () => { alive = false; };
  }, []);

  // 扁平行序：mode 2 项 + level 3 项（ask 下 level 禁用）
  const rows: Row[] = [
    ...MODE_OPTIONS.map((o) => ({ kind: 'mode' as const, value: o.value })),
    ...LEVEL_OPTIONS.map((o) => ({ kind: 'level' as const, value: o.value, disabled: mode === 'ask' })),
  ];

  const current = MODE_OPTIONS.find((o) => o.value === mode) ?? MODE_OPTIONS[0]!;
  const levelLabel = LEVEL_OPTIONS.find((o) => o.value === level)?.label ?? '仅敏感';
  const statusLabel = mode === 'ask' ? '只读' : levelLabel;
  const triggerTint = mode === 'ask' ? ' modeselect__trigger--ask' : level === 'auto' ? ' modeselect__trigger--auto' : '';

  // 打开时高亮当前项并滚入视野
  useEffect(() => {
    if (!open) return;
    const idx = rows.findIndex((r) => (r.kind === 'mode' ? r.value === mode : r.value === level));
    setHi(idx >= 0 ? idx : 0);
    requestAnimationFrame(() => itemRefs.current[idx >= 0 ? idx : 0]?.scrollIntoView({ block: 'nearest' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 点外关闭 + Esc/↑↓/Enter（展开态才拦，避免吃掉输入框的取消行为）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHi((v) => {
          for (let step = 1; step <= rows.length; step++) {
            const next = (v + (e.key === 'ArrowDown' ? step : rows.length - step)) % rows.length;
            const row = rows[next]!;
            if (!(row.kind === 'level' && row.disabled)) return next;
          }
          return v;
        });
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const row = rows[hi];
        if (row && !(row.kind === 'level' && row.disabled)) pick(row);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hi, mode, level]);

  const pick = (row: Row) => {
    setOpen(false);
    if (row.kind === 'mode') {
      if (row.value !== mode) setMode(row.value);
    } else {
      setLevel(row.value);
      void saveSettings({ agent: { confirmLevel: row.value } });
    }
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (open) return; // 展开态键盘交给浮层的 document 监听
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div className="modeselect" ref={rootRef}>
      <Tooltip label={`行为模式：${current.label}；确认策略：${statusLabel}${mode === 'ask' ? '（ask 只读，无需确认）' : ''}`} disabled={open}>
        <button
          type="button"
          className={`modeselect__trigger${triggerTint}`}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={onTriggerKey}
        >
          {mode === 'ask' ? <Eye size={12} /> : <Bot size={12} />}
          <span className="modeselect__label">{statusLabel}</span>
        </button>
      </Tooltip>
      {open && (
        <div className="modeselect__pop" role="listbox" aria-label="行为模式与确认策略">
          <div className="modeselect__group">行为模式</div>
          {MODE_OPTIONS.map((o, i) => (
            <button
              key={o.value}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              role="option"
              aria-selected={o.value === mode}
              className={`modeselect__opt${i === hi ? ' modeselect__opt--hi' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick({ kind: 'mode', value: o.value })}
            >
              <span className="modeselect__opt-icon">
                {o.value === 'ask' ? <Eye size={13} /> : <Bot size={13} />}
              </span>
              <span className="modeselect__opt-body">
                <span className="modeselect__opt-label">{o.label}</span>
                <span className="modeselect__opt-desc">{o.desc}</span>
              </span>
              {o.value === mode && <Check size={13} className="modeselect__opt-check" />}
            </button>
          ))}
          <div className={`modeselect__group${mode === 'ask' ? ' modeselect__group--off' : ''}`}>
            确认策略{mode === 'ask' ? '（ask 只读，无需确认）' : ''}
          </div>
          {LEVEL_OPTIONS.map((o, i) => {
            const idx = i + MODE_OPTIONS.length;
            const isCur = mode !== 'ask' && o.value === level;
            return (
              <button
                key={o.value}
                ref={(el) => { itemRefs.current[idx] = el; }}
                type="button"
                role="option"
                aria-selected={isCur}
                disabled={mode === 'ask'}
                className={`modeselect__opt${idx === hi ? ' modeselect__opt--hi' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHi(idx)}
                onClick={() => pick({ kind: 'level', value: o.value, disabled: mode === 'ask' })}
              >
                <span className="modeselect__opt-body">
                  <span className="modeselect__opt-label">{o.label}</span>
                  <span className="modeselect__opt-desc">{o.desc}</span>
                </span>
                {isCur && <Check size={13} className="modeselect__opt-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
