// components/settings/HookExclusionsPage.tsx
// 敏感站点排除管理页（spec 2026-09-08 §3.4）：命中名单的站点不注入 MAIN world 观测 hook。
// 保存即生效（每次增删直调 SAVE，无独立保存钮）；已打开页面需刷新才生效。
import { useEffect, useState } from 'react';
import { Plus, Trash2, RotateCcw } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { isValidMatchPattern } from '../../shared/match-pattern';
import { sendHookExclusionsRequest } from '../../stores/hook-exclusions';
import type { HookExclusionsData } from '../../shared/messages';

export function HookExclusionsPage({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<HookExclusionsData>({ patterns: [], defaults: [] });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // 回调先于 useEffect 声明：effect 在 render 后才跑无 TDZ，但顺序更清晰、免 use-before-declare 告警。
  const refresh = async (): Promise<void> => {
    const resp = await sendHookExclusionsRequest<{ ok: boolean; data?: HookExclusionsData; error?: string }>({ type: 'HOOK_EXCLUSIONS_GET' });
    if (resp.ok && resp.data) setData(resp.data);
  };

  const save = async (patterns: string[]): Promise<boolean> => {
    setError(null); setWarning(null);
    const resp = await sendHookExclusionsRequest<{ ok: boolean; data?: HookExclusionsData & { warnings?: string[] }; error?: string }>({
      type: 'HOOK_EXCLUSIONS_SAVE', patterns,
    });
    if (!resp.ok) { setError(resp.error ?? '保存失败'); return false; }
    if (resp.data) setData({ patterns: resp.data.patterns, defaults: resp.data.defaults });
    if (resp.data?.warnings?.length) setWarning(resp.data.warnings[0] ?? null);
    return true;
  };

  const add = async (): Promise<void> => {
    const p = draft.trim();
    if (!p) return;
    if (!isValidMatchPattern(p)) { setError(`非法 match pattern：${p}`); return; }
    if (data.patterns.includes(p)) { setError(`已在名单中：${p}`); return; }
    if (await save([...data.patterns, p])) setDraft('');
  };

  const remove = async (p: string): Promise<void> => {
    await save(data.patterns.filter((x) => x !== p));
  };

  const reset = async (): Promise<void> => {
    await save(data.defaults);
  };

  useEffect(() => { void refresh(); }, []);

  const customCount = data.patterns.filter((p) => !data.defaults.includes(p)).length;

  return (
    <PageShell title="敏感站点排除" eyebrow="HOOK" onBack={onBack}>
      <section className="section">
        <h2 className="section__title">排除名单</h2>
        <p className="hx-notice">
          命中名单的站点不注入 MAIN world 观测 hook，消除扩展指纹——Boss直聘等风控站检测到包装痕迹会拒绝打开。
          保存后需<b>刷新已打开的页面</b>才生效；该站 console 观测失效、网络请求/响应 body 不可用；自己的用户脚本不受此名单约束。
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <Input
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
            placeholder="*://*.example.com/*"
            className="mono-input"
            aria-label="新增排除 pattern"
          />
          <Button onClick={() => void add()}><Plus size={14} /> 添加</Button>
        </div>
        {error && <div className="status-text status-text--err" style={{ marginTop: 6 }}>{error}</div>}
        {warning && <div className="status-text" style={{ marginTop: 6, color: 'var(--warn)' }}>{warning}</div>}

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 14, marginBottom: 6 }}>
          <span className="hx-count">PATTERNS · {data.patterns.length}</span>
          {customCount > 0 && <span className="hx-count">+{customCount} 自定义</span>}
        </div>
        <div className="hx-list">
          {data.patterns.length === 0 && <span className="hint" style={{ padding: '6px 8px' }}>名单为空：所有站点均注入观测 hook。</span>}
          {data.patterns.map((p) => {
            const isDefault = data.defaults.includes(p);
            return (
              <div key={p} className="hx-row">
                <span className={`hx-dot${isDefault ? ' hx-dot--default' : ''}`} aria-hidden />
                <code className="hx-pattern" title={p}>{p}</code>
                {isDefault && <span className="hx-count">默认</span>}
                <button className="hx-del" onClick={() => void remove(p)} aria-label={`删除 ${p}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <Button onClick={() => void reset()}><RotateCcw size={14} /> 恢复默认</Button>
          <span className="hint">回到出厂四站；自定义条目会被移除。</span>
        </div>
      </section>
    </PageShell>
  );
}
