// components/chat/ContextRing.tsx
// 环形上下文指示器 = 压缩按钮（设计 §3.2）。颜色即信息：normal/warn/danger 分档。
import { Loader2 } from 'lucide-react';
import { meterRatio, meterZone } from '../../agent/context-meter';

const R = 11;                       // 半径（配 28px 外框）
export const RING_CIRCUMFERENCE = 2 * Math.PI * R;

/** 已填充比例 → stroke-dashoffset（0=满，周长=空）。 */
export function dashOffset(ratio: number): number {
  return RING_CIRCUMFERENCE * (1 - ratio);
}

export function ContextRing({
  used, window, compacting, disabled, onCompact,
}: {
  used?: number;
  window: number;
  compacting: boolean;
  disabled: boolean;
  onCompact: () => void;
}) {
  const ratio = meterRatio(used, window);
  const zone = meterZone(ratio);
  const pct = Math.round(ratio * 100);
  const usedText = used != null ? `${(used / 1000).toFixed(0)}k` : '—';
  const winText = `${(window / 1000).toFixed(0)}k`;
  const tip = used != null
    ? `上下文 ${pct}% · ${usedText}/${winText} tokens · 点击压缩历史`
    : `上限 ${winText} · 点击压缩`;

  return (
    <button
      type="button"
      className={`ctxring ctxring--${zone}${disabled ? ' ctxring--disabled' : ''}`}
      title={tip}
      aria-label={tip}
      disabled={disabled || compacting}
      onClick={onCompact}
    >
      {compacting ? (
        <Loader2 size={16} className="spin" />
      ) : (
        <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
          <circle className="ctxring__track" cx="14" cy="14" r={R} fill="none" strokeWidth="2.5" />
          <circle
            className="ctxring__fill"
            cx="14" cy="14" r={R} fill="none" strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset(ratio)}
            transform="rotate(-90 14 14)"
          />
        </svg>
      )}
    </button>
  );
}
