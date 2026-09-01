// components/scripts/ScriptsListView.tsx
// 脚本池列表页（spec §9.1）：当前页运行中区 + 搜索 + 脚本行（启停/徽标）+ 新建/导入。
import { useRef, useState } from 'react';
import { CircleAlert, Plus, Power, Search, Upload } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { filterSummaries, sendScriptsRequest, useScripts } from '../../stores/scripts';
import { useUi } from '../../stores/ui';
import type { ScriptsRuntimeEntry } from '../../shared/messages';
import type { ScriptSummary } from '../../shared/types';

const SOURCE_LABEL: Record<ScriptSummary['source'], string> = {
  user: 'user',
  agent: 'agent',
  import: 'TM',
};

export function ScriptsListView() {
  const { summaries, runtimeEntries, activeTabId, query, engineWarning, setQuery } = useScripts();
  const openScript = useUi((s) => s.openScript);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const runtime: ScriptsRuntimeEntry | undefined = activeTabId != null ? runtimeEntries[activeTabId] : undefined;
  const visible = filterSummaries(summaries, query);

  async function createNew(): Promise<void> {
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: { id: string } }; error?: string }>({
      type: 'SCRIPTS_CREATE',
      input: { name: '未命名脚本', code: '// 新脚本\n', matches: [] },
    });
    if (resp.ok && resp.data) {
      await useScripts.getState().refresh();
      openScript(resp.data.script.id);
    }
  }

  async function importFile(file: File): Promise<void> {
    const source = await file.text();
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: { id: string }; warnings: string[] }; error?: string }>({
      type: 'SCRIPTS_IMPORT',
      source,
      filename: file.name,
    });
    if (resp.ok && resp.data) {
      setImportWarnings(resp.data.warnings);
      await useScripts.getState().refresh();
      openScript(resp.data.script.id);
    } else {
      setImportWarnings([resp.error ?? '导入失败']);
    }
  }

  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    await sendScriptsRequest({ type: 'SCRIPTS_SET_ENABLED', id, enabled });
    await useScripts.getState().refresh();
  }

  return (
    <PageShell title="脚本池" eyebrow="LIBRARY">
      {engineWarning && (
        <div className="scripts-notice" role="alert">
          <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{engineWarning}</span>
        </div>
      )}

      <div className="scripts-run">
        <div className="scripts-run__head">
          <span className={`scripts-run__dot${runtime && runtime.scriptIds.length > 0 ? '' : ' scripts-run__dot--off'}`} aria-hidden />
          <span className="mono">RUNNING · {runtime?.scriptIds.length ?? 0}</span>
        </div>
        {runtime == null || runtime.scriptIds.length === 0 ? (
          <div className="scripts-run__empty">无脚本在此页运行</div>
        ) : (
          runtime.scriptIds.map((id) => {
            const s = summaries.find((x) => x.id === id);
            return (
              <div key={id} className="scripts-run__item">
                {s?.name ?? id}
              </div>
            );
          })
        )}
      </div>

      <div className="scripts-toolbar">
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={13} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--ink-3)' }} aria-hidden />
          <Input
            aria-label="搜索脚本"
            placeholder="搜索名称 / 匹配规则…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ paddingLeft: 26 }}
          />
        </div>
      </div>

      {importWarnings.length > 0 && (
        <div className="scripts-warnline" role="status">
          {importWarnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      <div>
        {visible.map((s) => (
          <button key={s.id} className={`scripts-row${s.enabled ? '' : ' is-off'}`} onClick={() => openScript(s.id)}>
            <span className="scripts-row__name">{s.name}</span>
            <span className="scripts-row__match">{s.matches.join(' ') || '（无匹配规则）'}</span>
            <span className={`scripts-badge scripts-badge--signal`} aria-hidden>
              {SOURCE_LABEL[s.source]}
            </span>
            {s.hasGrants && (
              <span className="scripts-badge scripts-badge--warn" title="脚本使用了 GM_* API（本扩展不支持，调用会报错）">
                GM
              </span>
            )}
            <Button
              variant="ghost"
              aria-label={s.enabled ? '禁用' : '启用'}
              aria-pressed={s.enabled}
              title={s.enabled ? '禁用' : '启用'}
              onClick={(e) => {
                e.stopPropagation();
                void setEnabled(s.id, !s.enabled);
              }}
            >
              <Power size={13} color={s.enabled ? 'var(--ok)' : 'var(--ink-3)'} />
            </Button>
          </button>
        ))}
        {visible.length === 0 && <div className="chat__empty">没有匹配的脚本</div>}
      </div>

      <div className="scripts-footer">
        <Button variant="primary" onClick={() => void createNew()}>
          <Plus size={14} /> 新建
        </Button>
        <Button onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> 导入 .user.js
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".user.js,.js"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = '';
          }}
        />
      </div>
    </PageShell>
  );
}
