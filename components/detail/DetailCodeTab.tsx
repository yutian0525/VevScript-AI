// components/detail/DetailCodeTab.tsx
// 代码 Tab：源码编辑器（全宽破格）+ dirty 指示 + 保存（patch {text} 整文替换）。
import { useEffect, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import { parseUserScript } from '../../shared/userscript-meta';
import type { UserScript } from '../../shared/types';

export function DetailCodeTab({ script, onSaved }: { script: UserScript; onSaved: (saved: UserScript) => Promise<void> | void }) {
  const [text, setText] = useState(script.text);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  // 脚本切换/保存后同步基线
  useEffect(() => { setText(script.text); setDirty(false); }, [script.id, script.updatedAt]);

  // 实时解析预览（头部即配置，所见即所得——保存才落库重注册）
  const parsed = useMemo(() => parseUserScript(text), [text]);

  async function save(): Promise<void> {
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
      type: 'SCRIPTS_UPDATE', id: script.id, patch: { text },
    });
    if (resp.ok && resp.data) {
      setDirty(false);
      setMessage('已重新注册，刷新页面生效');
      await onSaved(resp.data.script);
    } else {
      setMessage(resp.error ?? '保存失败');
    }
  }

  return (
    <div className="detail-code">
      <div className="detail-code__bar">
        <span className="mono detail-code__status">
          {dirty ? '● 未保存' : parsed.warnings.length > 0 ? `${parsed.warnings.length} 条解析警告` : '已同步'}
        </span>
        <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
          <Save size={14} /> 保存
        </Button>
      </div>
      {message && <div className="scripts-warnline" role="status">{message}</div>}
      {parsed.warnings.length > 0 && (
        <div className="scripts-warnline">
          {parsed.warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}
      <textarea
        aria-label="脚本源码"
        className="detail-code__editor mono"
        spellCheck={false}
        value={text}
        onChange={(e) => { setText(e.target.value); setDirty(true); }}
        onKeyDown={(e) => {
          // Tab 键插入两空格（轻量编辑器约定，不做 CodeMirror）
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
  );
}
