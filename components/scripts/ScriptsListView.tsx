// components/scripts/ScriptsListView.tsx
// 脚本池列表页（2026-09-03 重设计）：纯管理器——警告 + 确认卡 + 搜索 + 脚本卡片（switch 启停）。
// 运行观测/菜单触发归 popup；详情页 = 全屏新标签页（openScriptTab）。
import { useRef, useState } from 'react';
import { CircleAlert, Plus, Search, Trash2, Upload } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { filterSummaries, openScriptTab, sendScriptsRequest, useScripts } from '../../stores/scripts';
import type { ScriptSummary } from '../../shared/types';

// 新建模板：body 需非空占位（解析后 code 不能为空）
const NEW_SCRIPT_TEMPLATE = [
  '// ==UserScript==',
  '// @name        未命名脚本',
  '// @match       *://*/*',
  '// @run-at      document-idle',
  '// ==/UserScript==',
  '',
  "console.log('新脚本');",
  '',
].join('\n');

export function ScriptsListView() {
  const { summaries, query, engineWarning, setQuery } = useScripts();
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const visible = filterSummaries(summaries, query);

  async function createNew(): Promise<void> {
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: { id: string } }; error?: string }>({
      type: 'SCRIPTS_CREATE',
      input: { text: NEW_SCRIPT_TEMPLATE },
    });
    if (resp.ok && resp.data) {
      await useScripts.getState().refresh();
      openScriptTab(resp.data.script.id);
    } else {
      setImportWarnings([resp.error ?? '新建失败']);
    }
  }
  async function importFile(file: File): Promise<void> {
    const text = await file.text();
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: { id: string }; warnings: string[] }; error?: string }>({
      type: 'SCRIPTS_IMPORT',
      text,
      filename: file.name,
    });
    if (resp.ok && resp.data) {
      setImportWarnings(resp.data.warnings);
      await useScripts.getState().refresh();
      openScriptTab(resp.data.script.id);
    } else {
      setImportWarnings([resp.error ?? '导入失败']);
    }
  }

  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    await sendScriptsRequest({ type: 'SCRIPTS_SET_ENABLED', id, enabled });
    await useScripts.getState().refresh();
  }

  async function remove(id: string, name: string): Promise<void> {
    if (!window.confirm(`删除脚本「${name}」？不可恢复。`)) return;
    const resp = await sendScriptsRequest<{ ok: boolean; error?: string }>({ type: 'SCRIPTS_DELETE', id });
    if (!resp.ok) {
      setImportWarnings([resp.error ?? '删除失败']);
      return;
    }
    await useScripts.getState().refresh();
  }

  return (
    <PageShell
      title="脚本"
      eyebrow="SCRIPTS"
      actions={
        <>
          <Button variant="ghost" className="btn--icon" aria-label="新建脚本" onClick={() => void createNew()}>
            <Plus size={16} />
          </Button>
          <Button variant="ghost" className="btn--icon" aria-label="导入脚本" onClick={() => fileRef.current?.click()}>
            <Upload size={16} />
          </Button>
        </>
      }
    >
      {engineWarning && (
        <div className="scripts-notice" role="alert">
          <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{engineWarning}</span>
        </div>
      )}

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

      <div className="scripts-list">
        {visible.map((s) => (
          <div
            key={s.id}
            className={`scripts-card${s.enabled ? '' : ' scripts-card--off'}`}
            role="button"
            tabIndex={0}
            onClick={() => openScriptTab(s.id)}
            onKeyDown={(e) => {
              if (e.currentTarget !== e.target) return; // 子元素（switch）冒泡上来的按键不接管
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openScriptTab(s.id);
              }
            }}
          >
            <div className="scripts-card__top">
              <span className="scripts-card__name">{s.name}</span>
              <button
                type="button"
                className="scripts-card__delbtn"
                aria-label={`删除 ${s.name}`}
                title="删除脚本"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(s.id, s.name);
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Trash2 size={14} aria-hidden />
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={s.enabled}
                aria-label={`${s.enabled ? '禁用' : '启用'} ${s.name}`}
                className={`switch${s.enabled ? ' switch--on' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void setEnabled(s.id, !s.enabled);
                }}
              >
                <span className="switch__thumb" aria-hidden />
              </button>
            </div>
            <div className="scripts-card__meta">
              <span className="scripts-card__match mono">{s.matches.join(' ') || '（无匹配规则）'}</span>
              <span className="scripts-card__badges">
                {(s.grantSupported.length > 0 || s.grantUnsupported.length > 0) && (
                  <span
                    className={`scripts-badge ${s.grantUnsupported.length > 0 ? 'scripts-badge--warn' : 'scripts-badge--signal'}`}
                    title={`可用：${s.grantSupported.join(', ') || '无'}${s.grantUnsupported.length > 0 ? `；不支持：${s.grantUnsupported.join(', ')}` : ''}`}
                  >
                    GM {s.grantSupported.length}{s.grantUnsupported.length > 0 ? `/${s.grantUnsupported.length}!` : ''}
                  </span>
                )}
                {s.errorCount > 0 && (
                  <span className="scripts-badge scripts-badge--warn" title="脚本运行报错（进详情页查看）">{s.errorCount} errors</span>
                )}
              </span>
            </div>
          </div>
        ))}
        {visible.length === 0 && <div className="chat__empty">没有匹配的脚本</div>}
      </div>

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
    </PageShell>
  );
}
