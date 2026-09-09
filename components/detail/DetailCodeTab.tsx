// components/detail/DetailCodeTab.tsx
// 代码 Tab（2026-09-04 重写）：CM6 编辑器顶满 + 工具栏（保存/导入/导出 左，状态字 右）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Save, Upload } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import { parseUserScript } from '../../shared/userscript-meta';
import type { UserScript } from '../../shared/types';
import { CodeEditor } from './CodeEditor';

const MAX_IMPORT_BYTES = 280 * 1024; // 与 UserScript.text 后端上限对齐

export function DetailCodeTab({ script, onSaved, onDirtyChange }: { script: UserScript; onSaved: (saved: UserScript) => Promise<void> | void; onDirtyChange?: (dirty: boolean) => void }) {
  const [text, setText] = useState(script.text);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  // 脚本切换/保存后同步基线
  useEffect(() => { setText(script.text); setDirty(false); }, [script.id, script.updatedAt]);
  // 上报 dirty 给 DetailApp（供跨界面变更时判断是否可安全重拉）；卸载（切 Tab）时归零
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

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

  function exportFile(): void {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(script.name || 'script').replace(/[\\/:*?"<>|]/g, '_')}.user.js`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onImportFile(file: File): Promise<void> {
    const content = await file.text();
    if (content.length > MAX_IMPORT_BYTES) {
      setMessage('文件过大（上限 280KB）');
      return;
    }
    setMessage('');
    setText(content);
    setDirty(true);
  }

  const status = dirty ? '● 未保存' : parsed.warnings.length > 0 ? `${parsed.warnings.length} 条解析警告` : '已同步';

  return (
    <div className="detail-code">
      <div className="detail-code__bar">
        <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
          <Save size={14} /> 保存
        </Button>
        <Button variant="ghost" onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> 导入
        </Button>
        <Button variant="ghost" onClick={exportFile}>
          <Download size={14} /> 导出
        </Button>
        <span className="detail-code__status mono">{status}</span>
      </div>
      {message && <div className="scripts-warnline" role="status">{message}</div>}
      {parsed.warnings.length > 0 && (
        <div className="scripts-warnline">
          {parsed.warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}
      <div className="detail-code__editor-host">
        <CodeEditor
          value={text}
          onChange={(v) => { setText(v); setDirty(true); }}
          onSave={() => { if (dirty) void save(); }}
          ariaLabel="脚本源码"
        />
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".user.js,.js"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onImportFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}
