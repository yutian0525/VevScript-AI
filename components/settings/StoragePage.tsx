// components/settings/StoragePage.tsx
// 存储管理二级页（spec §4）：用量总览 / 清理可再生数据 / 备份导出导入。统计经 bg 统一算。
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { sendStorageRequest } from '../../stores/ui';
import type { StorageCleanScope, StorageGroupKey, StorageUsage } from '../../shared/messages';

const GROUP_LABELS: Record<StorageGroupKey, string> = {
  conv: '会话本体', trace: 'Agent 调用记录', scripts: '脚本池', skills: '技能',
  memory: '记忆', settings: '设置（含密钥）', 'gm-resources': 'GM 资源缓存',
  'gm-auth': 'GM 授权', 'gm-values': 'GM 脚本值', 'update-state': '更新状态', other: '其它',
};

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function StoragePage({ onBack }: { onBack: () => void }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await sendStorageRequest<{ ok: boolean; data?: StorageUsage }>({ type: 'STORAGE_USAGE_GET' });
      if (resp?.ok && resp.data) setUsage(resp.data);
    } catch { /* 无 handler（如纯 UI 测试环境）静默，列表留空 */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const [traceSel, setTraceSel] = useState<Set<string>>(new Set());

  const doClean = useCallback(async (scope: StorageCleanScope) => {
    await sendStorageRequest({ type: 'STORAGE_CLEAN', scope });
    setTraceSel(new Set());
    await refresh();
  }, [refresh]);

  const maxBytes = usage?.groups[0]?.bytes ?? 0; // groups 已按字节降序，首个即最大域

  return (
    <PageShell title="存储管理" eyebrow="STORAGE" onBack={onBack} backLabel="返回设置">
      <section className="section">
        <h2 className="section__title">用量总览</h2>
        <div className="stor__total">
          <span>全部持久数据</span>
          <span className="mono">{usage ? fmtBytes(usage.totalBytes) : '…'}</span>
          <button type="button" className="btn btn--icon" aria-label="刷新统计" onClick={() => void refresh()}>
            <RefreshCw size={14} strokeWidth={1.8} className={loading ? 'spin' : undefined} />
          </button>
        </div>
        <div className="stor__rows">
          {usage?.groups.map((g) => (
            <div key={g.group} className="stor__row">
              <span className="stor__row-label">{GROUP_LABELS[g.group]}</span>
              {g.items != null && <span className="stor__row-items mono">{g.items} 项</span>}
              <span className="stor__bar" aria-hidden>
                <span className="stor__bar-fill" style={{ width: maxBytes ? `${Math.max(2, (g.bytes / maxBytes) * 100)}%` : '0%' }} />
              </span>
              <span className="stor__row-bytes mono">{fmtBytes(g.bytes)}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="section">
        <h2 className="section__title">清理（可再生数据）</h2>
        <div className="stor__rows">
          <div className="stor__row">
            <span className="stor__row-label">GM 资源缓存
              <span className="stor__row-items mono"> · {usage?.gmResources.count ?? 0} 项 · {usage ? fmtBytes(usage.gmResources.bytes) : ''}</span>
            </span>
            <ConfirmButton label="清空缓存" confirmLabel="确认清空？" onConfirm={() => void doClean({ kind: 'gm-resources' })} />
          </div>
          <div className="stor__trace-block">
            <div className="stor__row">
              <span className="stor__row-label">Agent 调用记录（清理后会话调试页对应记录消失）</span>
              <ConfirmButton
                label={traceSel.size ? '清理选中' : '全部清理'}
                confirmLabel="确认清理？"
                onConfirm={() => void doClean(traceSel.size ? { kind: 'trace', convIds: [...traceSel] } : { kind: 'trace' })}
              />
            </div>
            {usage?.traces.map((t) => (
              <label key={t.convId} className="stor__trace-row">
                <input
                  type="checkbox"
                  aria-label={t.title ?? t.convId}
                  checked={traceSel.has(t.convId)}
                  onChange={(e) => {
                    const next = new Set(traceSel);
                    if (e.target.checked) next.add(t.convId); else next.delete(t.convId);
                    setTraceSel(next);
                  }}
                />
                <span className="stor__row-label">{t.title ?? t.convId}</span>
                <span className="stor__row-bytes mono">{fmtBytes(t.bytes)}</span>
              </label>
            ))}
            {usage && usage.traces.length === 0 && <div className="stor__empty">暂无调用记录</div>}
          </div>
        </div>
      </section>
    </PageShell>
  );
}

/** 行内二次确认按钮（spec §4.2）：首点武装变 confirmLabel，5s 超时还原；再点执行。 */
function ConfirmButton({ label, confirmLabel, onConfirm }: { label: string; confirmLabel: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={`btn ${armed ? 'btn--danger' : ''}`}
      onClick={() => {
        if (armed) { setArmed(false); onConfirm(); } else { setArmed(true); }
      }}
    >
      <Trash2 size={14} strokeWidth={1.8} aria-hidden />
      {armed ? confirmLabel : label}
    </button>
  );
}
