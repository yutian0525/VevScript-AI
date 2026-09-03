// components/scripts/ScriptsConfirmCard.tsx
// 批准卡（spec §11）：GM_CONFIRM_PENDING 驱动；允许一次/总是允许/拒绝 + 60s 本地倒计时（超时移除由 SW GM_CONFIRM_RESOLVED 广播驱动）。
import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import type { GmConfirmItem } from '../../stores/scripts';

export function ScriptsConfirmCard({ confirm }: { confirm: GmConfirmItem }) {
  const [left, setLeft] = useState(60);
  useEffect(() => {
    const t = setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  const decide = (decision: 'allow-once' | 'always' | 'deny') =>
    void sendScriptsRequest({ type: 'GM_CONFIRM_RESOLVE', confirmId: confirm.confirmId, decision });
  return (
    <div className="scripts-notice" role="alert">
      <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden />
      <div style={{ flex: 1 }}>
        <div>脚本请求跨域访问 <span className="mono">{confirm.host}</span></div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', wordBreak: 'break-all' }}>{confirm.url}</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <Button variant="primary" onClick={() => decide('allow-once')}>允许一次</Button>
          <Button onClick={() => decide('always')}>总是允许</Button>
          <Button variant="danger" onClick={() => decide('deny')}>拒绝（{left}s）</Button>
        </div>
      </div>
    </div>
  );
}
