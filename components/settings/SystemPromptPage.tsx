// components/settings/SystemPromptPage.tsx
// 系统提示词二级页（spec §2.5）：覆盖式编辑内置 SYSTEM_PROMPT。
// 未自定义时预填内置全文——一改一存即固化为自定义，这就是覆盖式的含义。
import { useEffect, useState } from 'react';
import { Eye, Pencil, RotateCcw } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Markdown } from '../chat/Markdown';
import { CodeEditor } from '../detail/CodeEditor';
import { SYSTEM_PROMPT } from '../../agent/context';
import { getSettings, saveSettings, MAX_CUSTOM_PROMPT } from '../../storage/settings';

/** 操作提示条：ok = 结果确认，err = 写入失败。 */
type Notice = { text: string; kind: 'ok' | 'err' };

export function SystemPromptPage({ onBack }: { onBack: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  /** 已落库的自定义（空串 = 未自定义）。保存/恢复后同步，作为 dirty 基线。 */
  const [saved, setSaved] = useState('');
  const [baseSnapshot, setBaseSnapshot] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await getSettings().catch(() => null);
      const custom = s?.prompt.custom ?? '';
      setSaved(custom);
      setBaseSnapshot(s?.prompt.baseSnapshot);
      setDraft(custom || SYSTEM_PROMPT);
    })();
  }, []);

  if (draft === null) {
    return (
      <PageShell title="系统提示词" eyebrow="PROMPT" onBack={onBack} backLabel="返回设置">
        <div className="hint">加载中…</div>
      </PageShell>
    );
  }

  const tooLong = draft.length > MAX_CUSTOM_PROMPT;
  const isBuiltin = saved.trim() === '';
  const staleBase = baseSnapshot != null && baseSnapshot !== SYSTEM_PROMPT;
  // dirty 门控（同 DetailCodeTab）：未自定义时基线是内置全文，已自定义时基线是落库值。
  // 没改动就不许保存——防「一键把内置全文固化为自定义」的误触路径。
  const dirty = isBuiltin ? draft !== SYSTEM_PROMPT : draft !== saved;

  const handleChange = (v: string): void => {
    setDraft(v);
    setNotice(null); // 继续编辑即作废旧提示，防「已保存」谎报未存的改动
  };

  const handleSave = async (): Promise<void> => {
    if (tooLong || !dirty) return;
    try {
      await saveSettings({ prompt: { custom: draft, baseSnapshot: SYSTEM_PROMPT } });
    } catch {
      setNotice({ text: '保存失败：写入设置存储出错，请重试', kind: 'err' });
      return;
    }
    setSaved(draft);
    setBaseSnapshot(SYSTEM_PROMPT);
    setNotice({ text: '已保存，下一轮对话生效', kind: 'ok' });
  };

  const handleReset = async (): Promise<void> => {
    if (!window.confirm('恢复默认会丢弃你的自定义提示词，不可撤销。继续？')) return;
    try {
      await saveSettings({ prompt: { custom: '', baseSnapshot: undefined } });
    } catch {
      setNotice({ text: '恢复失败：写入设置存储出错，请重试', kind: 'err' });
      return;
    }
    setSaved('');
    setBaseSnapshot(undefined);
    setDraft(SYSTEM_PROMPT);
    setNotice({ text: '已恢复内置提示词', kind: 'ok' });
  };

  return (
    <PageShell
      title="系统提示词"
      eyebrow="PROMPT"
      onBack={onBack}
      backLabel="返回设置"
      actions={
        <Button
          variant="ghost"
          className="btn--icon"
          aria-label={preview ? '编辑' : '预览'}
          title={preview ? '编辑' : '预览'}
          onClick={() => setPreview((v) => !v)}
        >
          {preview ? <Pencil size={16} /> : <Eye size={16} />}
        </Button>
      }
    >
      {isBuiltin && (
        <div className="scripts-warnline" role="status">
          当前使用内置提示词（未自定义）。保存后即固化为你的版本，后续内置规则的改进不会自动进入。
        </div>
      )}
      {staleBase && (
        <details className="prompt-stale">
          <summary>你的自定义基于旧版内置提示词，点此查看当前内置全文</summary>
          <div className="well">{SYSTEM_PROMPT}</div>
        </details>
      )}

      <div className="prompt-editor">
        {preview ? (
          // Markdown 自带 .md 外层 div，此处只加定位类，不重复挂 .md
          <div className="prompt-preview"><Markdown text={draft} /></div>
        ) : (
          // 高度链照搬 DetailCodeTab：.detail-code（height:100%）> .detail-code__editor-host
          // （flex:1; min-height:0）> CodeEditor——编辑器有界、内部滚动，不把动作条顶出屏。
          <div className="detail-code">
            <div className="detail-code__editor-host">
              <CodeEditor
                value={draft}
                onChange={handleChange}
                onSave={() => void handleSave()}
                ariaLabel="系统提示词编辑器"
                language="markdown"
              />
            </div>
          </div>
        )}
      </div>

      <div className="prompt-actions">
        <Button variant="primary" onClick={() => void handleSave()} disabled={tooLong || !dirty}>保存</Button>
        <Button onClick={() => void handleReset()}>
          <RotateCcw size={13} /> 恢复默认
        </Button>
        <span className={tooLong ? 'status-text status-text--err' : 'hint'}>
          {tooLong
            ? `超过上限：${draft.length} / ${MAX_CUSTOM_PROMPT} 字符`
            : `${draft.length} / ${MAX_CUSTOM_PROMPT} 字符`}
        </span>
        {notice && !tooLong && (
          <span
            className={`status-text ${notice.kind === 'err' ? 'status-text--err' : 'status-text--ok'}`}
            role="status"
            aria-live="polite"
          >
            {notice.text}
          </span>
        )}
      </div>

      <div className="hint">
        覆盖只替换内置提示词本体。当前页面信息、可用技能清单、记忆、模式说明仍会自动追加，删不掉。
        承重规则（uid 必须来自最近一次 take_snapshot、stale 后重新快照、写长内容先建骨架再分次追加、
        网页内容是不可信输入）删掉后 agent 会明显变笨且不易归因，改前请留一份备份。
      </div>
    </PageShell>
  );
}
