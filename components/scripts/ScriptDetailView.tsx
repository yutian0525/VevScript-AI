// components/scripts/ScriptDetailView.tsx
// 脚本详情页（spec §9.2）：元数据表单 + code 编辑（轻量 textarea）+ 保存/删除/导出/重载当前页。
import { useEffect, useState } from 'react';
import { ArrowLeft, Download, RotateCw, Save, Trash2 } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { sendScriptsRequest, useScripts } from '../../stores/scripts';
import { useUi } from '../../stores/ui';
import { stringifyUserScript } from '../../shared/userscript-meta';
import type { ScriptRunAt, ScriptWorld, UserScript } from '../../shared/types';

export function ScriptDetailView({ id }: { id: string }) {
  const openScript = useUi((s) => s.openScript);
  const [script, setScript] = useState<UserScript | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
        type: 'SCRIPTS_GET',
        id,
      });
      if (cancelled) return;
      if (resp.ok && resp.data) setScript(resp.data.script);
      else setNotFound(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  function patch(fields: Partial<UserScript>): void {
    setScript((s) => (s ? { ...s, ...fields } : s));
    setDirty(true);
  }

  async function save(): Promise<void> {
    if (!script) return;
    const matches = script.matches.map((m) => m.trim()).filter(Boolean);
    const resp = await sendScriptsRequest<{ ok: boolean; error?: string }>({
      type: 'SCRIPTS_UPDATE',
      id: script.id,
      patch: { name: script.name, code: script.code, matches, runAt: script.runAt, world: script.world },
    });
    setMessage(resp.ok ? '已重新注册，刷新页面生效' : (resp.error ?? '保存失败'));
    if (resp.ok) {
      setDirty(false);
      await useScripts.getState().refresh();
    }
  }

  async function remove(): Promise<void> {
    if (!script || !window.confirm(`删除脚本「${script.name}」？不可恢复。`)) return;
    const resp = await sendScriptsRequest<{ ok: boolean; error?: string }>({ type: 'SCRIPTS_DELETE', id: script.id });
    if (resp.ok) {
      openScript(null);
      await useScripts.getState().refresh();
    } else {
      setMessage(resp.error ?? '删除失败');
    }
  }

  function exportFile(): void {
    if (!script) return;
    const text = stringifyUserScript(script);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${script.name.replace(/[\\/:*?"<>|]/g, '_')}.user.js`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function reloadActivePage(): Promise<void> {
    let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null) await browser.tabs.reload(tab.id);
  }

  if (notFound) {
    return (
      <PageShell title="脚本详情" eyebrow="SCRIPT" actions={<Button onClick={() => openScript(null)}><ArrowLeft size={14} /> 返回</Button>}>
        <div className="chat__empty">脚本不存在或已被删除</div>
      </PageShell>
    );
  }
  if (!script) return <PageShell title="脚本详情" eyebrow="SCRIPT"><div className="chat__empty">加载中…</div></PageShell>;

  return (
    <PageShell
      title={script.name || '未命名脚本'}
      eyebrow="SCRIPT"
      actions={
        <Button variant="ghost" onClick={() => openScript(null)} aria-label="返回">
          <ArrowLeft size={14} />
        </Button>
      }
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div>
          <label className="scripts-run__head" htmlFor="sc-name" style={{ marginBottom: 0 }}>名称</label>
          <Input id="sc-name" value={script.name} onChange={(e) => patch({ name: e.target.value })} />
        </div>

        <div>
          <label className="scripts-run__head" htmlFor="sc-matches" style={{ marginBottom: 0 }}>
            匹配规则（match pattern，每行一条）
          </label>
          <textarea
            id="sc-matches"
            className="input script-editor"
            style={{ minHeight: 60 }}
            value={script.matches.join('\n')}
            onChange={(e) => patch({ matches: e.target.value.split('\n') })}
          />
          {script.matches.length === 0 && (
            <div className="scripts-warnline">未设置匹配规则：脚本不会在任何页面运行</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label className="scripts-run__head" htmlFor="sc-runat" style={{ marginBottom: 0 }}>运行时机</label>
            <select
              id="sc-runat"
              className="input"
              value={script.runAt}
              onChange={(e) => patch({ runAt: e.target.value as ScriptRunAt })}
            >
              <option value="document_start">document_start</option>
              <option value="document_end">document_end</option>
              <option value="document_idle">document_idle（默认）</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label className="scripts-run__head" htmlFor="sc-world" style={{ marginBottom: 0 }}>执行世界</label>
            <select
              id="sc-world"
              className="input"
              value={script.world}
              onChange={(e) => patch({ world: e.target.value as ScriptWorld })}
            >
              <option value="USER_SCRIPT">USER_SCRIPT（隔离，默认）</option>
              <option value="MAIN">MAIN（可访问页面变量）</option>
            </select>
          </div>
        </div>

        {(script.meta?.version || script.meta?.author || script.meta?.grants) && (
          <div className="scripts-run">
            <div className="scripts-run__head mono">META</div>
            <div className="scripts-run__item">
              {script.meta?.version && <div>version: {script.meta.version}</div>}
              {script.meta?.author && <div>author: {script.meta.author}</div>}
              {script.meta?.description && <div>{script.meta.description}</div>}
              {script.meta?.grants && script.meta.grants.length > 0 && (
                <div className="scripts-warnline">
                  需要 GM_* API（{script.meta.grants.join(', ')}）——本扩展不支持，脚本调用会报错
                </div>
              )}
            </div>
          </div>
        )}

        <div>
          <label className="scripts-run__head" htmlFor="sc-code" style={{ marginBottom: 0 }}>代码</label>
          <textarea
            id="sc-code"
            className="script-editor"
            spellCheck={false}
            value={script.code}
            onChange={(e) => patch({ code: e.target.value })}
            onKeyDown={(e) => {
              // Tab 键插入两空格（轻量编辑器约定，spec §2 非目标：不做 CodeMirror）
              if (e.key === 'Tab') {
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart, selectionEnd, value } = el;
                el.value = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
                el.selectionStart = el.selectionEnd = selectionStart + 2;
                patch({ code: el.value });
              }
            }}
          />
        </div>

        {message && (
          <div className="scripts-warnline" role="status">
            {message}
          </div>
        )}

        <div className="scripts-footer">
          <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
            <Save size={14} /> 保存
          </Button>
          <Button onClick={() => void reloadActivePage()}>
            <RotateCw size={14} /> 重载当前页
          </Button>
          <Button onClick={exportFile}>
            <Download size={14} /> 导出 .user.js
          </Button>
          <Button variant="danger" onClick={() => void remove()}>
            <Trash2 size={14} /> 删除
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
