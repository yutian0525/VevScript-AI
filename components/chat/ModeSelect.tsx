// components/chat/ModeSelect.tsx
// 行为模式下拉（ask/agent）：自绘浮层（不用原生 <select>，样式不可控）。
// 展开态浮层与 slash-menu 同视觉语言；Esc/点外关闭；键盘 ↑↓ + Enter 可选。
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Eye, Bot } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import type { AgentMode } from '../../agent/mode';
import { useChat } from '../../stores/chat';
import { useConversations } from '../../stores/conversations';

const OPTIONS: Array<{ value: AgentMode; label: string; desc: string }> = [
  { value: 'agent', label: 'Agent', desc: '完整能力：可点击、填写、导航、执行脚本、管理脚本池' },
  { value: 'ask', label: 'Ask', desc: '只读问答：仅查看页面、截图、读控制台/网络/脚本，不做任何修改' },
];

export function ModeSelect({ disabled }: { disabled?: boolean }) {
  const mode = useChat((s) => s.mode);
  const setMode = useConversations((s) => s.setMode);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const current = OPTIONS.find((o) => o.value === mode) ?? OPTIONS[0]!;

  // 打开时高亮当前项并滚入视野
  useEffect(() => {
    if (!open) return;
    const idx = OPTIONS.findIndex((o) => o.value === mode);
    setHi(idx >= 0 ? idx : 0);
    // 浮层在下一帧才挂载，等一拍再滚
    requestAnimationFrame(() => itemRefs.current[idx >= 0 ? idx : 0]?.scrollIntoView({ block: 'nearest' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 点外关闭 + Esc 关闭（展开态才拦 Esc，避免吃掉输入框的取消行为）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const select = (v: AgentMode) => {
    setOpen(false);
    if (v !== mode) setMode(v);
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
      <Tooltip label={`行为模式：${current.label} — ${current.desc}`} disabled={open}>
        <button
          type="button"
          className={`modeselect__trigger${mode === 'ask' ? ' modeselect__trigger--ask' : ''}`}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={onTriggerKey}
        >
          {mode === 'ask' ? <Eye size={12} /> : <Bot size={12} />}
          <span className="modeselect__label">{current.label}</span>
          <ChevronDown size={12} className={`modeselect__chev${open ? ' modeselect__chev--open' : ''}`} />
        </button>
      </Tooltip>
      {open && (
        <div className="modeselect__pop" role="listbox" aria-label="行为模式">
          {OPTIONS.map((o, i) => (
            <button
              key={o.value}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              role="option"
              aria-selected={o.value === mode}
              className={`modeselect__opt${i === hi ? ' modeselect__opt--hi' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHi(i)}
              onClick={() => select(o.value)}
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
        </div>
      )}
    </div>
  );
}
