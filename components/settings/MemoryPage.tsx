// components/settings/MemoryPage.tsx
// AI 记忆二级页（spec §3.6）：列表 ↔ 详情。面板直接读写 storage/memory.ts，
// 不走 background 编排层——记忆无 md 解析、无注入引擎、无 tabs 监听，那层间接没有收益。
import { useCallback, useEffect, useState } from 'react';
import { Brain, Info, Plus, Search, Trash2 } from 'lucide-react';
import { storage } from 'wxt/utils/storage';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Tooltip } from '../ui/Tooltip';
import {
  listMemories, saveMemory, deleteMemory, newMemory, MAX_CONTENT_LENGTH, MEMORY_KEY,
} from '../../storage/memory';
import { getSettings, saveSettings } from '../../storage/settings';
import type { MemoryEntry } from '../../shared/types';
import { parsePatternLines, invalidPatterns, filterMemories } from './memory-page-utils';

/** 详情态：'new' = 新建，字符串 id = 编辑那一条。 */
type Editing = { kind: 'new' } | { kind: 'edit'; entry: MemoryEntry };

/** 面板卡内的一行开关：左侧标签 + info 图标（Tooltip 收纳长说明），右侧 switch。 */
function ToggleRow({
  label, hint, checked, onToggle,
}: { label: string; hint: string; checked: boolean; onToggle: () => void }) {
  return (
    <div className="mem-toggle">
      <span className="mem-toggle__label">
        {label}
        <Tooltip label={hint}>
          <button type="button" className="mem-info" aria-label={`${label}说明`}>
            <Info size={13} aria-hidden />
          </button>
        </Tooltip>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`switch${checked ? ' switch--on' : ''}`}
        onClick={onToggle}
      >
        <span className="switch__thumb" aria-hidden />
      </button>
    </div>
  );
}

export function MemoryPage({ onBack }: { onBack: () => void }) {
  const [list, setList] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [writable, setWritable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setList(await listMemories().catch(() => []));
  }, []);

  useEffect(() => {
    void refresh();
    void (async () => {
      const s = await getSettings().catch(() => null);
      if (!s) return;
      setEnabled(s.agent.memoryEnabled);
      setWritable(s.agent.memoryWritable);
    })();
    // AI 在任务中写记忆时，正开着这一页也能看到列表刷新
    const unwatch = storage.watch<MemoryEntry[]>(MEMORY_KEY, (next) => {
      setList(next ?? []);
    });
    return () => unwatch();
  }, [refresh]);

  const toggleEnabled = async (): Promise<void> => {
    const next = !enabled;
    setEnabled(next);
    try {
      await saveSettings({ agent: { memoryEnabled: next } });
      setError(null);
    } catch (e) {
      setEnabled(!next); // 回滚
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const toggleWritable = async (): Promise<void> => {
    const next = !writable;
    setWritable(next);
    try {
      await saveSettings({ agent: { memoryWritable: next } });
      setError(null);
    } catch (e) {
      setWritable(!next); // 回滚
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const remove = async (m: MemoryEntry): Promise<void> => {
    if (!window.confirm(`删除这条记忆？不可恢复。\n\n${m.content.slice(0, 80)}`)) return;
    try {
      await deleteMemory(m.id);
      setError(null);
    } catch (e) {
      // storage 故障等：显式提示而非未处理 rejection
      setError(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
    await refresh();
  };

  if (editing) {
    return (
      <MemoryDetail
        editing={editing}
        onCancel={() => { setEditing(null); setError(null); }}
        onSaved={async () => { setEditing(null); setError(null); await refresh(); }}
      />
    );
  }

  const visible = filterMemories(list, query);

  return (
    <PageShell
      title="AI 记忆"
      eyebrow="MEMORY"
      onBack={onBack}
      backLabel="返回设置"
      actions={
        <Tooltip label="新建记忆">
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            aria-label="新建记忆"
            onClick={() => setEditing({ kind: 'new' })}
          >
            <Plus size={16} />
          </button>
        </Tooltip>
      }
    >
      {error && <div className="scripts-warnline" role="status">{error}</div>}

      <div className="mem-panel">
        <ToggleRow
          label="启用记忆"
          hint="关闭后不再把记忆注入对话，也不给 AI 记忆工具。"
          checked={enabled}
          onToggle={() => void toggleEnabled()}
        />
        <ToggleRow
          label="允许 AI 写入"
          hint="关闭后 AI 只能读已有记忆，增删改全部由你在这一页维护。"
          checked={writable}
          onToggle={() => void toggleWritable()}
        />
      </div>

      {list.length > 0 && (
        <div className="scripts-toolbar">
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={13} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--ink-3)' }} aria-hidden />
            <Input
              aria-label="搜索记忆"
              placeholder="搜索正文 / 作用域…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ paddingLeft: 26 }}
            />
          </div>
        </div>
      )}

      <div className="scripts-list">
        {visible.map((m) => (
          <div
            key={m.id}
            className="scripts-card"
            role="button"
            tabIndex={0}
            onClick={() => setEditing({ kind: 'edit', entry: m })}
            onKeyDown={(e) => {
              if (e.currentTarget !== e.target) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setEditing({ kind: 'edit', entry: m });
              }
            }}
          >
            <div className="scripts-card__top">
              <span className="mem-card__content">{m.content}</span>
              <Tooltip label="删除记忆">
                <button
                  type="button"
                  className="scripts-card__delbtn"
                  aria-label={`删除这条记忆：${m.content}`}
                  onClick={(e) => { e.stopPropagation(); void remove(m); }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </Tooltip>
            </div>
            <div className="scripts-card__meta">
              {m.matches.length === 0
                ? <span className="mem-chip">全局</span>
                : m.matches.map((p) => <span key={p} className="mem-chip mem-chip--scope">{p}</span>)}
              <span className={`mem-src mem-src--${m.source}`}>{m.source === 'ai' ? 'AI' : '手工'}</span>
              <span className="mem-card__time">{new Date(m.updatedAt).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <div className="mem-empty">
            <Brain size={30} strokeWidth={1.5} className="mem-empty__icon" aria-hidden />
            <div className="mem-empty__text">
              {list.length === 0
                ? '还没有记忆。AI 在对话中发现值得长期保留的信息时会自己记下，你也可以点右上角手工添加。'
                : '没有匹配的记忆'}
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function MemoryDetail({
  editing, onCancel, onSaved,
}: {
  editing: Editing;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const existing = editing.kind === 'edit' ? editing.entry : null;
  const [content, setContent] = useState(existing?.content ?? '');
  const [scopeText, setScopeText] = useState((existing?.matches ?? []).join('\n'));
  // 保存错误必须由详情页自己持有并渲染：父组件渲染详情时已提前 return，
  // 交给父组件的 setError 只会显示在列表页——撞上限之类的失败会被静默吞掉。
  const [saveError, setSaveError] = useState<string | null>(null);

  const patterns = parsePatternLines(scopeText);
  const bad = invalidPatterns(patterns);
  const tooLong = content.length > MAX_CONTENT_LENGTH;
  const canSave = content.trim().length > 0 && !tooLong && bad.length === 0;

  const handleSave = async (): Promise<void> => {
    if (!canSave) return;
    try {
      // source 保留原值——来源是事实记录，不因编辑而改写（spec §3.6）
      const entry: MemoryEntry = existing
        ? { ...existing, content, matches: patterns, updatedAt: Date.now() }
        : newMemory({ content, matches: patterns, source: 'user' });
      await saveMemory(entry);
      await onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <PageShell
      title={existing ? '编辑记忆' : '新建记忆'}
      eyebrow="MEMORY"
      onBack={onCancel}
      backLabel="返回列表"
    >
      {saveError && <div className="scripts-warnline" role="status">{saveError}</div>}

      <div className="field">
        <label className="field-label" htmlFor="mem-content">记忆正文</label>
        <textarea
          id="mem-content"
          aria-label="记忆正文"
          className="textarea"
          rows={5}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="一条只说一件事，如：这个站的登录按钮在右上角头像的悬浮层里，需先 hover 再 click"
        />
        <span className={tooLong ? 'status-text status-text--err' : 'hint'}>
          {content.length} / {MAX_CONTENT_LENGTH} 字符
        </span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="mem-scope">站点作用域</label>
        <textarea
          id="mem-scope"
          aria-label="站点作用域"
          className="textarea mono-input"
          rows={3}
          value={scopeText}
          onChange={(e) => setScopeText(e.target.value)}
          placeholder={'*://*.bilibili.com/*\n每行一条，留空 = 全局记忆'}
          spellCheck={false}
        />
        {bad.length > 0 ? (
          <span className="status-text status-text--err">
            非法 match pattern：{bad.join('、')}（形如 *://*.example.com/* 或 &lt;all_urls&gt;）
          </span>
        ) : (
          <span className="hint">
            留空 = 全局记忆，任何页面都注入。只在某站适用的经验务必填，否则会在别的站误导 AI。
          </span>
        )}
      </div>

      <div className="prompt-actions">
        <Button variant="primary" onClick={() => void handleSave()} disabled={!canSave}>保存</Button>
        <Button onClick={onCancel}>取消</Button>
      </div>
    </PageShell>
  );
}
