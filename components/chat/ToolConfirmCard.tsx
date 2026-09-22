// components/chat/ToolConfirmCard.tsx
// 会话流内工具确认卡（spec §8.2）：单卡双态的「待确认」态。决策后由 tool-start/tool-end
// 事件权威翻转；本组件不持有决策权威，点击即发消息并本地锁定防双击。倒计时归零只显示状态。
import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import { SENSITIVE_TOOLS } from '../../agent/permission';

export type ConfirmDecision = 'allow' | 'allow-session' | 'deny';

function secondsLeft(until: number): number {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

export function ToolConfirmCard({ name, args, until, disabled, onDecide }: {
  name: string;
  args?: string;
  until: number;
  disabled?: boolean;
  onDecide: (decision: ConfirmDecision) => void;
}) {
  const [left, setLeft] = useState(() => secondsLeft(until));
  useEffect(() => {
    const t = setInterval(() => setLeft(secondsLeft(until)), 1000);
    return () => clearInterval(t);
  }, [until]);
  const [decided, setDecided] = useState(false);
  const lock = disabled || decided;

  return (
    <div className="toolconfirm" role="alertdialog" aria-label={`工具确认：${name}`}>
      <div className="toolconfirm__head">
        <ShieldAlert size={14} aria-hidden />
        <span className="mono toolconfirm__name">{name}</span>
        <span className="token toolconfirm__risk">{SENSITIVE_TOOLS.has(name) ? '敏感' : '写入'}</span>
        <span className="mono toolconfirm__left">{left > 0 ? `${left}s` : '已超时'}</span>
      </div>
      {args && <div className="well toolconfirm__args">{args}</div>}
      <div className="toolconfirm__actions">
        <Button variant="primary" disabled={lock} onClick={() => { setDecided(true); onDecide('allow'); }}>允许执行</Button>
        <Button disabled={lock} onClick={() => { setDecided(true); onDecide('allow-session'); }}>本次会话总是允许</Button>
        <Button variant="danger" disabled={lock} onClick={() => { setDecided(true); onDecide('deny'); }}>拒绝</Button>
      </div>
    </div>
  );
}
