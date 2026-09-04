// components/detail/DetailSettingsTab.tsx
// 设置 Tab：XHR 安全 = 「总是允许」域名名单查看 + 逐条撤销（校验语义不动）。
import { useEffect, useState } from 'react';
import { Undo2, ShieldOff } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import { DetailTabHeader } from './DetailTabHeader';
import { DetailEmptyCard } from './DetailEmptyCard';

export function DetailSettingsTab({ id }: { id: string }) {
  const [hosts, setHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  async function pull(): Promise<void> {
    setLoading(true);
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { hosts: string[] }; error?: string }>({
        type: 'SCRIPTS_GET_PERMISSIONS', id,
      });
      setHosts(resp.ok ? resp.data?.hosts ?? [] : []);
    } catch {
      setHosts([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void pull(); }, [id]);

  async function revoke(host: string): Promise<void> {
    setMessage('');
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; error?: string }>({ type: 'SCRIPTS_REVOKE_PERMISSION', id, host });
      if (resp.ok) await pull();
      else setMessage(resp.error ?? `撤销 ${host} 失败`);
    } catch {
      setMessage(`撤销 ${host} 失败`);
    }
  }

  return (
    <div className="detail__info">
      <DetailTabHeader
        title="XHR 安全"
        hint="这些域名已获得该脚本的跨域请求授权（在确认卡点「总是允许」时记录）；撤销后，脚本再请求这些域名会重新弹确认。"
      />
      {message && <div className="scripts-warnline" role="status">{message}</div>}
      {loading ? (
        <div className="chat__empty">加载中…</div>
      ) : hosts.length === 0 ? (
        <DetailEmptyCard icon={ShieldOff} title="无已授权域名" hint="脚本请求跨域时将逐次询问" />
      ) : (
        <div className="detail__hostlist">
          {hosts.map((h) => (
            <div key={h} className="detail__hostrow">
              <span className="mono">{h}</span>
              <Button variant="ghost" aria-label={`撤销 ${h}`} onClick={() => void revoke(h)}>
                <Undo2 size={13} /> 撤销
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
