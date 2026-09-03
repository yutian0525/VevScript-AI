// components/scripts/ScriptDetailView.tsx
// 脚本详情页（spec §9.2 修订：文本为源）——源码 textarea + 实时解析面板 + 保存/启停/删除/导出/重载当前页。
// text（.user.js 原文）是唯一真源：头部 @字段 即配置，解析面板随输入实时重算，保存 patch { text }。
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Download, Power, RotateCw, Save, Trash2, X } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { sendScriptsRequest, useScripts } from '../../stores/scripts';
import { useUi } from '../../stores/ui';
import { parseUserScript } from '../../shared/userscript-meta';
import { classifyGrants } from '../../shared/gm-apis';
import type { UserScript } from '../../shared/types';

export function ScriptDetailView({ id }: { id: string }) {
  const openScript = useUi((s) => s.openScript);
  const errors = useScripts((s) => s.errors[id] ?? []);
  const [script, setScript] = useState<UserScript | null>(null);
  const [text, setText] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
          type: 'SCRIPTS_GET',
          id,
        });
        if (cancelled) return;
        if (resp.ok && resp.data) {
          setScript(resp.data.script);
          setText(resp.data.script.text);
        } else {
          setNotFound(true);
        }
      } catch {
        // 传输异常（如 SW 死亡）时兜底为未找到，避免永停「加载中」
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // 实时解析：头部即配置，所见即所得（仅预览——保存才落库重注册）
  const parsed = useMemo(() => parseUserScript(text), [text]);
  const f = parsed.fields;

  // 启停当前脚本（头部之外的运行时开关，同 TM）
  async function toggleEnabled(): Promise<void> {
    if (!script) return;
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
      type: 'SCRIPTS_SET_ENABLED',
      id: script.id,
      enabled: !script.enabled,
    });
    if (resp.ok && resp.data) {
      setScript(resp.data.script);
      setMessage(resp.data.script.enabled ? '已启用，刷新页面生效' : '已禁用，刷新页面生效');
      await useScripts.getState().refresh();
    } else {
      setMessage(resp.error ?? '操作失败');
    }
  }

  async function save(): Promise<void> {
    if (!script) return;
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
      type: 'SCRIPTS_UPDATE',
      id: script.id,
      patch: { text },
    });
    if (resp.ok && resp.data) {
      setScript(resp.data.script);
      setDirty(false);
      setMessage('已重新注册，刷新页面生效');
      await useScripts.getState().refresh();
    } else {
      setMessage(resp.error ?? '保存失败');
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
    // 修订：直接下载原文（不再反向拼头部）
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(script.name || 'script').replace(/[\\/:*?"<>|]/g, '_')}.user.js`;
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
      title={f.name || script.name || '未命名脚本'}
      eyebrow="SCRIPT"
      actions={
        <Button variant="ghost" onClick={() => openScript(null)} aria-label="返回">
          <ArrowLeft size={14} />
        </Button>
      }
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div className="scripts-run">
          <div className="scripts-run__head mono">HEADER · 实时解析（头部即配置）</div>
          <div className="scripts-run__item">
            <div>name: {f.name || '（未设置）'}</div>
            {f.meta.version && <div>version: {f.meta.version}</div>}
            {f.meta.author && <div>author: {f.meta.author}</div>}
            {f.meta.description && <div>{f.meta.description}</div>}
            <div className="mono">match: {f.matches.length > 0 ? f.matches.join('  ') : '（无——脚本不会运行）'}</div>
            <div className="mono">run-at: {f.runAt} · world: {f.world}</div>
            {f.meta.grants && f.meta.grants.length > 0 && (
              <div style={{ fontSize: 11 }}>
                {f.meta.grants.map((g) => {
                  const ok = classifyGrants([g]).supported.length > 0;
                  return (
                    <div key={g} className="mono" style={{ display: 'flex', alignItems: 'center', gap: 4, color: ok ? 'var(--ink-2)' : 'var(--warn)' }}>
                      {ok ? <Check size={11} aria-hidden /> : <X size={11} aria-hidden />} {g}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {parsed.warnings.length > 0 && (
            <div className="scripts-warnline">
              {parsed.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="scripts-run__head" htmlFor="sc-text" style={{ marginBottom: 0 }}>
            源码（.user.js 原文，头部 @字段 即配置）
          </label>
          <textarea
            id="sc-text"
            className="script-editor"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
            onKeyDown={(e) => {
              // Tab 键插入两空格（轻量编辑器约定，spec §2 非目标：不做 CodeMirror）
              if (e.key === 'Tab') {
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart, selectionEnd, value } = el;
                el.value = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
                el.selectionStart = el.selectionEnd = selectionStart + 2;
                setText(el.value);
                setDirty(true);
              }
            }}
          />
        </div>

        {errors.length > 0 && (
          <div className="scripts-run">
            <div className="scripts-run__head mono" style={{ display: 'flex', alignItems: 'center' }}>
              <span>ERRORS · {errors.length}</span>
              <Button variant="ghost" style={{ marginLeft: 'auto' }} onClick={() => void sendScriptsRequest({ type: 'SCRIPTS_CLEAR_ERRORS', scriptId: id })}>清空</Button>
            </div>
            {errors.slice(-10).reverse().map((e, i) => (
              <div key={i} className="scripts-run__item" style={{ color: 'var(--warn)' }}>
                {new Date(e.at).toLocaleTimeString()} · line {e.line ?? '?'} · {e.message}
              </div>
            ))}
          </div>
        )}

        {message && (
          <div className="scripts-warnline" role="status">
            {message}
          </div>
        )}

        <div className="scripts-footer">
          <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
            <Save size={14} /> 保存
          </Button>
          <Button onClick={() => void toggleEnabled()}>
            <Power size={14} color={script.enabled ? 'var(--ok)' : 'var(--ink-3)'} /> {script.enabled ? '禁用' : '启用'}
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
