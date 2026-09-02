// components/ui/Gauge.tsx
// Live 仪表条（签名元素）：信号点 + mono 状态令牌，颜色即信息。

type GaugeState = 'idle' | 'running' | 'paused';

const LABEL: Record<GaugeState, string> = {
  idle: 'IDLE',
  running: 'RUNNING',
  paused: 'PAUSED',
};

export function Gauge({ state }: { state: GaugeState }) {
  return (
    <span className={`gauge gauge--${state}`} role="status" aria-live="polite">
      <span className={`dot dot--${state}`} />
      <span className="gauge__label">{LABEL[state]}</span>
    </span>
  );
}
