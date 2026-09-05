// components/confirm/ConfirmCard.tsx
// 通用确认卡（纯展示，spec §8）：title/message/rows/actions 全部来自 props，零 @connect 语义。
// countdown 按钮跑本地倒计时（起点 createdAt + timeoutMs）；归零后由 SW 广播 CONFIRM_RESOLVED 移除。
import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import type { ConfirmRequest, ConfirmAction } from '../../shared/confirm';

function secondsLeft(confirm: ConfirmRequest): number {
  return Math.max(0, Math.ceil((confirm.createdAt + confirm.timeoutMs - Date.now()) / 1000));
}

const VARIANT: Record<NonNullable<ConfirmAction['variant']>, 'primary' | 'danger' | undefined> = {
  primary: 'primary', danger: 'danger', default: undefined,
};

export function ConfirmCard({ confirm, onDecide }: { confirm: ConfirmRequest; onDecide: (decision: string) => void }) {
  const [left, setLeft] = useState(() => secondsLeft(confirm));
  useEffect(() => {
    const t = setInterval(() => setLeft(secondsLeft(confirm)), 1000);
    return () => clearInterval(t);
  }, [confirm]);

  return (
    <div className="confirm-card" role="alertdialog" aria-label={confirm.title}>
      <div className="confirm-card__head">
        <ShieldAlert size={16} aria-hidden />
        <span className="confirm-card__title">{confirm.title}</span>
      </div>
      <p className="confirm-card__msg">{confirm.message}</p>
      <dl className="confirm-card__rows">
        {confirm.rows.map((r, i) => (
          <div className="confirm-card__row" key={i}>
            <dt>{r.label}</dt>
            <dd className={r.mono ? 'mono' : undefined}>{r.value}</dd>
          </div>
        ))}
      </dl>
      <div className="confirm-card__actions">
        {confirm.actions.map((a) => (
          <Button
            key={a.decision}
            variant={a.variant ? VARIANT[a.variant] : undefined}
            onClick={() => onDecide(a.decision)}
          >
            {a.countdown ? `${a.label}（${left}s）` : a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
