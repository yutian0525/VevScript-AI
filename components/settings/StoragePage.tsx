// components/settings/StoragePage.tsx
// 存储管理二级页（spec §4）：用量总览 / 清理可再生数据 / 备份导出导入。统计经 bg 统一算。
import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw, Trash2 } from 'lucide-react';
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
  const [notice, setNotice] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await sendStorageRequest<{ ok: boolean; data?: StorageUsage }>({ type: 'STORAGE_USAGE_GET' });
      if (resp?.ok && resp.data) setUsage(resp.data);
    } catch (e) {
      setNotice({ text: `统计读取失败：${e instanceof Error ? e.message : String(e)}`, kind: 'err' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const [traceSel, setTraceSel] = useState<Set<string>>(new Set());

  const doClean = useCallback(async (scope: StorageCleanScope) => {
    try {
      const resp = await sendStorageRequest<{ ok: boolean; error?: string }>({ type: 'STORAGE_CLEAN', scope });
      if (!resp?.ok) throw new Error(resp?.error ?? '清理失败');
      setTraceSel(new Set());
    } catch (e) {
      setNotice({ text: `清理失败：${e instanceof Error ? e.message : String(e)}`, kind: 'err' });
    } finally {
      await refresh(); // 失败也刷新一次统计，让数字对得上现状
    }
  }, [refresh]);

  const [includeKey, setIncludeKey] = useState(false);
  const [busy, setBusy] = useState<'' | 'export' | 'import'>('');
  const [pending, setPending] = useState<{ name: string; text: string } | null>(null);

  const doExport = async () => {
    setBusy('export'); setNotice(null);
    try {
      const resp = await sendStorageRequest<{ ok: boolean; data?: { filename: string; dataUrl: string }; error?: string }>({
        type: 'STORAGE_EXPORT', includeApiKey: includeKey,
      });
      if (!resp?.ok || !resp.data) throw new Error(resp?.error ?? '导出失败');
      await browser.downloads.download({ url: resp.data.dataUrl, filename: resp.data.filename });
      setNotice({ text: `已导出 ${resp.data.filename}`, kind: 'ok' });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), kind: 'err' });
    } finally {
      setBusy('');
    }
  };

  const onPickFile = async (f: File | undefined) => {
    if (!f) return;
    setNotice(null);
    setPending({ name: f.name, text: await f.text() });
  };

  const doImport = async () => {
    if (!pending) return;
    setBusy('import');
    try {
      const resp = await sendStorageRequest<{ ok: boolean; data?: { apiKeyMissing: boolean }; error?: string }>({
        type: 'STORAGE_IMPORT', payload: pending.text,
      });
      if (!resp?.ok || !resp.data) throw new Error(resp?.error ?? '导入失败');
      setNotice({
        text: resp.data.apiKeyMissing
          ? '导入完成，即将重载（备份未含 API Key，重载后请到模型设置重填）'
          : '导入完成，即将重载',
        kind: 'ok',
      });
      setPending(null);
      setTimeout(() => browser.runtime.reload(), 1200);
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), kind: 'err' });
      setPending(null);
    } finally {
      setBusy('');
    }
  };

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
      <section className="section">
        <h2 className="section__title">备份</h2>
        <div className="stor__rows">
          <div className="stor__row">
            <label className="stor__row-label stor__check">
              <input type="checkbox" checked={includeKey} onChange={(e) => setIncludeKey(e.target.checked)} />
              包含模型 API Key（默认不勾，勾选后导出文件含明文密钥，请妥善保管）
            </label>
            <button type="button" className="btn" onClick={() => void doExport()} disabled={busy !== ''}>
              <Download size={14} strokeWidth={1.8} aria-hidden /> {busy === 'export' ? '导出中…' : '导出全部数据'}
            </button>
          </div>
          <div className="stor__row">
            <span className="stor__row-label">导入 = 全量替换当前数据（当前数据会先自动留存到下载目录）</span>
            <input
              data-testid="stor-import-input"
              type="file"
              accept=".json,application/json"
              className="stor__file"
              onChange={(e) => { void onPickFile(e.target.files?.[0]); e.target.value = ''; }}
            />
          </div>
          {pending && (
            <div className="stor__confirm">
              <span>将导入 <span className="mono">{pending.name}</span>：确认后当前数据先留存、再整体替换，完成后自动重载。备份内含的脚本池与 GM 授权会一并恢复并直接生效——只导入你信任来源的文件。</span>
              <div className="stor__confirm-actions">
                <button type="button" className="btn btn--danger" onClick={() => void doImport()} disabled={busy !== ''}>
                  {busy === 'import' ? '导入中…' : '确认导入'}
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setPending(null)}>取消</button>
              </div>
            </div>
          )}
          {notice && (
            <div className={`status-text ${notice.kind === 'err' ? 'status-text--err' : 'status-text--ok'}`}>{notice.text}</div>
          )}
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
