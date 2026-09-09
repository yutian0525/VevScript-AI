// components/detail/DetailSettingsTab.tsx
// 设置 Tab：模型调用权限档（三选一）+ XHR 安全（授权域名查看/撤销）。
import { useEffect, useState } from 'react';
import { Undo2, ShieldOff } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import { DetailTabHeader } from './DetailTabHeader';
import { DetailEmptyCard } from './DetailEmptyCard';

type LlmTier = 'ask' | 'allow' | 'deny';

const TIER_OPTIONS: Array<{ value: LlmTier; label: string; hint: string }> = [
  { value: 'ask', label: '每次询问', hint: '每次调用弹确认卡（默认）' },
  { value: 'allow', label: '始终允许', hint: '不弹卡直接放行' },
  { value: 'deny', label: '始终拒绝', hint: '调用直接报错' },
];

export function DetailSettingsTab({ id }: { id: string }) {
  const [hosts, setHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [tier, setTier] = useState<LlmTier>('ask');
  const [tierBusy, setTierBusy] = useState(false);

  async function pull(): Promise<void> {
    setLoading(true);
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { hosts: string[] }; error?: string }>({
        type: 'SCRIPTS_GET_PERMISSIONS', id,
      });
      setHosts(resp.ok ? resp.data?.hosts ?? [] : []);
      const t = await sendScriptsRequest<{ ok: boolean; data?: { tier: LlmTier }; error?: string }>({
        type: 'SCRIPTS_GET_LLM_TIER', id,
      });
      if (t.ok && t.data) setTier(t.data.tier);
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

  async function changeTier(next: LlmTier): Promise<void> {
    setTierBusy(true);
    setMessage('');
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; error?: string }>({ type: 'SCRIPTS_SET_LLM_TIER', id, tier: next });
      if (resp.ok) setTier(next);
      else setMessage(resp.error ?? '设置失败');
    } catch {
      setMessage('设置失败');
    } finally {
      setTierBusy(false);
    }
  }

  return (
    <div className="detail__info">
      <DetailTabHeader
        title="模型调用"
        hint="脚本调用大模型（GM_llmChat）的权限档。「始终允许/拒绝」立即生效；改档会同时清除已给的「本会话内允许」授权。"
      />
      {message && <div className="scripts-warnline" role="status">{message}</div>}
      <div className="detail__hostlist">
        {TIER_OPTIONS.map((opt) => (
          <div key={opt.value} className="detail__hostrow" style={tier === opt.value ? { borderColor: 'var(--signal)' } : undefined}>
            <span>
              <span style={{ fontWeight: 500 }}>{opt.label}</span>
              <span style={{ color: 'var(--ink-3)', marginLeft: 8, fontSize: 12 }}>{opt.hint}</span>
            </span>
            <Button
              variant={tier === opt.value ? 'primary' : 'ghost'}
              disabled={tierBusy || tier === opt.value}
              onClick={() => void changeTier(opt.value)}
            >
              {tier === opt.value ? '当前' : '选用'}
            </Button>
          </div>
        ))}
      </div>

      <DetailTabHeader
        title="XHR 安全"
        hint="这些域名已获得该脚本的跨域请求授权（在确认卡点「总是允许」时记录）；撤销后，脚本再请求这些域名会重新弹确认。"
      />
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
