// components/chat/ContextRing.tsx
// 独立小圆环 = 上下文占比指示器 ⊕ 压缩按钮（设计 §3.2）。放发送钮左侧。
// 颜色即信息：normal/warn/danger 分档；hover 出详情，点击压缩历史。
import { Loader2 } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { meterRatio, meterZone } from '../../agent/context-meter';
import { RING_CIRCUMFERENCE, RING_RADIUS, dashOffset } from './context-ring';

export function ContextRing({
  used, windowSize, compacting, disabled, onCompact,
}: {
  used?: number;
  windowSize: number;
  compacting: boolean;
  disabled: boolean;
  onCompact: () => void;
}) {
  const ratio = meterRatio(used, windowSize);
  const zone = meterZone(ratio);
  const pct = Math.round(ratio * 100);
  const usedText = used != null ? `${(used / 1000).toFixed(0)}k` : '—';
  const winText = `${(windowSize / 1000).toFixed(0)}k`;
  const tip = used != null
    ? `上下文 ${pct}% · ${usedText}/${winText} tokens · 点击压缩历史`
    : `上下文上限 ${winText} · 点击压缩`;

  return (
    <Tooltip label={tip} placement="top">
      <button
        type="button"
        className={`ctxring ctxring--${zone}${disabled ? ' ctxring--disabled' : ''}`}
        aria-label={tip}
        disabled={disabled || compacting}
        onClick={onCompact}
      >
        {compacting ? (
          <Loader2 size={13} className="spin" />
        ) : (
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
            <circle className="ctxring__track" cx="11" cy="11" r={RING_RADIUS} fill="none" strokeWidth="2" />
            <circle
              className="ctxring__fill"
              cx="11" cy="11" r={RING_RADIUS} fill="none" strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={dashOffset(ratio)}
              transform="rotate(-90 11 11)"
            />
          </svg>
        )}
      </button>
    </Tooltip>
  );
}
